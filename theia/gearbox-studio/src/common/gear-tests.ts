// Constructor Studio: running a product's tests gear by gear, and reading how
// they went.
//
// A gear is a crate, and its tests are that crate's `cargo test`. They run
// in the gear's own workspace -- `--manifest-path` at the crate in its source
// -- rather than as `cargo test -p <crate>` in the generated tree: there the
// gear is a path dependency, not a member, and cargo refuses to test a
// non-member that has dev-dependencies ("cannot be tested because it requires
// dev-dependencies and is not a member of the workspace"). Only when the
// crate's folder is not known (its source root is not on this machine) is
// `-p` tried, in the generated tree.
//
// Pass or fail is the command's exit code; the counts come from libtest's
// `test result:` lines in the terminal's output, one per test binary and one
// for the doc tests, added up.

import type { ResolvedProduct } from "./generated/ResolvedProduct";

/** How long a gear's tests may run before Studio stops waiting for them. */
export const TEST_WAIT_MS = 30 * 60_000;

/** One gear whose tests can be run. */
export interface GearTestTarget {
  readonly gear: string;
  readonly crate: string;
  /** The crate's Cargo.toml on this machine, when its source root is known. */
  readonly manifest?: string;
}

/**
 * The product's gears, by id, with where each crate is. `crateDirOf` answers
 * the absolute folder of a gear's crate (from its source and `crate_dir`),
 * or `undefined` when it is not on this machine.
 */
export function gearTestTargetsOf(
  product: ResolvedProduct,
  crateDirOf: (source: string, crateDir: string) => string | undefined,
): GearTestTarget[] {
  return Object.values(product.gears)
    .filter((gear) => gear !== undefined)
    .map((gear) => {
      const dir = crateDirOf(gear.source, gear.crate_dir);
      return {
        gear: gear.id,
        crate: gear.package.crate_name,
        ...(dir !== undefined ? { manifest: `${dir.replace(/[\\/]+$/, "")}/Cargo.toml` } : {}),
      };
    })
    .sort((a, b) => a.gear.localeCompare(b.gear));
}

/** The command that runs one gear's tests, from the generated tree's folder. */
export function testCommand(target: GearTestTarget): string {
  return target.manifest !== undefined ? `cargo test --manifest-path "${target.manifest}"` : `cargo test -p ${target.crate}`;
}

/** What libtest said, added up over every test binary it ran. */
export interface TestSummary {
  /** `test result:` lines read: one per test binary, and the doc tests. */
  readonly suites: number;
  readonly passed: number;
  readonly failed: number;
  readonly ignored: number;
  /** The tests reported as failing (`test <name> ... FAILED`), in order, at most `MAX_FAILING`. */
  readonly failing: readonly string[];
}

export const MAX_FAILING = 20;

const RESULT = /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/;
const FAILING = /^test (\S+) \.\.\. FAILED$/;

/**
 * Reads libtest's summary off a terminal's output as it comes, in chunks
 * that break lines anywhere. Colours are dropped; other escape sequences
 * (Windows' console moves the cursor) end a line.
 */
export class TestSummaryReader {
  protected buffer = "";
  protected suites = 0;
  protected passed = 0;
  protected failed = 0;
  protected ignored = 0;
  protected failing: string[] = [];

  feed(chunk: string): void {
    const plain = chunk
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*m/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*\x07/g, "");
    const lines = (this.buffer + plain).split(/\r?\n|\r/);
    this.buffer = lines.pop() ?? "";
    lines.forEach((line) => this.read(line));
  }

  protected read(line: string): void {
    const text = line.trim();
    const result = RESULT.exec(text);
    if (result !== null) {
      this.suites++;
      this.passed += Number(result[1]);
      this.failed += Number(result[2]);
      this.ignored += Number(result[3]);
      return;
    }
    const failing = FAILING.exec(text);
    if (failing !== null && this.failing.length < MAX_FAILING && !this.failing.includes(failing[1] as string)) {
      this.failing.push(failing[1] as string);
    }
  }

  /** What was read so far, the unfinished last line included. */
  summary(): TestSummary {
    const rest = new TestSummaryReader();
    rest.suites = this.suites;
    rest.passed = this.passed;
    rest.failed = this.failed;
    rest.ignored = this.ignored;
    rest.failing = [...this.failing];
    if (this.buffer !== "") rest.read(this.buffer);
    return { suites: rest.suites, passed: rest.passed, failed: rest.failed, ignored: rest.ignored, failing: rest.failing };
  }
}

/** Where one gear's tests are. */
export interface GearTestState {
  readonly status: "running" | "passed" | "failed";
  /** Counts, once a `test result:` line was read. */
  readonly passed?: number;
  readonly failed?: number;
  readonly ignored?: number;
  readonly failing?: readonly string[];
  /** Why it failed, when no test did: it did not compile, or it was stopped. */
  readonly why?: string;
}

/** How a gear's tests ended: by the exit code, with what libtest counted. */
export function testStateOf(end: { readonly ok: boolean; readonly why?: string }, summary: TestSummary): GearTestState {
  const counts =
    summary.suites > 0
      ? { passed: summary.passed, failed: summary.failed, ignored: summary.ignored, ...(summary.failing.length > 0 ? { failing: summary.failing } : {}) }
      : {};
  if (end.ok) return { status: "passed", ...counts };
  const why = summary.failed > 0 ? undefined : (end.why ?? "cargo test failed");
  return { status: "failed", ...counts, ...(why !== undefined ? { why } : {}) };
}

/** The line over the list: how many gears passed, failed, are running. */
export function testTally(states: Readonly<Record<string, GearTestState | undefined>>): { passed: number; failed: number; running: number } {
  const all = Object.values(states).filter((state): state is GearTestState => state !== undefined);
  return {
    passed: all.filter((s) => s.status === "passed").length,
    failed: all.filter((s) => s.status === "failed").length,
    running: all.filter((s) => s.status === "running").length,
  };
}
