import { describe, expect, it } from "vitest";

import { DOMAINS } from "./architecture";
import { FLOW_DOORS, FLOW_STEPS, FLOW_ZONES, RESEARCH_PROPOSAL, flowGears, nodeById, stepById, stepsThrough } from "./architecture-flow";

describe("the block diagram", () => {
  it("names only gears the domain table knows", () => {
    const known = new Set(DOMAINS.flatMap((d) => d.gears));
    expect(flowGears().filter((g) => !known.has(g))).toEqual([]);
  });

  it("keeps box and step ids unique", () => {
    const nodes = FLOW_ZONES.flatMap((z) => z.nodes.map((n) => n.id));
    expect(new Set(nodes).size).toBe(nodes.length);
    const steps = FLOW_STEPS.map((s) => s.id);
    expect(new Set(steps).size).toBe(steps.length);
  });

  it("sends every step through boxes that exist", () => {
    for (const step of FLOW_STEPS) {
      expect(step.nodes.length, step.id).toBeGreaterThan(0);
      for (const id of step.nodes) expect(nodeById(id), `${step.id} → ${id}`).toBeDefined();
    }
  });

  it("says what is missing wherever a step is not fully built", () => {
    for (const step of FLOW_STEPS) {
      if (step.state === "built") expect(step.gap, step.id).toBeUndefined();
      else expect(step.gap, step.id).toBeTruthy();
    }
  });

  it("leaves no box no step passes through", () => {
    const unused = FLOW_ZONES.flatMap((z) => z.nodes).filter((n) => stepsThrough(n.id).length === 0);
    expect(unused.map((n) => n.id)).toEqual([]);
  });

  it("numbers the steps through a box in reading order", () => {
    expect(stepsThrough("keycloak")).toEqual([1, 8]);
    expect(stepsThrough("sessions")).toEqual([3, 4, 7]);
    expect(stepById("deploy")?.state).toBe("partial");
  });

  it("points the Research proposal at doors that exist", () => {
    const doors = new Set(FLOW_DOORS.map((d) => d.id));
    for (const r of RESEARCH_PROPOSAL) expect(doors.has(r.door), r.title).toBe(true);
  });
});
