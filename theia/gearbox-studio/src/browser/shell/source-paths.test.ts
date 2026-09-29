import { isAbsolutePath, isInside, parentOf, resolveFrom } from "./source-paths";

describe("source paths", () => {
  describe("in a session (POSIX), unchanged", () => {
    it("finds the product's directory", () => {
      expect(parentOf("/workspace/gearbox/products/demo/product.gdl")).toBe("/workspace/gearbox/products/demo");
      expect(parentOf("/product.gdl")).toBe("/");
    });

    it("resolves a sibling checkout the way the demo names it", () => {
      expect(resolveFrom("/workspace/gearbox/products/demo", "../../../gears-rust")).toBe("/workspace/gears-rust");
      expect(resolveFrom("/workspace/app", ".")).toBe("/workspace/app");
      expect(resolveFrom("/workspace/app", "/opt/corpus/gears-rust")).toBe("/opt/corpus/gears-rust");
    });

    it("tells a file inside a root from one beside it", () => {
      expect(isInside("/workspace/app/products/x/product.gdl", "/workspace/app")).toBe(true);
      expect(isInside("/workspace/app-old/product.gdl", "/workspace/app")).toBe(false);
    });
  });

  describe("on a Windows desktop", () => {
    it("reads discovery's backslashes, which used to make the product's directory `/`", () => {
      expect(parentOf("C:\\Repos\\studio-web\\products\\shop\\product.gdl")).toBe("C:/Repos/studio-web/products/shop");
      expect(parentOf("C:/product.gdl")).toBe("C:/");
    });

    it("keeps an absolute source -- the machine's corpus copy -- as it is", () => {
      const copy = "C:/Users/me/ConstructorStudio/corpus/github.com__o__gears-rust/0123456789ab/gears-rust";
      expect(isAbsolutePath(copy)).toBe(true);
      expect(resolveFrom("C:/Repos/studio-web/products/shop", copy)).toBe(copy);
      expect(resolveFrom("C:/Repos/studio-web/products/shop", copy.replace(/\//g, "\\"))).toBe(copy);
    });

    it("resolves a relative source on the same drive, without a leading slash and never past the drive", () => {
      expect(resolveFrom("C:/Repos/studio-web/products/shop", "../../../gears-rust")).toBe("C:/Repos/gears-rust");
      expect(resolveFrom("C:/Repos", "../../../x")).toBe("C:/x");
    });

    it("matches a Theia root spelled `c:\\` against a path spelled `C:/`", () => {
      expect(isInside("C:/Repos/studio-web/products/shop/product.gdl", "c:\\Repos\\studio-web")).toBe(true);
      expect(isInside("C:/Repos/other/product.gdl", "c:\\Repos\\studio-web")).toBe(false);
    });
  });
});
