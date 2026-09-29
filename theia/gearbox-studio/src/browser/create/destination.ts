// Constructor Studio: where New Product suggests putting a product.

/**
 * `<root>/products/<id>/product.gdl` -- the layout discovery finds under the
 * repository the member opened (`productFiles`), for the id typed now.
 * Forward slashes whatever the root uses; `new-product` for an empty id.
 */
export function suggestedProductPath(root: string, productId: string): string {
  const id = productId.trim() === "" ? "new-product" : productId.trim();
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${base}/products/${id}/product.gdl`;
}

/**
 * The destination after the id changed. One taken from the suggestion follows
 * the id -- the person asked for "where you would put it", and that moved --
 * while one chosen or typed stays as it is.
 */
export function destinationAfterIdChange(
  destination: string,
  followsId: boolean,
  root: string,
  productId: string,
): string {
  return followsId && root !== "" ? suggestedProductPath(root, productId) : destination;
}

/** The preview pane's words while no dry run has answered for the destination now in the field. */
export function pendingPreview(current: string, destination: string, suggested: string): string {
  if (destination.trim() === "") return `Choose a destination. Suggested: ${suggested}`;
  return current.startsWith("Choose a destination") ? "Previewing…" : current;
}
