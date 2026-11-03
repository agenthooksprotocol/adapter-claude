// The world beneath the adapter in a `claude plugin test`: an engine that
// answers the calls the adapter makes on `$`, a registration on its
// filesystem, and an AHP backend behind its host fetch.
import type { On } from "claude-code";
import { mock } from "claude-code/testing";

export const HOME = "/home/tester";
export const CWD = "/work/project";
export const BACKEND_URL = "https://hooks.example/ahp";

export type Effect = Record<string, unknown>;
export type Request = {
  id?: string;
  method: string;
  params: { event: Record<string, unknown> & { type: string }; capabilities?: Record<string, unknown> };
};

export interface Backend {
  /** Every JSON-RPC message the backend received, in order. */
  readonly received: Request[];
  /** What the adapter logged, transcript and debug alike. */
  readonly logs: string[];
  /** Each binary upload curl was started for. */
  readonly uploads: { env: Record<string, string>; base64: string }[];
  /** The events of a type the backend received. */
  events(type: string): Record<string, unknown>[];
}

export interface World {
  /** Registration files by absolute path. */
  files?: Record<string, unknown>;
  /** The backend's answer to each intercept; no effects when absent. */
  respond?: (request: Request) => Effect[] | undefined;
  /** What the backend answers hooks/configuration with. */
  configuration?: Record<string, unknown>;
  /** Whether sh, base64 and curl are on the machine (default true). */
  uploadTools?: boolean;
  /** What session.messages({ as: "api" }) answers. */
  messages?: unknown[];
  /** Fail every request at the transport, as an unreachable backend does. */
  unreachable?: boolean;
}

/** A registration of one HTTP backend subscribing to `events`. */
export function registration(events: string[], options: { mode?: "intercept" | "observe"; failurePolicy?: "fail-open" | "fail-closed"; id?: string; upload?: boolean } = {}) {
  const mode = options.mode ?? "intercept";
  return {
    protocolVersion: "draft",
    hooks: [{
      id: options.id ?? "org.example.backend",
      transport: { type: "http", url: BACKEND_URL },
      subscriptions: [{
        mode,
        events,
        content: { default: "body" },
        ...(options.upload ? { upload: { endpoint: `${BACKEND_URL}/content`, timeoutMs: 5000, maxBytes: 1048576 } } : {}),
        ...(mode === "intercept" ? { timeoutMs: 5000, failurePolicy: options.failurePolicy ?? "fail-closed" } : {}),
      }],
    }],
  };
}

export function engine(on: On, world: World): Backend {
  const received: Request[] = [];
  const logs: string[] = [];
  const uploads: { env: Record<string, string>; base64: string }[] = [];
  const files = world.files ?? {};
  mock.env(on, { HOME, PATH: "/usr/bin:/bin" });
  mock.clock(on);
  on("session.version", () => ({ value: { version: "2.1.314", base: "2.1.314", builtAt: "2026-11-01T00:00:00Z" } }));
  on("session.id", () => ({ value: "session-1" }));
  on("session.messages", () => ({ value: (world.messages ?? []) as never }));
  on("process.run", () => ({ value: { exitCode: world.uploadTools === false ? 1 : 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }));
  // curl, as the upload path drives it: base64 in, receipt and write-out back.
  on("process.spawn", async function* (_$, e) {
    const env = (e.env ?? {}) as Record<string, string>;
    uploads.push({ env, base64: e.input ?? "" });
    const headers = Object.values(env).filter((value) => value.startsWith("ahp-content-sha256:"));
    const sha256 = (headers[0] ?? "").split(": ")[1];
    const size = atob(e.input ?? "").length;
    const receipt = JSON.stringify({ ref: `urn:test:${uploads.length}`, size, sha256 });
    yield { stream: "stdout" as const, text: `${receipt}\n${env.AHP_MARK}201 application/json\n{}` };
    return { value: { code: 0, signal: null } };
  });
  on("fs.exists", (_$, e) => ({ value: Object.hasOwn(files, e.path) }));
  on("fs.read", (_$, e) => {
    if (!Object.hasOwn(files, e.path)) throw new Error(`ENOENT: ${e.path}`);
    return { value: JSON.stringify(files[e.path]) };
  });
  on("ui.log", (_$, e) => {
    logs.push((e as { text: string }).text);
    return { value: undefined };
  });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  // No settings hooks run beneath: each classic event answers with nothing.
  on("classic.SessionStart", () => ({}));
  on("classic.PostToolUse", () => ({}));
  on("http.fetch", (_$, e) => {
    if (world.unreachable) throw new Error("connect ECONNREFUSED");
    const request = JSON.parse(e.init?.body ?? "{}") as Request;
    received.push(request);
    if (request.method === "hooks/observe")
      return { value: { status: 202, ok: true, headers: {} as Record<string, string>, text: "" } };
    if (request.method === "hooks/configuration")
      return {
        value: {
          status: 200,
          ok: true,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "draft", configuration: world.configuration } }),
        },
      };
    const effects = world.respond?.(request) ?? [];
    return {
      value: {
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "draft", effects } }),
      },
    };
  });
  return {
    received,
    logs,
    uploads,
    events: (type) => received.filter((request) => request.params?.event?.type === type).map((request) => request.params.event),
  };
}

/** Start the session the way Claude Code does: the mod's start, then the
 * classic SessionStart. */
export async function start($: { session: { start(e: unknown): Promise<unknown> }; classic: { SessionStart(e: unknown): Promise<unknown> } }): Promise<void> {
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", cwd: CWD });
}
