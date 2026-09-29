import { destinationAfterIdChange, pendingPreview, suggestedProductPath } from "./destination";

describe("New Product's destination", () => {
  it("suggests the typed id under the opened repository, on Windows as Theia spells the root", () => {
    expect(suggestedProductPath("c:\\gbxv\\studio-web", "shop")).toBe("c:/gbxv/studio-web/products/shop/product.gdl");
    expect(suggestedProductPath("/workspace/app/", " shop ")).toBe("/workspace/app/products/shop/product.gdl");
    expect(suggestedProductPath("c:\\gbxv\\studio-web", "")).toBe("c:/gbxv/studio-web/products/new-product/product.gdl");
  });

  it("keeps a suggested destination in step with the id, and leaves a chosen one alone", () => {
    const root = "c:\\gbxv\\studio-web";
    const taken = suggestedProductPath(root, "new-product");
    expect(destinationAfterIdChange(taken, true, root, "shop")).toBe("c:/gbxv/studio-web/products/shop/product.gdl");
    expect(destinationAfterIdChange("D:/elsewhere/product.gdl", false, root, "shop")).toBe("D:/elsewhere/product.gdl");
    expect(destinationAfterIdChange("", false, root, "shop")).toBe("");
  });

  it("drops the choose-a-destination hint as soon as there is one", () => {
    const hint = "Choose a destination. Suggested: c:/gbxv/studio-web/products/shop/product.gdl";
    expect(pendingPreview(hint, "c:/gbxv/studio-web/products/shop/product.gdl", "x")).toBe("Previewing…");
    expect(pendingPreview("product(\n  id = \"shop\" …", "c:/p/product.gdl", "x")).toBe("product(\n  id = \"shop\" …");
    expect(pendingPreview("product(…)", "", "c:/s/product.gdl")).toBe("Choose a destination. Suggested: c:/s/product.gdl");
  });
});
