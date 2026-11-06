import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type InfraPassport, type InfraService, type ProductDescriptionRevision } from "./api";
import { infraStore, projectListStore, serviceOf, useOf } from "./infra-store";

const passport: InfraPassport = {
  name: "keycloak",
  version: "26.0.7",
  image: "quay.io/keycloak/keycloak:26.0.7",
  ports: { http: 8080 },
  args: ["start-dev"],
  config: { KC_HEALTH_ENABLED: "true", KC_PROXY_HEADERS: "" },
  secrets: ["KC_BOOTSTRAP_ADMIN_PASSWORD"],
  provides: { "oidc.issuer": "{public_url}/realms/product" },
  stateful: false,
};

const record: InfraService = {
  passport,
  image: "registry.example/acme/shop/mirror/keycloak@sha256:abc",
  public_url: "https://id.shop.example",
};

const item = { passport: { name: "keycloak", provides: {} } } as unknown as InfraService;

afterEach(() => vi.restoreAllMocks());

describe("the infra services' store", () => {
  it("reads and writes the project's list, whole and without revisions", async () => {
    const read = vi.spyOn(api, "infraServices").mockResolvedValue({ items: [item], total: 1 });
    const write = vi.spyOn(api, "putInfraServices").mockResolvedValue({ items: [item], total: 1 });
    const store = projectListStore("t", "p");
    expect(await store.load()).toEqual({ items: [item], source: "project-list", revision: null });
    expect(await store.save([item], 7)).toEqual({ items: [item], source: "project-list", revision: null });
    expect(read).toHaveBeenCalledWith("t", "p");
    expect(write).toHaveBeenCalledWith("t", "p", [item]);
  });

  it("is the product description's (ADR-0065)", () => {
    expect(infraStore("t", "p").source).toBe("product-description");
  });

  const revision = (n: number, text: string) =>
    ({ revision: n, text, author: "a", created_at: "", sha256: "", source: "studio" }) as ProductDescriptionRevision;
  const PRODUCT = `product(
    id = "shop",
    sources = [source(id = "shop", at = path("."))],
    gears = [],
)
`;

  it("shows the project's list until the description says infra, and its first save writes it there", async () => {
    let latest = revision(3, PRODUCT);
    vi.spyOn(api, "productDescription").mockImplementation(async () => ({ latest }));
    vi.spyOn(api, "infraServices").mockResolvedValue({ items: [record], total: 1 });
    vi.spyOn(api, "listComponents").mockResolvedValue({ nodes: [] });
    const saved = vi.spyOn(api, "saveProductDescription").mockImplementation(async (_t, _p, body) => {
      latest = revision(4, body.text);
      return { revision: latest, created: true };
    });
    const put = vi.spyOn(api, "putInfraServices").mockResolvedValue({ items: [record], total: 1 });
    const store = infraStore("t", "p");
    const first = await store.load();
    expect(first).toMatchObject({ items: [record], source: "product-description", revision: 3 });
    const after = await store.save(first.items, first.revision);
    expect(saved).toHaveBeenCalledWith("t", "p", expect.objectContaining({ base_revision: 3 }));
    expect(latest.text).toContain(`use_service("keycloak", source = "shop")`);
    expect(put).toHaveBeenCalledWith("t", "p", [record]);
    expect(after.revision).toBe(4);
    expect(after.items[0].image).toBe(record.image);
  });

  it("makes no revision when the services are as the description says", async () => {
    const text = PRODUCT.replace("gears = []", `infra = [
        use_service("keycloak", source = "shop"),
    ],
    gears = []`);
    vi.spyOn(api, "productDescription").mockResolvedValue({ latest: revision(5, text) });
    vi.spyOn(api, "infraServices").mockResolvedValue({ items: [record], total: 1 });
    vi.spyOn(api, "listComponents").mockResolvedValue({ nodes: [] });
    const saved = vi.spyOn(api, "saveProductDescription");
    vi.spyOn(api, "putInfraServices").mockResolvedValue({ items: [record], total: 1 });
    const store = infraStore("t", "p");
    await store.save((await store.load()).items, 5);
    expect(saved).not.toHaveBeenCalled();
  });
});

describe("an infra service between product.gdl and the project's records", () => {
  it("is the catalogue's passport with the description's choice over it, and the environment's side", () => {
    const s = serviceOf(
      { name: "keycloak", source: "shop", image: "quay.io/keycloak/keycloak:26.0.8", config: { KC_PROXY_HEADERS: "xforwarded" } },
      [passport],
      [record],
    );
    expect(s.passport.image).toBe("quay.io/keycloak/keycloak:26.0.8");
    expect(s.passport.config).toEqual({ KC_HEALTH_ENABLED: "true", KC_PROXY_HEADERS: "xforwarded" });
    expect(s.image).toBe(record.image);
    expect(s.public_url).toBe("https://id.shop.example");
  });

  it("says only what differs from the catalogue's passport", () => {
    const edited: InfraService = {
      ...record,
      passport: { ...passport, config: { ...passport.config, KC_PROXY_HEADERS: "xforwarded" } },
    };
    expect(useOf(edited, [passport], undefined, "shop")).toEqual({
      name: "keycloak",
      source: "shop",
      image: undefined,
      chart: undefined,
      chart_version: undefined,
      config: { KC_PROXY_HEADERS: "xforwarded" },
      profileConfigText: undefined,
    });
  });

  it("keeps the source and a profile's values the description said", () => {
    const was = { name: "keycloak", source: "infra-repo", config: {}, profileConfigText: `{"dev": {}}` };
    const u = useOf(record, [passport], was, "shop");
    expect(u.source).toBe("infra-repo");
    expect(u.profileConfigText).toBe(`{"dev": {}}`);
  });

  it("keeps what the description said when the catalogue no longer offers the passport", () => {
    const was = { name: "keycloak", source: "shop", image: "quay.io/keycloak/keycloak:26.0.8", config: { KC_PROXY_HEADERS: "xforwarded" } };
    const u = useOf(serviceOf(was, [], [record]), [], was, "shop", record.passport);
    expect(u.image).toBe(was.image);
    expect(u.config).toEqual(was.config);
  });

  it("keeps an edit when the catalogue does not offer the passport, and makes no default the product's", () => {
    const was = { name: "keycloak", source: "shop", config: {} };
    const shown = serviceOf(was, [], [record]);
    expect(useOf(shown, [], was, "shop", record.passport)).toMatchObject({ image: undefined, config: {} });
    const edited: InfraService = {
      ...shown,
      passport: { ...shown.passport, image: "quay.io/keycloak/keycloak:26.0.9", config: { ...shown.passport.config, KC_PROXY_HEADERS: "forwarded" } },
    };
    expect(useOf(edited, [], was, "shop", record.passport)).toMatchObject({
      image: "quay.io/keycloak/keycloak:26.0.9",
      config: { KC_PROXY_HEADERS: "forwarded" },
    });
  });
});

describe("a save of the description's infra", () => {
  const revision = (n: number, text: string) =>
    ({ revision: n, text, author: "a", created_at: "", sha256: "", source: "studio" }) as ProductDescriptionRevision;
  const stub = (text: string) => {
    vi.spyOn(api, "productDescription").mockResolvedValue({ latest: revision(5, text) });
    vi.spyOn(api, "infraServices").mockResolvedValue({ items: [record], total: 1 });
    vi.spyOn(api, "listComponents").mockResolvedValue({ nodes: [] });
    vi.spyOn(api, "putInfraServices").mockResolvedValue({ items: [record], total: 1 });
    return vi.spyOn(api, "saveProductDescription").mockImplementation(async (_t, _p, body) => ({ revision: revision(6, body.text), created: true }));
  };
  const postgres = { ...record, passport: { ...passport, name: "postgresql", image: "postgres:16", config: {} } };

  it("is refused when a new service has no source to come from", async () => {
    const saved = stub(`product(
    id = "shop",
    gears = [],
)
`);
    const store = infraStore("t", "p");
    await expect(store.save([postgres], 5)).rejects.toThrow(/names no source/);
    expect(saved).not.toHaveBeenCalled();
  });

  it("writes back a call it does not read whole, and refuses to change it", async () => {
    const call = `use_service("keycloak", source = "shop", image = KEYCLOAK_IMAGE)`;
    const saved = stub(`product(
    id = "shop",
    sources = [source(id = "shop", at = path("."))],
    infra = [
        ${call},
    ],
    gears = [],
)
`);
    const store = infraStore("t", "p");
    const [keycloak] = (await store.load()).items;
    await store.save([keycloak, postgres], 5);
    expect(saved.mock.calls[0][2].text).toContain(call);
    expect(saved.mock.calls[0][2].text).toContain(`use_service("postgresql", source = "shop"`);
    const edited = { ...keycloak, passport: { ...keycloak.passport, image: "quay.io/keycloak/keycloak:27" } };
    await expect(store.save([edited], 5)).rejects.toThrow(/says more than Studio reads/);
  });
});
