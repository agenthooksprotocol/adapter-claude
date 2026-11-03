// stdio backends over `$.process.spawn`. The host writes a child's standard
// input once, at start, and then closes it, so a `per_event` backend (one
// message, then EOF) fits exactly; a `persistent` one cannot be driven and is
// refused at its first write.
import type { Host } from "./host.js";
import type { StdioProcess, StdioSpawn } from "agenthooksprotocol/client";

export function hostSpawn(host: Host): StdioSpawn {
  return (request) => {
    let started = false;
    let killed = false;
    const stdout: ((chunk: Uint8Array) => void)[] = [];
    const errors: ((error: unknown) => void)[] = [];
    const closes: ((code: number | null) => void)[] = [];
    let iterator: AsyncIterator<{ stream: "stdout" | "stderr"; text: string }, { code: number | null } | undefined> | undefined;
    const encoder = new TextEncoder();

    const run = async (input: string) => {
      const stream = host.spawn({
        argv: [request.command, ...request.args],
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        // The host's spawn inherits its own environment beneath these; the
        // registration's literal `env` and the base allow-list ride on top.
        env: request.env,
        input,
      });
      let code: number | null = null;
      try {
        iterator = stream[Symbol.asyncIterator]() as unknown as typeof iterator & object;
        while (true) {
          const step = await iterator.next();
          if (step.done) {
            code = step.value?.code ?? null;
            break;
          }
          if (killed) break;
          if (step.value.stream === "stdout") {
            const bytes = encoder.encode(step.value.text);
            for (const listener of stdout) listener(bytes);
          }
        }
      } catch (error) {
        if (!killed) for (const listener of errors) listener(error);
      }
      for (const listener of closes) listener(killed ? null : code);
    };

    const process: StdioProcess = {
      write(data, end, callback) {
        if (!end) {
          callback(new Error("persistent stdio backends are unavailable in a Claude Code mod; use lifecycle \"per_event\""));
          return;
        }
        if (started) {
          callback(new Error("stdio input was already written"));
          return;
        }
        started = true;
        void run(data);
        callback();
      },
      onStdout(listener) {
        stdout.push(listener);
      },
      onError(listener) {
        errors.push(listener);
      },
      onClose(listener) {
        closes.push(listener);
      },
      kill() {
        if (killed) return;
        killed = true;
        // Ending the loop kills the child (`return()` on the stream).
        void iterator?.return?.(undefined);
        if (!started) for (const listener of closes) listener(null);
      },
    };
    return process;
  };
}
