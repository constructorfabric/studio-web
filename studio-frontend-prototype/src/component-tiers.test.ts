import { describe, expect, it } from "vitest";

import type { CatalogNode, CatalogRepoSource } from "./api";
import {
  annotationNote,
  inTierTab,
  nodeTier,
  shadowedNote,
  shadowedSources,
  sourceShadowHint,
  tierCounts,
  withoutSource,
} from "./component-tiers";

const node = (name: string, tier?: "platform" | "organization"): CatalogNode => ({
  type_id: "gts.cf.studio.catalog.gear.v1~",
  instance_id: `gear:${name}`,
  value: { name, ...(tier ? { tier } : {}) },
});

const source = (repo: string, mode: string, shadowed?: boolean): CatalogRepoSource => ({
  tenant: "t",
  connection_id: null,
  repo,
  git_ref: null,
  mode,
  ...(shadowed === undefined ? {} : { shadowed_by_platform: shadowed }),
});

describe("component tiers", () => {
  it("files each node under its tier, an untiered one as the organization's", () => {
    const nodes = [node("ledger", "platform"), node("billing", "organization"), node("old")];
    expect(nodes.map(nodeTier)).toEqual(["platform", "organization", "organization"]);
    expect(nodes.filter((n) => inTierTab(n, "platform")).map((n) => n.value.name)).toEqual(["ledger"]);
    expect(nodes.filter((n) => inTierTab(n, "organization")).map((n) => n.value.name)).toEqual([
      "billing",
      "old",
    ]);
    expect(nodes.filter((n) => inTierTab(n, "all"))).toHaveLength(3);
    expect(tierCounts(nodes)).toEqual({ platform: 1, organization: 2, all: 3 });
  });

  it("says which components the platform shadows, and nothing when none", () => {
    expect(shadowedNote([])).toBeNull();
    expect(shadowedNote(undefined)).toBeNull();
    expect(shadowedNote(["cf-gears-ledger"])).toContain("1 of your organization's components is also the platform's");
    const many = shadowedNote(["a", "b", "c", "d", "e", "f", "g"]);
    expect(many).toContain("7 of your organization's components");
    expect(many).toContain("a, b, c, d, e and 2 more");
  });

  it("marks a source the platform already reads, and removing it keeps the rest", () => {
    const items = [
      source("constructorfabric/gears-rust", "gears", true),
      source("acme/gears", "gears", false),
      source("acme/kits", "kits"),
    ];
    expect(shadowedSources(items).map((s) => s.repo)).toEqual(["constructorfabric/gears-rust"]);
    expect(sourceShadowHint(items[0])).toContain("The platform already provides constructorfabric/gears-rust (gears)");
    expect(withoutSource(items, source("ConstructorFabric/Gears-Rust", "gears")).map((s) => s.repo)).toEqual([
      "acme/gears",
      "acme/kits",
    ]);
  });

  it("explains that a platform component's edits are the organization's annotation", () => {
    expect(annotationNote(node("ledger", "platform"))).toContain("your organization's annotation");
    expect(annotationNote(node("billing", "organization"))).toBeNull();
  });
});
