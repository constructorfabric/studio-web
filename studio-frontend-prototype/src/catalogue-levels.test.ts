import { describe, expect, it } from "vitest";
import type { CatalogNode } from "./api";
import {
  FRONTX_TYPE,
  KIT_TYPE,
  SERVICE_TYPE,
  byTier,
  docLink,
  docsOf,
  mayPropose,
  passportFacts,
  passportFile,
  pinRows,
  pinsFrom,
  tierOf,
} from "./catalogue-levels";

const node = (type_id: string, value: CatalogNode["value"]): CatalogNode => ({ type_id, instance_id: String(value.name), value });

describe("the two-level catalogue", () => {
  it("files each node under its tier, the project's own first", () => {
    const groups = byTier([
      node(FRONTX_TYPE, { name: "b", tier: "platform" }),
      node(FRONTX_TYPE, { name: "a", tier: "project" }),
      node(FRONTX_TYPE, { name: "c" }),
    ]);
    expect(groups.map((g) => g.tier)).toEqual(["project", "organization", "platform"]);
    expect(tierOf(node(FRONTX_TYPE, { name: "x" }))).toBe("organization");
  });

  it("shows a service passport's facts and its documents", () => {
    const s = node(SERVICE_TYPE, {
      name: "studio-theia",
      version: "1.4.0",
      image: "ghcr.io/constructorfabric/studio-theia",
      ports: { http: 3000 },
      env: { STUDIO_API_URL: "gateway.url" },
      requires: ["studio-session"],
      docs: ["theia/README.md"],
      synced_from: "constructorfabric/studio-web",
      git_ref: "main",
    });
    const facts = Object.fromEntries(passportFacts(s));
    expect(facts.Ports).toBe("http: 3000");
    expect(facts.Environment).toBe("STUDIO_API_URL: gateway.url");
    expect(facts.Requires).toBe("studio-session");
    expect(passportFile(s)).toBe("service.gdl");
    expect(docsOf(s)).toEqual(["theia/README.md"]);
    expect(docLink(s, "theia/README.md")).toBe("https://github.com/constructorfabric/studio-web/blob/main/theia/README.md");
  });

  it("reads a micro-frontend's passport from its profile", () => {
    const m = node(FRONTX_TYPE, { name: "@constructor-studio/projects-mfe", tier: "project" });
    const facts = Object.fromEntries(
      passportFacts(m, { auto: { frontx_kind: { v: "mfe", b: "mfe" }, mfe_calls: ["studio-documents", "studio-tasks"], mfe_frontx: "0.2.0-alpha.15" } }),
    );
    expect(facts.Kind).toBe("mfe");
    expect(facts.Requires).toBe("studio-documents, studio-tasks");
    expect(facts.FrontX).toBe("0.2.0-alpha.15");
    expect(mayPropose(m)).toBe(true);
    expect(mayPropose(node(FRONTX_TYPE, { name: "x", tier: "organization" }))).toBe(false);
  });

  it("says a pinned platform component's version and where a published one came from", () => {
    const k = node(KIT_TYPE, {
      name: "sdlc",
      tier: "platform",
      pinned_ref: "v1.4.0",
      passport_path: "kit.gdl",
      published_from: { project_name: "Studioweb", git_ref: "v2" },
    });
    const facts = Object.fromEntries(passportFacts(k));
    expect(facts["Pinned at"]).toBe("v1.4.0");
    expect(facts["Published from"]).toBe("Studioweb @ v2");
    expect(passportFile(k)).toBe("kit.gdl");
    expect(docLink(node(KIT_TYPE, { name: "p", synced_from: "publication:1" }), "README.md")).toBeNull();
  });

  it("edits the platform release one row per platform source", () => {
    const rows = pinRows([
      { repo: "constructorfabric/gears-rust", git_ref: "main", mode: "gears", pinned_ref: "v0.10.0" },
      { repo: "constructorfabric/gears-frontx", git_ref: "develop", mode: "frontx" },
    ]);
    expect(rows.map((r) => r.pinned)).toEqual(["v0.10.0", ""]);
    expect(pinsFrom(rows)).toEqual([{ repo: "constructorfabric/gears-rust", git_ref: "v0.10.0" }]);
  });
});
