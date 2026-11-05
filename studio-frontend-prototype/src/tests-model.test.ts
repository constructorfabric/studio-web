import { describe, expect, it } from "vitest";

import type { CiJob, CiRun } from "./api";
import {
  dailyStrip,
  durationLabel,
  failedJobLabel,
  failedJobs,
  mainline,
  passRate,
  pullRun,
  pullsCi,
  readProblem,
  runSeconds,
  specCode,
} from "./tests-model";

const NOW = Date.parse("2026-10-19T12:00:00Z");

function run(id: string, over: Partial<CiRun> = {}): CiRun {
  return {
    id,
    repo: "repo-1",
    workflow: "CI",
    workflow_path: ".github/workflows/ci.yml",
    title: id,
    event: "push",
    branch: "main",
    sha: `${id}0000000`,
    status: "completed",
    conclusion: "success",
    url: null,
    number: 1,
    created_at: "2026-10-19T10:00:00Z",
    updated_at: null,
    jobs: [],
    ...over,
  };
}

function job(name: string, over: Partial<CiJob> = {}): CiJob {
  return {
    name,
    status: "completed",
    conclusion: "success",
    failed_step: null,
    started_at: null,
    completed_at: null,
    duration_seconds: null,
    url: null,
    ...over,
  };
}

describe("failed jobs", () => {
  it("names the failed jobs and the step each failed at, skipping the rest", () => {
    const r = run("a", {
      conclusion: "failure",
      jobs: [
        job("build"),
        job("test-backend", { conclusion: "failure", failed_step: "cargo test" }),
        job("deploy", { conclusion: "skipped" }),
        job("lint", { conclusion: "failure" }),
      ],
    });
    const failed = failedJobs(r);
    expect(failed.map(failedJobLabel)).toEqual(["test-backend → cargo test", "lint"]);
  });

  it("reads a run whose jobs were never synced as no failed jobs", () => {
    expect(failedJobs({ jobs: undefined })).toEqual([]);
  });
});

describe("mainline", () => {
  it("is the server's latest completed run, with the branch's week", () => {
    const items = [
      run("new", { conclusion: "failure", created_at: "2026-10-19T10:00:00Z" }),
      run("y", { created_at: "2026-10-18T10:00:00Z" }),
      run("x", { created_at: "2026-10-15T10:00:00Z" }),
      run("cancelled", { conclusion: "cancelled", created_at: "2026-10-17T10:00:00Z" }),
      run("old", { created_at: "2026-10-01T10:00:00Z" }),
      run("feature", { branch: "feat/x", conclusion: "failure", created_at: "2026-10-19T09:00:00Z" }),
      run("live", { status: "in_progress", conclusion: null, created_at: "2026-10-19T11:00:00Z" }),
    ];
    const m = mainline({ items, latest_completed: "new" }, NOW)!;
    expect(m.run.id).toBe("new");
    expect(m.status).toBe("failed");
    expect(m.branch).toBe("main");
    // new (failed), y, x: cancelled, old, the feature branch and the live run are out.
    expect(m.week).toEqual({ passed: 2, finished: 3 });
    expect(passRate(m.week!)).toBe("66%");
  });

  it("says nothing before any run finished", () => {
    expect(mainline({ items: [run("live", { status: "queued" })], latest_completed: null }, NOW)).toBeNull();
  });
});

describe("the 14-day strip", () => {
  it("has every day, oldest first, counting green and red only", () => {
    const strip = dailyStrip(
      [
        run("a", { created_at: "2026-10-19T01:00:00Z" }),
        run("b", { created_at: "2026-10-19T02:00:00Z", conclusion: "failure" }),
        run("c", { created_at: "2026-10-19T03:00:00Z", conclusion: "cancelled" }),
        run("d", { created_at: "2026-10-06T23:00:00Z" }),
        run("e", { created_at: "2026-10-05T23:00:00Z" }),
        run("f", { created_at: null }),
      ],
      NOW,
    );
    expect(strip).toHaveLength(14);
    expect(strip[0]).toEqual({ day: "2026-10-06", passed: 1, failed: 0 });
    expect(strip[13]).toEqual({ day: "2026-10-19", passed: 1, failed: 1 });
    expect(strip.slice(1, 13).every((d) => d.passed === 0 && d.failed === 0)).toBe(true);
  });
});

describe("pull requests' CI", () => {
  const paths = new Map([
    ["repo-1", "o/one"],
    ["repo-2", "o/two"],
  ]);
  const runs = [
    run("old", { branch: "feat/a", created_at: "2026-10-18T00:00:00Z", conclusion: "failure" }),
    run("new", { branch: "feat/a", created_at: "2026-10-19T00:00:00Z" }),
    run("other-repo", { branch: "feat/a", repo: "repo-2", created_at: "2026-10-19T05:00:00Z", conclusion: "failure" }),
    run("b", { branch: "feat/b", status: "in_progress", conclusion: null }),
  ];

  it("is the newest run on the branch in the pull request's repository", () => {
    expect(pullRun({ repo: "o/one", source_branch: "feat/a" }, runs, paths)?.id).toBe("new");
    expect(pullRun({ repo: "o/two", source_branch: "feat/a" }, runs, paths)?.id).toBe("other-repo");
    expect(pullRun({ repo: null, source_branch: "feat/a" }, runs, paths)?.id).toBe("other-repo");
    expect(pullRun({ repo: "o/one", source_branch: null }, runs, paths)).toBeNull();
  });

  it("counts green, red, running and none", () => {
    expect(
      pullsCi(
        [
          { repo: "o/one", source_branch: "feat/a" },
          { repo: "o/two", source_branch: "feat/a" },
          { repo: "o/one", source_branch: "feat/b" },
          { repo: "o/one", source_branch: "feat/none" },
        ],
        runs,
        paths,
      ),
    ).toEqual({ green: 1, red: 1, running: 1, none: 1 });
  });
});

describe("durations", () => {
  it("reads seconds as a short label", () => {
    expect(durationLabel(40)).toBe("40 s");
    expect(durationLabel(360)).toBe("6 min");
    expect(durationLabel(3900)).toBe("1 h 5 min");
    expect(durationLabel(null)).toBeNull();
  });

  it("measures a run from its first job's start to its last job's end", () => {
    expect(
      runSeconds([
        job("a", { started_at: "2026-10-19T10:00:00Z", completed_at: "2026-10-19T10:02:00Z" }),
        job("b", { started_at: "2026-10-19T10:01:00Z", completed_at: "2026-10-19T10:06:30Z" }),
        job("c"),
      ]),
    ).toBe(390);
    expect(runSeconds([job("a")])).toBeNull();
    expect(runSeconds(undefined)).toBeNull();
  });
});

describe("spec ↔ code", () => {
  it("counts the functional capabilities apart from the non-functional", () => {
    const item = (status: string) => ({
      capability: status,
      status: status as "implemented",
      implemented_by: [],
      candidates: [],
    });
    expect(specCode({ items: [item("implemented"), item("implemented"), item("missing"), item("nonfunctional")] })).toEqual({
      implemented: 2,
      missing: 1,
      nonfunctional: 1,
      functional: 3,
    });
  });
});

describe("readProblem", () => {
  it("says a repository the connection cannot read in a few words, and that the connection fixes it", () => {
    expect(
      readProblem(
        "HTTP 400 · Failed Precondition — Operation precondition not met — the project's gear repository constructorfabric/studio-web could not be read: the token for connection '222' is not readable",
      ),
    ).toEqual({ short: "the repository can't be read", connection: true });
    expect(readProblem("HTTP 500 · Internal — boom")).toEqual({ short: "couldn't be checked", connection: false });
  });
});
