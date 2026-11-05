/* What the product step offers for picking, and what a product project's
 * session is launched with. The composing is the engine's and is pinned in
 * studio-backend's gearbox tests; these pin the two portal-side decisions that
 * can silently break the scenario: offering something the engine can never
 * compose, and launching an IDE whose product.gdl cannot find its gears.
 */
import { describe, expect, it } from "vitest";

import type { GearboxStatus, RepoEntry } from "./api";
import type { Candidate, PlanRow } from "./api";
import {
  KUBERNETES_PROFILES,
  PRODUCT_PROFILES,
  checkLanded,
  checkOf,
  corpusErrors,
  declaredProfiles,
  defaultPicks,
  deployableProfiles,
  diagnosticsByCode,
  groupDiagnostics,
  productPathOf,
  isPickable,
  productIdFrom,
  profileLabel,
  profilesToCheck,
  sortDiagnostics,
  verdictOf,
  verdictText,
  withCorpusSource,
} from "./product";

const cand = (
  name: string,
  kind = "gear",
  built: Candidate["built"] = "built",
  composable: Candidate["composable"] = "undescribed",
): Candidate => ({
  name,
  kind,
  built,
  score: 1,
  why: [],
  composable,
});

const row = (capability: string, ...candidates: Candidate[]): PlanRow => ({
  capability,
  candidates,
  gap: candidates.length === 0,
  unbuilt: false,
});

const status = (over: Partial<GearboxStatus> = {}): GearboxStatus => ({
  enabled: true,
  corpus_url: "https://github.com/MikeFalcon77/gears-rust.git",
  corpus_ref: "feature/gearbox",
  source_id: "gears-rust",
  profiles: ["dev", "local", "prod"],
  ...over,
});

describe("isPickable", () => {
  it("offers Rust gears and plugins only", () => {
    expect(isPickable(cand("cf-gears-api-gateway"))).toBe(true);
    expect(isPickable(cand("cf-gears-static-authn-plugin", "plugin"))).toBe(true);
    expect(isPickable(cand("cf-gears-api-gateway-sdk", "sdk"))).toBe(false);
    expect(isPickable(cand("cf-gears-toolkit", "toolkit"))).toBe(false);
    expect(isPickable(cand("@gears-frontx/shell", "gear"))).toBe(false);
  });
});

describe("defaultPicks", () => {
  it("takes the best built pickable gear per capability, once", () => {
    const plan = [
      row("auth", cand("@gears-frontx/login"), cand("cf-gears-authn-resolver"), cand("cf-gears-authz-resolver")),
      row("gateway", cand("cf-gears-api-gateway")),
      row("login", cand("cf-gears-authn-resolver")),
    ];
    expect(defaultPicks(plan)).toEqual(["cf-gears-authn-resolver", "cf-gears-api-gateway"]);
  });

  it("picks nothing for a capability that has only unbuilt candidates or none", () => {
    expect(defaultPicks([row("ledger", cand("cf-gears-ledger", "gear", "docs-only")), row("gap")])).toEqual([]);
  });
});

describe("productIdFrom", () => {
  it("makes a GDL kebab id out of a project name", () => {
    expect(productIdFrom("My Shop")).toBe("my-shop");
    expect(productIdFrom("  Payments  v2 ")).toBe("payments-v2");
    expect(productIdFrom("2024 Ledger")).toBe("ledger");
    expect(productIdFrom("Café—Bar")).toBe("cafe-bar");
    expect(productIdFrom("!!!")).toBe("product");
  });
});

describe("withCorpusSource", () => {
  const own: RepoEntry = { name: "my-shop", source: "github", url: "https://github.com/acme/my-shop.git" };

  it("checks the corpus out beside the project, on its ref", () => {
    expect(withCorpusSource([own], status())).toEqual([
      own,
      {
        name: "gears-rust",
        source: "git",
        url: "https://github.com/MikeFalcon77/gears-rust.git",
        branch: "feature/gearbox",
      },
    ]);
  });

  it("leaves a source that already takes the directory alone", () => {
    const pinned: RepoEntry = { name: "corpus", target: "gears-rust", source: "local", path: "/src/gears-rust" };
    expect(withCorpusSource([own, pinned], status())).toEqual([own, pinned]);
    const named: RepoEntry = { name: "gears-rust", source: "git", url: "https://example.com/fork.git" };
    expect(withCorpusSource([named], status())).toEqual([named]);
  });

  it("adds nothing when previews are off here", () => {
    expect(withCorpusSource([own], status({ enabled: false }))).toEqual([own]);
    expect(withCorpusSource([own], null)).toEqual([own]);
  });
});

describe("groupDiagnostics", () => {
  it("folds one finding raised per profile into one row naming the profiles", () => {
    const missing = (p: string) => ({
      code: "GBX0511",
      severity: "error",
      message: `in profile \`${p}\`, gear \`authn-resolver\` has no implementation`,
      file: "product.gdl",
      line: 1,
    });
    const grouped = groupDiagnostics([
      missing("dev"),
      { code: "GBX0120", severity: "error", message: "`event-broker` requires `mode`", file: "product.gdl" },
      missing("local"),
      missing("prod"),
    ]);
    expect(grouped.map((g) => [g.code, g.message, g.profiles])).toEqual([
      ["GBX0511", "gear `authn-resolver` has no implementation", ["dev", "local", "prod"]],
      ["GBX0120", "`event-broker` requires `mode`", []],
    ]);
  });
});

describe("diagnosticsByCode", () => {
  it("holds one warning said once per gear as one group, errors first", () => {
    const authz = (gear: string) => ({
      code: "GBX0215",
      severity: "warning",
      message: `\`${gear}\` resolves \`dyn AuthZResolverApi\``,
      file: "gear.gdl",
    });
    const groups = diagnosticsByCode([
      authz("a"),
      { code: "GBX0517", severity: "info", message: "two plugins share a vendor" },
      authz("b"),
      { code: "GBX0511", severity: "error", message: "no implementation" },
      authz("c"),
    ]);
    expect(groups.map((g) => [g.code, g.items.length])).toEqual([
      ["GBX0511", 1],
      ["GBX0215", 3],
      ["GBX0517", 1],
    ]);
  });
});

describe("sortDiagnostics", () => {
  it("puts errors first and keeps the engine's order within a severity", () => {
    const d = (code: string, severity: string) => ({ code, severity, message: "" });
    expect(
      sortDiagnostics([d("W1", "warning"), d("E1", "error"), d("I1", "info"), d("E2", "error")]).map((x) => x.code),
    ).toEqual(["E1", "E2", "W1", "I1"]);
  });
});

describe("defaultPicks and the engine's verdict", () => {
  it("prefers a gear that can run, and never starts from one that cannot", () => {
    const runs = { ...cand("cf-gears-tenant-resolver"), composable: "runs" as const };
    const blocked = { ...cand("cf-gears-resource-group"), composable: "blocked" as const };
    const plain = cand("cf-gears-account-management");
    expect(defaultPicks([row("tenancy", blocked, plain, runs)])).toEqual(["cf-gears-tenant-resolver"]);
    expect(defaultPicks([row("tenancy", blocked, plain)])).toEqual(["cf-gears-account-management"]);
    expect(defaultPicks([row("tenancy", blocked)])).toEqual([]);
  });
});

// The 28 errors a two-gear product showed on 2026-09-24 were all in the
// corpus's own gear.gdl files, which an older engine could not read.
describe("corpusErrors", () => {
  const d = (file: string | null, severity = "error") => ({ code: "GBX0102", severity, message: "m", file });

  it("counts only errors in files that are not this product", () => {
    const ds = [
      d("gears/system/credstore/credstore/gear.gdl"),
      d("gears/system/credstore/credstore/gear.gdl"),
      d("gears/bss/ledger/ledger/gear.gdl"),
      d("product.gdl"),
      d(null),
      d("gears/x/gear.gdl", "warning"),
    ];
    expect(corpusErrors(ds)).toEqual({ errors: 3, files: 2 });
  });

  it("is zero for a product whose problems are its own", () => {
    expect(corpusErrors([d("product.gdl"), d(null)])).toEqual({ errors: 0, files: 0 });
  });
});

describe("profiles and their verdicts (ADR-0057)", () => {
  const check = { ok: true, errors: 0, warnings: 0, applications: [], gears: [], gdl_sha256: "now" };

  it("are labelled shape first, and only kubernetes ones bind", () => {
    expect(PRODUCT_PROFILES.map((p) => p.label)).toEqual(["Kubernetes · prod", "One host · local", "One process · dev"]);
    expect(KUBERNETES_PROFILES).toEqual(["prod"]);
  });

  it("checks the profiles environments run, once each, or prod with none bound", () => {
    const b = (profile: string, environment_id: string) => ({ profile, environment_id });
    expect(profilesToCheck([b("prod", "stage"), b("prod", "prod"), b("local", "lab")])).toEqual(["prod", "local"]);
    expect(profilesToCheck([])).toEqual(["prod"]);
  });

  it("keeps each profile's verdict, stale once the description changes", () => {
    const product = {
      checks: { prod: check, local: { ...check, ok: false, errors: 2 }, dev: { ...check, gdl_sha256: "before" } },
      last_preview: { ...check, profile: "prod" },
    };
    expect(verdictText(verdictOf(product, "prod"))).toBe("✓");
    expect(verdictText(verdictOf(product, "local"))).toBe("✗ 2 errors");
    expect(verdictText(verdictOf(product, "dev"))).toBe("stale");
    expect(verdictText(verdictOf({ checks: {} }, "prod"))).toBe("not checked");
    // Against a newer description than the record's.
    expect(verdictOf(product, "prod", "newer").state).toBe("stale");
  });

  it("reads a record from before checks were kept: its last preview answers for its own profile", () => {
    const old = { last_preview: { profile: "dev", ok: true, errors: 0, warnings: 0, applications: [], gears: [] } };
    expect(checkOf(old, "dev")).toBe(old.last_preview);
    expect(checkOf(old, "prod")).toBeNull();
    expect(verdictOf(old, "dev").state).toBe("ok");
  });

  it("tells when a save's background check has landed on the record", () => {
    const product = { checks: { prod: { ...check, gdl_sha256: "saved" } } };
    expect(checkLanded(product, "prod", "saved")).toBe(true);
    // Still the check of the description before the save, or another profile.
    expect(checkLanded({ checks: { prod: { ...check, gdl_sha256: "before" } } }, "prod", "saved")).toBe(false);
    expect(checkLanded(product, "dev", "saved")).toBe(false);
    // An older backend says no hash: nothing to match.
    expect(checkLanded(product, "prod", "")).toBe(false);
  });
});

describe("productPathOf", () => {
  it("is the recorded path, else the product's own, never the root's", () => {
    expect(productPathOf({ product_id: "shop", written: { branch: "b", commit_sha: "c", path: "product.gdl" } })).toBe(
      "product.gdl",
    );
    expect(productPathOf({ product_id: "shop", description: { revision: 1, path: "products/x/product.gdl" } })).toBe(
      "products/x/product.gdl",
    );
    expect(productPathOf({ product_id: "shop" })).toBe("products/shop/product.gdl");
    expect(productPathOf({})).toBeNull();
    expect(productPathOf(null)).toBeNull();
  });
});

describe("the profiles the saved description declares", () => {
  const text = `gdl_version = "1.5"
product(
    id = "shop",
    # profiles = [kubernetes(id = "commented")],
    profiles = [
        embedded(id = "dev", development = True, database = postgres(host = "127.0.0.1")),
        kubernetes(id = "stage", discovery = "static", namespace = "shop-stage"),
        kubernetes(id = "prod", discovery = "static", namespace = "shop"),
        self_hosted(id = "lab", host = "lab"),
    ],
    gears = [use_gear("api-gateway", source = "gears-rust")],
)`;

  it("are read with their kinds, and only kubernetes ones can be bound", () => {
    const declared = declaredProfiles(text);
    expect(declared.map((p) => [p.id, p.kind])).toEqual([
      ["dev", "embedded"],
      ["stage", "kubernetes"],
      ["prod", "kubernetes"],
      ["lab", "self_hosted"],
    ]);
    expect(deployableProfiles(declared).map((p) => p.id)).toEqual(["stage", "prod"]);
    expect(profileLabel("stage", declared)).toBe("Kubernetes · stage");
    expect(profileLabel("lab", declared)).toBe("One host · lab");
  });

  it("fall back to the three a new description starts with", () => {
    for (const none of [null, "", "# no product here", "product(id = \"x\", profiles = PROFILES)"]) {
      expect(deployableProfiles(declaredProfiles(none)).map((p) => p.id)).toEqual(["prod"]);
    }
  });
});
