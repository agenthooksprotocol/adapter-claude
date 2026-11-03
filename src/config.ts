// Registration discovery: `hooks.json` under `.agents/` and `.claude/`, in the
// user's home directory and in the session's working directory, merged into one
// AHP registration document.
import type { Host } from "./runtime/host.js";

export interface RegistrationSource {
  /** Absolute path of the file. */
  path: string;
  scope: "user" | "project";
}

export interface LoadedRegistration {
  /** The merged registration, or undefined when no file declares a backend. */
  registration?: { protocolVersion: "draft"; hooks: Record<string, unknown>[] };
  /** The files that contributed, lowest precedence first. */
  sources: RegistrationSource[];
  /** Files skipped, and backends replaced by a more specific file. */
  diagnostics: string[];
}

/** Lowest precedence first: a later file's backend replaces an earlier one with
 * the same `id`, so the project beats the home directory and `.claude` beats
 * `.agents` within each. */
export function registrationPaths(home: string | undefined, cwd: string): RegistrationSource[] {
  const paths: RegistrationSource[] = [];
  if (home) {
    paths.push({ path: join(home, ".agents/hooks.json"), scope: "user" });
    paths.push({ path: join(home, ".claude/hooks.json"), scope: "user" });
  }
  if (cwd !== home) {
    paths.push({ path: join(cwd, ".agents/hooks.json"), scope: "project" });
    paths.push({ path: join(cwd, ".claude/hooks.json"), scope: "project" });
  }
  return paths;
}

function join(directory: string, file: string): string {
  return directory.endsWith("/") ? directory + file : `${directory}/${file}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read and merge every registration file that exists. Structural validation
 * of the result is the SDK's: this only keeps files from poisoning each other. */
export async function loadRegistration(host: Host, cwd: string): Promise<LoadedRegistration> {
  const home = host.environment.HOME;
  // One explicit file replaces discovery (tests, CI, a pinned deployment).
  const pinned = host.environment.AHP_HOOKS_FILE;
  const diagnostics: string[] = [];
  const sources: RegistrationSource[] = [];
  const backends = new Map<string, { backend: Record<string, unknown>; path: string }>();
  const paths = pinned ? [{ path: pinned, scope: "user" as const }] : registrationPaths(home, cwd);
  for (const source of paths) {
    let text: string;
    try {
      if (!(await host.exists(source.path))) continue;
      text = await host.read(source.path);
    } catch (error) {
      diagnostics.push(`${source.path}: unreadable (${String(error)})`);
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      diagnostics.push(`${source.path}: not JSON; skipped`);
      continue;
    }
    if (!object(document) || document.protocolVersion !== "draft" || !Array.isArray(document.hooks)) {
      diagnostics.push(`${source.path}: not an AHP draft registration (protocolVersion "draft", hooks[]); skipped`);
      continue;
    }
    sources.push(source);
    for (const backend of document.hooks) {
      if (!object(backend) || typeof backend.id !== "string") {
        diagnostics.push(`${source.path}: a backend without an id; skipped`);
        continue;
      }
      const previous = backends.get(backend.id);
      if (previous) diagnostics.push(`${backend.id}: ${source.path} replaces ${previous.path}`);
      backends.set(backend.id, { backend, path: source.path });
    }
  }
  if (backends.size === 0) return { sources, diagnostics };
  return {
    registration: { protocolVersion: "draft", hooks: [...backends.values()].map(({ backend }) => backend) },
    sources,
    diagnostics,
  };
}
