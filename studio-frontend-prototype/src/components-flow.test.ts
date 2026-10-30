import { describe, expect, it } from "vitest";

import type { Candidate, PlanRow } from "./api";
import {
  alsoCovers,
  productSteps,
  applyFix,
  codeDiff,
  codeGears,
  fixesFrom,
  nextStep,
  plainText,
  productionFixes,
  recommended,
  rowShortlist,
  type FlowState,
} from "./components-flow";

const cand = (name: string, extra: Partial<Candidate> = {}): Candidate => ({
  name,
  kind: "gear",
  step: "evidence",
  score: 1,
  why: ["x"],
  built: "built",
  composable: "runs",
  ...extra,
});
const row = (capability: string, candidates: Candidate[]): PlanRow => ({ capability, candidates, gap: false, unbuilt: false });

describe("plainText", () => {
  it("drops the markdown around a quoted statement", () => {
    expect(plainText("**Purpose**: The `deploy/README.md` and [runbook](x.md) stack")).toBe(
      "Purpose: The deploy/README.md and runbook stack",
    );
    expect(plainText("- __Must__ run on premises")).toBe("Must run on premises");
  });
});

describe("fixes from the engine's completion", () => {
  const completion = {
    gears: ["a", "rg-tr-plugin"],
    changes: [
      { gear: "rg-tr-plugin", added: true, reason: "tenant-resolver needs a plugin" },
      { gear: "dead", added: false, reason: "no gear.gdl" },
      { gear: "rg-tr-plugin", added: true, reason: "again" },
    ],
    config: { "keycloak-idp-plugin": { vendor: "cf" }, a: { port: 1 } },
  };

  it("lists each change once, and only config that differs", () => {
    const fixes = fixesFrom(["a", "dead"], { a: { port: 1 } }, completion);
    expect(fixes).toEqual([
      { kind: "add", gear: "rg-tr-plugin", reason: "tenant-resolver needs a plugin" },
      { kind: "remove", gear: "dead", reason: "no gear.gdl" },
      { kind: "config", gear: "keycloak-idp-plugin", field: "vendor", value: "cf", reason: "the engine needs vendor = cf" },
    ]);
  });

  it("applies one fix at a time", () => {
    const [add, remove, config] = fixesFrom(["a", "dead"], { dead: { x: 1 } }, completion);
    expect(applyFix(["a"], {}, add).picks).toEqual(["a", "rg-tr-plugin"]);
    expect(applyFix(["a", "dead"], { dead: { x: 1 } }, remove)).toEqual({ picks: ["a"], config: {} });
    expect(applyFix(["a"], {}, config).config).toEqual({ "keycloak-idp-plugin": { vendor: "cf" } });
  });

  it("asks for a picked gear's settings instead of taking it out", () => {
    const [setup] = fixesFrom(["oidc"], {}, {
      gears: ["oidc"],
      changes: [{ gear: "oidc", added: false, reason: "needs configuration: jwt", needs: ["jwt"] }],
    });
    expect(setup).toEqual({ kind: "setup", gear: "oidc", fields: ["jwt"], reason: "needs configuration: jwt" });
    expect(applyFix(["oidc"], {}, setup)).toEqual({ picks: ["oidc"], config: {} });
  });
});

describe("a production rule the product breaks", () => {
  const acceptAll = {
    code: "GBX0325",
    severity: "error",
    message:
      "profile `prod` breaks a production rule: `static-authn-plugin` in `accept_all` mode authenticates every request (ADR-0011 section 3)",
  };
  const picks = ["cf-gears-authn-resolver", "cf-gears-static-authn-plugin"];

  it("offers OIDC in place of static sign-in, named as the catalogue names it", () => {
    const [fix] = productionFixes(picks, [acceptAll]);
    expect(fix).toMatchObject({ kind: "replace", gear: "cf-gears-static-authn-plugin", with: "cf-gears-oidc-authn-plugin" });
    expect(applyFix(picks, { "cf-gears-static-authn-plugin": { mode: "accept_all" } }, fix)).toEqual({
      picks: ["cf-gears-authn-resolver", "cf-gears-oidc-authn-plugin"],
      config: {},
    });
  });

  it("only takes static sign-in out when OIDC is already there, and nothing without the error", () => {
    expect(productionFixes([...picks, "cf-gears-oidc-authn-plugin"], [acceptAll])).toMatchObject([
      { kind: "remove", gear: "cf-gears-static-authn-plugin" },
    ]);
    expect(productionFixes(picks, [{ ...acceptAll, severity: "warning" }])).toEqual([]);
    expect(productionFixes(["cf-gears-authn-resolver"], [acceptAll])).toEqual([]);
  });
});

describe("the product against the code", () => {
  it("keeps only pickable gears and says what changes", () => {
    expect(codeGears({ components_in_code: ["api-gateway", "@cf/ui"] })).toEqual(["api-gateway"]);
    expect(codeDiff(["a", "b"], ["b", "c"])).toEqual({ add: ["c"], drop: ["a"], keep: ["b"] });
  });
});

describe("a shorter section 1", () => {
  const auth = row("auth", [
    cand("docs", { built: "docs-only" }),
    cand("blocked", { composable: "blocked" }),
    cand("best"),
    cand("other"),
  ]);

  it("recommends a built gear the engine can run", () => {
    expect(recommended(auth)?.name).toBe("best");
  });

  it("shows the recommended one and the picks, and folds the rest", () => {
    const { shown, hidden } = rowShortlist(auth, ["other"], false);
    expect(shown.map((c) => c.name)).toEqual(["best", "other"]);
    expect(hidden).toBe(2);
    expect(rowShortlist(auth, [], true).hidden).toBe(0);
  });

  it("says when one gear answers several capabilities", () => {
    expect(alsoCovers([row("auth", [cand("authn")]), row("authz", [cand("authn"), cand("z")])])).toEqual({
      authn: ["auth", "authz"],
      z: ["authz"],
    });
  });
});

describe("the next step", () => {
  const base: FlowState = { capabilities: 8, open: 0, picks: 3, inCode: 22, resolves: true, fixes: 0, written: false, composing: true };

  it("starts from the code when the code already has gears", () => {
    expect(nextStep({ ...base, picks: 0 }).action).toBe("take-from-code");
    expect(nextStep({ ...base, picks: 0, inCode: 0 }).action).toBe("add-recommended");
  });

  it("asks for a preview, then for the fixes, before the build", () => {
    expect(nextStep({ ...base, resolves: null }).action).toBe("preview");
    expect(nextStep({ ...base, resolves: false, fixes: 3 })).toEqual({
      text: "The product does not resolve. 3 fixes below make it resolve.",
      action: "fix",
      tone: "todo",
    });
    expect(nextStep({ ...base, resolves: false }).action).toBeUndefined();
  });

  it("builds once it resolves, and says what is still open", () => {
    expect(nextStep(base).action).toBe("build");
    const gap = nextStep({ ...base, open: 2 });
    expect(gap.tone).toBe("warn");
    expect(gap.text).toContain("2 capabilities the specs ask for are not closed yet.");
    expect(nextStep({ ...base, written: true }).action).toBe("builds");
  });
});

describe("the steps from the specs to a built product", () => {
  const base: FlowState = { capabilities: 7, open: 5, picks: 0, inCode: 0, resolves: null, fixes: 0, written: false, composing: true };
  const states = (s: Partial<FlowState>) => productSteps({ ...base, ...s }).map((x) => x.state);

  it("starts on the specs", () => {
    expect(states({})).toEqual(["current", "todo", "todo"]);
    expect(productSteps(base)[0].status).toBe("7 capabilities");
  });
  it("moves on as gears are picked, the product resolves and is built", () => {
    expect(states({ picks: 3 })).toEqual(["done", "current", "todo"]);
    expect(productSteps({ ...base, picks: 3, resolves: false, fixes: 1 })[1].status).toBe("does not resolve · 1 fix");
    expect(states({ picks: 3, resolves: true })).toEqual(["done", "done", "current"]);
    expect(states({ picks: 3, resolves: true, written: true })).toEqual(["done", "done", "done"]);
  });
  it("is not built while it no longer resolves, and says how the capabilities are closed", () => {
    expect(states({ picks: 3, resolves: false, written: true })).toEqual(["done", "current", "todo"]);
    const s = productSteps({ ...base, picks: 3, covered: 2, weak: 5, open: 0, resolves: false, written: true });
    expect(s[0].status).toBe("7 capabilities · 2 closed, 5 only by words");
    expect(s[2].status).toBe("built earlier · build again once it resolves");
  });
  it("cannot compose without the engine", () => {
    expect(states({ composing: false })).toEqual(["current", "off", "off"]);
  });
});
