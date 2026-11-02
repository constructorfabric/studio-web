// A product's tests, gear by gear: which command, and how it went.
import {
  MAX_FAILING,
  TestSummaryReader,
  gearTestTargetsOf,
  testCommand,
  testStateOf,
  testTally,
} from "./gear-tests";
import type { ResolvedProduct } from "./generated/ResolvedProduct";

function gear(id: string, source: string, crate: string): unknown {
  return {
    id,
    source,
    gdl_path: `${id}/gear.gdl`,
    package: { crate_name: crate, lib_ident: crate.replace(/-/g, "_"), path: id, default_features: true },
    crate_dir: `gears/${id}`,
    selected_by: [],
  };
}

const product = {
  schema_version: 1,
  product: { id: "shop" },
  sources: {},
  gears: {
    "types-registry": gear("types-registry", "corpus", "cf-types-registry"),
    "bss-pricing": gear("bss-pricing", "remote", "bss-pricing"),
  },
  applications: [],
} as unknown as ResolvedProduct;

describe("gearTestTargetsOf", () => {
  it("lists the gears by id, with the crate's manifest where its source is on this machine", () => {
    const roots: Record<string, string> = { corpus: "C:\\corpus\\" };
    const targets = gearTestTargetsOf(product, (source, dir) => (roots[source] !== undefined ? `${roots[source]}${dir}\\` : undefined));
    expect(targets).toEqual([
      { gear: "bss-pricing", crate: "bss-pricing" },
      { gear: "types-registry", crate: "cf-types-registry", manifest: "C:\\corpus\\gears/types-registry/Cargo.toml" },
    ]);
  });
});

describe("testCommand", () => {
  it("tests the crate in its own workspace, else by package in the generated tree", () => {
    expect(testCommand({ gear: "g", crate: "cf-g", manifest: "C:/My Corpus/g/Cargo.toml" })).toBe('cargo test --manifest-path "C:/My Corpus/g/Cargo.toml"');
    expect(testCommand({ gear: "g", crate: "cf-g" })).toBe("cargo test -p cf-g");
  });
});

describe("TestSummaryReader", () => {
  it("adds up the result lines of every test binary", () => {
    const reader = new TestSummaryReader();
    reader.feed("running 3 tests\r\ntest a ... ok\r\ntest b::c ... FAILED\r\ntest d ... ignored\r\n\r\n");
    reader.feed("test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s\r\n");
    reader.feed("   Doc-tests cf_g\r\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n");
    expect(reader.summary()).toEqual({ suites: 2, passed: 3, failed: 1, ignored: 1, failing: ["b::c"] });
  });

  it("reads lines split across chunks, coloured, and the unfinished last one", () => {
    const reader = new TestSummaryReader();
    reader.feed("test x ... \x1b[31mFAI");
    reader.feed("LED\x1b[0m\ntest result: \x1b[32mok\x1b[0m. 4 pas");
    reader.feed("sed; 0 failed; 2 ignored; 0 measured");
    expect(reader.summary()).toEqual({ suites: 1, passed: 4, failed: 0, ignored: 2, failing: ["x"] });
    // Reading the summary does not count the unfinished line twice.
    reader.feed("\n");
    expect(reader.summary().suites).toBe(1);
  });

  it("ends a line at a cursor move, as Windows' console draws", () => {
    const reader = new TestSummaryReader();
    reader.feed("junk\x1b[5;1Htest result: ok. 1 passed; 0 failed; 0 ignored;\x1b[K\x1b[6;1H");
    expect(reader.summary()).toMatchObject({ suites: 1, passed: 1 });
  });

  it("keeps at most MAX_FAILING failing names, each once", () => {
    const reader = new TestSummaryReader();
    for (let i = 0; i < MAX_FAILING + 5; i++) reader.feed(`test t${i} ... FAILED\ntest t0 ... FAILED\n`);
    expect(reader.summary().failing).toHaveLength(MAX_FAILING);
    expect(reader.summary().failing[0]).toBe("t0");
  });

  it("says nothing was read when nothing ran", () => {
    expect(new TestSummaryReader().summary()).toEqual({ suites: 0, passed: 0, failed: 0, ignored: 0, failing: [] });
  });
});

describe("testStateOf", () => {
  const none = { suites: 0, passed: 0, failed: 0, ignored: 0, failing: [] };

  it("passes by the exit code, with the counts read", () => {
    expect(testStateOf({ ok: true }, { suites: 2, passed: 5, failed: 0, ignored: 1, failing: [] })).toEqual({
      status: "passed",
      passed: 5,
      failed: 0,
      ignored: 1,
    });
    expect(testStateOf({ ok: true }, none)).toEqual({ status: "passed" });
  });

  it("fails with the failing tests when tests failed", () => {
    expect(testStateOf({ ok: false, why: "it exited with 101" }, { suites: 1, passed: 1, failed: 2, ignored: 0, failing: ["a", "b"] })).toEqual({
      status: "failed",
      passed: 1,
      failed: 2,
      ignored: 0,
      failing: ["a", "b"],
    });
  });

  it("fails with the reason when no test failed: it did not build, or it was stopped", () => {
    expect(testStateOf({ ok: false, why: "error[E0425]: cannot find value" }, none)).toEqual({ status: "failed", why: "error[E0425]: cannot find value" });
    expect(testStateOf({ ok: false }, none)).toEqual({ status: "failed", why: "cargo test failed" });
  });
});

describe("testTally", () => {
  it("counts gears by status", () => {
    expect(testTally({ a: { status: "passed" }, b: { status: "failed" }, c: { status: "running" }, d: { status: "passed" }, e: undefined })).toEqual({
      passed: 2,
      failed: 1,
      running: 1,
    });
  });
});
