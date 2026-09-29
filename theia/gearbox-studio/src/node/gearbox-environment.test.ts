import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { productFiles } from "./gearbox-environment";

function tree(files: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-products-"));
  for (const file of files) {
    const at = path.join(root, file);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, "");
  }
  return root;
}

function found(root: string): string[] {
  return productFiles(root).map((file) => path.relative(root, file).split(path.sep).join("/"));
}

describe("productFiles", () => {
  const made: string[] = [];
  const make = (files: readonly string[]) => {
    const root = tree(files);
    made.push(root);
    return root;
  };
  afterAll(() => made.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

  it("finds a product New Product puts under the repository the member opened", () => {
    // The desktop member opened studio-web itself: the workspace is the checkout.
    const root = make([".git/HEAD", "products/shop/product.gdl", "products/blog/product.gdl", "src/main.ts"]);
    expect(found(root)).toEqual(["products/blog/product.gdl", "products/shop/product.gdl"]);
  });

  it("still finds the portal's product at the workspace root", () => {
    const root = make([".git/HEAD", "product.gdl"]);
    expect(found(root)).toEqual(["product.gdl"]);
  });

  it("still finds each checkout's products in a workspace of checkouts", () => {
    const root = make([
      "gears-rust/gears/authn/gear.gdl",
      "payments/product.gdl",
      "gearbox/products/payments-demo/product.gdl",
    ]);
    expect(found(root)).toEqual(["gearbox/products/payments-demo/product.gdl", "payments/product.gdl"]);
  });

  it("finds both layouts at once, each file once", () => {
    const root = make(["products/own/product.gdl", "shop/product.gdl", "shop/products/b/product.gdl"]);
    expect(found(root)).toEqual(["products/own/product.gdl", "shop/product.gdl", "shop/products/b/product.gdl"]);
  });

  it("does not descend into hidden or build directories", () => {
    const root = make([".gearbox/products/x/product.gdl", "node_modules/products/y/product.gdl", "target/product.gdl"]);
    expect(found(root)).toEqual([]);
  });

  it("answers nothing for a folder that is not there", () => {
    expect(productFiles(path.join(os.tmpdir(), "gbx-no-such-folder-here"))).toEqual([]);
  });
});
