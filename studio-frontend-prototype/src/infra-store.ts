/* Where a product's infra services are kept (ADR-0064), behind one small
 * interface so the views do not know.
 *
 * Today: the project's list (`GET`/`PUT /infra-services`), which a PUT
 * replaces whole. The decision is to keep them in the product description
 * (`infra = [use_service(…)]` inside `product(…)` in product.gdl); a store
 * over the description's revisions then takes this one's place, and the
 * views keep calling `load` and `save`. */

import { api, type InfraService } from "./api";

/** Where the list was read from: said on screen, so a member knows what a
 *  save writes. */
export type InfraSource = "project-list" | "product-description";

export interface InfraLoaded {
  items: InfraService[];
  source: InfraSource;
  /** The description revision the list was read from; null for a store
   *  without revisions. A save is made against it. */
  revision: number | null;
}

export interface InfraStore {
  source: InfraSource;
  load(): Promise<InfraLoaded>;
  /** Write the whole list; what comes back is what was kept. `base` is the
   *  revision it was read at: a store with revisions refuses an older one. */
  save(items: InfraService[], base: number | null): Promise<InfraLoaded>;
}

/** The project's list: no revisions, the last write wins. */
export function projectListStore(token: string, projectId: string): InfraStore {
  const loaded = (r: { items: InfraService[] }): InfraLoaded => ({ items: r.items, source: "project-list", revision: null });
  return {
    source: "project-list",
    load: () => api.infraServices(token, projectId).then(loaded),
    save: (items) => api.putInfraServices(token, projectId, items).then(loaded),
  };
}

/** The store the product's views use. */
export function infraStore(token: string, projectId: string): InfraStore {
  return projectListStore(token, projectId);
}

/** The source in words, for the editor's footer. */
export const INFRA_SOURCE_TEXT: Record<InfraSource, string> = {
  "project-list": "Kept in the project's infra-services list; a save replaces it whole.",
  "product-description": "Kept in product.gdl; a save makes a new description revision.",
};
