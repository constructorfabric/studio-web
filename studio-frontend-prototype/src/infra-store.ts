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
import { homeSource, readInfra, useServiceText, writeInfra, type UseService } from "./infra-gdl";
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
 *  passport to compare with, what the description said before is kept, and
 *  an edit is told from the passport the project kept (`kept`, what the view
 *  showed beneath it): a value left as shown is not made the product's. */
export function useOf(
  s: InfraService,
  offered: readonly InfraPassport[],
  was: UseService | undefined,
  home: string,
  kept?: InfraPassport,
): UseService {
  const p = s.passport;
  const base = offered.find((o) => o.name === p.name);
  const differs = <T>(mine: T | null | undefined, theirs: T | null | undefined) =>
    mine && mine !== theirs ? mine : undefined;
  const said = <T>(mine: T | null | undefined, before: T | undefined, shown: T | null | undefined) =>
    mine === (before ?? shown) ? before : mine || undefined;
  const config = base
    ? Object.fromEntries(Object.entries(p.config).filter(([k, v]) => k in base.config && base.config[k] !== v))
    : Object.fromEntries(Object.entries(p.config).filter(([k, v]) => (was && k in was.config) || kept?.config[k] !== v));
  return {
    name: p.name,
    source: was?.source ?? home,
    image: base ? differs(p.image, base.image) : said(p.image, was?.image, kept?.image),
    chart: base ? differs(p.chart, base.chart) : said(p.chart, was?.chart, kept?.chart),
    chart_version: base ? differs(p.chart_version, base.chart_version) : said(p.chart_version, was?.chart_version, kept?.chart_version),
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
      const { latest, records, offered } = await read();
      if (!latest) return projectListStore(token, projectId).save(items, null);
      const chosen = readInfra(latest.text) ?? [];
      const home = homeSource(latest.text) ?? "";
      const next = items.map((s) => {
        const name = s.passport.name;
        const was = chosen.find((u) => u.name === name);
        if (was?.text) {
          // A call that says more than Studio reads goes back as written.
          if (sameJson(serviceOf(was, offered, records).passport, s.passport)) return was;
          throw new Error(`use_service("${name}") in product.gdl says more than Studio reads: change it in product.gdl`);
        }
        if (!was?.source && !home) {
          throw new Error(
            `product.gdl names no source of the product's own repository (source(id = "…", at = path("…"))) to take ${name} from: add one, or add ${name} in product.gdl`,
          );
        }
        return useOf(s, offered, was, home, records.find((r) => r.passport.name === name)?.passport);
      });
      // Services as the description says them are not written again.
      const same = next.length === chosen.length && next.every((u, i) => useServiceText(u) === useServiceText(chosen[i]));
      const text = same ? latest.text : writeInfra(latest.text, next);
      if (text !== latest.text) {
        await api.saveProductDescription(token, projectId, { base_revision: base ?? latest.revision, text });
      }
      await api.putInfraServices(token, projectId, items);
      return load();
    },
  };
}

/** Whether `a` and `b` are the same JSON, whatever their keys' order. */
function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
              .map(([k, x]) => [k, norm(x)]),
          )
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
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
