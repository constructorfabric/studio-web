import { describe, expect, it } from "vitest";
import { homeSource, readInfra, useServiceText, writeInfra, type UseService } from "./infra-gdl";

const PRODUCT = `# The product.
product(
    id = "shop",
    sources = [source(id = "gears-rust", at = git(url = "https://github.com/x/gears-rust", rev = "abc")),
               source(id = "shop-repo", at = path("."))],
    profiles = [kubernetes(id = "dev", discovery = "static")],
    gears = [
        use_gear("api-gateway", source = "gears-rust"),
    ],
)
`;

const keycloak: UseService = {
  name: "keycloak",
  source: "shop-repo",
  image: "quay.io/keycloak/keycloak:26.0.7",
  config: { KC_PROXY_HEADERS: "xforwarded" },
};

describe("a product's infra in product.gdl", () => {
  it("is none when the product says no infra", () => {
    expect(readInfra(PRODUCT)).toBeNull();
  });

  it("is added before the gears, and read back as written", () => {
    const text = writeInfra(PRODUCT, [keycloak, { name: "postgresql", source: "shop-repo", config: {} }]);
    expect(text).toContain(`    infra = [\n        ${useServiceText(keycloak)},\n`);
    expect(text.indexOf("infra = [")).toBeLessThan(text.indexOf("gears = ["));
    expect(readInfra(text)).toEqual([keycloak, { name: "postgresql", source: "shop-repo", config: {} }]);
    expect(text.startsWith("# The product.\n")).toBe(true);
  });

  it("is replaced where it is, and a profile's values are carried over unread", () => {
    const withProfiles = writeInfra(PRODUCT, [keycloak]).replace(
      `config = {"KC_PROXY_HEADERS": "xforwarded"})`,
      `config = {"KC_PROXY_HEADERS": "xforwarded"}, profile_config = {"dev": {"KC_HEALTH_ENABLED": "false"}})`,
    );
    const [read] = readInfra(withProfiles)!;
    expect(read.profileConfigText).toBe(`{"dev": {"KC_HEALTH_ENABLED": "false"}}`);
    const again = writeInfra(withProfiles, [{ ...read, image: "quay.io/keycloak/keycloak:26.0.8" }]);
    expect(again).toContain(`profile_config = {"dev": {"KC_HEALTH_ENABLED": "false"}}`);
    expect(again).toContain("keycloak:26.0.8");
    expect(again.match(/infra = \[/g)).toHaveLength(1);
  });

  it("keeps a call it does not read whole as it is written", () => {
    const call = `use_service("keycloak", source = "shop-repo", image = KEYCLOAK_IMAGE, config = {"A": PORT})`;
    const text = PRODUCT.replace("    gears = [", `    infra = [
        ${call},
    ],
    gears = [`);
    const [read] = readInfra(text)!;
    expect(read.text).toBe(call);
    expect(useServiceText(read)).toBe(call);
    expect(writeInfra(text, [read, { name: "postgresql", source: "shop-repo", config: {} }])).toContain(call);
    expect(readInfra(writeInfra(PRODUCT, [keycloak]))![0].text).toBeUndefined();
  });

  it("is not rewritten when it holds more than use_service calls", () => {
    const text = PRODUCT.replace("    gears = [", `    infra = [KEYCLOAK],
    gears = [`);
    expect(() => writeInfra(text, [keycloak])).toThrow(/does not rewrite/);
    const named = PRODUCT.replace("    gears = [", `    infra = INFRA,
    gears = [`);
    expect(() => writeInfra(named, [keycloak])).toThrow(/does not rewrite/);
  });

  it("is taken out with its line when the list is empty", () => {
    const text = writeInfra(writeInfra(PRODUCT, [keycloak]), []);
    expect(readInfra(text)).toBeNull();
    expect(text).toBe(PRODUCT);
  });

  it("goes at the end of a product with no gears", () => {
    const bare = `product(\n    id = "shop",\n)\n`;
    const text = writeInfra(bare, [keycloak]);
    expect(readInfra(text)).toEqual([keycloak]);
    expect(text.trimEnd().endsWith(")")).toBe(true);
  });

  it("ignores a comment and a gear's string that look like it", () => {
    const tricky = PRODUCT.replace("# The product.", `# infra = [use_service("x", source = "y")]`).replace(
      `use_gear("api-gateway", source = "gears-rust")`,
      `use_gear("api-gateway", source = "gears-rust", config = {"note": "infra = []"})`,
    );
    expect(readInfra(tricky)).toBeNull();
    expect(readInfra(writeInfra(tricky, [keycloak]))).toEqual([keycloak]);
  });

  it("names the product's own repository as the source a new service comes from", () => {
    expect(homeSource(PRODUCT)).toBe("shop-repo");
    expect(homeSource(`product(id = "x")`)).toBeNull();
  });
});
