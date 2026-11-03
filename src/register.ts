// Agent Hooks Protocol adapter for Claude Code: a mod whose hooks deliver
// Claude Code's events to the AHP backends `hooks.json` registers.
import type { On } from "claude-code";
import { Adapter } from "./adapter.js";
import { installLifecycle } from "./events/lifecycle.js";
import { installTools } from "./events/tools.js";
import { installTurns } from "./events/turns.js";
import { installWebRuntime } from "./runtime/web.js";

installWebRuntime();

export function register(on: On): void {
  const adapter = new Adapter();
  installLifecycle(adapter, on);
  installTurns(adapter, on);
  installTools(adapter, on);
}
