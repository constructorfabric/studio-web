import { describe, expect, it } from "vitest";
import { checksChip, checksSummary, orderComponents, type ProjectComponent, type PullRequestCheck } from "./project-checks";

const check = (state: PullRequestCheck["state"], published = true): PullRequestCheck => ({
  repo: "a/b",
  number: 1,
  title: "t",
  head: "abc",
  state,
  description: "",
  files: [],
  published,
});

describe("pull request checks", () => {
  it("summarises what was checked and what was set", () => {
    expect(checksSummary({ items: [check("success"), check("failure", false)], total: 2, pulls: 5, reached: true })).toBe(
      "2 pull requests checked · 1 fails · 1 status not set on the host",
    );
    expect(checksSummary({ items: [], total: 0, pulls: 3, reached: true })).toMatch(/None of the 3/);
    expect(checksSummary({ items: [], total: 0, pulls: 0, reached: false })).toMatch(/No repository/);
  });
});

describe("the pull request checks chip", () => {
  it("says how many pass or fail, in a tone", () => {
    expect(checksChip({ items: [check("success"), check("success")], total: 2, pulls: 2, reached: true })).toEqual({
      text: "PR checks: 2 pass",
      tone: "ok",
    });
    expect(checksChip({ items: [check("success"), check("failure")], total: 2, pulls: 2, reached: true })).toEqual({
      text: "PR checks: 1 of 2 fail",
      tone: "danger",
    });
    expect(checksChip({ items: [], total: 0, pulls: 0, reached: false }).tone).toBe("neutral");
  });
});

describe("components beyond gears", () => {
  const c = (name: string, readiness: ProjectComponent["readiness"]): ProjectComponent => ({
    repo: "a/b",
    dir: name,
    name,
    kind: "go",
    manifests: [],
    contracts: [],
    has_tests: true,
    has_readme: true,
    owners: [],
    open_pulls: 0,
    readiness,
    reasons: [],
  });
  it("puts what is not ready first", () => {
    expect(orderComponents([c("b", "ready"), c("a", "caution"), c("z", "not_ready")]).map((x) => x.name)).toEqual([
      "z",
      "a",
      "b",
    ]);
  });
});
