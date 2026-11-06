import { describe, expect, it } from "vitest";

import {
  BUILTIN_PHASES,
  canMove,
  defaultStatus,
  firstPhase,
  lifecycleField,
  parsePhases,
  phaseKeyFor,
  phaseMoves,
  phasesOf,
  phasesProblem,
  phaseTone,
  resolvePhase,
  statusText,
} from "./project-lifecycle";

const P = BUILTIN_PHASES;

describe("reading a stored list", () => {
  it("is null when the document holds none, so the caller looks further", () => {
    expect(parsePhases(null)).toBeNull();
    expect(parsePhases({ types: [] })).toBeNull();
    expect(parsePhases({ phases: "no" })).toBeNull();
  });

  it("keeps the well-formed entries and says a status for each", () => {
    expect(
      parsePhases({
        phases: [
          { key: "alpha", label: "Alpha" },
          { key: "alpha", label: "Again" },
          { key: "", label: "No key" },
          { key: "ga", label: "GA", status: "Generally available" },
          { key: "gone", label: "Retired", closing: true },
        ],
      }),
    ).toEqual([
      { key: "alpha", label: "Alpha", status: "In alpha" },
      { key: "ga", label: "GA", status: "Generally available" },
      { key: "gone", label: "Retired", status: "Retired", closing: true },
    ]);
  });

  it("is no list when nothing but closing phases is left", () => {
    expect(parsePhases({ phases: [{ key: "x", label: "X", closing: true }] })).toBeNull();
  });

  it("takes the nearest document that has a list, else the built-in one", () => {
    const org = { types: [], phases: [{ key: "a", label: "A" }] };
    expect(phasesOf({ types: [] }, org).map((p) => p.key)).toEqual(["a"]);
    expect(phasesOf(null, undefined)).toBe(BUILTIN_PHASES);
  });

  it("words a status from the label", () => {
    expect(defaultStatus("Testing")).toBe("In testing");
    expect(defaultStatus("Archived", true)).toBe("Archived");
  });
});

describe("a project's phase", () => {
  it("is read by key", () => {
    expect(resolvePhase(P, "testing").phase?.label).toBe("Testing");
    expect(statusText(P, "production")).toBe("In production");
  });

  it("reads the statuses from before phases as the phases they meant", () => {
    expect(resolvePhase(P, "draft").phase?.key).toBe("discovery");
    expect(resolvePhase(P, "active").phase?.key).toBe("development");
    expect(resolvePhase(P, "archived").phase?.key).toBe("archived");
  });

  it("says a value the list lost as it is, and none as no phase", () => {
    expect(resolvePhase(P, "pilot")).toEqual({ phase: null, unknown: "pilot" });
    expect(statusText(P, "pilot")).toBe("pilot");
    expect(statusText(P, undefined)).toBe("No phase");
  });

  it("is toned by where it is on the ladder", () => {
    expect(phaseTone(P, "production")).toBe("ok");
    expect(phaseTone(P, "testing")).toBe("info");
    expect(phaseTone(P, "archived")).toBe("neutral");
    expect(phaseTone(P, "pilot")).toBe("warn");
    expect(phaseTone(P, null)).toBe("neutral");
  });

  it("starts in the first working phase", () => {
    expect(firstPhase(P)?.key).toBe("discovery");
  });
});

describe("moving between phases", () => {
  it("goes one step either way and may close from anywhere", () => {
    const m = phaseMoves(P, "testing");
    expect(m.forward?.key).toBe("production");
    expect(m.back?.key).toBe("development");
    expect(m.close.map((p) => p.key)).toEqual(["archived"]);
    expect(m.reopen).toBeNull();
  });

  it("has no step past either end", () => {
    expect(phaseMoves(P, "discovery").back).toBeNull();
    expect(phaseMoves(P, "production").forward).toBeNull();
  });

  it("reopens a closed project in the last working phase", () => {
    const m = phaseMoves(P, "archived");
    expect(m.reopen?.key).toBe("production");
    expect(m.forward).toBeNull();
    expect(m.close).toEqual([]);
  });

  it("lets a project with no phase, or a lost one, be put in any", () => {
    expect(phaseMoves(P, undefined).any).toHaveLength(P.length);
    expect(phaseMoves(P, "pilot").any).toHaveLength(P.length);
  });

  it("refuses a jump, and staying where it is", () => {
    expect(canMove(P, "discovery", "development")).toBe(true);
    expect(canMove(P, "discovery", "production")).toBe(false);
    expect(canMove(P, "testing", "testing")).toBe(false);
    expect(canMove(P, "development", "archived")).toBe(true);
    expect(canMove(P, "archived", "discovery")).toBe(false);
    expect(canMove(P, "draft", "development")).toBe(true);
    expect(canMove(P, null, "production")).toBe(true);
  });
});

describe("editing a list", () => {
  it("needs a working phase, names, and distinct keys", () => {
    expect(phasesProblem(P)).toBeNull();
    expect(phasesProblem([{ key: "a", label: "A", status: "A", closing: true }])).toMatch(/working phase/);
    expect(phasesProblem([{ key: "a", label: " ", status: "" }])).toMatch(/name/);
    expect(
      phasesProblem([
        { key: "a", label: "A", status: "" },
        { key: "a", label: "B", status: "" },
      ]),
    ).toMatch(/Two phases/);
  });

  it("makes a free key from a label", () => {
    expect(phaseKeyFor("User testing", [])).toBe("user_testing");
    expect(phaseKeyFor("Testing", ["testing"])).toBe("testing_2");
    expect(phaseKeyFor("!!!", [])).toBe("phase");
  });
});

describe("the lifecycle as a project field", () => {
  const field = lifecycleField(P);
  const facts = (status?: string) => ({ attributes: status === undefined ? {} : { status } });

  it("draws the status as a chip, toned by the ladder", () => {
    expect(field.chip!(facts("testing"))).toMatchObject({ key: "testing", text: "In testing", tone: "info" });
    expect(field.chip!(facts())).toMatchObject({ key: "none", text: "No phase" });
  });

  it("moves by writing the phase into `status`", () => {
    expect(field.moves!(facts("testing"))).toEqual([
      { label: "Move to Production →", patch: { status: "production" } },
      { label: "← Back to Development", patch: { status: "development" } },
      { label: "Move to Archived", patch: { status: "archived" } },
    ]);
    expect(field.moves!(facts("archived"))).toEqual([{ label: "Reopen in Production", patch: { status: "production" } }]);
  });

  it("claims `status`, so no generic filter repeats it", () => {
    expect(field.claims).toEqual(["status"]);
    expect(field.initial!()).toEqual({ status: "discovery" });
  });
});
