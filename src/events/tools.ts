// Tools: tool.before / tool.after around `tool.call`, allow and ask through
// `tool.check`, tool.permission.request at the classic PermissionRequest,
// tool.permission.resolved once a verdict stands, and tool.batch.after.
import type { On } from "claude-code";
import { Permission, state } from "agenthooksprotocol/client";
import { type Adapter, type CallState, MAIN, denial, eventId, flow, injections } from "../adapter.js";
import { asText, json, message, textPart, texts, type Message } from "../content.js";
import { extractMedia, toolResult } from "../media.js";

const PINNED = new Set(["tool", "tool_use_id", "agentId", "requestMeta"]);

function split(e: Record<string, unknown>): { input: Record<string, unknown>; pinned: Record<string, unknown> } {
  const input: Record<string, unknown> = {};
  const pinned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e)) (PINNED.has(key) ? pinned : input)[key] = value;
  return { input, pinned };
}

function descriptor(name: string) {
  const mcp = name.startsWith("mcp__");
  return { name, origin: mcp ? "mcp" : "native", path: mcp ? "mcp" : "native" } as const;
}

function sameJson(a: unknown, b: unknown): boolean {
  return asText(a) === asText(b);
}

export function installTools(adapter: Adapter, on: On): void {
  on("tool.call", async ($, e, next) => {
    const event = e as unknown as Record<string, unknown>;
    const callId = String(event.tool_use_id);
    const name = String(event.tool);
    const loop = typeof event.agentId === "string" ? event.agentId : MAIN;
    const { input, pinned } = split(event);
    const call: CallState = { name, input, loop };
    adapter.calls.set(callId, call);
    const base = { callId, ...descriptor(name), ...adapter.scope(loop) };
    const context: string[] = [];

    const before = await adapter.client("tool.before");
    let effective = e;
    if (before) {
      const result = await before.toolBefore(
        { ...base, input },
        { initialState: state.initial(Permission.None), signal: next.signal },
      );
      adapter.report(result);
      const id = eventId(result);
      if (id) call.beforeEventId = id;
      const refused = denial(result);
      if (refused !== undefined) {
        await after(adapter, call, callId, base, input, {
          outcome: "denied",
          execution: { status: "skipped", reason: "policy" },
          items: [],
        });
        return { deny: refused };
      }
      context.push(...injections(result));
      const permission = (result.state as { permission?: string }).permission;
      if (permission === Permission.Allow || permission === Permission.Ask) call.decision = permission as "allow" | "ask";
      const candidate = (result.state as { candidate?: { value: unknown } | null }).candidate;
      if (candidate) {
        // A supplied result: the tool does not run.
        const text = asText(candidate.value);
        await after(adapter, call, callId, base, input, {
          outcome: "ok",
          execution: { status: "skipped", reason: "supplied_result" },
          items: [message(`${callId}:result`, "tool", text)],
        });
        return { result: candidate.value as never, ...(context.length ? { context } : {}) };
      }
      const rewritten = (result.event as { tool?: { input?: unknown } }).tool?.input;
      if (rewritten && typeof rewritten === "object" && !sameJson(rewritten, input)) {
        call.input = rewritten as Record<string, unknown>;
        effective = { ...pinned, ...(rewritten as Record<string, unknown>) } as typeof e;
      }
    }

    const ran = await next(effective);

    if (call.decision === "ask" || call.checked === "ask") {
      // A person answered the prompt: the call ran or it was refused.
      await resolved(adapter, call, callId, ran.deny === undefined ? "allow" : "deny", "user");
    }
    if (!call.afterSent) {
      // No PostToolUse ran (a refusal, an interruption, a hook's own answer).
      const outcome = ran.deny !== undefined ? "denied" : ran.isError ? "error" : "ok";
      await after(adapter, call, callId, base, call.input, {
        outcome,
        execution: outcome === "denied" ? { status: "skipped", reason: "policy" } : { status: "executed" },
        items: outcome === "denied" ? [] : [ran.text !== undefined ? message(`${callId}:result`, "tool", ran.text) : toolResult(`${callId}:result`, ran.result, adapter.media)],
        ...(outcome === "error" ? { error: { class: "ToolError", message: ran.text || "The tool reported an error" } } : {}),
      });
    }
    adapter.calls.delete(callId);
    if (ran.deny !== undefined || !context.length) return ran;
    return { ...ran, context: [...(ran.context ?? []), ...context] };
  }).catch(($, e, next) =>
    next.called || !adapter.failsClosed("tool.before")
      ? next(e)
      : { deny: "The AHP adapter failed and a tool.before subscription fails closed" });

  // tool.after where Claude Code itself lets a hook replace what the model reads.
  on("classic.PostToolUse", async ($, e, next) => {
    const call = adapter.calls.get(e.tool_use_id);
    const ran = await next(e);
    if (!call) return ran;
    const callId = e.tool_use_id;
    const base = { callId, ...descriptor(call.name), ...adapter.scope(call.loop) };
    const { value, parts } = extractMedia(e.tool_response, `${callId}:result`, adapter.media);
    const original = asText(value);
    const items: Message[] = [message(`${callId}:result`, "tool", original)];
    items[0]!.parts.push(...parts);
    if (call.skillText) items[0]!.parts.push(textPart(`${callId}:result#skill`, call.skillText, "skill"));
    const result = await after(adapter, call, callId, base, call.input, {
      outcome: "ok",
      execution: { status: "executed" },
      items,
    });
    if (!result) return ran;
    const context = injections(result);
    const output = texts((result.event as { items?: unknown[] }).items).join("\n");
    const changed = output !== [original, call.skillText].filter(Boolean).join("\n");
    const isMcp = call.name.startsWith("mcp__");
    return {
      ...ran,
      ...(context.length ? { additionalContext: [...(ran.additionalContext ?? []), ...context] } : {}),
      ...(changed ? (isMcp ? { updatedMCPToolOutput: output } : { updatedToolOutput: output }) : {}),
    };
  });

  on("classic.PostToolUseFailure", async ($, e, next) => {
    const call = adapter.calls.get(e.tool_use_id);
    const ran = await next(e);
    if (!call) return ran;
    const callId = e.tool_use_id;
    const base = { callId, ...descriptor(call.name), ...adapter.scope(call.loop) };
    const error = String((e as { error?: unknown }).error ?? "The tool failed");
    const result = await after(adapter, call, callId, base, call.input, {
      outcome: (e as { is_interrupt?: boolean }).is_interrupt ? "cancelled" : "error",
      execution: (e as { is_interrupt?: boolean }).is_interrupt ? { status: "skipped", reason: "cancelled" } : { status: "executed" },
      items: [],
      ...((e as { is_interrupt?: boolean }).is_interrupt ? {} : { error: { class: "ToolError", message: error } }),
    });
    if (!result) return ran;
    const context = injections(result);
    return context.length ? { ...ran, additionalContext: [...(ran.additionalContext ?? []), ...context] } : ran;
  });

  // allow and ask from tool.before land on the permission decision.
  on("tool.check", async ($, e, next) => {
    const call = e.tool_use_id ? adapter.calls.get(e.tool_use_id) : undefined;
    const verdict = await next(e);
    if (!call) return verdict;
    let decision = verdict.decision;
    let decidedBy: "policy" | "hook" | "auto" = verdict.rule ? "policy" : "auto";
    // A hook's allow skips the ordinary prompt only; its ask forces one. A
    // rule's deny stands either way.
    if (call.decision === "allow" && decision === "ask") {
      decision = "allow";
      decidedBy = "hook";
    } else if (call.decision === "ask" && decision === "allow") {
      decision = "ask";
      decidedBy = "hook";
    }
    call.checked = decision;
    if (decision !== "ask") await resolved(adapter, call, e.tool_use_id!, decision, decidedBy);
    if (decision === verdict.decision) return verdict;
    return { ...verdict, decision, reason: decision === "allow" ? "Allowed by an AHP hook" : "An AHP hook asks for approval" };
  }).catch(($, e, next) =>
    next.called || !adapter.failsClosed("tool.before") ? next(e) : { decision: "deny" as const, reason: "The AHP adapter failed and a tool.before subscription fails closed" });

  on("classic.PermissionRequest", async ($, e, next) => {
    const hooks = await adapter.client("tool.permission.request");
    if (!hooks) return next(e);
    // The classic event names no call id: find the call by tool and input.
    const entry = [...adapter.calls.entries()].find(([, call]) =>
      call.name === e.tool_name && sameJson(call.input, e.tool_input) && call.checked === "ask");
    const callId = entry?.[0] ?? `permission:${crypto.randomUUID()}`;
    const loop = entry?.[1].loop ?? (e.agent_id ?? MAIN);
    const result = await hooks.toolPermissionRequest({
      callId,
      ...(entry ? {} : { callSynthesized: true }),
      ...descriptor(e.tool_name),
      ...adapter.scope(loop),
      input: (e.tool_input ?? {}) as Record<string, unknown>,
      suggestions: (e.permission_suggestions ?? []) as never,
      sandboxBypass: false,
      ...(entry?.[1].beforeEventId ? { parentEventId: entry[1].beforeEventId } : {}),
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    const stop = flow(result);
    const refused = denial(result);
    if (refused !== undefined || stop?.operation === "stop")
      return { decision: { behavior: "deny", message: refused ?? (stop as { reason: string }).reason, ...(stop?.operation === "stop" ? { interrupt: true as const } : {}) } };
    const permission = (result.state as { permission?: string }).permission;
    const rewritten = (result.event as { tool?: { input?: unknown } }).tool?.input;
    if (permission === Permission.Allow) {
      if (entry) entry[1].decision = "allow";
      return {
        decision: {
          behavior: "allow",
          ...(rewritten && !sameJson(rewritten, e.tool_input) ? { updatedInput: rewritten as Record<string, unknown> } : {}),
        },
      };
    }
    return next(e);
  }).catch(($, e, next) =>
    next.called || !adapter.failsClosed("tool.permission.request") ? next(e) : { decision: { behavior: "deny" as const, message: "The AHP adapter failed and a tool.permission.request subscription fails closed" } });

  on("classic.PostToolBatch", async ($, e, next) => {
    const hooks = await adapter.client("tool.batch.after");
    const ran = await next(e);
    if (!hooks) return ran;
    const loop = e.agent_id ?? MAIN;
    const calls = e.tool_calls.map((entry) => ({
      call: { id: entry.tool_use_id },
      tool: { name: entry.tool_name, origin: descriptor(entry.tool_name).origin, input: json(entry.tool_input ?? {}) },
      path: descriptor(entry.tool_name).path,
      outcome: "ok" as const,
      execution: { status: "executed" as const },
    }));
    const result = await hooks.toolBatchAfter({
      batch: { id: `batch:${e.tool_calls.map((entry) => entry.tool_use_id).join(",")}`, synthesized: true },
      calls,
      ...adapter.scope(loop),
    });
    adapter.report(result);
    const context = injections(result);
    const stop = flow(result);
    return {
      ...ran,
      ...(context.length ? { additionalContext: [...(ran.additionalContext ?? []), ...context] } : {}),
      ...(stop?.operation === "stop" ? { preventContinuation: true as const, stopReason: stop.reason } : {}),
    };
  });

  // Skill content reaches hooks: the Skill tool's own result names only the
  // skill, so its rendered text rides on tool.after.
  on("skill.prompt", async ($, e, next) => {
    const ran = await next(e);
    for (const call of adapter.calls.values())
      if (call.name === "Skill" && !call.afterSent && call.input.skill === e.skill) call.skillText = ran.text;
    return ran;
  });

  // Subagents: their loop events carry `session.agent` and hang off the
  // Agent call that started them.
  on("agent.spawn", async ($, e, next) => {
    const ran = await next(e);
    if (ran.agentId) {
      adapter.agents.set(ran.agentId, {
        type: e.subagentType,
        ...(adapter.calls.get(e.tool_use_id)?.beforeEventId ? { parentEventId: adapter.calls.get(e.tool_use_id)!.beforeEventId! } : {}),
      });
    }
    return ran;
  });
}

type Base = { callId: string; name: string; origin: "native" | "mcp"; path: "native" | "mcp" } & ReturnType<Adapter["scope"]>;
type AfterFields = Omit<Parameters<NonNullable<Adapter["hooks"]>["toolAfter"]>[0], keyof Base | "input">;

async function after(
  adapter: Adapter,
  call: CallState,
  callId: string,
  base: Base,
  input: Record<string, unknown>,
  fields: AfterFields,
) {
  call.afterSent = true;
  const hooks = await adapter.client("tool.after");
  if (!hooks) return undefined;
  const result = await hooks.toolAfter(
    { ...base, input, ...(call.beforeEventId ? { parentEventId: call.beforeEventId } : {}), ...fields },
    { initialState: state.initial(Permission.None) },
  );
  adapter.report(result);
  return result;
}

async function resolved(
  adapter: Adapter,
  call: CallState,
  callId: string,
  decision: "allow" | "deny",
  decidedBy: string,
): Promise<void> {
  const hooks = await adapter.client("tool.permission.resolved");
  if (!hooks) return;
  const result = await hooks.toolPermissionResolved({
    callId,
    ...descriptor(call.name),
    ...adapter.scope(call.loop),
    input: call.input,
    decision,
    decidedBy,
    ...(call.beforeEventId ? { parentEventId: call.beforeEventId } : {}),
  });
  adapter.report(result);
}
