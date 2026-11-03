import { expect, test } from "claude-code/testing";
import { CWD, HOME, engine, registration, start } from "./harness.ts";

const USER_FILE = `${HOME}/.claude/hooks.json`;

test("tool.before carries the call and a deny refuses it", async ($, on) => {
  const backend = engine(on, {
    files: { [USER_FILE]: registration(["tool.before"]) },
    respond: () => [{ type: "deny", reason: "no shell today" }],
  });
  let ran = false;
  on("tool.call", () => {
    ran = true;
    return { result: {} };
  });
  await start($);
  const result = await $.tool.call({ tool: "Bash", command: "ls -la" });
  expect(result.deny).toBe("no shell today");
  expect(ran).toBe(false);
  const [event] = backend.events("tool.before");
  expect(event?.tool).toEqual({ name: "Bash", origin: "native", input: { command: "ls -la" } });
  expect((event?.session as { id: string }).id).toBe("session-1");
  expect(event?.harness).toEqual({ name: "claude-code", version: "2.1.314" });
});

test("tool.before rewrites the input the tool runs with", async ($, on) => {
  engine(on, {
    files: { [USER_FILE]: registration(["tool.before"]) },
    respond: () => [{ type: "modify", target: "input", operation: "merge", value: { command: "ls" } }],
  });
  let command: unknown;
  on("tool.call", (_$, e) => {
    command = (e as { command?: unknown }).command;
    return { result: {} };
  });
  await start($);
  await $.tool.call({ tool: "Bash", command: "rm -rf /" });
  expect(command).toBe("ls");
});

test("tool.before supplies a result in the tool's place", async ($, on) => {
  engine(on, {
    files: { [USER_FILE]: registration(["tool.before"]) },
    respond: () => [{ type: "return", value: "cached listing" }],
  });
  let ran = false;
  on("tool.call", () => {
    ran = true;
    return { result: {} };
  });
  await start($);
  const result = await $.tool.call({ tool: "Bash", command: "ls" });
  expect(ran).toBe(false);
  expect(result.result).toBe("cached listing");
});

test("tool.after reports the result and replaces what the model reads", async ($, on) => {
  const backend = engine(on, {
    files: { [`${CWD}/.agents/hooks.json`]: registration(["tool.after"]) },
    respond: (request) => [{
      type: "modify",
      target: "output",
      operation: "replace",
      value: [{ id: `${(request.params.event.call as { id: string }).id}:result`, role: "tool", parts: [{ id: "redacted", kind: "text", mediaType: "text/plain", selection: "body", text: "[redacted]" }] }],
    }],
  });
  let classic: Record<string, unknown> | undefined;
  on("tool.call", async (_$, e) => {
    classic = await $.classic.PostToolUse({
      tool_name: "Bash",
      tool_input: { command: "cat .env" },
      tool_response: "SECRET=1",
      tool_use_id: e.tool_use_id,
    } as never);
    return { result: {} };
  });
  await start($);
  await $.tool.call({ tool: "Bash", command: "cat .env" });
  const [event] = backend.events("tool.after");
  expect(event?.outcome).toBe("ok");
  expect(JSON.stringify(event?.items)).toContain("SECRET=1");
  expect(classic?.updatedToolOutput).toBe("[redacted]");
});

test("an unreachable fail-closed backend refuses the call", async ($, on) => {
  engine(on, { files: { [USER_FILE]: registration(["tool.before"]) }, unreachable: true });
  on("tool.call", () => ({ result: {} }));
  await start($);
  const result = await $.tool.call({ tool: "Bash", command: "ls" });
  expect(typeof result.deny).toBe("string");
});

test("an unreachable fail-open backend lets the call run", async ($, on) => {
  engine(on, { files: { [USER_FILE]: registration(["tool.before"], { failurePolicy: "fail-open" }) }, unreachable: true });
  let ran = false;
  on("tool.call", () => {
    ran = true;
    return { result: {} };
  });
  await start($);
  await $.tool.call({ tool: "Bash", command: "ls" });
  expect(ran).toBe(true);
});

test("with no registration every call passes straight through", async ($, on) => {
  const backend = engine(on, {});
  let ran = false;
  on("tool.call", () => {
    ran = true;
    return { result: {} };
  });
  await start($);
  await $.tool.call({ tool: "Bash", command: "ls" });
  expect(ran).toBe(true);
  expect(backend.received.length).toBe(0);
});
