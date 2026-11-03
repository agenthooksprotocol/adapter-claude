// Turns: turn.start at prompt.submit (where the prompt can still be refused,
// rewritten and annotated) or at Claude Code's own turn.start for turns no
// prompt begins; turn.finish.before at the classic Stop / SubagentStop;
// turn.end at turn.complete; peer deliveries as user.message.*; and the
// model.* boundaries each `turn.step` makes.
import type { On, PromptOrigin } from "claude-code";
import { Permission, state } from "agenthooksprotocol/client";
import { type Adapter, type LoopTurn, MAIN, denial, flow, injections, model } from "../adapter.js";
import { asText, json, message, textPart, texts, type Message } from "../content.js";
import { apiMessage, attachment } from "../media.js";

const OBSERVE_ONLY = { effects: [] };

/** Claude Code's prompt origins, folded onto AHP's turn triggers. */
function trigger(origin: PromptOrigin | undefined): "user" | "continuation" | "hook" | "external" {
  switch (origin?.kind) {
    case undefined:
    case "composer":
    case "bridge":
    case "sdk":
      return "user";
    case "auto-continuation":
      return "continuation";
    case "plugin":
      return "hook";
    default:
      return "external";
  }
}

const OUTCOME = { answer: "completed", aborted: "cancelled", refusal: "failed", error: "failed" } as const;

export function installTurns(adapter: Adapter, on: On): void {
  on("prompt.submit", async ($, e, next) => {
    // Delivered into a running turn: an inbound message, not a turn.
    if (e.turnId !== undefined) return inbound(adapter, e, next);
    const hooks = await adapter.client("turn.start");
    if (!hooks) return next(e);
    const id = crypto.randomUUID();
    const turn: LoopTurn = { id, synthesized: true, continuationCount: 0 };
    const native = { origin: e.origin, ...(e.isMeta ? { isMeta: true } : {}) };
    const prompt: Message = message(`${id}:prompt`, "user", e.text, { synthesized: true, ...(e.command ? { category: "command" } : {}) });
    for (const [index, item] of (e.attachments ?? []).entries()) {
      const partId = `${id}:prompt:media:${index}`;
      const mediaType = item.mediaType ?? "application/octet-stream";
      // Readable only here, while the submission is in flight, and only by a
      // managed-settings install: elsewhere the media is a gap until the next
      // model request reports the row that holds it.
      let base64 = "";
      let refused: string | undefined = item.id ? undefined : "Claude Code exposes no handle for this prompt attachment";
      let offset: number | undefined;
      while (item.id && refused === undefined) {
        const slice = await $.prompt.media({ id: item.id, ...(offset === undefined ? {} : { offset }) }).catch((error: unknown) => ({ deny: String(error) }));
        if ("deny" in slice && slice.deny !== undefined) refused = String(slice.deny);
        else if ("unreadable" in slice && slice.unreadable !== undefined) refused = String(slice.unreadable);
        else {
          base64 += (slice as { base64: string }).base64;
          offset = (slice as { next?: number }).next;
          if (offset === undefined) break;
        }
      }
      prompt.parts.push(attachment(partId, mediaType, base64, adapter.media, refused));
    }
    const result = await hooks.turnStart(
      {
        turn: { id, synthesized: true },
        session: adapter.session(),
        trigger: trigger(e.origin),
        items: [prompt],
        ...(e.command ? { expandedFrom: `/${e.command.name}` } : {}),
        extensions: { "com.anthropic.claude-code": native },
      },
      {
        initialState: state.initial(Permission.None),
        signal: next.signal,
        // A command's line and a hidden prompt take no rewrite.
        ...(e.command || e.isMeta ? { capabilities: { effects: ["deny", "inject", "message"], inject: { context: { append: true, deliverAt: ["now"] } } } } : {}),
      },
    );
    adapter.report(result);
    const refused = denial(result);
    if (refused !== undefined) return { drop: refused };
    adapter.pendingTurn = turn;
    const context = injections(result);
    const text = texts((result.event as { items?: unknown[] }).items).join("\n");
    return next({
      ...e,
      ...(text !== e.text && !e.command && !e.isMeta ? { text } : {}),
      ...(context.length ? { context: [...(e.context ?? []), ...context] } : {}),
    });
  }).catch(($, e, next) =>
    next.called || !adapter.failsClosed("turn.start")
      ? next(e)
      : { drop: "The AHP adapter failed and a turn.start subscription fails closed" });

  on("turn.start", async ($, e, next) => {
    const loop = e.agentId ?? MAIN;
    const pending = loop === MAIN ? adapter.pendingTurn : undefined;
    if (pending) {
      adapter.pendingTurn = undefined;
      adapter.turns.set(loop, { ...pending, claudeTurnId: e.turnId });
      return next(e);
    }
    // A turn no prompt began: a continuation, a subagent's run, a wake.
    const parentEventId = loop === MAIN ? undefined : adapter.agents.get(loop)?.parentEventId;
    const turn: LoopTurn = { id: e.turnId, claudeTurnId: e.turnId, continuationCount: 0, ...(parentEventId ? { parentEventId } : {}) };
    adapter.turns.set(loop, turn);
    const hooks = await adapter.client("turn.start");
    if (hooks) {
      const result = await hooks.turnStart(
        {
          turn: { id: turn.id },
          session: adapter.session(loop),
          trigger: loop === MAIN ? "continuation" : "external",
          items: e.text ? [message(`${turn.id}:prompt`, "user", e.text, { synthesized: true })] : [],
          ...(parentEventId ? { parentEventId } : {}),
        },
        { capabilities: OBSERVE_ONLY as never },
      );
      adapter.report(result);
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const ran = await next(e);
    const loop = e.agentId ?? MAIN;
    const turn = adapter.turns.get(loop);
    const hooks = await adapter.client("turn.end");
    if (hooks && turn) {
      const result = await hooks.turnEnd({
        session: adapter.session(loop),
        turn: { id: turn.id, ...(turn.synthesized ? { synthesized: true } : {}) },
        items: e.answer ? [message(`${turn.id}:answer`, "assistant", e.answer, { synthesized: true })] : [],
        continuationCount: turn.continuationCount,
        outcome: OUTCOME[e.reason],
        ...(e.reason === "error" || e.reason === "refusal"
          ? { error: { class: e.reason === "refusal" ? "Refusal" : "ModelError", message: e.reason === "refusal" ? "The model refused" : "The turn ended on an error" } }
          : {}),
        ...(turn.parentEventId ? { parentEventId: turn.parentEventId } : {}),
        extensions: { "com.anthropic.claude-code": { turnId: e.turnId, durationMs: e.durationMs } },
      });
      adapter.report(result);
    }
    if (adapter.turns.get(loop) === turn) adapter.turns.delete(loop);
    return ran;
  });

  on("classic.Stop", async ($, e, next) => finish(adapter, MAIN, e, await next(e)));
  on("classic.SubagentStop", async ($, e, next) => finish(adapter, e.agent_id, e, await next(e)));

  // A model request in progress failed past retry.
  on("classic.StopFailure", async ($, e, next) => {
    const ran = await next(e);
    const hooks = await adapter.client("model.error");
    if (hooks) {
      const loop = e.agent_id ?? MAIN;
      const result = await hooks.modelError({
        ...adapter.scope(loop),
        model: model(adapter.model ?? "unknown"),
        attempt: { id: `${adapter.turns.get(loop)?.id ?? "turn"}:failure`, number: 1, synthesized: true },
        execution: { status: "executed" },
        error: { class: String(e.error ?? "ModelError"), message: e.error_details ?? String(e.error ?? "The model request failed") },
      });
      adapter.report(result);
    }
    return ran;
  });

  // The system prompt as rendered, reported with each model request.
  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    adapter.systemSections = composed.sections.map((section, index) => ({
      id: String((section as { id?: unknown }).id ?? index),
      text: String((section as { text?: unknown }).text ?? ""),
    }));
    adapter.model = e.model;
    return composed;
  });

  on("turn.step", async function* ($, e, next) {
    const loop = e.agentId ?? MAIN;
    const turn = adapter.turns.get(loop);
    const attempt = { id: `${e.turnId}:${e.index}`, number: 1, synthesized: true };
    const modelId = e.model;
    const request = await adapter.client("model.request.before");
    if (request) {
      const history = await adapter.messages(e.agentId).catch(() => []);
      const items: Message[] = [
        ...(adapter.systemSections.length
          ? [{
              id: `${attempt.id}:system`,
              role: "system" as const,
              synthesized: true,
              parts: adapter.systemSections.map((section) => textPart(`${attempt.id}:system:${section.id}`, section.text, "system")),
            }]
          : []),
        ...history.map((row, index) => apiMessage(`${attempt.id}:message:${index}`, row, adapter.media)),
      ];
      const result = await request.modelRequestBefore({
        ...adapter.scope(loop),
        ...(turn ? {} : {}),
        model: model(modelId),
        attempt,
        params: { model: modelId, ...(e.effort !== undefined ? { effort: e.effort } : {}), messageCount: e.messageCount },
        items,
      }, { capabilities: OBSERVE_ONLY as never });
      adapter.report(result);
    }
    const response = yield* next(e);
    const responded = await adapter.client(response.stopReason === null ? "model.error" : "model.response.after");
    if (responded && response.stopReason === null) {
      const result = await responded.modelError({
        ...adapter.scope(loop),
        model: model(modelId),
        attempt,
        execution: { status: "executed" },
        error: { class: "ModelError", message: "No response arrived for the model request" },
      });
      adapter.report(result);
    } else if (responded) {
      const text = [response.answer, ...(response.toolUses.length ? [asText(response.toolUses)] : [])].filter(Boolean).join("\n");
      const result = await responded.modelResponseAfter({
        ...adapter.scope(loop),
        model: model((response as { usage?: { model?: string } | null }).usage?.model ?? modelId),
        attempt,
        execution: { status: "executed" },
        finishReason: response.stopReason ?? "unknown",
        items: text ? [message(`${attempt.id}:response`, "assistant", text, { synthesized: true })] : [],
        ...(response.serverToolUses?.length
          ? { extensions: { "com.anthropic.claude-code": json({ serverToolUses: response.serverToolUses }) } }
          : {}),
      }, { capabilities: OBSERVE_ONLY as never });
      adapter.report(result);
    }
    return response;
  });

  // Messages from peers, channels and bridges.
  on("session.receive", async ($, e, next) => {
    const hooks = await adapter.client("user.message.inbound");
    if (!hooks) return next(e);
    const id = crypto.randomUUID();
    const loop = (e as { agentId?: string }).agentId ?? MAIN;
    const result = await hooks.userMessageInbound({
      ...adapter.scope(loop),
      message: {
        channel: String((e.origin as { kind?: unknown })?.kind ?? "unknown"),
        sender: asText((e.origin as { from?: unknown })?.from ?? (e.origin as { kind?: unknown })?.kind ?? "unknown"),
        messages: [message(`${id}:message`, "user", e.text, { synthesized: true })],
      },
    }, { initialState: state.initial(Permission.None), signal: next.signal });
    adapter.report(result);
    const refused = denial(result);
    if (refused !== undefined) return { consumed: refused };
    const text = texts((result.event as { message?: { messages?: unknown[] } }).message?.messages).join("\n");
    return next(text && text !== e.text ? { ...e, text } : e);
  }).catch(($, e, next) =>
    next.called || !adapter.failsClosed("user.message.inbound") ? next(e) : { consumed: "The AHP adapter failed and a user.message.inbound subscription fails closed" });

  on("session.send", async ($, e, next) => {
    const hooks = await adapter.client("user.message.outbound");
    if (!hooks) return next(e);
    const id = crypto.randomUUID();
    const loop = (e as { agentId?: string }).agentId ?? MAIN;
    const result = await hooks.userMessageOutbound({
      ...adapter.scope(loop),
      message: {
        channel: "send-message",
        messages: [message(`${id}:message`, "assistant", e.text, { synthesized: true })],
      },
      extensions: { "com.anthropic.claude-code": { to: e.to } },
    }, { initialState: state.initial(Permission.None), signal: next.signal });
    adapter.report(result);
    const refused = denial(result);
    if (refused !== undefined) return { isDelivered: false, reason: refused };
    const text = texts((result.event as { message?: { messages?: unknown[] } }).message?.messages).join("\n");
    return next(text && text !== e.text ? { ...e, text } : e);
  }).catch(($, e, next) =>
    next.called || !adapter.failsClosed("user.message.outbound") ? next(e) : { isDelivered: false as const, reason: "The AHP adapter failed and a user.message.outbound subscription fails closed" });
}

type Stopped = { block?: string; preventContinuation?: true; stopReason?: string; additionalContext?: string[] };

/** turn.finish.before at a Stop hook: continue re-prompts, stop ends. */
async function finish<R extends Stopped>(adapter: Adapter, key: string, e: { last_assistant_message?: string }, ran: R): Promise<R> {
  const hooks = await adapter.client("turn.finish.before");
  const turn = adapter.turns.get(key);
  if (!hooks || !turn || ran.block !== undefined || ran.preventContinuation) return ran;
  const result = await hooks.turnFinishBefore({
    session: adapter.session(key),
    turn: { id: turn.id, ...(turn.synthesized ? { synthesized: true } : {}) },
    items: e.last_assistant_message ? [message(`${turn.id}:answer`, "assistant", e.last_assistant_message, { synthesized: true })] : [],
    continuationCount: turn.continuationCount,
    outcome: "completed",
  }, { initialState: state.initial(Permission.None) });
  adapter.report(result);
  const decision = flow(result);
  if (decision?.operation === "stop") return { ...ran, preventContinuation: true, stopReason: decision.reason };
  if (decision?.operation === "continue") {
    turn.continuationCount += 1;
    return { ...ran, block: decision.instruction ?? "Continue: an AHP hook asked for another pass." };
  }
  return ran;
}

/** A prompt folded into a running turn: user.message.inbound on the turn. */
async function inbound<E extends { text: string; origin: PromptOrigin }, R>(adapter: Adapter, e: E, next: (e: E) => Promise<R>): Promise<R> {
  const event = e;
  const hooks = await adapter.client("user.message.inbound");
  if (!hooks) return next(e);
  const id = crypto.randomUUID();
  const result = await hooks.userMessageInbound({
    ...adapter.scope(MAIN),
    message: {
      channel: event.origin?.kind ?? "composer",
      sender: event.origin?.kind ?? "user",
      messages: [message(`${id}:message`, "user", event.text, { synthesized: true })],
    },
  }, { initialState: state.initial(Permission.None) });
  adapter.report(result);
  const refused = denial(result);
  if (refused !== undefined) return { drop: refused } as R;
  const text = texts((result.event as { message?: { messages?: unknown[] } }).message?.messages).join("\n");
  return next(text && text !== event.text ? { ...event, text } : event);
}
