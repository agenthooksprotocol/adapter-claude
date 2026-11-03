import { expect, test } from "claude-code/testing";
import { CWD, HOME, engine, registration, start } from "./harness.ts";

test("the project's .claude registration replaces the user's backend of the same id", async ($, on) => {
  const user = registration(["tool.before"], { mode: "observe" });
  const project = registration(["tool.after"], { mode: "observe" });
  const backend = engine(on, {
    files: {
      [`${HOME}/.agents/hooks.json`]: user,
      [`${CWD}/.claude/hooks.json`]: project,
    },
  });
  on("tool.call", () => ({ result: {} }));
  await start($);
  await $.tool.call({ tool: "Bash", command: "ls" });
  expect(backend.events("tool.before").length).toBe(0);
  expect(backend.events("tool.after").length).toBe(1);
});

test("backends with distinct ids from every file all receive events", async ($, on) => {
  const backend = engine(on, {
    files: {
      [`${HOME}/.claude/hooks.json`]: registration(["tool.before"], { mode: "observe", id: "org.example.user" }),
      [`${CWD}/.agents/hooks.json`]: registration(["tool.before"], { mode: "observe", id: "org.example.project" }),
    },
  });
  on("tool.call", () => ({ result: {} }));
  await start($);
  await $.tool.call({ tool: "Bash", command: "ls" });
  expect(backend.events("tool.before").length).toBe(2);
});

test("a file that is not an AHP registration is skipped", async ($, on) => {
  const backend = engine(on, {
    files: {
      [`${HOME}/.claude/hooks.json`]: { hooks: { PreToolUse: [] } },
      [`${CWD}/.claude/hooks.json`]: registration(["tool.before"], { mode: "observe" }),
    },
  });
  on("tool.call", () => ({ result: {} }));
  await start($);
  await $.tool.call({ tool: "Bash", command: "ls" });
  expect(backend.events("tool.before").length).toBe(1);
});
