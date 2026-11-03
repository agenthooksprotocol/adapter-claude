// The web platform pieces the AHP SDK uses and a Claude Code hooks module
// lacks: Headers, Response, DOMException and timers. Each is installed only
// where the environment has none, so a richer host keeps its own.
import type { HttpInit } from "claude-code";
import type { Host } from "./host.js";
import { sendBinary } from "./upload.js";

type HeadersInit = { forEach(callback: (value: string, name: string) => void): void } | Record<string, string> | Iterable<readonly [string, string]>;

/** The fetch signature the SDK takes (`HooksOptions.fetch`). */
export type Fetch = (input: string | URL | { url: string }, init?: FetchInit) => Promise<unknown>;

/** A WHATWG-compatible header map: names fold to lower case, order is kept. */
class HeadersShim {
  readonly #entries = new Map<string, string>();

  constructor(init?: HeadersInit) {
    if (init === undefined || init === null) return;
    if (typeof (init as Iterable<unknown>)[Symbol.iterator] === "function") {
      for (const [name, value] of init as Iterable<readonly [string, string]>) this.append(name, value);
    } else {
      for (const [name, value] of Object.entries(init)) this.append(name, String(value));
    }
  }

  append(name: string, value: string): void {
    const key = HeadersShim.#name(name);
    const current = this.#entries.get(key);
    this.#entries.set(key, current === undefined ? HeadersShim.#value(value) : `${current}, ${HeadersShim.#value(value)}`);
  }
  set(name: string, value: string): void {
    this.#entries.set(HeadersShim.#name(name), HeadersShim.#value(value));
  }
  get(name: string): string | null {
    return this.#entries.get(HeadersShim.#name(name)) ?? null;
  }
  has(name: string): boolean {
    return this.#entries.has(HeadersShim.#name(name));
  }
  delete(name: string): void {
    this.#entries.delete(HeadersShim.#name(name));
  }
  forEach(callback: (value: string, name: string, headers: HeadersShim) => void): void {
    for (const [name, value] of this.entries()) callback(value, name, this);
  }
  *entries(): IterableIterator<[string, string]> {
    yield* [...this.#entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  *keys(): IterableIterator<string> {
    for (const [name] of this.entries()) yield name;
  }
  *values(): IterableIterator<string> {
    for (const [, value] of this.entries()) yield value;
  }
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  static #name(name: string): string {
    const text = String(name);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(text)) throw new TypeError(`Invalid header name: ${text}`);
    return text.toLowerCase();
  }
  static #value(value: string): string {
    const text = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
    if (/[\0\n\r]/.test(text)) throw new TypeError("Invalid header value");
    return text;
  }
}

/** A one-chunk body stream with the reader surface the SDK reads through. */
class BodyShim {
  #bytes: Uint8Array | undefined;
  #locked = false;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }
  get locked(): boolean {
    return this.#locked;
  }
  getReader() {
    if (this.#locked) throw new TypeError("Body is already locked");
    this.#locked = true;
    return {
      read: async (): Promise<{ done: true; value: undefined } | { done: false; value: Uint8Array }> => {
        const bytes = this.#bytes;
        this.#bytes = undefined;
        return bytes === undefined || bytes.byteLength === 0
          ? { done: true, value: undefined }
          : { done: false, value: bytes };
      },
      cancel: async (): Promise<void> => {
        this.#bytes = undefined;
      },
      releaseLock: (): void => {
        this.#locked = false;
      },
    };
  }
  async cancel(): Promise<void> {
    this.#bytes = undefined;
  }
}

/** A fetch Response over a body the host has already read. */
class ResponseShim {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: HeadersShim;
  readonly body: BodyShim | null;
  readonly redirected = false;
  readonly type = "basic";
  readonly url: string;
  #used = false;
  readonly #text: string;

  constructor(body?: string | Uint8Array | null, init: { status?: number; statusText?: string; headers?: HeadersInit; url?: string } = {}) {
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "";
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new HeadersShim(init.headers);
    this.url = init.url ?? "";
    this.#text = body === undefined || body === null ? "" : typeof body === "string" ? body : new TextDecoder().decode(body);
    this.body = body === undefined || body === null ? null : new BodyShim(new TextEncoder().encode(this.#text));
  }
  get bodyUsed(): boolean {
    return this.#used || (this.body?.locked ?? false);
  }
  async text(): Promise<string> {
    if (this.bodyUsed) throw new TypeError("Body has already been consumed");
    this.#used = true;
    return this.#text;
  }
  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = new TextEncoder().encode(await this.text());
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}

class DOMExceptionShim extends Error {
  constructor(message = "", name = "Error") {
    super(message);
    this.name = name;
  }
}

/** Timers over `$.clock`, bound once the session hands the module a `$`. */
let engine: Host | undefined;
const timers = new Map<number, { cancel(): void }>();
let nextTimer = 1;

function setTimeoutShim(callback: (...args: unknown[]) => void, ms = 0, ...args: unknown[]): number {
  const host = engine;
  if (!host) throw new Error("Timers are unavailable until the adapter binds the session clock");
  const id = nextTimer++;
  timers.set(id, host.after(Math.max(0, Number(ms) || 0), () => {
    timers.delete(id);
    callback(...args);
  }));
  return id;
}
function clearTimeoutShim(id: unknown): void {
  const timer = timers.get(id as number);
  timers.delete(id as number);
  timer?.cancel();
}

/** Install the missing globals. Idempotent; a host's own globals win. */
export function installWebRuntime(): void {
  const scope = globalThis as Record<string, unknown>;
  scope.Headers ??= HeadersShim;
  scope.Response ??= ResponseShim;
  scope.DOMException ??= DOMExceptionShim;
  if (typeof scope.setTimeout !== "function") {
    scope.setTimeout = setTimeoutShim;
    scope.clearTimeout = clearTimeoutShim;
  }
}

/** Route the timer shim through this session's clock. */
export function bindClock(host: Host): void {
  engine = host;
}

type FetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
  signal?: AbortSignal | null;
  redirect?: string;
};

/**
 * `fetch` over `$.http.fetch`, which reads the whole body as text and takes no
 * signal: an abort settles the caller at once and the host request is
 * abandoned. Binary bodies (content uploads) go through upload.ts instead.
 */
export function hostFetch(host: Host): Fetch {
  return (async (input: string | URL | { url: string }, init: FetchInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const request: HttpInit = { method: init.method ?? "GET" };
    const headers: Record<string, string> = {};
    new HeadersShim(init.headers as HeadersInit | undefined).forEach((value, name) => {
      headers[name] = value;
    });
    request.headers = headers;
    const binary = init.body instanceof Uint8Array ? init.body : init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : undefined;
    if (!binary && init.body !== undefined && init.body !== null) request.body = textBody(init.body);
    const pending = binary
      ? sendBinary(host, url, request.method ?? "POST", headers, binary, signal).then(
          (response) => new ResponseShim(response.text, { status: response.status, headers: response.headers, url }),
        )
      : host.fetch(url, request).then(
          (response) => new ResponseShim(response.text, { status: response.status, headers: response.headers, url }),
        );
    if (!signal) return pending;
    return new Promise<ResponseShim>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }) as Fetch;
}

function textBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new TypeError("Unsupported request body");
}
