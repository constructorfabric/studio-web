// The configurator shows parts with slots and short lists, never the wiring:
// these pin which plugin a slot offers first, that a part taken out takes
// its plugins along, and that what the engine added is told apart from what
// was asked for.
import { describe, expect, it } from "vitest";

import type { GearCatalogue } from "./product-configurator";
import {
  byCategory,
  choosePlugin,
  compose,
  indexCatalogue,
  offers,
  removePart,
  slotLabel,
  unsetFields,
  gearFacts,
  subsystemOf,
  subsystemOrder,
  subsystems,
  todos,
  explanationIndex,
  inBatches,
  plainWords,
  unexplained,
} from "./product-configurator";

const AUTHN = "cf.toolkit.plugins.plugin.v1~cf.core.authn_resolver.plugin.v1~";
const point = { spec: AUTHN, trait_ident: "AuthNResolverPluginClient", sdk: { crate_name: "authn-resolver-sdk" } };

const catalogue: GearCatalogue = {
  gears: {
    "api-gateway": {
      id: "api-gateway",
      display_name: "API gateway",
      description: "Routes requests to gears.",
      category: "Platform",
      package: { crate_name: "cf-gears-api-gateway" },
    },
    "authn-resolver": {
      id: "authn-resolver",
      display_name: "Authentication",
      category: "Security",
      package: { crate_name: "cf-gears-authn-resolver" },
      extension_points: [point],
      vendor_selector: "static",
    },
    "oidc-authn-plugin": {
      id: "oidc-authn-plugin",
      display_name: "OIDC",
      package: { crate_name: "cf-gears-oidc-authn-plugin" },
      implements: { spec: AUTHN, default_vendor: "oidc", default_priority: 1 },
      config_schema: { fields: [{ name: "issuer", required: true }] },
    },
    "static-authn-plugin": {
      id: "static-authn-plugin",
      display_name: "Static tokens",
      package: { crate_name: "cf-gears-static-authn-plugin" },
      implements: { spec: AUTHN, default_vendor: "static", default_priority: 10 },
    },
    "rest-host": {
      id: "rest-host",
      package: { crate_name: "cf-gears-rest-host" },
      serves: [{ config_key: "bind_addr" }],
      config_schema: { fields: [{ name: "bind_addr", required: true }, { name: "port", required: true, default: 80 }] },
    },
  },
};
const index = indexCatalogue(catalogue);

describe("slots", () => {
  it("read as the person names the point", () => {
    expect(slotLabel(point)).toBe("AuthN resolver");
    expect(slotLabel({ trait_ident: "ModelPolicyPluginClientV1" })).toBe("Model policy");
    expect(slotLabel({ spec: AUTHN })).toBe("authn resolver");
    // Without the words that repeat the host's name.
    const miniChat = { id: "mini-chat", display_name: "MiniChat" };
    expect(slotLabel({ trait_ident: "MiniChatModelPolicyPluginClientV1" }, miniChat)).toBe("Model policy");
    expect(slotLabel({ trait_ident: "MiniChatAuditPluginClientV1" }, miniChat)).toBe("Audit");
    expect(slotLabel(point, { id: "authn-resolver", display_name: "Authentication Resolver" })).toBe("Provider");
    expect(slotLabel({ trait_ident: "IdpPluginClient" }, { id: "account-management" })).toBe("IdP");
  });

  it("offer first the plugin the host selects by, as completion would choose", () => {
    const { parts } = compose(index, ["cf-gears-authn-resolver"], {});
    const slot = parts[0].slots[0];
    expect(slot.options.map((o) => o.name)).toEqual(["cf-gears-static-authn-plugin", "cf-gears-oidc-authn-plugin"]);
    expect(slot.recommended).toBe("cf-gears-static-authn-plugin");
    expect(slot.chosen).toEqual([]);
  });

  it("hold the picked plugin, which is then not a part of its own", () => {
    const { parts } = compose(index, ["cf-gears-authn-resolver", "cf-gears-oidc-authn-plugin"], {});
    expect(parts.map((p) => p.id)).toEqual(["authn-resolver"]);
    expect(parts[0].slots[0].chosen).toEqual(["cf-gears-oidc-authn-plugin"]);
  });

  it("change their plugin by replacing the one that was there", () => {
    const picks = ["cf-gears-authn-resolver", "cf-gears-oidc-authn-plugin"];
    const slot = compose(index, picks, {}).parts[0].slots[0];
    expect(choosePlugin(picks, slot, "cf-gears-static-authn-plugin")).toEqual([
      "cf-gears-authn-resolver",
      "cf-gears-static-authn-plugin",
    ]);
    expect(choosePlugin(picks, slot, null)).toEqual(["cf-gears-authn-resolver"]);
  });
});

describe("parts", () => {
  it("say which host a plugin picked alone plugs into", () => {
    const { parts } = compose(index, ["cf-gears-oidc-authn-plugin"], {});
    expect(parts[0].plugsInto).toBe("Authentication");
  });

  it("taken out take their plugins with them", () => {
    const picks = ["cf-gears-api-gateway", "cf-gears-authn-resolver", "cf-gears-oidc-authn-plugin"];
    const authn = compose(index, picks, {}).parts.find((p) => p.id === "authn-resolver")!;
    expect(removePart(picks, authn)).toEqual(["cf-gears-api-gateway"]);
  });

  it("count the required settings left unset, not defaults or what generation writes", () => {
    const oidc = index.find("oidc-authn-plugin")!;
    expect(unsetFields(oidc, {})).toEqual(["issuer"]);
    expect(unsetFields(oidc, { "cf-gears-oidc-authn-plugin": { issuer: "https://id" } })).toEqual([]);
    expect(unsetFields(index.find("rest-host")!, {})).toEqual([]);
  });

  it("group by category, and keep picks the catalogue does not know apart", () => {
    const c = compose(index, ["cf-gears-api-gateway", "cf-gears-authn-resolver", "cf-gears-mystery"], {});
    expect(byCategory(c.parts).map((g) => g.category)).toEqual(["Platform", "Security"]);
    expect(c.unknown).toEqual(["cf-gears-mystery"]);
  });

  it("added by the engine are listed with its reason, apart from the picks", () => {
    const c = compose(index, ["cf-gears-api-gateway"], {}, {
      gears: [
        { id: "api-gateway", crate_name: "cf-gears-api-gateway", reasons: ["selected"] },
        { id: "rest-host", crate_name: "cf-gears-rest-host", reasons: ["co-located with api-gateway"] },
      ],
    });
    expect(c.automatic).toEqual([{ id: "rest-host", label: "rest-host", why: "co-located with api-gateway" }]);
  });
});

describe("what can be added", () => {
  it("is every gear that is not a plugin and not in the product, by category", () => {
    const groups = offers(index, ["cf-gears-api-gateway"]);
    expect(groups.map((g) => [g.category, g.items.map((i) => i.name)])).toEqual([
      ["Security", ["cf-gears-authn-resolver"]],
      ["Other", ["cf-gears-rest-host"]],
    ]);
    expect(groups[0].items[0].slots).toBe(1);
  });

  it("is found by name or description", () => {
    expect(offers(index, [], "routes").flatMap((g) => g.items.map((i) => i.name))).toEqual(["cf-gears-api-gateway"]);
  });
});

describe("subsystems", () => {
  it("are the gear's category, named for a person, Examples and Other last", () => {
    expect(subsystemOf({ category: "gen-ai" })).toBe("AI");
    expect(subsystemOf({ category: "data-plane" })).toBe("Data plane");
    expect(subsystemOf({})).toBe("Other");
    expect(["Other", "Examples", "AI", "Billing (BSS)"].sort(subsystemOrder)).toEqual(["AI", "Billing (BSS)", "Examples", "Other"]);
    expect(subsystems(index)).toEqual(["Platform", "Security", "Other"]);
  });
});

describe("what a part is", () => {
  it("is told from facts when gear.gdl has no words for it", () => {
    expect(gearFacts(index, index.find("oidc-authn-plugin")!)).toEqual(["A choice for Authentication."]);
    expect(gearFacts(index, index.find("authn-resolver")!)).toEqual(["You choose its provider."]);
    const ledger = { id: "ledger", package: { crate_name: "cf-gears-ledger" }, runtime_caps: ["db", "rest"], colocated_deps: ["api-gateway"] };
    expect(gearFacts(index, ledger)).toEqual(["Serves a REST API.", "Keeps its data in its own database.", "Brings along: API gateway."]);
  });
});

describe("what is left to do", () => {
  it("names an empty slot and a plugin's unset setting", () => {
    expect(todos(compose(index, ["cf-gears-authn-resolver"], {})).map((t) => t.text)).toEqual([
      "Authentication: choose its provider",
    ]);
    expect(todos(compose(index, ["cf-gears-authn-resolver", "cf-gears-oidc-authn-plugin"], {})).map((t) => t.text)).toEqual([
      "Authentication: set OIDC.issuer",
    ]);
  });
});

describe("a crate that holds a gear and its plugins", () => {
  // mini-chat as the corpus has it: both static plugins in its own crate.
  const point = (spec: string) => ({ spec, sdk: { crate_name: "cf-gears-mini-chat-sdk" } });
  const plugin = (id: string, spec: string) => ({ id, package: { crate_name: "cf-gears-mini-chat" }, fills: { point: point(spec) } });
  const chat = indexCatalogue({
    gears: {
      "mini-chat": { id: "mini-chat", package: { crate_name: "cf-gears-mini-chat" }, extension_points: [point("audit~"), point("model_policy~")] },
      "static-mini-chat-audit-plugin": plugin("static-mini-chat-audit-plugin", "audit~"),
      "static-mini-chat-model-policy-plugin": plugin("static-mini-chat-model-policy-plugin", "model_policy~"),
    },
  });

  it("names the gear by its crate and each plugin by its id", () => {
    expect(chat.find("cf-gears-mini-chat")?.id).toBe("mini-chat");
    expect(chat.name(chat.find("static-mini-chat-audit-plugin")!)).toBe("static-mini-chat-audit-plugin");
    expect(chat.name(chat.find("mini-chat")!)).toBe("cf-gears-mini-chat");
  });

  it("gives each point its own plugin", () => {
    const picks = ["cf-gears-mini-chat", "static-mini-chat-audit-plugin", "static-mini-chat-model-policy-plugin"];
    const [part] = compose(chat, picks, {}).parts;
    expect(part.slots.map((s) => s.chosen)).toEqual([["static-mini-chat-audit-plugin"], ["static-mini-chat-model-policy-plugin"]]);
  });
});

describe("gears in plain words", () => {
  const explanations = explanationIndex([
    { gear_id: "authn-resolver", text: " Lets people sign in. ", source: "generated", updated_at: "2026-10-15T00:00:00Z" },
    { gear_id: "api-gateway", text: "The front door.", source: "edited", updated_at: "2026-10-15T00:00:00Z" },
  ]);

  it("reads the explanation first, then the catalogue's description, then nothing", () => {
    expect(plainWords(index.find("authn-resolver"), explanations)).toBe("Lets people sign in.");
    expect(plainWords(index.find("api-gateway"), explanations)).toBe("The front door.");
    expect(plainWords(index.find("api-gateway"), explanationIndex([]))).toBe("Routes requests to gears.");
    expect(plainWords(index.find("rest-host"), explanations)).toBeNull();
    expect(plainWords(undefined, explanations)).toBeNull();
  });

  it("lists, for Explain all, the gears with neither a description nor an explanation", () => {
    expect(unexplained(index, explanations).map((g) => g.id)).toEqual([
      "oidc-authn-plugin",
      "rest-host",
      "static-authn-plugin",
    ]);
  });

  it("runs at most `limit` at a time, counts failures, and stops starting when told", async () => {
    let running = 0;
    let most = 0;
    const seen: number[] = [];
    const progress: number[] = [];
    const r = await inBatches(
      [1, 2, 3, 4, 5, 6, 7],
      3,
      async (n) => {
        running++;
        most = Math.max(most, running);
        await new Promise((ok) => setTimeout(ok, 1));
        running--;
        seen.push(n);
        if (n === 4) throw new Error("no");
      },
      { onProgress: (p) => progress.push(p.done + p.failed) },
    );
    expect(most).toBe(3);
    expect(r).toEqual({ done: 6, failed: 1, skipped: 0 });
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(progress.at(-1)).toBe(7);

    let stopped = false;
    const s = await inBatches([1, 2, 3, 4, 5], 1, async (n) => {
      if (n === 2) stopped = true;
    }, { stop: () => stopped });
    expect(s).toEqual({ done: 2, failed: 0, skipped: 3 });
  });
});

describe("whose a part is", () => {
  const idx = indexCatalogue(
    {
      gears: {
        "api-gateway": { id: "api-gateway", source: "gears-rust", package: { crate_name: "cf-gears-api-gateway" } },
        "acme-billing": { id: "acme-billing", source: "acme-gears", package: { crate_name: "acme-billing" } },
        "studio-documents": { id: "studio-documents", source: "studio-backend", package: { crate_name: "cf-studio-backend" } },
      },
    },
    {
      roots: [
        { source_id: "gears-rust", tier: "platform" },
        { source_id: "acme-gears", tier: "organization" },
      ],
      project_sources: ["studio-backend"],
    },
  );

  it("is the project's for a root its own repository holds, the organization's for its gear repositories, else the platform's", () => {
    expect(idx.origin(idx.find("studio-documents"))).toBe("project");
    expect(idx.origin(idx.find("acme-billing"))).toBe("organization");
    expect(idx.origin(idx.find("api-gateway"))).toBe("platform");
    expect(idx.origin(undefined)).toBe("platform");
  });
});
