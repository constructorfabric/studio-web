// Supervises one engine process per workspace root.
//
// The engine speaks JSON-RPC over its stdio with LSP framing, so the same
// `vscode-jsonrpc` reader/writer Theia uses elsewhere works with no adapter.
// `child.stderr` is piped to the backend log: the engine puts everything that is
// not JSON-RPC there, by design, and dropping it would turn a crash into a hang.
//
// Supervision is the substance of this file. `vscode-jsonrpc` rejects in-flight
// requests when the *connection* is disposed, not when the stream closes, so a
// child that dies after `listen()` leaves every pending `sendRequest` hanging
// forever. And `spawn` reports ENOENT by emitting `'error'`, which with no
// listener is an uncaught exception that takes the whole Theia backend down.
// Both are handled here rather than at each call site.

import { ILogger } from "@theia/core/lib/common/logger";
import { spawn, ChildProcess } from "child_process";
import { PassThrough } from "stream";
import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

import { method } from "../common/protocol";

/** How long the engine gets to act on `exit` before SIGTERM. */
const EXIT_GRACE_MS = 1_000;
/** And how long after SIGTERM before SIGKILL. */
const SIGTERM_GRACE_MS = 2_000;

export interface EngineHandle {
  readonly connection: MessageConnection;
  /** Resolves with why the engine died; never rejects. */
  readonly exited: Promise<string>;
  /** Whether the child is gone or the connection has been disposed. */
  readonly dead: boolean;
  /**
   * Send a request that always settles.
   *
   * The reason this is not `connection.sendRequest` at the call site:
   * `vscode-jsonrpc` registers a request in its pending map only *after* the
   * write resolves, and `dispose()` rejects what is in that map. An engine that
   * dies in the window between the two -- which is every engine that fails to
   * start, because the spawn error is a `nextTick` and the write completes on a
   * microtask after it -- leaves a request nobody will ever settle. Racing the
   * answer against the child's death closes that window; the timeout closes the
   * one where the child is alive and simply never answers.
   *
   * A timeout is fatal to the handle, not just to the request. An engine that
   * missed its deadline is still running the work: it goes on emitting
   * `catalogueChanged` and a final `$/progress done` for a load the client has
   * already given up on and reported as an error, which walks the panel back
   * from "failed" to "ready" with a tree nobody asked for. There is also no way
   * to cancel the work -- the load runs on the engine's request thread -- so the
   * only way to make the abandonment real is to end the process.
   *
   * @throws when the engine dies first, sends nothing at all for `timeoutMs`
   * (see `silenceVerdict`), or has not answered after `CEILING_FACTOR` times that.
   */
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T>;
  dispose(): void;
}

/**
 * A Windows path as the rest of the IDE spells it. The engine canonicalizes
 * its roots, and on Windows Rust's `canonicalize` answers in the verbatim form
 * (`\\?\C:\…`, `\\?\UNC\server\share\…`), which Theia's `URI.fromFilePath`
 * turns into `file://%3F/c%3A/…` — a URI nothing can open. A `file:` URI built
 * from such a path gets the same repair. Anything else is returned as it is,
 * so on Linux this changes nothing.
 */
/** `\\?\` and `\\?\UNC\`, spelled as JavaScript strings. */
const VERBATIM = "\\\\?\\";
const VERBATIM_UNC = "\\\\?\\UNC\\";

export function plainPath(value: string): string {
  if (value.startsWith(VERBATIM_UNC)) return `\\\\${value.slice(VERBATIM_UNC.length)}`;
  if (value.startsWith(VERBATIM)) return value.slice(VERBATIM.length);
  const uri = value.match(/^file:\/{2,4}(?:%3F|\?)\/(.*)$/i);
  return uri ? `file:///${uri[1]}` : value;
}

/** `plainPath` applied to every string in an engine answer, however deep. */
export function plainPaths<T>(value: T): T {
  if (typeof value === "string") return plainPath(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => plainPaths(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = plainPaths(item);
    return out as T;
  }
  return value;
}

/**
 * Why the engine did not start, finishing "the engine …". A missing binary is
 * the common case outside the session image — a desktop build without one, a
 * checkout with nothing on PATH — and a bare ENOENT does not say what to do.
 */
export function startFailure(enginePath: string, error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") {
    return `is not installed here: ${enginePath} was not found (set GEARBOX_ENGINE to a gearbox executable)`;
  }
  return `could not be started (${enginePath}): ${error.message}`;
}

/**
 * Constructor Studio: whether a request has waited too long, judged by the
 * engine's silence rather than by the clock alone.
 *
 * `timeoutMs` used to be a flat deadline, and a flat deadline cannot tell a
 * wedged engine from a busy one. The engine answers one request at a time:
 * `product/load` sent while a catalogue load is still projecting waits for all
 * of it, and on a cold file cache (a desktop's first open, Defender scanning
 * some 6000 files of the corpus) that projection alone took longer than the 60 s
 * the product methods get. The engine was talking the whole time --
 * `catalogueChanged` per gear, `$/progress`, log lines -- and was ended as
 * wedged anyway, taking the session with it.
 *
 * So `timeoutMs` is how long the engine may stay **silent**: any output
 * restarts it. A wedged engine says nothing and is still ended at `timeoutMs`,
 * as before. `ceilingMs` bounds a request that the engine keeps busy forever.
 */
export function silenceVerdict(
  startedAt: number,
  lastHeard: number,
  now: number,
  timeoutMs: number,
  ceilingMs: number,
): { readonly expired: true; readonly reason: string } | { readonly expired: false; readonly recheckInMs: number } {
  const waited = now - startedAt;
  if (waited >= ceilingMs) return { expired: true, reason: `in ${ceilingMs}ms` };
  const quiet = now - Math.max(startedAt, lastHeard);
  if (quiet >= timeoutMs) return { expired: true, reason: `and sent nothing for ${timeoutMs}ms` };
  return { expired: false, recheckInMs: Math.max(1, Math.min(timeoutMs - quiet, ceilingMs - waited)) };
}

/** How much longer than its silence allowance one request may take in all. */
export const CEILING_FACTOR = 10;

/** Spawn `gearbox rpc --stdio --root <root>` and wrap its stdio. */
export function spawnEngine(
  enginePath: string,
  roots: readonly string[],
  logger: ILogger,
): EngineHandle {
  const args = ["rpc", "--stdio", ...roots.flatMap((r) => ["--root", r])];
  const child: ChildProcess = spawn(enginePath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // When the engine last said anything, on either stream. See `silenceVerdict`.
  let lastHeard = Date.now();
  child.stdout?.on("data", () => {
    lastHeard = Date.now();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    lastHeard = Date.now();
    for (const line of chunk.split("\n").filter((l) => l.trim())) {
      void logger.info(`[gearbox engine] ${line}`);
    }
  });

  let settle: (reason: string) => void = () => undefined;
  const exited = new Promise<string>((resolve) => {
    settle = resolve;
  });

  let dead = false;
  let connection: MessageConnection | undefined;
  const die = (reason: string): void => {
    if (dead) {
      return;
    }
    dead = true;
    void logger.warn(`[gearbox engine] ${reason}`);
    // Disposing is what rejects the in-flight requests. Without it the client
    // waits on a process that no longer exists.
    connection?.dispose();
    settle(reason);
  };

  // ENOENT, EACCES, and every other spawn failure arrive here. With no listener
  // Node re-throws them on the event loop, which is an IDE-wide crash for a
  // missing `target/debug/gearbox`.
  child.on("error", (error: NodeJS.ErrnoException) => {
    die(startFailure(enginePath, error));
  });
  // Same rule one level down: an unlistened `'error'` on a stream is also an
  // uncaught exception.
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on("error", (error: Error) => {
      die(`stdio failed: ${error.message}`);
    });
  }
  child.on("exit", (code, signal) => {
    die(`exited code=${code} signal=${signal}`);
  });

  if (!child.stdout || !child.stdin) {
    child.kill();
    throw new Error("engine process has no stdio");
  }

  // The writer writes into a buffer of ours, which is piped to the child --
  // rather than into the child's stdin directly.
  //
  // Not indirection for its own sake. A write into the stdin of a child that
  // has already died rejects inside `vscode-jsonrpc`'s writer, and that
  // rejection is not one anybody awaits: under Node's default
  // `--unhandled-rejections=throw` it surfaces as an uncaught exception and
  // takes the Theia backend with it. That is exactly the case that matters
  // most -- a missing `target/debug/gearbox`, where `initialize` writes
  // microseconds after the spawn fails. A write into a `PassThrough` cannot
  // fail; the pipe to the dead child reports the failure as an `'error'` event,
  // which is handled, and the waiting request is rejected by `die()` disposing
  // the connection.
  const outbound = new PassThrough();
  outbound.on("error", (error: Error) => die(`stdin failed: ${error.message}`));

  // `@types/node`'s `Readable` and vscode-jsonrpc's `ReadableStream` disagree on
  // the async-iterator signature only; the runtime shapes match, which the smoke
  // test exercises against the same reader.
  connection = createMessageConnection(
    new StreamMessageReader(child.stdout as unknown as NodeJS.ReadableStream),
    new StreamMessageWriter(outbound as unknown as NodeJS.WritableStream),
  );
  connection.onClose(() => {
    die("connection closed");
  });
  // Without this an error on the reader (a truncated frame, a closed pipe mid
  // message) is silent, and the symptom is again a request that never settles.
  connection.onError(([error]) => {
    die(`transport error: ${error.message}`);
  });
  connection.listen();

  // Piped only now. Attaching to an already-destroyed stdin -- the missing
  // binary again -- emits `'error'` synchronously, and `die()` running before
  // `connection` exists would dispose nothing, leaving the first request
  // pending on a connection nobody will ever close.
  outbound.pipe(child.stdin);

  const live = connection;
  // Every notification the engine sends reaches its handler with plain paths,
  // whoever registered it (see `plainPath`).
  const listen = live.onNotification.bind(live) as (method: unknown, handler: (...params: unknown[]) => unknown) => unknown;
  const plain = Object.create(live, {
    onNotification: {
      value: (method: unknown, handler: (...params: unknown[]) => unknown) =>
        listen(method, (...params: unknown[]) => handler(...params.map((param) => plainPaths(param)))),
    },
  }) as MessageConnection;
  const handle: EngineHandle = {
    connection: plain,
    exited,
    get dead(): boolean {
      return dead;
    },
    async request<T>(requestMethod: string, params: unknown, timeoutMs: number): Promise<T> {
      if (dead) {
        throw new Error(`the engine is not running (${await exited})`);
      }
      let timer: NodeJS.Timeout | undefined;
      const startedAt = Date.now();
      const timeout = new Promise<never>((_, reject) => {
        const check = (): void => {
          const verdict = silenceVerdict(startedAt, lastHeard, Date.now(), timeoutMs, timeoutMs * CEILING_FACTOR);
          if (!verdict.expired) {
            timer = setTimeout(check, verdict.recheckInMs);
            return;
          }
          // **Rejected first, then ended, and the order is the message.**
          // `dispose()` disposes the connection, which rejects the pending
          // `sendRequest` synchronously with `vscode-jsonrpc`'s own
          // "Pending response rejected since connection got disposed" -- and
          // `Promise.race` keeps whichever settled first. So disposing before
          // rejecting handed the panel a sentence about a connection instead of
          // the one written here, which is the only one that names the method
          // and the deadline. Measured against a real engine held past a real
          // cap; no test read this text before, so it had been wrong for as long
          // as it had existed.
          reject(new Error(`the engine did not answer \`${requestMethod}\` ${verdict.reason}`));
          // Ended, not merely abandoned. See `EngineHandle.request`: a wedged
          // engine that later finishes its load would otherwise overwrite the
          // error the client is already showing.
          handle.dispose();
        };
        timer = setTimeout(check, timeoutMs);
      });
      const died = exited.then((reason): never => {
        throw new Error(`the engine ${reason} while answering \`${requestMethod}\``);
      });
      try {
        return plainPaths(await Promise.race([
          live.sendRequest<T>(requestMethod, params),
          died,
          timeout,
        ]));
      } finally {
        clearTimeout(timer);
      }
    },
    dispose(): void {
      // Three escalating steps, because only the last one always works and only
      // the first one is clean.
      //
      // `exit` first. The engine's lifecycle is LSP-shaped -- `serve_stdio` in
      // `crates/gearbox-rpc/src/lib.rs` runs until the client sends it -- so a
      // shutdown it understands exists, and taking it lets the engine return
      // from its request loop and release its source roots itself instead of
      // being cut down between two writes. It has to go out before `die()`,
      // which disposes the connection.
      //
      // Then the signals, for the engine that is wedged and not reading: a
      // pathological parse or a hung network read ignores `exit`, and leaving it
      // running holds the source root and its file handles open.
      //
      // Notably *not* an EOF on stdin in between. Ending `outbound` propagates
      // the end through the pipe to a `child.stdin` that a dead child has
      // already destroyed, and the write-after-end that follows escapes as an
      // uncaught error -- which is the same class of failure the `PassThrough`
      // above exists to prevent. SIGTERM ends the process either way.
      if (!dead) {
        live.sendNotification(method.EXIT).catch(() => undefined);
      }
      try {
        die("disposed");
      } finally {
        const escalate = [
          setTimeout(() => child.kill("SIGTERM"), EXIT_GRACE_MS),
          setTimeout(() => child.kill("SIGKILL"), EXIT_GRACE_MS + SIGTERM_GRACE_MS),
        ];
        for (const timer of escalate) {
          // Unreffed, or a disposal during shutdown holds the event loop open
          // for the whole grace period and Theia appears to hang on exit.
          timer.unref?.();
        }
        child.once("exit", () => {
          for (const timer of escalate) {
            clearTimeout(timer);
          }
        });
      }
    },
  };
  return handle;
}
