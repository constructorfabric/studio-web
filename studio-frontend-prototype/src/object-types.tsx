import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { CatalogType, TypeCount } from "./api";
import { errText } from "./format";
import { EmptyState, PageHeader, StatusChip } from "./ui-standard";

/* ============================================================================
 * Objects — every type the graph holds, and which of them are components.
 *
 * The Components page used to list nodes of one hardcoded type, which made
 * "what is a component" a constant inside a gear. It is not: it is a judgement
 * about an organization's model. This page is where that judgement is made,
 * and the Components page is the view of what it produced.
 *
 * A type marked here appears there. A type unmarked here leaves. Nothing else
 * about the graph changes — a mark is an opinion about a type, not a migration
 * of the nodes under it.
 * ==========================================================================*/

/** How a type reads at a glance. Not a taxonomy — a way to keep four hundred
 *  rows scannable, derived from the id because the id is the only thing every
 *  type is guaranteed to have. */
function familyOf(leafId: string): string {
  const body = leafId.replace(/^gts\./, "").replace(/~$/, "");
  const tokens = body.split(".");
  // vendor.package.namespace.type.vN — the namespace is the useful grouping.
  return tokens.length >= 3 ? `${tokens[1]}.${tokens[2]}` : body;
}

/** The type's own name, without the ancestry or the version. */
function shortName(leafId: string): string {
  const body = leafId.replace(/^gts\./, "").replace(/~$/, "");
  const tokens = body.split(".");
  return tokens.length >= 4 ? tokens[3] : body;
}

function titleize(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type Lens = "all" | "components" | "described" | "abstract";

/** The metadata Studio keeps beside a component (it names its gear in
 *  `gear_name`), never a component of its own; the server refuses the mark. */
export const COMPANION_TYPES = new Set(["gts.cf.studio.catalog.gear_profile.v1~"]);

const LENS_LABEL: Record<Lens, string> = {
  all: "All types",
  components: "Components",
  described: "With a page",
  abstract: "Abstract",
};

export function ObjectTypes({ token, query = "" }: { token: string; query?: string }) {
  const [types, setTypes] = useState<CatalogType[] | null>(null);
  // `gts_id -> title`, from the types-registry: ADR-0013 makes that the
  // catalogue of MEANING, so a human name comes from there rather than from
  // prettifying an identifier — `domain.skill` is displayed "Competency" if
  // that is what the model calls it.
  const [titles, setTitles] = useState<Record<string, string>>({});
  // `leaf_id -> count`, loaded after the table so hundreds of types render at
  // once rather than waiting on one projection each. `null` while unknown: an
  // absent count reads as "not counted yet", never as "empty".
  const [objectCounts, setObjectCounts] = useState<Record<string, TypeCount> | null>(null);
  const [lens, setLens] = useState<Lens>("all");
  const [err, setErr] = useState<string | null>(null);
  // The type currently being written, so its row can say so and not be
  // clicked twice.
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      const { types } = await api.catalogTypes(token);
      setTypes(types ?? []);
    } catch (e) {
      setErr(errText(e));
      setTypes([]);
    }
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let live = true;
    api
      .typeCounts(token)
      .then(({ counts }) => {
        if (!live) return;
        const next: Record<string, TypeCount> = {};
        for (const c of counts ?? []) next[c.leaf_id] = c;
        setObjectCounts(next);
      })
      .catch(() => {
        // A count that cannot be taken leaves the column blank. Showing zero
        // would be a claim about the graph that nothing checked.
        if (live) setObjectCounts(null);
      });
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    let live = true;
    api
      .gtsTypeTitles(token)
      .then(({ entities }) => {
        if (!live) return;
        const next: Record<string, string> = {};
        for (const e of entities ?? []) {
          const title = e.content?.title?.trim();
          if (title) next[e.gts_id] = title;
        }
        setTitles(next);
      })
      .catch(() => {
        // A registry that will not answer costs the names, not the page.
        if (live) setTitles({});
      });
    return () => {
      live = false;
    };
  }, [token]);

  const nameOf = useCallback(
    (t: CatalogType) =>
      titles[t.leaf_id] ?? titles[t.type_id] ?? titleize(shortName(t.leaf_id)),
    [titles],
  );

  const toggle = async (t: CatalogType) => {
    setBusy(t.leaf_id);
    setErr(null);
    try {
      await api.setTypeComponent(token, t.leaf_id, !t.component);
      // Optimism would be wrong here: the server prunes a mark that agrees
      // with what the tenant inherits, so what it stored is not always what
      // was sent. Read it back.
      await reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (types ?? [])
      .filter((t) => {
        if (lens === "components") return t.component;
        if (lens === "described") return t.schema !== "none";
        if (lens === "abstract") return t.is_abstract;
        return true;
      })
      .filter(
        (t) =>
          !q ||
          t.leaf_id.toLowerCase().includes(q) ||
          nameOf(t).toLowerCase().includes(q),
      )
      .sort((a, b) => {
        // Components first: they are what somebody came here to check.
        if (a.component !== b.component) return a.component ? -1 : 1;
        return a.leaf_id.localeCompare(b.leaf_id);
      });
  }, [types, lens, query, nameOf]);

  const counts = useMemo(() => {
    const all = types ?? [];
    return {
      all: all.length,
      components: all.filter((t) => t.component).length,
      described: all.filter((t) => t.schema !== "none").length,
      abstract: all.filter((t) => t.is_abstract).length,
    };
  }, [types]);

  return (
    <div className="objt">
      <style>{OBJT_CSS}</style>

      <PageHeader
        title="Objects"
        status={
          types !== null && (
            <>
              <span>
                {counts.all} type{counts.all === 1 ? "" : "s"} in the graph-storage ontology
              </span>
              <StatusChip tone={counts.components > 0 ? "ok" : "neutral"}>
                {counts.components} component{counts.components === 1 ? "" : "s"}
              </StatusChip>
            </>
          )
        }
        info={
          <>
            <p>
              Every type the graph stores for this organization. Tick one and it becomes a <strong>component</strong>:
              the Components page lists its nodes, against the field schema the type has, or the gear schema if it has
              none of its own. Untick it and it leaves. The nodes are untouched either way: a mark is an opinion about a
              type, not a change to what is stored under it.
            </p>
            <p>
              <strong>Objects</strong> counts the nodes of each type in this organization&apos;s graph. graph-storage
              has no count in its contract, so the number is taken by paging and stops at 2 000; past that it reads{" "}
              <code>2 000+</code>, which is also where the Components page stops rendering.
            </p>
          </>
        }
      />

      <div className="objt-lenses">
        {(Object.keys(LENS_LABEL) as Lens[]).map((l) => (
          <button key={l} aria-pressed={lens === l} onClick={() => setLens(l)}>
            {LENS_LABEL[l]} <span className="objt-count">{counts[l]}</span>
          </button>
        ))}
      </div>

      {err && <p className="objt-err">{err}</p>}

      {types === null ? (
        <div className="empty">Reading the ontology…</div>
      ) : visible.length === 0 ? (
        counts.all === 0 ? (
          <EmptyState title="The graph has no node types yet." body="Run a sync, or ingest an artifact." />
        ) : (
          <EmptyState title="No type matches the current filter." />
        )
      ) : (
        <table className="objt-table">
          <thead>
            <tr>
              <th className="objt-tick">Component</th>
              <th>Type</th>
              <th className="objt-num">Objects</th>
              <th>Namespace</th>
              <th>Page</th>
              <th>Identifier</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t) => (
              <tr key={t.leaf_id} className={t.component ? "is-component" : undefined}>
                <td className="objt-tick">
                  <input
                    type="checkbox"
                    checked={t.component}
                    // An abstract type is a family: it is derived from and
                    // never instantiated, so marking one would produce a page
                    // that can never have a card on it.
                    disabled={t.is_abstract || COMPANION_TYPES.has(t.leaf_id) || busy === t.leaf_id}
                    title={
                      COMPANION_TYPES.has(t.leaf_id)
                        ? "Studio keeps this beside a component; it is not one of its own"
                        : undefined
                    }
                    onChange={() => void toggle(t)}
                    aria-label={`Treat ${nameOf(t)} as a component`}
                  />
                </td>
                <td>
                  <span className="objt-name">{nameOf(t)}</span>
                  {t.is_abstract && <StatusChip tone="neutral" className="objt-pill">family</StatusChip>}
                  {!t.type_id && (
                    <StatusChip tone="warn" className="objt-pill" title="Marked, but the graph holds no node of it yet">
                      no nodes yet
                    </StatusChip>
                  )}
                </td>
                <td className="objt-num">
                  <ObjectCount count={objectCounts?.[t.leaf_id]} known={objectCounts !== null} />
                </td>
                <td className="objt-dim">{familyOf(t.leaf_id)}</td>
                <td>
                  <StatusChip tone={t.schema === "tenant" ? "info" : "neutral"} className="objt-pill" data-schema={t.schema}>
                    {t.schema === "tenant"
                      ? "yours"
                      : t.schema === "builtin"
                        ? "built-in"
                        : "gear schema"}
                  </StatusChip>
                </td>
                <td className="objt-id">{t.leaf_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** How many nodes of a type there are, or an honest absence of that number.
 *
 *  Three states, and they are not the same thing: not counted yet, counted and
 *  empty, counted past the cap. Only the middle one is a zero. */
function ObjectCount({ count, known }: { count: TypeCount | undefined; known: boolean }) {
  if (!known) return <span className="objt-dim">—</span>;
  if (!count) return <span className="objt-dim">—</span>;
  if (count.count === 0) return <span className="objt-zero">0</span>;
  return (
    <span
      title={
        count.capped
          ? `More than ${count.count} — the count stops there, and so does the Components page`
          : undefined
      }
    >
      {count.count.toLocaleString()}
      {count.capped && <span className="objt-plus">+</span>}
    </span>
  );
}

const OBJT_CSS = `
.objt { padding: 22px 26px 40px; }
.objt-lenses { display: flex; gap: 6px; margin: 14px 0 10px; flex-wrap: wrap; }
.objt-lenses button {
  background: transparent; border: 1px solid var(--studio-line); color: inherit;
  border-radius: var(--radius-full); padding: 5px 12px; font-size: 12px; cursor: pointer;
}
.objt-lenses button[aria-pressed="true"] { border-color: var(--studio-accent); color: var(--studio-accent); }
.objt-count { opacity: .6; margin-left: 4px; }
.objt-err { color: var(--studio-danger); font-size: 13px; }
.objt-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.objt-table th {
  text-align: left; font-weight: 500; color: var(--studio-muted); font-size: 11px;
  text-transform: uppercase; letter-spacing: .04em; padding: 8px 10px;
  border-bottom: 1px solid var(--studio-line);
}
.objt-table td { padding: 8px 10px; border-bottom: 1px solid var(--studio-line); vertical-align: middle; }
.objt-table tr.is-component .objt-name { color: var(--studio-accent); }
.objt-tick { width: 92px; }
.objt-num { width: 90px; text-align: right; font-variant-numeric: tabular-nums; }
.objt-zero { opacity: .4; }
.objt-plus { opacity: .6; margin-left: 1px; }
.objt-name { font-weight: 500; }
.objt-dim { color: var(--studio-muted); }
.objt-id { color: var(--studio-muted); font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
.objt-pill { margin-left: 8px; }
`;
