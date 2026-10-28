// From Gearbox Studio, constructorfabric/gearbox#14 (`ide/tests/ux/source-alias.spec.ts`),
// moved from Playwright to jest, with the git-source case Constructor Studio adds.
import { productSourceFor, type ProductSourceContext } from "./product-source";

function context(sources: Record<string, string>, roots: Record<string, string>, selections: Array<{gear: string; source: string}> = [], owners: Record<string, string> = {}, productPath = "/work/products/demo/product.gdl"): ProductSourceContext {
  return {
    productPath,
    intent: { sources: Object.fromEntries(Object.entries(sources).map(([id, at]) => [id, { kind: "path" as const, at }])), selected_gears: selections },
    roots: Object.entries(roots).map(([id, path]) => ({id, path})), sourceOf: id => owners[id],
  };
}

describe("product source alias matching", () => {
  test("preserves an existing matching source ID", () => {
    expect(productSourceFor("sdk", context({sdk: "/sdk"}, {sdk: "/sdk"}))).toEqual({ok: true, source: "sdk"});
  });
  test("uses a product's custom alias by root path", () => {
    expect(productSourceFor("local-checkout", context({platform: "/sdk"}, {"local-checkout": "/sdk"}))).toEqual({ok: true, source: "platform"});
  });
  test("resolves relative locations from the product directory", () => {
    expect(productSourceFor("checkout", context({platform: "../../sdk"}, {checkout: "/work/sdk"}))).toEqual({ok: true, source: "platform"});
  });
  test("normalizes Windows drive case, separators and extended paths", () => {
    expect(productSourceFor("checkout", context({platform: "c:/Libs/./sdk"}, {checkout: "\\?\C:\libs\sdk"}, [], {}, "C:\work\product.gdl"))).toEqual({ok: true, source: "platform"});
  });
  test("keeps UNC shares distinct and accepts extended UNC paths", () => {
    expect(productSourceFor("checkout", context({platform: "//SERVER/sdk/repo", other: "//server/other/repo"}, {checkout: "\\?\UNC\server\SDK\repo", other: "//server/other/repo"}))).toEqual({ok: true, source: "platform"});
  });
  test("uses written selections when the checkout was relocated", () => {
    const ctx = context({platform: "/author/sdk", extra: "/author/extra"}, {checkout: "/local/sdk", other: "/local/extra"}, [{gear: "existing", source: "platform"}], {existing: "checkout"});
    expect(productSourceFor("checkout", ctx)).toEqual({ok: true, source: "platform"});
  });
  test("can map the single relocated source of an empty product", () => {
    expect(productSourceFor("checkout", context({platform: "/old/sdk"}, {checkout: "/new/sdk"}))).toEqual({ok: true, source: "platform"});
  });
  test("maps each root independently in a multi-source product", () => {
    const ctx = context({platform: "/sdk", customer: "/customer"}, {"sdk-copy": "/sdk", "customer-copy": "/customer"});
    expect(productSourceFor("customer-copy", ctx)).toEqual({ok: true, source: "customer"});
    expect(productSourceFor("sdk-copy", ctx)).toEqual({ok: true, source: "platform"});
  });
  test("does not pair multiple relocated sources by array order", () => {
    expect(productSourceFor("one", context({platform: "/old/sdk", customer: "/old/customer"}, {one: "/new/customer", two: "/new/sdk"})).ok).toBe(false);
  });
  test("does not confuse POSIX paths that differ only in case", () => {
    expect(productSourceFor("upper-copy", context({upper: "/SDK", lower: "/sdk"}, {"upper-copy": "/SDK", "lower-copy": "/sdk"}))).toEqual({ok: true, source: "upper"});
  });
  test("refuses contradictory path and selection ownership", () => {
    expect(productSourceFor("one", context({platform: "/two"}, {one: "/one", two: "/two"}, [{gear: "existing", source: "platform"}], {existing: "one"})).ok).toBe(false);
  });
  test("refuses ambiguous aliases without an exact declared catalogue ID", () => {
    expect(productSourceFor("checkout", context({platform: "/sdk", vendor: "/sdk"}, {checkout: "/sdk"})).ok).toBe(false);
  });
  test("keeps a git source's ID, which names the directory it was brought into", () => {
    const ctx: ProductSourceContext = {
      productPath: "/work/products/demo/product.gdl",
      intent: { sources: { "gears-rust": { kind: "git", url: "https://github.com/constructorfabric/gears-rust", rev: "abc" } }, selected_gears: [] },
      roots: [{ id: "gears-rust", path: "/home/me/ConstructorStudio/corpus/gears-rust-abc" }], sourceOf: () => undefined,
    };
    expect(productSourceFor("gears-rust", ctx)).toEqual({ ok: true, source: "gears-rust" });
  });
  test("does not invent a source declaration for an unopened root", () => {
    expect(productSourceFor("missing", context({platform: "/sdk"}, {checkout: "/sdk"})).ok).toBe(false);
  });
});
