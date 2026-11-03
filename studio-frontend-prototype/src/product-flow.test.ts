import { describe, expect, it } from "vitest";

import { configureParts, describedGaps, lineDiff, productAttention, productFlow, type FlowFacts } from "./product-flow";
import type { Infrastructure, RunsIn } from "./product-sections";

const env = (over: Partial<RunsIn> = {}): RunsIn => ({
  environment: "dev",
  namespace: "studio",
  profile: "prod",
  profileLabel: "Kubernetes · prod",
  verdict: { state: "ok", errors: 0, check: null },
  needs: null,
  database: "its own Postgres",
  missing: [],
  unchecked: null,
  ...over,
});

const infra = (over: Partial<Infrastructure> = {}): Infrastructure => ({
  profile: "prod",
  profileLabel: "Kubernetes · prod",
  runsIn: [env()],
  needs: null,
  applications: [],
  ...over,
});

const frontend = {
  shell: { repo: "acme/web", path: "studio-frontend", ref: "main" },
  mfes: [{ repo: "acme/web", path: "studio-frontend/src-app/mfe_packages/people-mfe" }],
};

const check = { ok: true, errors: 0, warnings: 0, applications: [], gears: [], gdl_sha256: "abc" };
const preview = { ...check, profile: "prod" };

const described = `product(
    gears = [
        use_gear("api-gateway", source = "gears-rust"),
        use_gear("studio-documents", source = "studio-backend", plugins = [plugin("static-authz-plugin")]),
    ],
)`;

const facts = (over: Partial<FlowFacts> = {}): FlowFacts => ({
  product: { gears: ["cf-gears-api-gateway", "cf-studio-documents"], checks: { prod: check }, last_preview: preview, frontend: null },
  cfg: {},
  infra: infra(),
  kept: { revision: 4, text: described },
  build: { text: "0.1.0 is published. Next: deploy it.", tone: "done", go: "releases" },
  deploy: { text: "Runs in dev (studio).", tone: "done" },
  ...over,
});

describe("configuring the product", () => {
  it("reads each part off what the project holds", () => {
    const failed = { ...check, ok: false, errors: 2 };
    const [i, b, f] = configureParts(
      { gears: ["cf-gears-api-gateway"], checks: { prod: failed }, last_preview: { ...failed, profile: "prod" }, frontend },
      {},
      infra(),
    );
    expect([i.state, b.state, f.state]).toEqual(["done", "failed", "done"]);
    expect(b.status).toBe("1 gear; Kubernetes · prod (dev): 2 errors from the engine.");
    expect(f.status).toBe("1 micro-frontend on studio-frontend.");
  });

  it("marks no frontend as neither done nor waiting, and the step as configured", () => {
    const [, , f] = configureParts({ gears: [], frontend: null }, {}, infra());
    expect(f.state).toBe("none");
    expect(productFlow(facts())[0].state).toBe("done");
  });

  it("asks to save a frontend picked before the product kept it", () => {
    const [, , f] = configureParts({ gears: [], frontend: null }, { frontend: { mfes: ["@x/a"] } }, infra());
    expect(f.state).toBe("todo");
  });

  it("names what the infrastructure lacks", () => {
    const [i] = configureParts(null, null, infra({ runsIn: [env({ missing: ["PostgreSQL"] })] }));
    expect(i.state).toBe("failed");
    expect(i.status).toContain("A deploy to dev will stop: it gives no database");
  });

  it("asks for a check of the profile an environment runs, when it has none", () => {
    const [i] = configureParts(null, null, infra({ runsIn: [env({ unchecked: "not checked yet for prod" })] }));
    expect(i.state).toBe("todo");
    expect(i.status).toBe("dev: not checked yet for prod. Check it under Backend.");
  });

  it("says which profile each environment runs", () => {
    const [i] = configureParts(null, null, infra({ runsIn: [env(), env({ environment: "stage" })] }));
    expect(i.status).toBe("dev runs Kubernetes · prod; stage runs Kubernetes · prod.");
  });

  it("is done only when every bound profile's check is current and resolves", () => {
    const two = infra({ runsIn: [env(), env({ environment: "lab", profile: "local", profileLabel: "One host · local" })] });
    const product = { gears: ["cf-gears-api-gateway"], frontend: null, last_preview: preview };
    // `local` was never checked.
    const [, waiting] = configureParts({ ...product, checks: { prod: check } }, null, two);
    expect(waiting.state).toBe("todo");
    expect(waiting.status).toBe("1 gear, not checked by the engine yet for One host · local (lab).");
    // Checked, but for a description that has changed since.
    const [, stale] = configureParts({ ...product, checks: { prod: check, local: { ...check, gdl_sha256: "old" } } }, null, two);
    expect(stale.state).toBe("todo");
    const [, done] = configureParts({ ...product, checks: { prod: check, local: check } }, null, two);
    expect(done.state).toBe("done");
    expect(done.status).toBe("1 gear; resolves for Kubernetes · prod (dev), One host · local (lab).");
  });

  it("checks prod when no environment is bound", () => {
    const none = infra({ runsIn: [env({ profile: null, profileLabel: null, verdict: null })] });
    const [, b] = configureParts({ gears: ["a"], frontend: null, last_preview: { ...check, profile: "dev" }, checks: { dev: check } }, null, none);
    expect(b.status).toBe("1 gear, not checked by the engine yet for Kubernetes · prod.");
  });
});

describe("whether the saved description says the product", () => {
  it("says it when every picked gear is named and the frontend matches", () => {
    expect(describedGaps({ gears: ["cf-gears-api-gateway", "cf-gears-static-authz-plugin"], frontend: null }, described)).toEqual([]);
  });

  it("names a picked gear it lacks and a frontend it does not say", () => {
    expect(describedGaps({ gears: ["cf-gears-oagw"], frontend }, described)).toEqual(["1 picked gear not in it", "the frontend"]);
  });

  it("names a frontend the product no longer has", () => {
    expect(describedGaps({ gears: [], frontend: null }, `${described}\nfrontend = frontx_product(`)).toEqual([
      "a frontend the product no longer has",
    ]);
  });
});

describe("the way from configured to running", () => {
  it("is four steps, done when each part is", () => {
    const steps = productFlow(facts());
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ["configure", "done"],
      ["save", "done"],
      ["build", "done"],
      ["deploy", "done"],
    ]);
    expect(steps[2].tab).toBe("releases");
  });

  it("asks to save again when the product changed past its revision", () => {
    const [, save] = productFlow(facts({ product: { ...facts().product!, frontend } }));
    expect(save).toMatchObject({ state: "todo", status: "Revision 4 does not say the frontend: save it again." });
  });

  it("says a product never saved and what could not be read", () => {
    const steps = productFlow(facts({ kept: null, build: null }));
    expect(steps[1]).toMatchObject({ state: "todo", status: "Not saved yet: the build has nothing to take." });
    expect(steps[2].state).toBe("unknown");
    expect(productFlow(facts({ kept: undefined }))[1].state).toBe("unknown");
  });
});

describe("what a save changes", () => {
  it("keeps the common lines and marks what goes and what comes", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });
});

describe("when the Product tab needs a look", () => {
  it("flags the engine's errors, then a frontend not saved to the product, else nothing", () => {
    expect(productAttention({ last_preview: { ...preview, ok: false, errors: 2 }, frontend: null }, {})).toEqual({
      tone: "failed",
      count: 2,
      text: "2 errors from the engine at the last check",
    });
    expect(productAttention({ last_preview: preview, frontend: null }, { frontend: { mfes: [] } })?.tone).toBe("todo");
    expect(productAttention({ last_preview: preview, frontend }, { frontend: { mfes: [] } })).toBeNull();
    expect(productAttention(null, null)).toBeNull();
  });
});
