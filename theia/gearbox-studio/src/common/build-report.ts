// Constructor Studio: what Build and Run tell the Studio server about a build
// (ADR-0045 phase 2) -- its start, and how it ended, with the first error.
//
// Build and Run type `cargo` into a terminal, so the IDE does not hold the
// process: how a build ended is read off what the terminal prints. Cargo says
// it plainly -- `Finished ... target(s) in` when the build is done, `Running
// \`...\`` when Run starts the binary, `error: could not compile` or `error:
// failed to run custom build command` when it stopped -- and the first `error`
// line is the one a member needs. The build output stays on the machine; only
// that line goes to the server.

/** Strip the colour and cursor sequences a terminal prints. */
export function plainText(chunk: string): string {
  // eslint-disable-next-line no-control-regex
  return chunk.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** How a build ended, as its output says. */
export interface BuildOutcome {
  readonly status: "passed" | "failed";
  /** The first error line, when it failed. */
  readonly failure?: string;
  /** The step it failed in: `toolchain`, `protoc`, `build script`, `compile` or `link`. */
  readonly failureStep?: string;
}

/** The step a first error belongs to, from its words. */
export function failureStep(line: string): string {
  if (/protoc/i.test(line)) return "protoc";
  if (/not recognized as|command not found|no such command/i.test(line)) return "toolchain";
  if (/linking with|link\.exe|linker|undefined reference/i.test(line)) return "link";
  if (/custom build command|build script/i.test(line)) return "build script";
  return "compile";
}

const PASSED_BUILD = /^\s*Finished\b.*\btarget\(s\) in\b/;
const PASSED_RUN = /^\s*Running\s+`/;
const STOPPED =
  /^error: (could not compile|linking with|aborting due to)|^error: process didn't exit successfully|^warning: build failed/;
// A build script that failed prints its own output after this line, and with
// one job running nothing follows that says the build stopped: the build is
// over once the terminal falls quiet (`BuildWatcher.idle`).
const SCRIPT_FAILED = /^error: failed to run custom build command/;
const FIRST_ERROR = /^error(\[E\d+\])?:\s*\S/;
const NO_CARGO = /'cargo' is not recognized|cargo: command not found|cargo: not found/;

/**
 * Reads a Build or Run terminal's output as it arrives and says, once, how the
 * build ended. A Run has passed its build when cargo starts the binary.
 */
export class BuildWatcher {
  protected pending = "";
  protected firstError: string | undefined;
  protected done = false;
  protected stopping = false;

  constructor(protected readonly action: "build" | "run") {}

  /** Feed one chunk of output; the outcome when this chunk ends the build. */
  feed(chunk: string): BuildOutcome | undefined {
    if (this.done) return undefined;
    const text = this.pending + plainText(chunk).replace(/\r(?!\n)/g, "\n");
    const lines = text.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      const outcome = this.line(line);
      if (outcome !== undefined) {
        this.done = true;
        return outcome;
      }
    }
    return undefined;
  }

  /**
   * The terminal fell quiet: a build that was stopping (a build script
   * failed) has ended. Undefined otherwise -- quiet alone is not an outcome,
   * cargo is often silent while it compiles.
   */
  idle(): BuildOutcome | undefined {
    if (this.done || !this.stopping) return undefined;
    this.done = true;
    return this.failed(this.pending);
  }

  protected failed(line: string): BuildOutcome {
    const failure = this.firstError ?? line.trim().slice(0, 500);
    return { status: "failed", failure, failureStep: failureStep(failure) };
  }

  protected line(raw: string): BuildOutcome | undefined {
    const line = raw.trimEnd();
    if (NO_CARGO.test(line)) {
      return { status: "failed", failure: line.trim().slice(0, 500), failureStep: "toolchain" };
    }
    if (this.firstError === undefined && FIRST_ERROR.test(line)) this.firstError = line.trim().slice(0, 500);
    // A panic in a build script (protoc missing) prints its message after
    // the `error:` line that names the script; the message is what helps.
    if (this.firstError !== undefined && /^\s*(thread '.*' panicked|Error: Custom \{|.*Could not find `protoc`)/.test(line)) {
      const detail = line.trim().slice(0, 500);
      if (/protoc/i.test(detail) && !/protoc/i.test(this.firstError)) this.firstError = detail;
    }
    if (SCRIPT_FAILED.test(line)) this.stopping = true;
    if (STOPPED.test(line)) return this.failed(line);
    if (PASSED_BUILD.test(line) && this.action === "build") return { status: "passed" };
    if (PASSED_RUN.test(line) && this.action === "run") return { status: "passed" };
    return undefined;
  }
}

/** One report to the Studio server, as `POST .../builds` takes it, less
 *  `where` -- the Studio extension that sends it knows whether this is a
 *  desktop or a session. */
export interface BuildReport {
  readonly build_id: string;
  readonly action: "build" | "run";
  readonly status: "running" | "passed" | "failed" | "cancelled";
  readonly product: string;
  readonly profile?: string;
  readonly commit?: string;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly failure?: string;
  readonly failure_step?: string;
  /** What a Publish put in the registry (ADR-0048): the images by application, and the chart. */
  readonly images?: readonly { readonly app: string; readonly image: string }[];
  readonly chart_ref?: string;
  readonly chart_version?: string;
}

/** A build id: unique enough per machine, and what the server takes (8-64 of `[A-Za-z0-9-]`). */
export function newBuildId(now: number = Date.now(), random: () => number = Math.random): string {
  const rand = Math.floor(random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `b-${now.toString(36)}-${rand}`;
}
