import { expect, test } from "claude-code/testing";
import { CWD, HOME, engine, registration, start } from "./harness.ts";

const USER_FILE = `${HOME}/.claude/hooks.json`;

test("turn.start rewrites the prompt and adds context", async ($, on) => {
  const backend = engine(on, {
    files: { [USER_FILE]: registration(["turn.start"]) },
    respond: (request) => {
      const items = request.params.event.items as { id: string; role: string; parts: { id: string }[] }[];
      return [
        { type: "modify", target: "prompt", operation: "replace", value: [{ id: items[0]!.id, role: "user", parts: [{ id: items[0]!.parts[0]!.id, kind: "text", mediaType: "text/plain", selection: "body", text: "be careful" }] }] },
        { type: "inject", target: "context", operation: "append", deliverAt: "now", value: [{ id: "ctx", role: "user", parts: [{ id: "ctx#0", kind: "text", mediaType: "text/plain", selection: "body", text: "Policy: no deploys." }] }] },
      ];
    },
  });
  let submitted: { text?: string; context?: readonly string[] } = {};
  on("prompt.submit", (_$, e) => {
    submitted = e;
    return { text: e.text, ...(e.context ? { context: e.context } : {}) };
  });
  await start($);
  await $.prompt.submit({ text: "deploy it", wait: false, origin: { kind: "composer" } } as never);
  expect(submitted.text).toBe("be careful");
  expect(submitted.context).toEqual(["Policy: no deploys."]);
  const [event] = backend.events("turn.start");
  expect(event?.trigger).toBe("user");
});

test("turn.start's deny drops the prompt", async ($, on) => {
  engine(on, {
    files: { [USER_FILE]: registration(["turn.start"]) },
    respond: () => [{ type: "deny", reason: "outside working hours" }],
  });
  let reached = false;
  on("prompt.submit", (_$, e) => {
    reached = true;
    return { text: e.text };
  });
  await start($);
  const result = await $.prompt.submit({ text: "hello", wait: false, origin: { kind: "composer" } } as never);
  expect(reached).toBe(false);
  expect((result as { drop?: string }).drop).toBe("outside working hours");
});

test("turn events share the turn id minted at prompt.submit", async ($, on) => {
  const backend = engine(on, {
    files: { [USER_FILE]: registration(["turn.*", "tool.before"], { mode: "observe" }) },
  });
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("tool.call", () => ({ result: {} }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await start($);
  await $.prompt.submit({ text: "hi", wait: false, origin: { kind: "composer" } } as never);
  await $.turn.start({ text: "hi", turnId: "claude-turn-1" });
  await $.tool.call({ tool: "Read", file_path: `${CWD}/README.md` });
  await $.turn.complete({ answer: "done", durationMs: 10, isAborted: false, turnId: "claude-turn-1", reason: "answer" } as never);
  const start_ = backend.events("turn.start")[0] as { turn: { id: string } };
  const tool = backend.events("tool.before")[0] as { turn: { id: string } };
  const end = backend.events("turn.end")[0] as { turn: { id: string }; outcome: string };
  expect(tool.turn.id).toBe(start_.turn.id);
  expect(end.turn.id).toBe(start_.turn.id);
  expect(end.outcome).toBe("completed");
});

test("turn.finish.before continues the turn through the Stop hook", async ($, on) => {
  engine(on, {
    files: { [USER_FILE]: registration(["turn.finish.before"]) },
    respond: () => [{ type: "flow", operation: "continue", instruction: "Run the tests first." }],
  });
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("classic.Stop", () => ({}));
  await start($);
  await $.turn.start({ text: "", turnId: "t1" });
  const result = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: "Done." } as never);
  expect(result.block).toBe("Run the tests first.");
});
