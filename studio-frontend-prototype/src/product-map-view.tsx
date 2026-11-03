/* The product map (product-map.ts): Configure's overview and its constructor.
 * The product's frontend, backend and infrastructure as lanes of one picture,
 * the links between them drawn over it; a palette on the left adds screens
 * and gears, a panel on the right says what is selected. The sections below
 * the strip are its detailed views; product.gdl is its other view, the same
 * product as text, selected together with the map.
 *
 * Adds and removes write through the product record as the sections do, so
 * the strip and every section read the same product afterwards. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";

import {
  PRODUCT_CHANGED_EVENT,
  api,
  type FrontendPick,
  type ProductChange,
  type ProjectProduct,
  type ProjectTargets,
} from "./api";
import { gearKey, librariesFrom, mfesFrom, shellsFrom, splitTemplates, type Library, type Mfe, type Shell } from "./frontend-constructor";
import { errText } from "./problem";
import { lineDiff } from "./product-flow";
import { useGearCatalogue } from "./product-configurator-view";
import { offers } from "./product-configurator";
import {
  MAP_LAYERS,
  catalogueMfe,
  frontendWith,
  frontendWithout,
  gearsWith,
  gearsWithout,
  groupsOf,
  linksOf,
  problemsOf,
  productGdlLines,
  productMap,
  withRequires,
  type MapLayer,
  type MapLink,
  type MapNode,
  type MapOverlay,
} from "./product-map";
import { profilesToCheck } from "./product";
import { infrastructureOf, type ProductSectionId } from "./product-sections";

type Read = {
  product: ProjectProduct | null;
  targets: ProjectTargets | null;
  mfes: Mfe[];
  shells: Shell[];
  libraries: Library[];
};

const SECTION_TITLE: Record<"frontend" | "backend" | "infrastructure", string> = {
  frontend: "Frontend",
  backend: "Backend",
  infrastructure: "Infrastructure",
};

const KIND_WORDS: Record<MapNode["detail"]["kind"], string> = {
  shell: "Shell",
  mfe: "Micro-frontend",
  gear: "Gear",
  plugin: "Plugin",
  "missing-gear": "Missing gear",
  technology: "Runs on",
};

const STATE_WORDS: Record<MapNode["state"], string> = {
  ok: "",
  missing: "missing",
  bad: "stops a deploy",
  warn: "look at it",
  unused: "no screen uses it",
};

const DRAG_MFE = "application/x-pmap-mfe";
const DRAG_GEAR = "application/x-pmap-gear";

/** The product map: lanes, links, palette and detail, or product.gdl. */
export function ProductMap({
  token,
  projectId,
  onSection,
  overlay,
}: {
  token: string;
  projectId: string;
  /** Opens a section of the Product page: the node's detailed view. */
  onSection: (id: ProductSectionId) => void;
  /** What runs where, drawn over the nodes when given (not yet read). */
  overlay?: MapOverlay;
}) {
  const [read, setRead] = useState<Read | null>(null);
  // The map checks and composes for the profile the product runs as: the
  // first one bound to an environment (ADR-0057), or the deploy shape when
  // none is bound -- the same one the strip's Save sends.
  const checkProfile = profilesToCheck(read?.targets?.bindings ?? [])[0];
  const [readErr, setReadErr] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  /** The product as shown: the record, or an add not yet saved. */
  const [product, setProduct] = useState<ProjectProduct | null>(null);
  const [view, setView] = useState<"map" | "gdl">("map");
  const [layers, setLayers] = useState<Set<MapLayer>>(() => new Set(MAP_LAYERS.map((l) => l.id)));
  const [selected, setSelected] = useState<string | null>(null);
  const [link, setLink] = useState<MapLink | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<{ after: string; changes: ProductChange[] } | null>(null);
  const catalogue = useGearCatalogue(token, true, projectId);
  const index = catalogue && "index" in catalogue ? catalogue.index : null;

  useEffect(() => {
    let live = true;
    Promise.all([
      api.projectProduct(token, projectId),
      api.projectTargets(token, projectId).catch((): ProjectTargets | null => null),
      api.listComponents(token).catch(() => ({ nodes: [] })),
      api.listComponentProfiles(token).catch(() => ({ nodes: [] })),
    ])
      .then(([p, targets, components, profiles]) => {
        if (!live) return;
        const byName: Record<string, Record<string, unknown>> = {};
        for (const n of profiles.nodes ?? []) {
          const name = typeof n.value.gear_name === "string" ? n.value.gear_name : "";
          if (name) byName[name] = n.value as Record<string, unknown>;
        }
        const nodes = components.nodes ?? [];
        setRead({
          product: p,
          targets,
          mfes: splitTemplates(mfesFrom(nodes, byName)).addable,
          shells: shellsFrom(nodes, byName),
          libraries: librariesFrom(nodes, byName),
        });
        setProduct(p);
        setReadErr(null);
      })
      .catch((e) => live && setReadErr(errText(e)));
    return () => {
      live = false;
    };
  }, [token, projectId, round]);

  // Any write to the product -- here, in a section, a check -- reads it again.
  useEffect(() => {
    const changed = (e: Event) => {
      if ((e as CustomEvent<string>).detail === projectId) setRound((r) => r + 1);
    };
    window.addEventListener(PRODUCT_CHANGED_EVENT, changed);
    return () => window.removeEventListener(PRODUCT_CHANGED_EVENT, changed);
  }, [projectId]);

  const map = useMemo(
    () =>
      read
        ? productMap({
            product,
            infra: infrastructureOf(product, read.targets),
            mfes: read.mfes,
            shells: read.shells,
            catalogue: index,
          })
        : null,
    [read, product, index],
  );
  const nodeById = useMemo(() => new Map((map?.nodes ?? []).map((n) => [n.id, n])), [map]);
  const problems = useMemo(() => (map ? problemsOf(map) : []), [map]);
  const select = useCallback((id: string | null) => {
    setSelected(id);
    setLink(null);
  }, []);

  /* ── Writes ── */

  /** Save `body` to the product, showing `next` straight away; back to what
   *  was there if the save fails. */
  async function write(what: string, next: ProjectProduct, body: Parameters<typeof api.saveProjectProduct>[2]) {
    const before = product;
    setBusy(what);
    setErr(null);
    setProduct(next);
    try {
      const saved = await api.saveProjectProduct(token, projectId, body);
      setProduct(saved.value);
      return saved.value;
    } catch (e) {
      setProduct(before);
      setErr(errText(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Check the product as it now is, without saving a revision: the map's
   *  states follow the engine's verdict. */
  function recheck(p: ProjectProduct) {
    if (!p.product_id || !(p.gears ?? []).length) return;
    void api
      .previewProduct(token, projectId, { product_id: p.product_id, name: p.name ?? p.product_id, gears: p.gears ?? [], profile: checkProfile, config: p.config })
      .catch(() => undefined);
  }

  async function setGears(what: string, gears: string[], offerMore: string | null) {
    const frontend = withRequires(product?.frontend, read?.mfes ?? [], gears);
    const saved = await write(what, { ...(product ?? {}), gears, ...(frontend ? { frontend } : {}) }, {
      ...(product?.product_id ? { product_id: product.product_id } : {}),
      gears,
      ...(frontend ? { frontend } : {}),
    });
    if (!saved) return;
    setSuggest(null);
    if (offerMore) {
      api
        .completeProduct(token, gears, saved.config)
        .then((r) => {
          const changes = r.changes.filter((c) => c.added && !gears.some((g) => gearKey(g) === gearKey(c.gear)));
          if (changes.length > 0) setSuggest({ after: offerMore, changes });
        })
        .catch(() => undefined);
    }
    recheck(saved);
  }

  const addGear = (name: string) => void setGears(`Adding ${name}…`, gearsWith(product?.gears ?? [], name), name);
  const removeGear = (name: string) => void setGears(`Removing ${name}…`, gearsWithout(product?.gears ?? [], name), null);

  async function setFrontend(what: string, frontend: FrontendPick) {
    await write(what, { ...(product ?? {}), frontend }, { frontend });
  }

  function addScreen(m: Mfe) {
    const { pick, error } = frontendWith(product?.frontend, m, read?.libraries ?? [], product?.gears ?? []);
    if (!pick) {
      setErr(error);
      return;
    }
    void setFrontend(`Mounting ${m.name}…`, pick).then(() => select(`mfe:${pick.mfes[pick.mfes.length - 1].path}`));
  }

  function removeScreen(path: string) {
    if (product?.frontend) void setFrontend("Unmounting…", frontendWithout(product.frontend, path));
  }

  if (readErr) return <section className="card error">The product could not be read: {readErr}</section>;
  if (!read || !map) return <section className="card muted">Drawing the product…</section>;

  const shown = selected ? nodeById.get(selected) ?? null : null;
  return (
    <section className="card pmap" data-product-section="map" data-product-map>
      <div className="pmap-bar">
        <div className="doc-views" role="tablist" aria-label="View">
          {(["map", "gdl"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={`doc-view${view === v ? " on" : ""}`}
              onClick={() => setView(v)}
              data-pmap-view={v}
            >
              {v === "map" ? "Map" : "product.gdl"}
            </button>
          ))}
        </div>
        {view === "map" && (
          <div className="pmap-filters" aria-label="Layers">
            {MAP_LAYERS.map((l) => (
              <label key={l.id} title={l.hint}>
                <input
                  type="checkbox"
                  checked={layers.has(l.id)}
                  onChange={() =>
                    setLayers((s) => {
                      const n = new Set(s);
                      if (n.has(l.id)) n.delete(l.id);
                      else n.add(l.id);
                      return n;
                    })
                  }
                  data-pmap-layer-toggle={l.id}
                />{" "}
                {l.title}
              </label>
            ))}
          </div>
        )}
        <span className="grow" />
        {busy && <span className="muted">{busy}</span>}
        <span className={`badge ${problems.some((p) => p.node.state !== "unused") ? "danger" : "ok"}`} data-pmap-problems={problems.length}>
          {problems.length === 0 ? "no problems on the map" : `${problems.length} problem${problems.length === 1 ? "" : "s"} on the map`}
        </span>
      </div>
      {err && <div className="error">{err}</div>}
      {problems.length > 0 && (
        <ul className="pmap-problems">
          {problems.slice(0, 6).map((p) => (
            <li key={p.node.id}>
              <button type="button" className={`pmap-problem ${p.node.state}`} onClick={() => select(p.node.id)}>
                <b>{p.node.label}</b> {p.text}
              </button>
            </li>
          ))}
          {problems.length > 6 && <li className="muted">and {problems.length - 6} more: the red and dashed nodes below.</li>}
        </ul>
      )}
      {suggest && (
        <div className="pmap-suggest" data-pmap-suggest>
          <span className="grow">
            {suggest.after} also needs{" "}
            {suggest.changes.map((c, i) => (
              <span key={c.gear} title={c.reason}>
                {i > 0 && ", "}
                <b>{c.gear}</b>
              </span>
            ))}
            , the engine says.
          </span>
          <button
            type="button"
            className="primary"
            disabled={!!busy}
            onClick={() =>
              void setGears(
                "Adding what it needs…",
                suggest.changes.reduce((gs, c) => gearsWith(gs, c.gear), product?.gears ?? []),
                null,
              )
            }
          >
            Take them
          </button>
          <button type="button" className="ghost" onClick={() => setSuggest(null)}>
            Not now
          </button>
        </div>
      )}
      <div className="pmap-body">
        <Palette
          read={read}
          product={product}
          catalogue={catalogue}
          infra={infrastructureOf(product, read.targets).needs}
          busy={!!busy}
          onAddScreen={addScreen}
          onAddGear={addGear}
        />
        {view === "map" ? (
          <Canvas
            map={map}
            nodeById={nodeById}
            layers={layers}
            selected={selected}
            link={link}
            collapsed={collapsed}
            overlay={overlay}
            hasFrontend={!!product?.frontend}
            onSelect={select}
            onLink={(l) => {
              setLink(l);
              setSelected(null);
            }}
            onToggleGroup={(key) =>
              setCollapsed((s) => {
                const n = new Set(s);
                if (n.has(key)) n.delete(key);
                else n.add(key);
                return n;
              })
            }
            onDropScreen={(name) => {
              const m = read.mfes.find((x) => x.name === name);
              if (m) addScreen(m);
            }}
            onDropGear={addGear}
          />
        ) : (
          <GdlView token={token} projectId={projectId} product={product} profile={checkProfile} nodeIds={map.nodes.map((n) => n.id)} selected={selected} onSelect={select} />
        )}
        <Detail
          map={map}
          node={shown}
          link={link}
          nodeById={nodeById}
          product={product}
          busy={!!busy}
          view={view}
          onSelect={select}
          onLink={(l) => {
            setLink(l);
            setSelected(null);
          }}
          onSection={onSection}
          onShowMap={() => setView("map")}
          onAddGear={addGear}
          onRemoveGear={removeGear}
          onRemoveScreen={removeScreen}
        />
      </div>
    </section>
  );
}

/* ── The lanes and the links ─────────────────────────────────────────────── */

type Path = { key: string; d: string; link: MapLink };

function Canvas({
  map,
  nodeById,
  layers,
  selected,
  link,
  collapsed,
  overlay,
  hasFrontend,
  onSelect,
  onLink,
  onToggleGroup,
  onDropScreen,
  onDropGear,
}: {
  map: ReturnType<typeof productMap>;
  nodeById: Map<string, MapNode>;
  layers: Set<MapLayer>;
  selected: string | null;
  link: MapLink | null;
  collapsed: Set<string>;
  overlay?: MapOverlay;
  hasFrontend: boolean;
  onSelect: (id: string | null) => void;
  onLink: (l: MapLink) => void;
  onToggleGroup: (key: string) => void;
  onDropScreen: (name: string) => void;
  onDropGear: (name: string) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<Path[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [over, setOver] = useState<MapLayer | null>(null);
  const lanes = MAP_LAYERS.filter((l) => layers.has(l.id));
  const groupKey = (n: MapNode) => `${n.layer}:${n.group}`;

  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const at = el.getBoundingClientRect();
    const rank = (layer: MapLayer) => MAP_LAYERS.findIndex((l) => l.id === layer);
    // A node in a folded group is drawn at its group's header.
    const rectOf = (id: string) => {
      const n = nodeById.get(id);
      if (!n || !layers.has(n.layer)) return null;
      const target = collapsed.has(groupKey(n)) ? refs.current.get(`group:${groupKey(n)}`) : refs.current.get(id);
      const r = target?.getBoundingClientRect();
      return r ? { x: r.left - at.left, y: r.top - at.top, w: r.width, h: r.height } : null;
    };
    const out: Path[] = [];
    map.links.forEach((l, i) => {
      const a = rectOf(l.from);
      const b = rectOf(l.to);
      const na = nodeById.get(l.from);
      const nb = nodeById.get(l.to);
      if (!a || !b || !na || !nb) return;
      const ax = a.x + a.w / 2;
      const bx = b.x + b.w / 2;
      let d: string;
      if (rank(na.layer) === rank(nb.layer)) {
        const ay = a.y + a.h;
        const by = b.y + b.h;
        const dip = Math.max(ay, by) + 24;
        d = `M${ax},${ay} C${ax},${dip} ${bx},${dip} ${bx},${by}`;
      } else {
        const down = rank(na.layer) < rank(nb.layer);
        const ay = down ? a.y + a.h : a.y;
        const by = down ? b.y : b.y + b.h;
        const mid = (ay + by) / 2;
        d = `M${ax},${ay} C${ax},${mid} ${bx},${mid} ${bx},${by}`;
      }
      out.push({ key: `${i}:${l.from}>${l.to}`, d, link: l });
    });
    setPaths(out);
    setSize({ w: el.scrollWidth, h: el.scrollHeight });
  }, [map, nodeById, layers, collapsed]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const setRef = (id: string) => (el: HTMLElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  };
  const touches = (l: MapLink) => (selected ? l.from === selected || l.to === selected : link ? l === link : false);
  const linked = new Set<string>();
  if (selected) for (const l of linksOf(map, selected)) linked.add(l.from === selected ? l.to : l.from);
  if (link) {
    linked.add(link.from);
    linked.add(link.to);
  }
  const focus = !!selected || !!link;

  const accepts = (layer: MapLayer, e: DragEvent) =>
    (layer === "frontend" && e.dataTransfer.types.includes(DRAG_MFE)) || (layer === "backend" && e.dataTransfer.types.includes(DRAG_GEAR));

  const chip = (n: MapNode) => {
    const run = overlay?.get(n.id);
    return (
      <button
        key={n.id}
        ref={setRef(n.id)}
        type="button"
        className={`pmap-node ${n.state} ${n.detail.kind}${selected === n.id ? " on" : ""}${linked.has(n.id) ? " linked" : ""}${focus && !linked.has(n.id) && selected !== n.id ? " dim" : ""}`}
        title={`${KIND_WORDS[n.detail.kind]}: ${n.label}${STATE_WORDS[n.state] ? ` (${STATE_WORDS[n.state]})` : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(selected === n.id ? null : n.id);
        }}
        data-pmap-node={n.id}
        data-pmap-state={n.state}
      >
        <span className="pmap-node-label">{n.label}</span>
        {n.state !== "ok" && <span className="pmap-node-state">{STATE_WORDS[n.state]}</span>}
        {(n.badges ?? []).map((b) => (
          <span key={b.text} className={`pmap-badge ${b.tone}`}>
            {b.text}
          </span>
        ))}
        {run && (
          <span className={`pmap-badge ${run.health === "failing" ? "bad" : "info"}`}>
            {run.version ?? "?"} {run.health ?? ""}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="pmap-canvas" ref={box} onClick={() => onSelect(null)} data-pmap-canvas>
      <svg className="pmap-links" width={size.w} height={size.h} aria-hidden>
        {paths.map((p) => {
          // Gear-to-gear links show only for what is selected: the lane would
          // be a web otherwise.
          if (p.link.kind === "depends" && !touches(p.link)) return null;
          const cls = `pmap-link ${p.link.kind} ${p.link.state}${touches(p.link) ? " on" : focus ? " dim" : ""}`;
          return (
            <g key={p.key}>
              <path className={cls} d={p.d} />
              <path
                className="pmap-link-hit"
                d={p.d}
                onClick={(e) => {
                  e.stopPropagation();
                  onLink(p.link);
                }}
              >
                <title>{p.link.why}</title>
              </path>
            </g>
          );
        })}
      </svg>
      {lanes.length === 0 && <p className="muted">Every layer is hidden: turn one on above.</p>}
      {lanes.map((lane) => {
        const groups = groupsOf(map.nodes, lane.id);
        const shell = map.nodes.find((n) => n.detail.kind === "shell");
        return (
          <div
            key={lane.id}
            className={`pmap-lane${over === lane.id ? " drop" : ""}`}
            data-pmap-lane={lane.id}
            onDragOver={(e) => {
              if (!accepts(lane.id, e)) return;
              e.preventDefault();
              setOver(lane.id);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              setOver(null);
              const mfe = e.dataTransfer.getData(DRAG_MFE);
              const gear = e.dataTransfer.getData(DRAG_GEAR);
              if (lane.id === "frontend" && mfe) onDropScreen(mfe);
              if (lane.id === "backend" && gear) onDropGear(gear);
            }}
          >
            <div className="pmap-lane-h" title={lane.hint}>
              {lane.title}
            </div>
            <div className="pmap-lane-body">
              {lane.id === "frontend" ? (
                shell ? (
                  <div
                    ref={setRef(shell.id)}
                    className={`pmap-shell ${shell.state}${selected === shell.id ? " on" : ""}${linked.has(shell.id) ? " linked" : ""}`}
                    data-pmap-node={shell.id}
                    data-pmap-state={shell.state}
                  >
                    <button
                      type="button"
                      className="pmap-shell-h"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(selected === shell.id ? null : shell.id);
                      }}
                    >
                      shell: <b>{shell.label}</b> {shell.detail.facts[1]?.startsWith("It signs") ? "(signs in ✓)" : ""}
                      {shell.state !== "ok" && <span className="pmap-node-state"> {STATE_WORDS[shell.state]}</span>}
                    </button>
                    <div className="pmap-chips">
                      {groups.flatMap((g) => g.nodes).filter((n) => n.id !== shell.id).map(chip)}
                      {groups.flatMap((g) => g.nodes).length <= 1 && <span className="muted">No screens mounted: drag one here from the palette.</span>}
                    </div>
                  </div>
                ) : (
                  <p className="muted pmap-empty">
                    {hasFrontend ? "Reading the frontend…" : "No frontend: the product is its gears and their APIs. Drag a screen here to start one from the FrontX shell template."}
                  </p>
                )
              ) : groups.length === 0 ? (
                <p className="muted pmap-empty">
                  {lane.id === "backend"
                    ? "No gears yet: drag one here from the palette, or pick them under Backend."
                    : "Shows once the product is checked: what the gears need running beside them."}
                </p>
              ) : (
                groups.map((g) => {
                  const key = `${lane.id}:${g.group}`;
                  const folded = collapsed.has(key);
                  const worst = g.nodes.find((n) => n.state === "bad" || n.state === "missing");
                  return (
                    <div key={key} className={`pmap-group${folded ? " folded" : ""}`} data-pmap-group={g.group}>
                      <button
                        type="button"
                        ref={setRef(`group:${key}`)}
                        className={`pmap-group-h${worst ? " bad" : ""}${folded && g.nodes.some((n) => linked.has(n.id) || n.id === selected) ? " linked" : ""}`}
                        aria-expanded={!folded}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleGroup(key);
                        }}
                        title={folded ? "Unfold: links to its nodes end here while it is folded" : "Fold"}
                      >
                        {folded ? "▸" : "▾"} {g.group} <span className="muted">{g.nodes.length}</span>
                      </button>
                      {!folded && <div className="pmap-chips">{g.nodes.map(chip)}</div>}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── The palette ─────────────────────────────────────────────────────────── */

function Palette({
  read,
  product,
  catalogue,
  infra,
  busy,
  onAddScreen,
  onAddGear,
}: {
  read: Read;
  product: ProjectProduct | null;
  catalogue: ReturnType<typeof useGearCatalogue>;
  infra: ReturnType<typeof infrastructureOf>["needs"];
  busy: boolean;
  onAddScreen: (m: Mfe) => void;
  onAddGear: (name: string) => void;
}) {
  const [tab, setTab] = useState<"screens" | "gears" | "infrastructure">("screens");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const mounted = product?.frontend?.mfes ?? [];
  const screens = read.mfes.filter(
    (m) =>
      !mounted.some((p) => catalogueMfe(p, [m])) &&
      (!q || `${m.name} ${m.description} ${m.calls.join(" ")}`.toLowerCase().includes(q)),
  );
  const have = [...(product?.gears ?? []), ...(product?.last_preview?.gears ?? [])];
  const gearOffers = catalogue && "index" in catalogue ? offers(catalogue.index, have, query) : null;

  return (
    <aside className="pmap-palette" aria-label="Add to the product" data-pmap-palette>
      <div className="doc-views" role="tablist" aria-label="Palette">
        {(["screens", "gears", "infrastructure"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`doc-view${tab === t ? " on" : ""}`} onClick={() => setTab(t)} data-pmap-palette-tab={t}>
            {t === "screens" ? "Screens" : t === "gears" ? "Gears" : "Infra"}
          </button>
        ))}
      </div>
      {tab !== "infrastructure" && (
        <input type="search" placeholder={tab === "screens" ? "Find a screen" : "Find a gear"} value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      {tab === "screens" && (
        <div className="pmap-palette-list">
          <p className="muted pmap-hint">Drag onto Frontend, or Add. A screen mounts in the shell; the gears it calls show as links.</p>
          {screens.length === 0 && <p className="muted">{read.mfes.length === 0 ? "The catalogue has no micro-frontends: add one under Frontend." : "Nothing more to mount."}</p>}
          {screens.map((m) => (
            <div
              key={m.name}
              className="pmap-item"
              draggable={!busy}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MFE, m.name);
                e.dataTransfer.effectAllowed = "copy";
              }}
              data-pmap-offer-screen={m.name}
            >
              <div className="grow">
                <div className="pmap-item-name">{m.name.replace(/^@[^/]+\//, "")}</div>
                <div className="pmap-item-sub">{m.calls.length > 0 ? `calls ${m.calls.join(", ")}` : m.description || "calls no gear"}</div>
              </div>
              <button type="button" className="ghost" disabled={busy} onClick={() => onAddScreen(m)}>
                Add
              </button>
            </div>
          ))}
        </div>
      )}
      {tab === "gears" && (
        <div className="pmap-palette-list">
          <p className="muted pmap-hint">Drag onto Backend, or Add. The engine then checks the product and says what else it needs.</p>
          {!catalogue && <p className="muted">Reading the catalogue…</p>}
          {catalogue && "error" in catalogue && <p className="error">The catalogue could not be read: {catalogue.error}</p>}
          {gearOffers?.length === 0 && <p className="muted">Nothing more to add{q ? " that matches" : ""}.</p>}
          {gearOffers?.map((g) => (
            <div key={g.category}>
              <div className="pmap-item-group">{g.category}</div>
              {g.items.map((o) => (
                <div
                  key={o.name}
                  className="pmap-item"
                  draggable={!busy}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_GEAR, o.name);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  title={o.description ?? undefined}
                  data-pmap-offer-gear={o.name}
                >
                  <div className="grow">
                    <div className="pmap-item-name">{o.label}</div>
                    {o.description && <div className="pmap-item-sub">{o.description}</div>}
                  </div>
                  <button type="button" className="ghost" disabled={busy} onClick={() => onAddGear(o.name)}>
                    Add
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {tab === "infrastructure" && (
        <div className="pmap-palette-list">
          <p className="muted pmap-hint">
            Not added by hand: what the product runs on follows from its gears and from the environment it is deployed to.
          </p>
          {infra === null ? (
            <p className="muted">Shows once the product is checked.</p>
          ) : infra.length === 0 ? (
            <p className="muted">The gears need nothing beside them.</p>
          ) : (
            infra.map((t) => (
              <div key={t.id} className="pmap-item">
                <div className="grow">
                  <div className="pmap-item-name">{t.name}</div>
                  <div className="pmap-item-sub">
                    {t.why}; for {t.gears.length} gear{t.gears.length === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </aside>
  );
}

/* ── The detail panel ────────────────────────────────────────────────────── */

function Detail({
  map,
  node,
  link,
  nodeById,
  product,
  busy,
  view,
  onSelect,
  onLink,
  onSection,
  onShowMap,
  onAddGear,
  onRemoveGear,
  onRemoveScreen,
}: {
  map: ReturnType<typeof productMap>;
  node: MapNode | null;
  link: MapLink | null;
  nodeById: Map<string, MapNode>;
  product: ProjectProduct | null;
  busy: boolean;
  view: "map" | "gdl";
  onSelect: (id: string | null) => void;
  onLink: (l: MapLink) => void;
  onSection: (id: ProductSectionId) => void;
  onShowMap: () => void;
  onAddGear: (name: string) => void;
  onRemoveGear: (name: string) => void;
  onRemoveScreen: (path: string) => void;
}) {
  const name = (id: string) => nodeById.get(id)?.label ?? id;
  if (link) {
    return (
      <aside className="pmap-detail" data-pmap-detail="link">
        <div className="pmap-detail-kind">Link: {link.kind}</div>
        <p className={link.state === "bad" ? "error" : ""} style={{ margin: "4px 0" }}>
          {link.why}
        </p>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <button type="button" className="ghost" onClick={() => onSelect(link.from)}>
            {name(link.from)}
          </button>
          <span>→</span>
          <button type="button" className="ghost" onClick={() => onSelect(link.to)}>
            {name(link.to)}
          </button>
        </div>
      </aside>
    );
  }
  if (!node) {
    return (
      <aside className="pmap-detail" data-pmap-detail="none">
        <div className="pmap-detail-kind">The product map</div>
        <p className="muted" style={{ margin: "4px 0" }}>
          Click a node to see what it is and what it links to, or a link to see where it comes from. Add screens and gears
          from the palette; the sections below the strip are the detailed views.
        </p>
        <ul className="pmap-legend">
          <li><span className="pmap-swatch missing" /> a gear a screen calls that the product lacks</li>
          <li><span className="pmap-swatch bad" /> stops a deploy: no database where it runs</li>
          <li><span className="pmap-swatch unused" /> a gear no screen uses</li>
        </ul>
      </aside>
    );
  }
  const d = node.detail;
  const its = linksOf(map, node.id);
  const lacks = d.kind === "mfe" ? its.filter((l) => l.state === "bad" && l.from === node.id).map((l) => nodeById.get(l.to)) : [];
  return (
    <aside className="pmap-detail" data-pmap-detail={node.id}>
      <div className="pmap-detail-kind">
        {KIND_WORDS[d.kind]}
        {node.state !== "ok" && <span className={`pmap-node-state ${node.state}`}> · {STATE_WORDS[node.state]}</span>}
      </div>
      <h3 style={{ margin: "2px 0 4px" }}>{node.label}</h3>
      <p style={{ margin: "0 0 6px" }}>{d.what}</p>
      {d.problem && <p className="error" style={{ margin: "0 0 6px" }}>{d.problem}</p>}
      <ul className="pmap-facts">
        {d.facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      {its.length > 0 && (
        <>
          <div className="pmap-detail-kind" style={{ marginTop: 8 }}>
            Links ({its.length})
          </div>
          <ul className="pmap-facts pmap-detail-links">
            {its.map((l, i) => (
              <li key={i}>
                <button type="button" className={`linklike${l.state === "bad" ? " bad" : ""}`} onClick={() => onLink(l)} title={l.why}>
                  {l.from === node.id ? `→ ${name(l.to)}` : `← ${name(l.from)}`}
                </button>{" "}
                <span className="muted">{l.kind}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="pmap-actions">
        {lacks.map((g) =>
          g?.detail.gear ? (
            <button key={g.id} type="button" className="primary" disabled={busy} onClick={() => onAddGear(g.detail.gear!)} data-pmap-add-gear={g.detail.gear}>
              Add {g.label}
            </button>
          ) : null,
        )}
        {d.kind === "missing-gear" && d.gear && (
          <button type="button" className="primary" disabled={busy} onClick={() => onAddGear(d.gear!)} data-pmap-add-gear={d.gear}>
            Add {node.label}
          </button>
        )}
        {(d.kind === "gear" || d.kind === "plugin") && d.picked && d.gear && (
          <button type="button" className="ghost" disabled={busy} onClick={() => onRemoveGear(d.gear!)}>
            Remove from the product
          </button>
        )}
        {(d.kind === "gear" || d.kind === "plugin") && !d.picked && (
          <span className="muted">The engine pulled it in: remove what needs it instead.</span>
        )}
        {d.kind === "mfe" && d.path && product?.frontend && (
          <button type="button" className="ghost" disabled={busy} onClick={() => onRemoveScreen(d.path!)}>
            Remove from the product
          </button>
        )}
        <button type="button" className="ghost" onClick={() => onSection(d.section)}>
          Open in {SECTION_TITLE[d.section]}
        </button>
        {view === "gdl" && (
          <button type="button" className="ghost" onClick={onShowMap}>
            Show on the map
          </button>
        )}
      </div>
    </aside>
  );
}

/* ── product.gdl: the map's other view ───────────────────────────────────── */

type Draft = { text: string; source: "draft" | "kept"; ok?: boolean; note?: string };

function GdlView({
  token,
  projectId,
  product,
  profile,
  nodeIds,
  selected,
  onSelect,
}: {
  token: string;
  projectId: string;
  product: ProjectProduct | null;
  /** The profile the draft is composed for. */
  profile: string;
  nodeIds: string[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [kept, setKept] = useState<{ revision: number; text: string } | null | undefined>(undefined);
  const box = useRef<HTMLDivElement | null>(null);
  // What the next save would compose from; a check of the same writes the
  // same record, so it is asked again only when this changes.
  const inputs = product?.product_id
    ? JSON.stringify({ id: product.product_id, name: product.name, gears: product.gears ?? [], profile, config: product.config, frontend: product.frontend })
    : null;

  useEffect(() => {
    let live = true;
    setDraft(null);
    const keptP = api.productDescription(token, projectId).then(
      (d) => (d.latest ? { revision: d.latest.revision, text: d.latest.text } : null),
      () => null,
    );
    keptP.then((k) => live && setKept(k));
    const p = inputs ? (JSON.parse(inputs) as { id: string; name?: string; gears: string[]; profile?: string; config?: ProjectProduct["config"] }) : null;
    const compose =
      p && p.gears.length > 0
        ? api.previewProduct(token, projectId, { product_id: p.id, name: p.name ?? p.id, gears: p.gears, profile: p.profile, config: p.config })
        : Promise.reject(new Error("The product has no gears to compose."));
    compose
      .then((r) => live && setDraft({ text: r.product_gdl, source: "draft", ok: r.ok }))
      .catch(async (e) => {
        const k = await keptP;
        if (!live) return;
        setDraft(k ? { text: k.text, source: "kept", note: errText(e) } : { text: "", source: "kept", note: errText(e) });
      });
    return () => {
      live = false;
    };
  }, [token, projectId, inputs]);

  const lines = useMemo(() => (draft ? productGdlLines(draft.text, nodeIds) : null), [draft, nodeIds]);
  const rows = useMemo(() => {
    if (!draft) return [];
    const diff = draft.source === "draft" && kept ? lineDiff(kept.text, draft.text) : draft.text.replace(/\r\n/g, "\n").split("\n").map((text) => ({ kind: "same" as const, text }));
    let n = 0;
    return diff.map((l) => ({ ...l, n: l.kind === "del" ? null : ++n }));
  }, [draft, kept]);
  const mine = selected ? lines?.byNode.get(selected) ?? [] : [];

  useEffect(() => {
    const el = box.current;
    if (!el || mine.length === 0) return;
    const row = el.querySelector<HTMLElement>(`[data-gdl-line="${mine[0]}"]`);
    if (row) el.scrollTop = Math.max(0, row.offsetTop - el.clientHeight / 3);
  }, [selected, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!draft) return <div className="pmap-gdl muted">Composing the description the next save would write…</div>;
  const changes = rows.filter((r) => r.kind !== "same").length;
  return (
    <div className="pmap-gdl" data-pmap-gdl={draft.source}>
      <div className="pmap-gdl-h">
        {draft.source === "draft" ? (
          <>
            What the next save writes{draft.ok === false ? " (the engine does not resolve it yet)" : ""}.{" "}
            <span className="muted">
              {kept
                ? changes === 0
                  ? `Same as revision ${kept.revision}.`
                  : `${changes} line${changes === 1 ? "" : "s"} differ from revision ${kept.revision}: + added, − removed.`
                : "Nothing saved yet."}
            </span>
          </>
        ) : draft.text ? (
          <>
            The kept revision{kept ? ` ${kept.revision}` : ""}: the product could not be composed{draft.note ? ` (${draft.note})` : ""}.
          </>
        ) : (
          <>No description yet, and the product could not be composed{draft.note ? `: ${draft.note}` : ""}.</>
        )}{" "}
        <span className="muted">Click a highlighted line to select it on the map.</span>
      </div>
      <div className="pmap-gdl-box" ref={box}>
        {rows.map((r, i) => {
          const owner = r.n !== null ? lines?.byLine.get(r.n) : undefined;
          const on = r.n !== null && mine.includes(r.n);
          return (
            <div
              key={i}
              className={`pmap-gdl-line ${r.kind}${owner ? " owned" : ""}${on ? " on" : ""}`}
              data-gdl-line={r.n ?? undefined}
              onClick={owner ? () => onSelect(owner) : undefined}
              title={owner ? `Select ${owner.replace(/^[a-z]+:/, "")}` : undefined}
            >
              <span className="pmap-gdl-mark">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
              <span className="pmap-gdl-n">{r.n ?? ""}</span>
              <span className="pmap-gdl-text">{r.text || " "}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
