// What this adapter can enforce through Claude Code's mod API, and what it
// cannot. Everything here is optional for an AHP runtime: an event or effect
// left out is simply not advertised, and the gaps say why.
import { capabilityCount, type HostCapabilities } from "agenthooksprotocol/client";

/** Stop-hook continuations Claude Code will run in a row before it gives up. */
export const MAX_CONTINUATIONS = 8;

const injectNow = { context: { append: true, deliverAt: ["now"] } } as const;

export const capabilities = {
  // Lifecycle. classic SessionStart takes additionalContext.
  sessionStart: { observe: true, intercept: { inject: injectNow, message: true } },
  sessionEnd: { observe: true },

  // Turns. prompt.submit rewrites, drops and annotates the prompt.
  turnStart: {
    observe: true,
    intercept: { deny: true, modifyPrompt: "replace", inject: injectNow, message: true },
  },
  // classic Stop / SubagentStop: block = continue, preventContinuation = stop.
  turnFinishBefore: {
    observe: true,
    intercept: {
      flow: {
        operations: ["continue", "stop"],
        remainingContinuations: capabilityCount(MAX_CONTINUATIONS),
        continuationCount: capabilityCount(0),
        maxContinuations: capabilityCount(MAX_CONTINUATIONS),
      },
      message: true,
    },
  },
  turnEnd: { observe: true },

  // Model requests are observed per step; their messages are pinned.
  modelRequestBefore: { observe: true },
  modelResponseAfter: { observe: true },
  modelError: { observe: true },
  modelSwitchBefore: { observe: true, intercept: { deny: true, message: true } },
  modelSwitchAfter: { observe: true },

  // Tools. tool.call wraps the run: deny, rewrite, answer in its place,
  // and rewrite what the model reads; tool.check carries allow and ask.
  toolBefore: {
    observe: true,
    intercept: {
      deny: true,
      allow: true,
      ask: true,
      modifyInput: "replace-and-merge",
      returnResult: true,
      inject: injectNow,
      message: true,
    },
  },
  toolAfter: {
    observe: true,
    intercept: { modifyOutput: "replace-and-merge", inject: injectNow, message: true },
  },
  toolPermissionRequest: {
    observe: true,
    intercept: { allow: true, deny: true, modifyInput: "replace-and-merge", flow: { operations: ["stop"] }, message: true },
  },
  toolPermissionResolved: { observe: true },
  toolBatchAfter: {
    observe: true,
    intercept: { inject: injectNow, flow: { operations: ["stop"] }, message: true },
  },

  // Compaction. session.compact: skip, instructions, a summary of its own.
  contextCompactBefore: {
    observe: true,
    intercept: { deny: true, modifyInstructions: "replace-and-merge", returnResult: true, message: true },
  },
  contextCompactAfter: { observe: true },

  // Everything else is a classic hook with a block at most.
  configChangeBefore: { observe: true, intercept: { deny: true, message: true } },
  configChangeAfter: { observe: true },
  taskChangeBefore: { observe: true, intercept: { deny: true, message: true } },
  userAttention: { observe: true },
  userElicitationRequest: { observe: true, intercept: { deny: true, message: true } },
  userElicitationResult: { observe: true },
  userMessageInbound: { observe: true, intercept: { deny: true, modifyPrompt: "replace", message: true } },
  userMessageOutbound: { observe: true, intercept: { deny: true, modifyContent: "replace", message: true } },
  workspaceChangeAfter: { observe: true },
  fileChanged: { observe: true },
  hookFailure: { observe: true },
} satisfies HostCapabilities;

/** Coverage Claude Code's mod API does not reach, as manifest gaps. */
export const gaps = [
  { path: "model.request.before.items", reason: "turn.step pins the request's messages: they are observed from the transcript, never rewritten (no modify(request), no inject now)" },
  { path: "model.request.before.params", reason: "per-request model and effort changes have no AHP target" },
  { path: "model.response.after.effects", reason: "a streamed response is observed after the step; it is not rewritten" },
  { path: "tool.after.flow.continue", reason: "Claude Code has no continuation after a single tool result" },
  { path: "tool.progress", reason: "Claude Code exposes no tool-progress hook" },
  { path: "tool.before.tool.mcp", reason: "the mod API names an MCP tool but not its server's descriptor" },
  { path: "workspace.change.before", reason: "working-directory and root changes are observe-only in Claude Code" },
  { path: "user.elicitation.request.return", reason: "Claude Code's Elicitation hook can only block, not answer" },
  { path: "user.elicitation.result.modify", reason: "Claude Code's ElicitationResult hook cannot rewrite content" },
  { path: "turn.finish.before.modify", reason: "the final response is recorded before Stop hooks run" },
  { path: "session.start.items", reason: "startup instructions (CLAUDE.md, memory) reach the model in the first request, after session.start; they are reported on model.request.before" },
  { path: "turn.start.items.attachments", reason: "pasted prompt media is readable only by a managed-settings install of the mod; elsewhere it is a gap at turn.start and arrives on the next model.request.before" },
  { path: "transport.stdio.persistent", reason: "a mod writes a child's standard input once; stdio backends must use lifecycle per_event" },
  { path: "transport.stdio.env", reason: "stdio children inherit Claude Code's environment beneath the registration's env" },
  { path: "transport.http.redirect", reason: "Claude Code's host fetch decides redirects; the adapter cannot refuse them" },
  { path: "tool.after.server", reason: "API-run (server) tools raise no tool events; they are reported in model.response.after's extensions" },
];

/** Declared when this machine lacks what an upload runs on. */
export const uploadGap = { path: "content.upload", reason: "content uploads run through sh, base64 and curl, which this machine lacks; attachments carry a gap" };

/** What one upload may hold: its base64 crosses into a child's standard input. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export const toolPaths = ["native", "mcp"];

export const contentCategories = ["text", "reasoning", "instructions", "skill", "attachment", "summary", "system"];
