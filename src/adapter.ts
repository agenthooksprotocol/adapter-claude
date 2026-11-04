// The adapter's session state and the plumbing every mapping shares: one
// `Hooks` client per session, the session/turn/call identities AHP events
// carry, and how residual effects become Claude Code answers.
import { auth, Hooks, type DeliveryDiagnostic } from "agenthooksprotocol/client";
import { capabilities, contentCategories, gaps, MAX_CONTINUATIONS, MAX_UPLOAD_BYTES, toolPaths, uploadGap } from "./capabilities.js";
import { loadRegistration } from "./config.js";
import { texts } from "./content.js";
import type { MediaPolicy } from "./media.js";
import { type Host, readEnvironmentVariable, resolveHostname } from "./runtime/host.js";
import { hostSpawn } from "./runtime/spawn.js";
import { uploadsAvailable } from "./runtime/upload.js";
import { bindClock, hostFetch } from "./runtime/web.js";

export const SOURCE = "urn:anthropic:claude-code";
export const MAIN = "main";

/** One agent loop's current turn, as AHP identifies it. */
export interface LoopTurn {
  /** The AHP turn id: Claude Code's `turnId`, or one minted at prompt.submit. */
  id: string;
  synthesized?: true;
  /** Claude Code's own turn id, once its `turn.start` has run. */
  claudeTurnId?: string;
  continuationCount: number;
  /** The event the turn hangs off (a subagent's Agent tool.before). */
  parentEventId?: string;
}

/** What the adapter remembers about a tool call between its hooks. */
export interface CallState {
  name: string;
  input: Record<string, unknown>;
  loop: string;
  beforeEventId?: string;
  /** A hook's allow or ask, applied at tool.check. */
  decision?: "allow" | "ask";
  /** The verdict tool.check settled on, for tool.permission.resolved. */
  checked?: "allow" | "ask" | "deny";
  afterSent?: boolean;
  /** Text a hook put in place of the result, applied at PostToolUse. */
  skillText?: string;
}

export type SessionObject = {
  id: string;
  cwd?: string;
  model?: string;
  agent?: { id: string; type?: string };
}

/** Model identifiers carry their provider. */
export function model(id: string): { id: string; provider: string } {
  return { id, provider: "anthropic" };
}

export interface AgentState {
  type: string;
  parentEventId?: string;
}

/** What every boundary result has, whatever its event. */
interface AnyResult {
  readonly event: unknown;
  readonly effects: unknown;
  readonly acceptedResponses: readonly unknown[];
  readonly state: unknown;
  readonly content?: { close(): Promise<void> };
  readonly diagnostics: readonly DeliveryDiagnostic[];
  readonly interrupted: boolean;
}

export class Adapter {
  hooks: Hooks | undefined;
  #ready: Promise<void> = Promise.resolve();
  #host: Host | undefined;

  sessionId = "";
  cwd = "";
  model: string | undefined;
  permissionMode = "default";
  readonly turns = new Map<string, LoopTurn>();
  readonly calls = new Map<string, CallState>();
  readonly agents = new Map<string, AgentState>();
  /** A turn minted at prompt.submit, bound at the main loop's next turn.start. */
  pendingTurn: LoopTurn | undefined;
  /** How attachment parts are built on this machine. */
  media: MediaPolicy = {};
  /** The system prompt as last composed, for model.request.before. */
  systemSections: { id: string; text: string }[] = [];

  #started = false;

  /** Load the registration and start the client, once per load of the module:
   * whichever of the classic SessionStart and the mod's session.start runs
   * first starts it. Resolves even when there is nothing to deliver to; every
   * mapping then passes straight through. */
  start(host: Host, cwd: string): Promise<void> {
    if (this.#started) return this.#ready;
    this.#started = true;
    this.#host = host;
    this.cwd = cwd;
    bindClock(host);
    this.#ready = this.#start(host, cwd).catch((error) => {
      this.hooks = undefined;
      this.log(`not started: ${describe(error)}`);
    });
    return this.#ready;
  }

  async #start(host: Host, cwd: string): Promise<void> {
    const previous = this.hooks;
    this.hooks = undefined;
    await previous?.close().catch(() => {});
    const [{ registration, sources, diagnostics }, version, sessionId] = await Promise.all([
      loadRegistration(host, cwd),
      host.version(),
      host.sessionId(),
    ]);
    this.sessionId = sessionId;
    for (const line of diagnostics) this.log(line, true);
    if (!registration) {
      this.log("no hooks.json registration found; nothing is delivered", true);
      return;
    }
    const uploads = await uploadsAvailable(host);
    this.media = uploads ? {} : { unavailable: uploadGap.reason };
    const fetch = hostFetch(host);
    const { AHP_HOOKS_FILE: _pinned, ...environment } = host.environment;
    const hooks = new Hooks(registration, {
      source: SOURCE,
      harness: { name: "claude-code", version: version.version },
      capabilities,
      manifestMetadata: {
        authentication: ["bearer", "oauth"],
        contentCategories,
        correlationIdentityFields: ["session.id", "turn.id", "call.id", "parentEventId", "session.agent.id"],
        gaps: uploads ? gaps : [...gaps, uploadGap],
        limits: { maxContinuations: MAX_CONTINUATIONS, maxUploadBytes: MAX_UPLOAD_BYTES },
        managedPolicy: { disableable: true, scopes: ["user", "project"] },
        toolPaths,
        transports: ["http", "stdio"],
      },
      fetch,
      spawn: hostSpawn(host),
      maxContentBytes: MAX_UPLOAD_BYTES,
      environment,
      auth: auth({
        fetch,
        resolveEnvironmentVariable: (name: string) => readEnvironmentVariable(host, name),
        resolveHostname: (name: string) => resolveHostname(host, name),
      }),
    });
    await hooks.initialized;
    for (const issue of hooks.initializationDiagnostics ?? []) this.log(`initialization: ${describe(issue)}`, true);
    this.hooks = hooks;
    this.log(`delivering to ${registration.hooks.length} backend(s) from ${sources.map((s) => s.path).join(", ")}`, true);
  }

  /** The session's conversation (a subagent's with `agentId`). */
  messages(agentId?: string) {
    return this.#host?.messages(agentId) ?? Promise.resolve([]);
  }

  /** The client, once started; undefined when nothing subscribes to `type`. */
  async client(type: string): Promise<Hooks | undefined> {
    await this.#ready;
    const hooks = this.hooks;
    if (!hooks || !hooks.subscribes(type as never)) return undefined;
    return hooks;
  }

  async close(): Promise<void> {
    await this.#ready;
    const hooks = this.hooks;
    this.hooks = undefined;
    await hooks?.close();
  }

  /** The AHP session object for a loop (subagents carry `agent`). */
  session(loop: string = MAIN): SessionObject {
    const agent = loop === MAIN ? undefined : this.agents.get(loop);
    return {
      id: this.sessionId,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(loop === MAIN ? {} : { agent: { id: loop, ...(agent ? { type: agent.type } : {}) } }),
    };
  }

  /** The `turn` field for a loop's current turn, if it has one. */
  turn(loop: string = MAIN): { turn?: { id: string; synthesized?: true } } {
    const turn = this.turns.get(loop);
    if (!turn) return {};
    return { turn: { id: turn.id, ...(turn.synthesized ? { synthesized: true as const } : {}) } };
  }

  /** Session and turn for an event raised in `loop`. */
  scope(loop: string = MAIN): { session: SessionObject; turn?: { id: string; synthesized?: true } } {
    return { session: this.session(loop), ...this.turn(loop) };
  }

  log(text: string, debug = false): void {
    this.#host?.log(`AHP: ${text}`, debug ? { to: "debug" } : undefined);
  }

  /** Report delivery diagnostics and user-visible messages. */
  report(result: AnyResult): void {
    // The adapter reads no attachment back: release what the SDK kept.
    void result.content?.close().catch(() => {});
    for (const diagnostic of result.diagnostics) {
      this.log(`${diagnostic.backendId} ${diagnostic.phase}: ${diagnostic.code}${diagnostic.syntheticDenial ? " (denied by failure policy)" : ""}`, !diagnostic.syntheticDenial);
    }
    for (const text of messages(result)) this.log(text);
  }
}

/** Effects of one type from a boundary result. */
function residual(result: AnyResult): readonly Record<string, unknown>[] {
  return (result.effects ?? []) as unknown as readonly Record<string, unknown>[];
}

/** User-visible `message` effects. */
export function messages(result: AnyResult): string[] {
  return residual(result)
    .filter((effect) => effect.type === "message" && typeof effect.text === "string")
    .map((effect) => effect.text as string);
}

/** Model-visible `inject` effects, as the context strings Claude Code takes. */
export function injections(result: AnyResult): string[] {
  const state = result.state as { injections?: readonly { value?: readonly unknown[] }[] };
  const fromState = state.injections ?? [];
  const fromEffects = residual(result).filter((effect) => effect.type === "inject") as { value?: readonly unknown[] }[];
  const all = fromState.length ? fromState : fromEffects;
  return all.flatMap((effect) => texts(effect.value as unknown[] | undefined)).filter((text) => text !== "");
}

/** The accepted `flow` operation, if any: stop outranks continue. */
export function flow(result: AnyResult): { operation: "stop"; reason: string } | { operation: "continue"; instruction?: string } | undefined {
  const flows = residual(result).filter((effect) => effect.type === "flow");
  const stop = flows.find((effect) => effect.operation === "stop");
  if (stop) return { operation: "stop", reason: String(stop.reason ?? "Stopped by an AHP hook") };
  const state = result.state as { flow?: string };
  const go = flows.find((effect) => effect.operation === "continue");
  if (go || state.flow === "continue") {
    const instruction = flows
      .filter((effect) => effect.operation === "continue" && typeof effect.instruction === "string")
      .map((effect) => effect.instruction as string)
      .join("\n");
    return { operation: "continue", ...(instruction ? { instruction } : {}) };
  }
  if (state.flow === "stop") return { operation: "stop", reason: "Stopped by an AHP hook" };
  return undefined;
}

/** Whether the boundary refused the operation, and why. */
export function denial(result: AnyResult): string | undefined {
  const state = result.state as { permission?: string };
  if (!result.interrupted && state.permission !== "deny") return undefined;
  for (const response of result.acceptedResponses as unknown as readonly { response?: { result?: { effects?: { type?: string; reason?: string }[] } }; result?: { effects?: { type?: string; reason?: string }[] } }[]) {
    const effects = response.response?.result?.effects ?? response.result?.effects ?? [];
    const deny = effects.find((effect) => effect.type === "deny");
    if (deny?.reason) return deny.reason;
  }
  if (result.diagnostics.some((diagnostic) => diagnostic.syntheticDenial))
    return "An AHP hook was unavailable and its failure policy is fail-closed";
  return "Denied by an AHP hook";
}

/** The id the SDK gave the delivered event. */
export function eventId(result: AnyResult): string | undefined {
  const id = (result.event as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

export function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
