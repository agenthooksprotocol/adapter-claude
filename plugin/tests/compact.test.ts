import { expect, test } from "claude-code/testing";
import { HOME, engine, registration, start } from "./harness.ts";

const USER_FILE = `${HOME}/.claude/hooks.json`;
const summary = (text: string) => [{ id: "s", kind: "text", mediaType: "text/plain", selection: "body", text }];
const compact = { trigger: "manual", messages: [{ role: "user", text: "hello", handle: "m1" }] } as never;

test("a backend's summary reaches the model as its text", async ($, on) => {
  engine(on, {
    files: { [USER_FILE]: registration(["context.compact.before"]) },
    respond: () => [{ type: "return", value: summary("the supplied summary") }],
  });
  let ran = false;
  on("session.compact", () => {
    ran = true;
    return { messages: [] };
  });
  await start($);
  const result = await $.session.compact(compact);
  expect(ran).toBe(false);
  expect(result.messages?.[0]?.text).toBe("the supplied summary");
});

test("every part of a backend's summary is kept", async ($, on) => {
  engine(on, {
    files: { [USER_FILE]: registration(["context.compact.before"]) },
    respond: () => [{ type: "return", value: [...summary("first"), { ...summary("second")[0], id: "t" }] }],
  });
  on("session.compact", () => ({ messages: [] }));
  await start($);
  const result = await $.session.compact(compact);
  expect(result.messages?.[0]?.text).toBe("first\nsecond");
});
