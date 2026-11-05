/* Where a product's infra services are kept, behind one small interface so
 * the views do not know.
 *
 * ADR-0065: what the product runs -- the service, its image, its settings --
 * is in the product description (`infra = [use_service(…)]` in product.gdl),
 * so a save is a new revision. What each environment does with it -- its
 * copy of the image, a ready chart's values, its public address -- stays in
 * the project's list (`GET`/`PUT /infra-services`), which also keeps each
 * passport for builds made before the description said infra (ADR-0064). */

import { api, type InfraPassport, type InfraService } from "./api";
import { homeSource, readInfra, writeInfra, type UseService } from "./infra-gdl";
import { offeredInfra } from "./infra-services";

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

const bare = (name: string): InfraPassport => ({ name, ports: {}, args: [], config: {}, secrets: [], provides: {}, stateful: false });

/** A service as the views edit it: the passport the catalogue offers (else
 *  the one the project kept) with the description's choice over it, and the
 *  environment's side from the project's record. */
export function serviceOf(u: UseService, offered: readonly InfraPassport[], records: readonly InfraService[]): InfraService {
  const record = records.find((r) => r.passport.name === u.name);
  const base = offered.find((p) => p.name === u.name) ?? record?.passport ?? bare(u.name);
  return {
    ...record,
    passport: {
      ...base,
      image: u.image ?? base.image,
      chart: u.chart ?? base.chart,
      chart_version: u.chart_version ?? base.chart_version,
      config: { ...base.config, ...u.config },
    },
  };
}

/** The call that says `s`: only what differs from the catalogue's passport,
 *  so a passport's later default reaches the product. Without the catalogue's
 *  passport to compare with, what the description said before is kept. */
export function useOf(s: InfraService, offered: readonly InfraPassport[], was: UseService | undefined, home: string): UseService {
  const p = s.passport;
  const base = offered.find((o) => o.name === p.name);
  const differs = <T>(mine: T | null | undefined, theirs: T | null | undefined) =>
    mine && mine !== theirs ? mine : undefined;
  const config = base
    ? Object.fromEntries(Object.entries(p.config).filter(([k, v]) => k in base.config && base.config[k] !== v))
    : (was?.config ?? {});
  return {
    name: p.name,
    source: was?.source ?? home,
    image: base ? differs(p.image, base.image) : was?.image,
    chart: base ? differs(p.chart, base.chart) : was?.chart,
    chart_version: base ? differs(p.chart_version, base.chart_version) : was?.chart_version,
    config,
    profileConfigText: was?.profileConfigText,
  };
}

/** The product description's: a save is a new revision when the services
 *  change, and the environment's side is written to the project's list. A
 *  project without a description yet keeps the list alone. */
export function descriptionStore(token: string, projectId: string): InfraStore {
  const read = async () => {
    const [description, records, catalogue] = await Promise.all([
      api.productDescription(token, projectId),
      api.infraServices(token, projectId),
      api.listComponents(token, projectId).catch(() => ({ nodes: [] })),
    ]);
    return { latest: description.latest ?? null, records: records.items, offered: offeredInfra(catalogue.nodes ?? []) };
  };
  const load = async (): Promise<InfraLoaded> => {
    const { latest, records, offered } = await read();
    if (!latest) return { items: records, source: "project-list", revision: null };
    const chosen = readInfra(latest.text);
    // Not in the description yet: the project's list is shown, and the first
    // save writes it there.
    const items = chosen === null ? records : chosen.map((u) => serviceOf(u, offered, records));
    return { items, source: "product-description", revision: latest.revision };
  };
  return {
    source: "product-description",
    load,
    save: async (items, base) => {
      const { latest, offered } = await read();
      if (!latest) return projectListStore(token, projectId).save(items, null);
      const chosen = readInfra(latest.text) ?? [];
      const home = homeSource(latest.text) ?? "";
      const text = writeInfra(
        latest.text,
        items.map((s) => useOf(s, offered, chosen.find((u) => u.name === s.passport.name), home)),
      );
      if (text !== latest.text) {
        await api.saveProductDescription(token, projectId, { base_revision: base ?? latest.revision, text });
      }
      await api.putInfraServices(token, projectId, items);
      return load();
    },
  };
}

/** The store the product's views use. */
export function infraStore(token: string, projectId: string): InfraStore {
  return descriptionStore(token, projectId);
}

/** The source in words, for the editor's footer. */
export const INFRA_SOURCE_TEXT: Record<InfraSource, string> = {
  "project-list": "Kept in the project's infra-services list; a save replaces it whole.",
  "product-description":
    "Kept in product.gdl: a save makes a new description revision. Each environment's copy of the image and public address stay with the project.",
};
