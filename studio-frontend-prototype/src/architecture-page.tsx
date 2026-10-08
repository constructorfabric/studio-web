/* The /architecture/ page: how Studio is built, drawn from the backend that is
 * running. The model — domains, the application map, who uses whom — is in
 * `architecture.ts`; this file only draws it.
 *
 * Opened from the product menu in a tab of its own, like /api-docs/. The
 * manifest needs a signed-in caller, so the page renews the portal's session
 * (the refresh token the portal keeps in this browser) instead of signing in
 * again; without one it says so and links back to the portal. */

import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { OpenApiDoc } from "./api-docs";
import {
  AREAS,
  SURFACES,
  VIA_WORDS,
  apiDocsUrl,
  capabilityWords,
  commitUrl,
  commitsDiffer,
  designDocUrl,
  domainById,
  domainLinks,
  domainOf,
  edgeCounts,
  edgesOf,
  gearCounts,
  gearTitle,
  groupPlatform,
  groupStudio,
  leaks,
  reportsUses,
  restSurfaces,
  shortCommit,
  summary,
  surfaceCounts,
  surfacesOf,
  usedBy,
  usesOf,
} from "./architecture";
import type { Edge, GroupedDomain, Manifest, ManifestGear, PrototypeMap, RestSurface, Surface, Via } from "./architecture";
import "./styles.css";
import "./architecture.css";

const MANIFEST_URL = "/cf/studio-assembly/v1/manifest";
const OPENAPI_URL = "/cf/openapi.json";
const MAP_URL = "./prototype-map.json";

type Loaded = { manifest: Manifest; openapi: OpenApiDoc | null; map: PrototypeMap | null };
type LoadError = { kind: "signed-out" | "missing" | "failed"; message: string };

/** The portal's session in this browser, renewed; null when there is none. */
async function accessToken(): Promise<string | null> {
  try {
    const { hasSsoSession, refreshSsoSession } = await import("./oidc");
    if (!hasSsoSession()) return null;
    const session = await refreshSsoSession();
    return session?.accessToken ?? null;
  } catch {
    return null;
  }
}

async function load(): Promise<Loaded> {
  const token = await accessToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const [manifestRes, openapi, map] = await Promise.all([
    fetch(MANIFEST_URL, { headers }),
    fetch(OPENAPI_URL, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<OpenApiDoc>) : null))
      .catch(() => null),
    fetch(MAP_URL, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<PrototypeMap>) : null))
      .catch(() => null),
  ]);
  if (manifestRes.status === 401) {
    throw { kind: "signed-out", message: "Sign in to Studio in this browser first." } satisfies LoadError;
  }
  if (manifestRes.status === 404) {
    throw {
      kind: "missing",
      message: "This backend is older than the architecture page: it has no /studio-assembly/v1/manifest.",
    } satisfies LoadError;
  }
  if (!manifestRes.ok) {
    throw { kind: "failed", message: `${MANIFEST_URL} answered ${manifestRes.status}.` } satisfies LoadError;
  }
  return { manifest: (await manifestRes.json()) as Manifest, openapi, map };
}

/* ── Selection ───────────────────────────────────────────────────────────── */

type Selection = { kind: "gear"; name: string } | { kind: "surface"; id: string } | null;

function selectionFromHash(): Selection {
  const gear = window.location.hash.match(/^#gear=(.+)$/);
  if (gear) return { kind: "gear", name: decodeURIComponent(gear[1]) };
  const surface = window.location.hash.match(/^#surface=(.+)$/);
  if (surface) return { kind: "surface", id: decodeURIComponent(surface[1]) };
  return null;
}

function hashOf(selection: NonNullable<Selection>): string {
  return selection.kind === "gear"
    ? `#gear=${encodeURIComponent(selection.name)}`
    : `#surface=${encodeURIComponent(selection.id)}`;
}

/* ── Small pieces ────────────────────────────────────────────────────────── */

function kindLabel(gear: ManifestGear): string {
  const origin = gear.origin === "studio" ? "Studio" : "Platform";
  const role = gear.role === "plugin" ? "plugin" : gear.role === "system" ? "system gear" : "gear";
  return `${origin} ${role}`;
}

type ChipState = "selected" | "related" | "dim" | "plain";

function GearChip({
  name,
  gear,
  state = "plain",
  note,
  onSelect,
}: {
  name: string;
  gear?: ManifestGear;
  state?: ChipState;
  note?: ReactNode;
  onSelect: (name: string) => void;
}) {
  const origin = gear ? (gear.origin === "studio" ? "studio" : "platform") : name.startsWith("studio-") ? "studio" : "platform";
  return (
    <button
      type="button"
      className={`arch-gear origin-${origin} role-${gear?.role ?? "gear"} is-${state}${gear ? "" : " is-absent"}`}
      aria-pressed={state === "selected"}
      title={gear ? `${name} — ${kindLabel(gear)}` : `${name} — not linked into this backend`}
      data-gear={name}
      onClick={() => onSelect(name)}
    >
      <span className="arch-gear-name">{name}</span>
      {note}
    </button>
  );
}

function ViaTag({ via }: { via: Via }) {
  return (
    <span className={`arch-via via-${via}`} title={VIA_WORDS[via].says}>
      {via === "internal" ? "⚠ internal" : VIA_WORDS[via].label}
    </span>
  );
}

function CommitLink({ commit }: { commit?: string | null }) {
  if (!commit) return <span className="arch-muted">local build (no commit recorded)</span>;
  return (
    <a href={commitUrl(commit)} target="_blank" rel="noopener noreferrer">
      <code>{shortCommit(commit)}</code>
    </a>
  );
}

function Stat({ value, label, tone }: { value: ReactNode; label: ReactNode; tone?: "bad" }) {
  return (
    <div className={`arch-stat${tone ? ` is-${tone}` : ""}`}>
      <span className="arch-stat-value">{value}</span>
      <span className="arch-stat-label">{label}</span>
    </div>
  );
}

/* ── View 1: the application map ─────────────────────────────────────────── */

function SurfaceList({
  selection,
  byName,
  onSurface,
  onGear,
}: {
  selection: Selection;
  byName: Map<string, ManifestGear>;
  onSurface: (id: string) => void;
  onGear: (name: string) => void;
}) {
  const gearSelected = selection?.kind === "gear" ? selection.name : null;
  const surfaceSelected = selection?.kind === "surface" ? selection.id : null;
  return (
    <div className="arch-surfaces">
      {AREAS.map((area) => {
        const surfaces = SURFACES.filter((s) => s.area === area.id);
        return (
          <section key={area.id} className="arch-area">
            <h3 className="arch-area-title">{area.title}</h3>
            <ul>
              {surfaces.map((s) => {
                const relies = gearSelected ? s.gears.includes(gearSelected) : false;
                const state = surfaceSelected
                  ? s.id === surfaceSelected
                    ? "selected"
                    : "dim"
                  : gearSelected
                    ? relies
                      ? "related"
                      : "dim"
                    : "plain";
                return (
                  <li key={s.id} className={`arch-surface is-${state}`} data-surface={s.id}>
                    <button
                      type="button"
                      className="arch-surface-head"
                      aria-pressed={state === "selected"}
                      onClick={() => onSurface(s.id)}
                    >
                      <span className="arch-surface-title">{s.title}</span>
                      <span className="arch-surface-count">
                        {s.gears.length} gear{s.gears.length === 1 ? "" : "s"}
                      </span>
                    </button>
                    <p className="arch-surface-does">{s.does}</p>
                    {state === "selected" && (
                      <div className="arch-chips arch-surface-gears">
                        {s.hostedBy?.map((name) => (
                          <GearChip
                            key={`host-${name}`}
                            name={name}
                            gear={byName.get(name)}
                            onSelect={onGear}
                            note={<span className="arch-chip-note">runs inside</span>}
                          />
                        ))}
                        {s.gears
                          .filter((g) => !s.hostedBy?.includes(g))
                          .map((name) => (
                            <GearChip key={name} name={name} gear={byName.get(name)} onSelect={onGear} />
                          ))}
                      </div>
                    )}
                    {state === "related" && gearSelected && (
                      <p className="arch-surface-why">calls {gearSelected}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function MapBoard({
  studio,
  platform,
  byName,
  selection,
  onGear,
}: {
  studio: GroupedDomain[];
  platform: { title: string; gears: ManifestGear[] }[];
  byName: Map<string, ManifestGear>;
  selection: Selection;
  onGear: (name: string) => void;
}) {
  const counts = useMemo(() => surfaceCounts(), []);
  const surface = selection?.kind === "surface" ? SURFACES.find((s) => s.id === selection.id) : undefined;
  const gearSelected = selection?.kind === "gear" ? selection.name : null;
  const stateOf = (name: string): ChipState =>
    gearSelected
      ? name === gearSelected
        ? "selected"
        : "dim"
      : surface
        ? surface.gears.includes(name)
          ? "related"
          : "dim"
        : "plain";
  const note = (name: string) => {
    const n = counts.get(name) ?? 0;
    return n ? <span className="arch-chip-note">{n}</span> : null;
  };
  return (
    <div className="arch-mapboard">
      <div className="arch-domains compact">
        {studio.map(({ domain, gears }) => (
          <section key={domain.id} className="arch-domain" data-domain={domain.id}>
            <h3 className="arch-domain-title">{domain.title}</h3>
            <div className="arch-chips">
              {gears.map((g) => (
                <GearChip key={g.name} name={g.name} gear={g} state={stateOf(g.name)} note={note(g.name)} onSelect={onGear} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <section className="arch-platform compact">
        <h3 className="arch-domain-title">Platform (gears-rust) — the screens call these directly too</h3>
        <div className="arch-chips">
          {platform
            .flatMap((row) => row.gears)
            .filter((g) => (counts.get(g.name) ?? 0) > 0 || stateOf(g.name) === "selected")
            .map((g) => (
              <GearChip key={g.name} name={g.name} gear={g} state={stateOf(g.name)} note={note(g.name)} onSelect={onGear} />
            ))}
          {[...counts.keys()]
            .filter((n) => !byName.has(n))
            .sort()
            .map((n) => (
              <GearChip key={n} name={n} state={stateOf(n)} note={note(n)} onSelect={onGear} />
            ))}
        </div>
      </section>
      <p className="arch-muted arch-small">
        The number on a gear is how many of the places on the left call it. A gear without one is not called
        from any screen: it works behind the others.
      </p>
    </div>
  );
}

/* ── View 2: who uses whom ───────────────────────────────────────────────── */

interface Line {
  d: string;
  via: Via;
}

function DependencyBoard({
  studio,
  platform,
  gears,
  edges,
  hasUses,
  selected,
  onGear,
}: {
  studio: GroupedDomain[];
  platform: { title: string; gears: ManifestGear[] }[];
  gears: ManifestGear[];
  edges: Edge[];
  hasUses: boolean;
  selected: string | null;
  onGear: (name: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const current = selected ? gears.find((g) => g.name === selected) : undefined;
  const out = useMemo(() => (selected ? new Map(usesOf(edges, selected).map((e) => [e.to, e])) : new Map<string, Edge>()), [edges, selected]);
  const inc = useMemo(() => (selected ? new Map(usedBy(edges, selected).map((e) => [e.from, e])) : new Map<string, Edge>()), [edges, selected]);
  const needs = new Set(current?.depends_on ?? []);

  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box || !selected) return setLines([]);
    const origin = box.getBoundingClientRect();
    const rowOf = (name: string) => box.querySelector<HTMLElement>(`[data-row="${CSS.escape(name)}"]`);
    const from = rowOf(selected);
    if (!from) return setLines([]);
    const a = from.getBoundingClientRect();
    const out2: Line[] = [];
    const curve = (other: string, via: Via) => {
      const el = rowOf(other);
      if (!el) return;
      const b = el.getBoundingClientRect();
      const ax = a.left - origin.left + a.width / 2;
      const ay = a.top - origin.top + a.height / 2;
      const bx = b.left - origin.left + b.width / 2;
      const by = b.top - origin.top + b.height / 2;
      const mx = (ax + bx) / 2;
      const my = Math.min(ay, by) - 24;
      out2.push({ d: `M${ax},${ay} Q${mx},${my} ${bx},${by}`, via });
    };
    for (const [name, e] of out) curve(name, e.via);
    for (const [name, e] of inc) if (!out.has(name)) curve(name, e.via);
    setLines(out2);
  }, [selected, out, inc]);

  useLayoutEffect(() => {
    measure();
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(box);
    return () => observer.disconnect();
  }, [measure]);

  const row = (g: ManifestGear, plugins: ManifestGear[] = []) => {
    const c = gearCounts(edges, g.name);
    const isSel = g.name === selected;
    const o = out.get(g.name);
    const i = inc.get(g.name);
    const related = Boolean(o || i);
    const state = !selected ? "plain" : isSel ? "selected" : related ? "related" : hasUses ? "dim" : "plain";
    return (
      <li key={g.name}>
        <button
          type="button"
          className={`arch-row is-${state}`}
          data-row={g.name}
          aria-pressed={isSel}
          onClick={() => onGear(g.name)}
        >
          <span className="arch-row-name">{g.name}</span>
          {selected && !isSel && related ? (
            <span className="arch-row-rel">
              {o && (
                <span>
                  {selected} uses it <ViaTag via={o.via} />
                </span>
              )}
              {i && (
                <span>
                  uses {selected} <ViaTag via={i.via} />
                </span>
              )}
            </span>
          ) : hasUses ? (
            <span className="arch-row-counts">
              <span title="Studio gears that use it">used by {c.usedBy}</span>
              <span title="Studio gears it uses">uses {c.uses}</span>
              {c.reachedInto > 0 && (
                <span className="arch-bad" title="Gears that reach into its private modules">
                  ⚠ {c.reachedInto} reach in
                </span>
              )}
            </span>
          ) : (
            <span className="arch-row-counts">
              <span>needs {g.depends_on.length} platform gear{g.depends_on.length === 1 ? "" : "s"}</span>
            </span>
          )}
        </button>
        {plugins.length > 0 && (
          <p className="arch-plugins-note">
            + {plugins.length} plugin{plugins.length === 1 ? "" : "s"}:{" "}
            {plugins.map((p) => p.name.replace(/-connector-plugin$/, "")).join(", ")}
          </p>
        )}
      </li>
    );
  };

  return (
    <div className="arch-depboard" ref={boxRef}>
      <svg className="arch-lines" aria-hidden="true">
        {lines.map((l, i) => (
          <path key={i} d={l.d} className={`arch-line via-${l.via}`} />
        ))}
      </svg>
      <div className="arch-domains">
        {studio.map(({ domain, gears: own, plugins }) => {
          const internalOut = edges.filter(
            (e) => e.via === "internal" && own.some((g) => g.name === e.from),
          ).length;
          return (
            <section key={domain.id} className="arch-domain" data-domain={domain.id}>
              <h3 className="arch-domain-title">
                {domain.title}
                {hasUses && internalOut > 0 && (
                  <span className="arch-domain-bad" title="Uses from this domain that reach into another gear's internals">
                    ⚠ {internalOut} internal use{internalOut === 1 ? "" : "s"}
                  </span>
                )}
              </h3>
              <p className="arch-domain-blurb">{domain.blurb}</p>
              <ul className="arch-rows">{own.map((g) => row(g, plugins.get(g.name)))}</ul>
            </section>
          );
        })}
      </div>
      <section className="arch-platform">
        <h3 className="arch-domain-title">Platform (gears-rust)</h3>
        <p className="arch-domain-blurb">
          Studio's gears reach the platform through its SDKs only; the toolkit checks those dependencies at start.
          {current ? ` Outlined: what ${current.name} needs.` : " Choose a Studio gear to outline what it needs."}
        </p>
        <div className="arch-platform-rows">
          {platform.map((r) => (
            <div key={r.title} className="arch-platform-row">
              <span className="arch-platform-title">{r.title}</span>
              <span className="arch-chips">
                {r.gears.map((g) => (
                  <GearChip
                    key={g.name}
                    name={g.name}
                    gear={g}
                    state={!current ? "plain" : g.name === current.name ? "selected" : needs.has(g.name) ? "related" : "dim"}
                    onSelect={onGear}
                  />
                ))}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function LeakList({ edges, onGear }: { edges: Edge[]; onGear: (name: string) => void }) {
  const list = useMemo(() => leaks(edges), [edges]);
  if (list.length === 0) return <p className="arch-muted">No gear reaches into another's internals.</p>;
  return (
    <ol className="arch-leaks">
      {list.map((leak) => (
        <li key={leak.gear} className="arch-leak">
          <div className="arch-leak-head">
            <button type="button" className="arch-link-button" onClick={() => onGear(leak.gear)}>
              {leak.gear}
            </button>
            <span>
              — <strong>{leak.users.length}</strong> gear{leak.users.length === 1 ? " reaches" : "s reach"} into its
              private modules
            </span>
          </div>
          <ul className="arch-leak-modules">
            {leak.modules.map((m) => (
              <li key={m.item}>
                <code>
                  {leak.gear.replace(/^studio-/, "")}::{m.item}
                </code>{" "}
                <span className="arch-muted">by</span>{" "}
                {m.users.map((u, i) => (
                  <span key={u}>
                    {i > 0 && ", "}
                    <button type="button" className="arch-link-button" onClick={() => onGear(u)}>
                      {u.replace(/^studio-/, "")}
                    </button>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function DomainLinks({ edges, gears }: { edges: Edge[]; gears: ManifestGear[] }) {
  const all = useMemo(() => domainLinks(edges, gears), [edges, gears]);
  // Only the crossings that leak: the clean ones are the design working.
  const links = all.filter((l) => l.internal > 0);
  const clean = all.length - links.length;
  if (all.length === 0) return null;
  return (
    <>
    <p className="arch-muted arch-small arch-intro">
      Uses that cross from one domain into another's internals. {clean} other crossing
      {clean === 1 ? " goes" : "s go"} only through ports or surfaces.
    </p>
    <table className="arch-table">
      <thead>
        <tr>
          <th scope="col">From</th>
          <th scope="col">To</th>
          <th scope="col" className="num">
            Uses
          </th>
          <th scope="col" className="num">
            Internal
          </th>
        </tr>
      </thead>
      <tbody>
        {links.map((l) => (
          <tr key={`${l.from}>${l.to}`}>
            <td>{domainById(l.from).title}</td>
            <td>{domainById(l.to).title}</td>
            <td className="num">{l.total}</td>
            <td className={`num${l.internal ? " arch-bad" : ""}`}>{l.internal ? `⚠ ${l.internal}` : "0"}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}

/* ── The detail of one gear ──────────────────────────────────────────────── */

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="arch-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function EdgeList({
  edges,
  side,
  byName,
  onGear,
}: {
  edges: Edge[];
  side: "to" | "from";
  byName: Map<string, ManifestGear>;
  onGear: (name: string) => void;
}) {
  return (
    <ul className="arch-edges">
      {edges.map((e) => {
        const other = e[side];
        return (
          <li key={other} className={`via-${e.via}`}>
            <GearChip name={other} gear={byName.get(other)} onSelect={onGear} />
            <ViaTag via={e.via} />
            {e.items.length > 0 && <code className="arch-items">{e.items.join(", ")}</code>}
          </li>
        );
      })}
    </ul>
  );
}

function GearDetail({
  gear,
  gears,
  edges,
  hasUses,
  commit,
  surface,
  onGear,
  onSurface,
  onClose,
}: {
  gear: ManifestGear;
  gears: ManifestGear[];
  edges: Edge[];
  hasUses: boolean;
  commit?: string | null;
  surface?: RestSurface;
  onGear: (name: string) => void;
  onSurface: (id: string) => void;
  onClose: () => void;
}) {
  const byName = new Map(gears.map((g) => [g.name, g]));
  const out = usesOf(edges, gear.name);
  const inc = usedBy(edges, gear.name);
  const screens = surfacesOf(gear.name);
  const hosted = gears.filter((g) => g.role === "plugin" && g.extends === gear.name);
  const domain = domainById(domainOf(gear));
  const reachIn = inc.filter((e) => e.via === "internal").length;
  return (
    <div className="arch-detail-body" data-detail={gear.name}>
      <div className="arch-detail-top">
        <h2 className="arch-detail-title">{gearTitle(gear.name)}</h2>
        <button type="button" className="arch-close" onClick={onClose} aria-label="Close the gear's detail">
          ×
        </button>
      </div>
      <p className="arch-detail-sub">
        <code>{gear.name}</code> <span className="badge">{kindLabel(gear)}</span>{" "}
        <span className="badge">{domain.title}</span>
      </p>
      {gear.purpose ? (
        <p className="arch-purpose">{gear.purpose}</p>
      ) : (
        <p className="arch-muted">
          {gear.origin === "studio"
            ? "No design document describes this gear yet."
            : "A platform gear: its documentation lives with gears-rust."}
        </p>
      )}
      {gear.design_doc && (
        <p className="arch-small">
          <a href={designDocUrl(gear.design_doc, commit)} target="_blank" rel="noopener noreferrer">
            Read its design
          </a>{" "}
          <span className="arch-muted">
            ({gear.design_doc} at {shortCommit(commit)})
          </span>
        </p>
      )}
      {reachIn > 0 && (
        <p className="arch-warn arch-small" role="note">
          ⚠ {reachIn} gear{reachIn === 1 ? " reaches" : "s reach"} into this gear's private modules instead of its
          port. Changing those modules breaks {reachIn === 1 ? "it" : "them"}.
        </p>
      )}
      <dl className="arch-facts">
        <Fact label="Where people use it">
          {screens.length ? (
            <ul className="arch-plain-list">
              {screens.map((s) => (
                <li key={s.id}>
                  <button type="button" className="arch-link-button" onClick={() => onSurface(s.id)}>
                    {s.title}
                  </button>{" "}
                  <span className="arch-muted">({AREAS.find((a) => a.id === s.area)?.title.toLowerCase()})</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="arch-muted">no screen calls it directly</span>
          )}
        </Fact>
        {gear.origin === "studio" && (
          <>
            <Fact label={hasUses ? `Uses (${out.length})` : "Uses"}>
              {!hasUses ? (
                <span className="arch-muted">this backend does not report it</span>
              ) : out.length ? (
                <EdgeList edges={out} side="to" byName={byName} onGear={onGear} />
              ) : (
                <span className="arch-muted">no other Studio gear</span>
              )}
            </Fact>
            <Fact label={hasUses ? `Used by (${inc.length})` : "Used by"}>
              {!hasUses ? (
                <span className="arch-muted">this backend does not report it</span>
              ) : inc.length ? (
                <EdgeList edges={inc} side="from" byName={byName} onGear={onGear} />
              ) : (
                <span className="arch-muted">no other Studio gear</span>
              )}
            </Fact>
          </>
        )}
        <Fact label="Needs from the platform">
          {gear.depends_on.length ? (
            <span className="arch-chips">
              {gear.depends_on.map((d) => (
                <GearChip key={d} name={d} gear={byName.get(d)} onSelect={onGear} />
              ))}
            </span>
          ) : (
            <span className="arch-muted">nothing — it can start first</span>
          )}
        </Fact>
        {gear.role === "plugin" && (
          <Fact label="Plugs into">
            {gear.extends ? (
              <GearChip name={gear.extends} gear={byName.get(gear.extends)} onSelect={onGear} />
            ) : (
              <span className="arch-muted">not said by its name</span>
            )}
          </Fact>
        )}
        {hosted.length > 0 && (
          <Fact label={`Plugins it hosts (${hosted.length})`}>
            <span className="arch-chips">
              {hosted.map((p) => (
                <GearChip key={p.name} name={p.name} gear={p} onSelect={onGear} />
              ))}
            </span>
          </Fact>
        )}
        <Fact label="What it is">
          {gear.capabilities.filter((c) => c !== "system").length || gear.role === "system" ? (
            <ul className="arch-plain-list">
              {gear.capabilities.map((c) => (
                <li key={c}>{capabilityWords(c)}</li>
              ))}
            </ul>
          ) : (
            <span className="arch-muted">a library other gears call in-process; no API, tables or workers</span>
          )}
        </Fact>
        <Fact label="REST API">
          {surface ? (
            <span className="arch-rest">
              {surface.prefixes.map((p) => (
                <code key={p}>{p}</code>
              ))}
              <span className="arch-muted">
                {surface.operations} operation{surface.operations === 1 ? "" : "s"}
              </span>
              <a href={apiDocsUrl(surface.component)} target="_blank" rel="noopener">
                Open in Docs &amp; API
              </a>
            </span>
          ) : (
            <span className="arch-muted">none of its own (or /cf/openapi.json was not readable)</span>
          )}
        </Fact>
      </dl>
    </div>
  );
}

function SurfaceDetail({
  surface,
  byName,
  onGear,
  onClose,
}: {
  surface: Surface;
  byName: Map<string, ManifestGear>;
  onGear: (name: string) => void;
  onClose: () => void;
}) {
  const studio = surface.gears.filter((g) => g.startsWith("studio-"));
  const platform = surface.gears.filter((g) => !g.startsWith("studio-"));
  return (
    <div className="arch-detail-body" data-detail-surface={surface.id}>
      <div className="arch-detail-top">
        <h2 className="arch-detail-title">{surface.title}</h2>
        <button type="button" className="arch-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <p className="arch-detail-sub">
        <span className="badge">{AREAS.find((a) => a.id === surface.area)?.title}</span>
      </p>
      <p className="arch-purpose">{surface.does}</p>
      <dl className="arch-facts">
        <Fact label={`Studio gears it calls (${studio.length})`}>
          <span className="arch-chips">
            {studio.map((g) => (
              <GearChip
                key={g}
                name={g}
                gear={byName.get(g)}
                onSelect={onGear}
                note={surface.hostedBy?.includes(g) ? <span className="arch-chip-note">runs inside</span> : undefined}
              />
            ))}
          </span>
        </Fact>
        {platform.length > 0 && (
          <Fact label={`Platform gears it calls directly (${platform.length})`}>
            <span className="arch-chips">
              {platform.map((g) => (
                <GearChip key={g} name={g} gear={byName.get(g)} onSelect={onGear} />
              ))}
            </span>
          </Fact>
        )}
        <Fact label="Read from">
          {surface.components ? (
            <span className="arch-small">
              the prototype's components{" "}
              {surface.components.map((c, i) => (
                <span key={c}>
                  {i > 0 && ", "}
                  <code>{c}</code>
                </span>
              ))}
            </span>
          ) : (
            <span className="arch-small">
              {surface.sources?.map((s, i) => (
                <span key={s}>
                  {i > 0 && ", "}
                  <code>{s}</code>
                </span>
              ))}
            </span>
          )}
        </Fact>
      </dl>
    </div>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

function ArchitecturePage() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [selection, setSelection] = useState<Selection>(selectionFromHash);

  useEffect(() => {
    load().then(setData, (e: unknown) =>
      setError(
        e && typeof e === "object" && "kind" in e
          ? (e as LoadError)
          : { kind: "failed", message: e instanceof Error ? e.message : String(e) },
      ),
    );
    const onHash = () => setSelection(selectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const current = useRef(selection);
  current.current = selection;
  const choose = useCallback((next: Selection) => {
    setSelection(next);
    history.replaceState(null, "", next ? hashOf(next) : window.location.pathname + window.location.search);
  }, []);
  const onGear = useCallback((name: string) => choose({ kind: "gear", name }), [choose]);
  // Choosing the chosen place again lets it go.
  const onSurface = useCallback(
    (id: string) => {
      const prev = current.current;
      choose(prev?.kind === "surface" && prev.id === id ? null : { kind: "surface", id });
    },
    [choose],
  );
  const close = useCallback(() => choose(null), [choose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const gears = useMemo(() => data?.manifest.gears ?? [], [data]);
  const byName = useMemo(() => new Map(gears.map((g) => [g.name, g])), [gears]);
  const studio = useMemo(() => groupStudio(gears), [gears]);
  const platform = useMemo(() => groupPlatform(gears), [gears]);
  const edges = useMemo(() => edgesOf(gears), [gears]);
  const hasUses = useMemo(() => reportsUses(gears), [gears]);
  const surfaces = useMemo(
    () => (data?.openapi ? restSurfaces(data.openapi, gears.map((g) => g.name)) : null),
    [data, gears],
  );

  if (error) {
    return (
      <main className="arch">
        <h1>How Studio is built</h1>
        <div className="arch-warn" role="alert">
          <p>{error.message}</p>
          {error.kind === "signed-out" && (
            <p>
              <a href="../">Open the portal</a>, sign in, then reload this page.
            </p>
          )}
        </div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="arch">
        <h1>How Studio is built</h1>
        <p className="arch-muted">Asking the backend what it is made of…</p>
      </main>
    );
  }

  const { manifest, map } = data;
  const counts = summary(gears);
  const via = edgeCounts(edges);
  const backendCommit = manifest.build.commit ?? null;
  const prototypeCommit = map?.commit ?? null;
  const selectedGear = selection?.kind === "gear" ? (byName.get(selection.name) ?? null) : null;
  const selectedSurface = selection?.kind === "surface" ? SURFACES.find((s) => s.id === selection.id) : undefined;
  const unknownGear = selection?.kind === "gear" && !selectedGear ? selection.name : null;
  const detailOpen = Boolean(selectedGear || selectedSurface || unknownGear);
  const worst = leaks(edges)[0];

  return (
    <main className={`arch${detailOpen ? " has-detail" : ""}`}>
      <header className="arch-head">
        <h1>How Studio is built</h1>
        <p className="arch-lede">
          Studio's backend is one Rust program assembled from <strong>gears</strong> — parts that each own one job,
          their own API and their own tables. Studio's gears sit on the <strong>platform</strong>'s (gears-rust),
          which provide sign-in, accounts, storage and the runtime. Everything below is read from the backend running
          right now.
        </p>
        <div className="arch-stats">
          <Stat value={counts.studio} label={<>Studio gears in {counts.domains} domains</>} />
          <Stat value={counts.platform} label="platform gears underneath" />
          <Stat value={counts.connectorPlugins} label="connector plugins (GitHub, GitLab, Slack…)" />
          <Stat value={hasUses ? via.total : "—"} label={hasUses ? "uses between Studio gears" : "uses: not reported by this backend"} />
          <Stat
            value={hasUses ? via.internal : "—"}
            label={hasUses ? "of them reach into another gear's internals — boundary violations" : "boundary violations: unknown"}
            tone={hasUses && via.internal > 0 ? "bad" : undefined}
          />
        </div>
        {hasUses && worst && (
          <p className="arch-headline-problem">
            Worst: <strong>{worst.gear}</strong>'s private modules ({worst.modules.map((m) => m.item).join(", ")}) are used
            directly by <strong>{worst.users.length}</strong> gears. See{" "}
            <a href="#leaks">where the boundaries leak</a>.
          </p>
        )}
      </header>

      <div className="arch-layout">
        <div className="arch-views">
          <section className="card arch-section" id="map" aria-labelledby="map-title">
            <h2 id="map-title">1 · What people do in Studio, and the gears behind it</h2>
            <p className="arch-muted arch-intro">
              Every place in the portal, the IDE and the desktop app, with the backend gears it calls. Choose a place to
              light up its gears; choose a gear to see every place that relies on it.
            </p>
            <div className="arch-map">
              <SurfaceList selection={selection} byName={byName} onSurface={onSurface} onGear={onGear} />
              <MapBoard studio={studio} platform={platform} byName={byName} selection={selection} onGear={onGear} />
            </div>
          </section>

          <section className="card arch-section" id="uses" aria-labelledby="uses-title">
            <h2 id="uses-title">2 · Who uses whom between Studio gears</h2>
            {hasUses ? (
              <>
                <p className="arch-muted arch-intro">
                  A gear should reach another only through its <strong>port</strong> — the module it offers for that.
                  Choose a gear to draw its uses; the words on each partner say which way it goes.
                </p>
                <ul className="arch-legend" aria-label="How one gear reaches another">
                  <li>
                    <span className="arch-line-key via-port" /> <ViaTag via="port" /> through its port — as intended (
                    {via.port})
                  </li>
                  <li>
                    <span className="arch-line-key via-surface" /> <ViaTag via="surface" /> through what its module
                    exports at the top — tolerable ({via.surface})
                  </li>
                  <li>
                    <span className="arch-line-key via-internal" /> <ViaTag via="internal" /> into a private module —
                    a boundary violation ({via.internal})
                  </li>
                </ul>
              </>
            ) : (
              <div className="arch-warn" role="status">
                This backend does not say which Studio gear uses which: that arrives with the manifest's{" "}
                <code>uses</code> field. Until it is deployed this view shows the domains and what each gear needs from
                the platform.
              </div>
            )}
            <DependencyBoard
              studio={studio}
              platform={platform}
              gears={gears}
              edges={edges}
              hasUses={hasUses}
              selected={selectedGear?.name ?? null}
              onGear={onGear}
            />
          </section>

          {hasUses && (
            <section className="card arch-section" id="leaks" aria-labelledby="leaks-title">
              <h2 id="leaks-title">3 · Where the boundaries leak</h2>
              <p className="arch-muted arch-intro">
                Each gear below has private modules that other gears import directly. Those gears break when the
                module changes, and the owner cannot see them coming. The fix is a port on the owner and a move of the
                callers onto it — the longest lists first.
              </p>
              <div className="arch-leaks-grid">
                <LeakList edges={edges} onGear={onGear} />
                <div>
                  <h3 className="arch-subtitle">Between domains</h3>
                  <DomainLinks edges={edges} gears={gears} />
                </div>
              </div>
            </section>
          )}

          <footer className="arch-build">
            <span>
              Backend <CommitLink commit={backendCommit} />
              {manifest.build.features.length > 0 && (
                <span className="arch-muted"> · features {manifest.build.features.join(", ")}</span>
              )}
            </span>
            <span>
              Prototype{" "}
              {map ? <CommitLink commit={prototypeCommit} /> : <span className="arch-muted">no build map</span>}
            </span>
            <span>
              IDE session image{" "}
              {manifest.sessions_enabled && manifest.session_image ? (
                <code>{manifest.session_image}</code>
              ) : (
                <span className="arch-muted">sessions are off</span>
              )}
            </span>
            {commitsDiffer(backendCommit, prototypeCommit) && (
              <span className="arch-muted">
                The backend and this page were built from different commits; the application map is this page's.
              </span>
            )}
            {!data.openapi && <span className="arch-muted">{OPENAPI_URL} could not be read: no REST facts.</span>}
          </footer>
        </div>

        <aside className={`arch-detail${detailOpen ? " is-open" : ""}`} aria-live="polite" aria-label="Detail">
          {selectedGear ? (
            <GearDetail
              gear={selectedGear}
              gears={gears}
              edges={edges}
              hasUses={hasUses}
              commit={backendCommit}
              surface={surfaces?.get(selectedGear.name)}
              onGear={onGear}
              onSurface={onSurface}
              onClose={close}
            />
          ) : selectedSurface ? (
            <SurfaceDetail surface={selectedSurface} byName={byName} onGear={onGear} onClose={close} />
          ) : unknownGear ? (
            <div className="arch-detail-body">
              <div className="arch-detail-top">
                <h2 className="arch-detail-title">{unknownGear}</h2>
                <button type="button" className="arch-close" onClick={close} aria-label="Close">
                  ×
                </button>
              </div>
              <p className="arch-muted">This backend has not linked a gear by that name.</p>
            </div>
          ) : (
            <div className="arch-detail-empty">
              <p>
                <strong>Choose a place or a gear</strong> to see what it is for, what it uses, what uses it and where
                people meet it.
              </p>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

// The portal passes its theme when it opens this page (`?theme=dark`); the
// portal's theme is its own preference, not the OS's.
const theme = new URLSearchParams(window.location.search).get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ArchitecturePage />
  </StrictMode>,
);
