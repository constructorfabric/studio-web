import { describe, expect, it } from "vitest";

import type { StageStatus } from "./api";
import { journeyProgress, specsStatus } from "./specs-status";

const req = (type_key: string, present: boolean) => ({
  type_key,
  present,
  conforms: present,
  analyses_outstanding: [],
});
const stage = (key: string, complete: boolean, requirements: ReturnType<typeof req>[]): StageStatus =>
  ({ key, label: key, required: true, complete, requirements }) as StageStatus;

describe("the journey's progress", () => {
  it("counts the stages that ask for something, and the types missing", () => {
    const stages = [
      stage("idea", true, []),
      stage("spec", false, [req("prd", false), req("adr", true)]),
      stage("build", false, [req("prd", false)]),
    ];
    expect(journeyProgress(stages)).toEqual({ complete: 0, total: 2, missing: ["prd"] });
  });

  it("says nothing when no stage asks for anything", () => {
    expect(journeyProgress([stage("idea", true, [])])).toBeNull();
  });
});

describe("the Specs header's status", () => {
  it("leads with the specs and adds review, findings and the journey", () => {
    expect(specsStatus({ bound: 155, needsReview: 570, findings: 213, journey: { complete: 0, total: 2 } })).toEqual({
      lead: "155 specs",
      chips: [
        { id: "review", text: "570 need review", tone: "warn" },
        { id: "findings", text: "213 open findings", tone: "danger" },
        { id: "journey", text: "journey 0/2", tone: "warn" },
      ],
    });
  });

  it("does not turn unread verdicts into zero findings", () => {
    expect(specsStatus({ bound: 3, needsReview: 0, findings: null, journey: null }).chips).toEqual([]);
    expect(specsStatus({ bound: 1, needsReview: 0, findings: 0, journey: null })).toEqual({
      lead: "1 spec",
      chips: [{ id: "findings", text: "no open findings", tone: "ok" }],
    });
  });
});
