// Binary request bodies. `$.http.fetch` carries text only, so a content upload
// goes through curl: base64 on the child's standard input, decoded in the pipe.
// The URL and headers (a bearer token among them) ride the child's environment,
// never its argv, and the script names them only as quoted variables.
import type { Host } from "./host.js";

const DECODE = 'if printf QQ== | base64 -d >/dev/null 2>&1; then d=-d; else d=-D; fi; base64 "$d"';

export interface UploadResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** Whether this machine has what an upload runs on. */
export async function uploadsAvailable(host: Host): Promise<boolean> {
  try {
    const { exitCode } = await host.run(["sh", "-c", "command -v curl >/dev/null && command -v base64 >/dev/null"], { timeoutMs: 5000 });
    return exitCode === 0;
  } catch {
    return false;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(text);
}

export function fromBase64(base64: string): Uint8Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}

/** Send one binary request. An abort kills curl (ending the loop kills the child). */
export async function sendBinary(
  host: Host,
  url: string,
  method: string,
  headers: Record<string, string>,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<UploadResponse> {
  // curl sets Content-Length from the body it read.
  const entries = Object.entries(headers).filter(([name]) => name !== "content-length");
  const mark = `ahp-${crypto.randomUUID()}:`;
  const env: Record<string, string> = { AHP_URL: url, AHP_METHOD: method, AHP_MARK: mark };
  entries.forEach(([name, value], index) => {
    env[`AHP_HEADER_${index}`] = `${name}: ${value}`;
  });
  const script = [
    `${DECODE} | curl -q --silent --show-error --proto =http,https --request "$AHP_METHOD"`,
    '--data-binary @- -H "Expect:"',
    ...entries.map((_, index) => `-H "$AHP_HEADER_${index}"`),
    '--write-out "\\n$AHP_MARK%{http_code} %{content_type}\\n%{header_json}"',
    '"$AHP_URL"',
  ].join(" ");
  const stream = host.spawn({ argv: ["sh", "-c", script], env, input: toBase64(bytes) });
  const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<
    { stream: "stdout" | "stderr"; text: string },
    { code: number | null } | undefined
  >;
  const kill = () => void iterator.return?.(undefined);
  signal?.addEventListener("abort", kill, { once: true });
  let stdout = "";
  let code: number | null = null;
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        code = step.value?.code ?? null;
        break;
      }
      if (step.value.stream === "stdout") stdout += step.value.text;
    }
  } finally {
    signal?.removeEventListener("abort", kill);
  }
  signal?.throwIfAborted();
  const at = stdout.lastIndexOf(mark);
  if (code !== 0 || at === -1) throw new TypeError(`Content upload failed (curl exit ${String(code)})`);
  const [summary = "", ...rest] = stdout.slice(at + mark.length).split("\n");
  const [status = "0", ...type] = summary.split(" ");
  return {
    status: Number(status),
    headers: { ...responseHeaders(rest.join("\n")), ...(type.length && type.join(" ") ? { "content-type": type.join(" ") } : {}) },
    text: stdout.slice(0, Math.max(0, at - 1)),
  };
}

/** `%{header_json}`, which curl before 7.83 leaves empty. */
function responseHeaders(text: string): Record<string, string> {
  try {
    const parsed = JSON.parse(text) as Record<string, string[]>;
    return Object.fromEntries(Object.entries(parsed).map(([name, values]) => [name.toLowerCase(), values.join(", ")]));
  } catch {
    return {};
  }
}
