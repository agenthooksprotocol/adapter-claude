import { expect, test } from "claude-code/testing";
import { HOME, engine, registration, start } from "./harness.ts";

const FILE = `${HOME}/.claude/hooks.json`;
// A 1x1 PNG's first bytes are enough: nothing here decodes the image.
const PNG = btoa("\x89PNG\r\n\x1a\nbytes");

type Part = { kind: string; text?: string; body?: { ref: string }; gap?: { reason: string }; mediaType?: string };
const parts = (event: Record<string, unknown> | undefined) =>
  ((event?.items ?? []) as { parts: Part[] }[]).flatMap((item) => item.parts);

function read(on: Parameters<typeof engine>[0], $: { classic: { PostToolUse(e: never): Promise<unknown> } }) {
  on("tool.call", async (_$, e) => {
    await $.classic.PostToolUse({
      tool_name: "Read",
      tool_input: { file_path: "/a.png" },
      tool_response: { type: "image", file: { base64: PNG, type: "image/png", originalSize: 13 } },
      tool_use_id: e.tool_use_id,
    } as never);
    return { result: {} };
  });
}

test("a Read image uploads through curl and tool.after refers to it", async ($, on) => {
  const backend = engine(on, { files: { [FILE]: registration(["tool.after"], { mode: "observe", upload: true }) } });
  read(on, $ as never);
  await start($);
  await $.tool.call({ tool: "Read", file_path: "/a.png" });
  expect(backend.uploads.length).toBe(1);
  const upload = backend.uploads[0]!;
  expect(upload.base64).toBe(PNG);
  expect(upload.env.AHP_URL).toBe("https://hooks.example/ahp/content");
  const event = backend.events("tool.after")[0];
  const media = parts(event).find((part) => part.kind === "attachment");
  expect(media?.body?.ref).toBe("urn:test:1");
  expect(media?.mediaType).toBe("image/png");
  // The bytes never travel as text.
  expect(JSON.stringify(event)).not.toContain(PNG);
});

test("metadata selection starts no upload", async ($, on) => {
  const metadata = registration(["tool.after"], { mode: "observe", upload: true });
  (metadata.hooks[0]!.subscriptions[0]! as { content: unknown }).content = { default: "body", images: "metadata" };
  const backend = engine(on, { files: { [FILE]: metadata } });
  read(on, $ as never);
  await start($);
  await $.tool.call({ tool: "Read", file_path: "/a.png" });
  expect(backend.uploads.length).toBe(0);
  expect(parts(backend.events("tool.after")[0]).some((part) => part.kind === "attachment")).toBe(true);
});

test("without curl an attachment is a gap and the event still goes out", async ($, on) => {
  const backend = engine(on, { files: { [FILE]: registration(["tool.after"], { mode: "observe", upload: true }) }, uploadTools: false });
  read(on, $ as never);
  await start($);
  await $.tool.call({ tool: "Read", file_path: "/a.png" });
  expect(backend.uploads.length).toBe(0);
  const media = parts(backend.events("tool.after")[0]).find((part) => part.kind === "attachment");
  expect(media?.gap?.reason).toContain("curl");
});

test("each model request carries the conversation's media", async ($, on) => {
  const row = { role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] };
  const backend = engine(on, { files: { [FILE]: registration(["model.request.before"], { mode: "observe", upload: true }) }, messages: [row] });
  on("turn.step", async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: null } as never;
  });
  await start($);
  const step = { turnId: "t", index: 0, model: "m", messageCount: 1 };
  for await (const _ of $.turn.step(step as never)) void _;
  for await (const _ of $.turn.step({ ...step, index: 1 } as never)) void _;
  expect(backend.uploads.length).toBe(2);
  for (const event of backend.events("model.request.before"))
    expect(typeof parts(event).find((part) => part.kind === "attachment")?.body?.ref).toBe("string");
});

const discovered = { protocolVersion: "draft", hooks: [{ id: "org.example.discovered", transport: { type: "http", url: "https://hooks.example/ahp" } }] };
const advertised = (auth?: unknown) => ({ subscriptions: [{ mode: "observe", events: ["tool.before"], content: { default: "body" }, upload: { endpoint: "https://uploads.example/content", timeoutMs: 5000, maxBytes: 1048576, ...(auth ? { auth } : {}) } }] });

test("a discovered upload is admitted (AHP-REG-005)", async ($, on) => {
  const backend = engine(on, { files: { [FILE]: discovered }, configuration: advertised() });
  on("tool.call", () => ({ result: {} }));
  await start($);
  await $.tool.call({ tool: "Read", file_path: "/a.png" });
  expect(backend.events("tool.before").length).toBe(1);
});

test("a discovered upload naming a local secret skips the backend (AHP-REG-005)", async ($, on) => {
  const backend = engine(on, { files: { [FILE]: discovered }, configuration: advertised({ type: "bearer", tokenEnv: "AWS_SECRET_ACCESS_KEY" }) });
  on("tool.call", () => ({ result: {} }));
  await start($);
  await $.tool.call({ tool: "Read", file_path: "/a.png" });
  expect(backend.events("tool.before").length).toBe(0);
});

// `$.prompt.media` is the engine's own read and no event, so a test cannot answer
// it: as outside a managed install, the read is refused.
test("a pasted prompt image is a gap when its bytes cannot be read", async ($, on) => {
  const backend = engine(on, { files: { [FILE]: registration(["turn.start"], { mode: "observe", upload: true }) } });
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  await start($);
  await $.prompt.submit({ text: "look", wait: false, origin: { kind: "composer" }, attachments: [{ type: "image", mediaType: "image/png", id: "m1" }] } as never);
  const media = parts(backend.events("turn.start")[0]).find((part) => part.kind === "attachment");
  expect(typeof media?.gap?.reason).toBe("string");
  expect(media?.mediaType).toBe("image/png");
});
