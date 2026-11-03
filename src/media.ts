// Media in what Claude Code hands a hook: base64 inside tool results and API
// content blocks. It leaves as attachment parts, uploaded only when a
// subscription selects the body; the text around it never carries the bytes.
import { Attachment } from "agenthooksprotocol/client";
import { asText, message, textPart, type Message, type Part } from "./content.js";
import { fromBase64 } from "./runtime/upload.js";

/** How this adapter builds attachment parts for the current session. */
export type MediaPolicy = {
  /** Why no body can be sent on this machine, if so. */
  unavailable?: string;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only non-text, non-JSON media is uploaded (AHP-CONTENT-002). */
function isBinary(mediaType: string): boolean {
  return !/^text\/|[/+]json\b/.test(mediaType);
}

/** One attachment part over base64 the engine already holds. */
export function attachment(id: string, mediaType: string, base64: string, policy: MediaPolicy, gap?: string): Part {
  const reason = gap ?? policy.unavailable;
  if (reason !== undefined) return { id, kind: "attachment", mediaType, selection: "body", gap: { reason } };
  return { id, kind: "attachment", mediaType, body: Attachment.lazy(() => fromBase64(base64)) };
}

/** The media a value's object holds directly, as the engine and MCP spell it. */
function mediaOf(value: Record<string, unknown>, parent?: Record<string, unknown>): { mediaType: string; base64: string } | undefined {
  // Read: `{ base64, type: "image/png" }`; a PDF's `{ base64, filePath }` under
  // `{ type: "pdf" }`; a split PDF's pages `{ base64, mediaType }`.
  if (typeof value.base64 === "string" && value.base64) {
    if (typeof value.type === "string" && value.type.includes("/")) return { mediaType: value.type, base64: value.base64 };
    if (typeof value.mediaType === "string") return { mediaType: value.mediaType, base64: value.base64 };
    if (parent?.type === "pdf") return { mediaType: "application/pdf", base64: value.base64 };
  }
  // Messages API: `{ type: "image", source: { type: "base64", media_type, data } }`.
  const source = value.source;
  if (object(source) && source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string")
    return { mediaType: source.media_type, base64: source.data };
  // MCP: `{ type: "image", data, mimeType }`.
  if (typeof value.data === "string" && typeof value.mimeType === "string")
    return { mediaType: value.mimeType, base64: value.data };
  return undefined;
}

/** Take the media out of a value: its JSON with `{ attachment: id }` in place
 * of each, and the parts. */
export function extractMedia(value: unknown, prefix: string, policy: MediaPolicy): { value: unknown; parts: Part[] } {
  const parts: Part[] = [];
  const walk = (item: unknown, parent?: Record<string, unknown>): unknown => {
    if (Array.isArray(item)) return item.map((entry) => walk(entry, parent));
    if (!object(item)) return item;
    const media = mediaOf(item, parent);
    if (media && isBinary(media.mediaType)) {
      const id = `${prefix}:media:${parts.length}`;
      parts.push(attachment(id, media.mediaType, media.base64, policy));
      return { attachment: id, mediaType: media.mediaType };
    }
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry, item)]));
  };
  return { value: walk(value), parts };
}

/** A tool's result as the `tool` message of tool.after. */
export function toolResult(id: string, result: unknown, policy: MediaPolicy): Message {
  const { value, parts } = extractMedia(result, id, policy);
  const item: Message = message(id, "tool", asText(value));
  item.parts.push(...parts);
  return item;
}

/** A Messages API row as a canonical message. */
export function apiMessage(id: string, row: { role: string; content: readonly Record<string, unknown>[] }, policy: MediaPolicy): Message {
  const parts: Part[] = [];
  const text = (value: string, category?: string) => parts.push(textPart(`${id}#${parts.length}`, value, category));
  const block = (entry: Record<string, unknown>) => {
    if (entry.type === "text" && typeof entry.text === "string") return text(entry.text);
    if (entry.type === "thinking" && typeof entry.thinking === "string") return text(entry.thinking, "reasoning");
    if (entry.type === "redacted_thinking") return;
    if (entry.type === "tool_result" && Array.isArray(entry.content)) {
      const { content, ...rest } = entry;
      text(asText(rest), "tool_result");
      for (const nested of content as Record<string, unknown>[]) block(nested);
      return;
    }
    const media = mediaOf(entry);
    if (media && isBinary(media.mediaType)) {
      parts.push(attachment(`${id}#${parts.length}`, media.mediaType, media.base64, policy));
      return;
    }
    return text(asText(entry), typeof entry.type === "string" ? entry.type : undefined);
  };
  for (const entry of row.content) block(entry);
  return { id, role: row.role === "assistant" ? "assistant" : "user", parts, synthesized: true };
}
