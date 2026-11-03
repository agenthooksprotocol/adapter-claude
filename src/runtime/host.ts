// The engine as the adapter uses it. Claude Code reads a hooks module's source
// and admits `$` only as `$.noun.event(...)` at a call site inside a hook, so
// the one hook that starts the adapter spells each call there (lifecycle.ts)
// and hands the rest of the adapter these closures instead of `$`.
import type { HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult, ProcessSpawnRequest, SessionVersion, UiLogOptions } from "claude-code";

export type SpawnStream = AsyncIterable<{ stream: "stdout" | "stderr"; text: string }>;

export type ApiRow = { role: string; content: readonly Record<string, unknown>[] };

export interface Host {
  fetch(url: string, init: HttpInit): Promise<HttpResponse>;
  run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>;
  spawn(request: ProcessSpawnRequest): SpawnStream;
  after(ms: number, callback: () => void): { cancel(): void };
  log(text: string, options?: UiLogOptions): void;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /** The conversation as the next request is built from it, in API form. */
  messages(agentId?: string): Promise<readonly ApiRow[]>;
  version(): Promise<SessionVersion>;
  sessionId(): Promise<string>;
  /** The environment variables `$.env.get` read by literal name. */
  environment: Readonly<Record<string, string | undefined>>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One environment variable of Claude Code's process, by a run-time name
 * (a registration's `tokenEnv` or `valueEnv`): the literal reads first, then
 * `printenv`, as `$.env.get` takes only names spelled in the source. */
export async function readEnvironmentVariable(host: Host, name: string): Promise<string | undefined> {
  if (Object.hasOwn(host.environment, name)) return host.environment[name];
  if (!NAME.test(name)) return undefined;
  const { exitCode, stdout } = await host.run(["printenv", name], { timeoutMs: 5000 });
  if (exitCode !== 0) return undefined;
  return stdout.replace(/\n$/, "");
}

/** Resolve a host name to its addresses, for the SDK's OAuth destination
 * checks, with the platform's own resolver. */
export async function resolveHostname(host: Host, name: string): Promise<string[]> {
  const bare = name.replace(/^\[|\]$/g, "");
  if (/^[0-9.]+$/.test(bare) || bare.includes(":")) return [bare];
  if (!/^[A-Za-z0-9.-]+$/.test(bare)) throw new Error("Invalid host name");
  for (const argv of [["getent", "ahosts", bare], ["dscacheutil", "-q", "host", "-a", "name", bare]]) {
    try {
      const { exitCode, stdout } = await host.run(argv, { timeoutMs: 5000 });
      if (exitCode !== 0) continue;
      const addresses = new Set<string>();
      for (const line of stdout.split("\n")) {
        const match = /^(?:ipv6_address:\s*|ip_address:\s*)?([0-9a-fA-F:.]+)(?:\s|$)/.exec(line.trim());
        if (match?.[1] && (match[1].includes(".") || match[1].includes(":"))) addresses.add(match[1]);
      }
      if (addresses.size) return [...addresses];
    } catch {
      // Try the next resolver.
    }
  }
  throw new Error(`Could not resolve ${bare}`);
}
