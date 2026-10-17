import { describe, expect, it } from "vitest";

import type { Candidate, PlanRow } from "./api";
import type { ProjectComponent } from "./project-checks";
import { inventory } from "./project-inventory";

const cand = (name: string, extra: Partial<Candidate> = {}): Candidate =>
  ({ name, kind: "gear", built: "built", step: "evidence", declared: false, ...extra }) as Candidate;
const need = (capability: string, candidates: Candidate[], extra: Partial<PlanRow> = {}): PlanRow =>
  ({ capability, candidates, gap: false, unbuilt: false, nonfunctional: false, ...extra }) as PlanRow;

describe("what a project is made of", () => {
  const plan = [
    need("tenancy", [cand("tenant-resolver", { tier: "platform", step: "contract" }), cand("cluster", { tier: "platform" })]),
    need("domain", [cand("studio-domain-model", { tier: "project", declared: true }), cand("probe", { origin: "project", registry_state: "candidate" })]),
    need("billing", [], { gap: true }),
  ];
  const service = { repo: "org/app", dir: "web", name: "web", kind: "npm", readiness: "ready", reasons: [], owners: [] } as unknown as ProjectComponent;
  const rows = inventory(plan, { components_in_code: ["tenant-resolver", "serde-helper"] } as never, ["tenant-resolver"], [service], (r) => !!r.gap);
  const by = (name: string) => rows.find((r) => r.name === name);

  it("takes the platform's components the product or the code uses, not every one offered", () => {
    expect(by("tenant-resolver")).toMatchObject({ role: "platform", inProduct: true, inCode: true, answers: ["tenancy"] });
    expect(by("cluster")).toBeUndefined();
    expect(by("serde-helper")).toMatchObject({ role: "platform", inCode: true, inProduct: false, answers: [] });
  });
  it("keeps its own gears and the code that could become one", () => {
    expect(by("studio-domain-model")).toMatchObject({ role: "ours", answers: ["domain"] });
    expect(by("probe")).toMatchObject({ role: "could", answers: [] });
  });
  it("offers a gear to create for what the documents ask and nothing answers, and lists the services", () => {
    expect(rows.find((r) => r.role === "create")).toMatchObject({ name: "A gear for billing", answers: ["billing"] });
    expect(by("web")).toMatchObject({ role: "service", path: "org/app/web" });
  });
  it("puts its own first, the services last", () => {
    expect(rows.map((r) => r.role)).toEqual(["ours", "could", "create", "platform", "platform", "service"]);
  });

  it("lists every gear its own code declares, offered or not, as in its code", () => {
    const own = [
      { name: "studio-domain-model", kind: "gear" },
      { name: "studio-documents", kind: "gear", path: "studio-backend/src/documents" },
      { name: "github-connector-plugin", kind: "plugin" },
    ];
    const withOwn = inventory(plan, { components_in_code: ["studio-documents"] } as never, [], [], () => false, own);
    const find = (name: string) => withOwn.find((r) => r.name === name);
    expect(find("studio-domain-model")).toMatchObject({ role: "ours", inCode: true, answers: ["domain"] });
    expect(find("studio-documents")).toMatchObject({ role: "ours", inCode: true, path: "studio-backend/src/documents" });
    expect(find("github-connector-plugin")).toMatchObject({ role: "ours", kind: "plugin" });
    // Its code holds studio-documents, and it is still the project's, not the platform's.
    expect(withOwn.filter((r) => r.name === "studio-documents")).toHaveLength(1);
  });
});
