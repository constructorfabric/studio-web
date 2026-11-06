/* The product map (product-map.ts): Configure's overview and its constructor.
 * The product's frontend, backend and infrastructure as lanes of one picture,
 * the links between them drawn over it; a palette on the left adds screens
 * and gears, a panel on the right says what is selected. The sections below
 * the strip are its detailed views; product.gdl is its other view, the same
 * product as text, selected together with the map.
 *
 * Adds and removes write through the product record as the sections do, so
 * the strip and every section read the same product afterwards. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";

import {
  PRODUCT_CHANGED_EVENT,
  api,
  type CatalogNode,
  type FrontendPick,
  type GearConfigSchema,
  type InfraPlan,
  type InfraService,
  type ProductChange,
  type ProjectProduct,
  type ProjectTargets,
  type ScreenPreview as ScreenPicture,
} from "./api";
import { HeaderMenu } from "./header-menu";
import { InfraLane } from "./infra-services-view";
import { infraStore } from "./infra-store";
import { gearKey, librariesFrom, mfesFrom, shellsFrom, splitTemplates, type Library, type Mfe, type Shell } from "./frontend-constructor";
import { errText } from "./problem";
import { lineDiff } from "./product-flow";
import { useGearCatalogue } from "./product-configurator-view";
import { offers } from "./product-configurator";
import {
  MAP_LAYERS,
  MISSING_GROUP,
  catalogueMfe,
  describedConfigs,
  frontendAbsence,
  gearConfigOf,
  gearParams,
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
  type NodeParam,
} from "./product-map";
import { profilesToCheck } from "./product";
import { infrastructureOf, type ProductSectionId } from "./product-sections";
import { previewBuild, shortCommit, type PreviewBuild } from "./screen-previews";
import { StatusChip } from "./ui-standard";

type Read = {
  product: ProjectProduct | null;
  targets: ProjectTargets | null;
  mfes: Mfe[];
  shells: Shell[];
  libraries: Library[];
  /** The project's catalogue: what describes a gear the engine does not hold. */
  components: CatalogNode[];
  /** Why the Frontend lane is empty, when it is (`frontendAbsence`). */
  absence: { text: string; tone: "none" | "warn" };
  /** The project's infra services (ADR-0064) and each environment's plan
   *  for them; null and empty when they could not be read. */
  services: InfraService[] | null;
  plans: InfraPlan[];
  /** The newest saved product.gdl: the configuration as saved. */
  description: { revision: number; text: string } | null;
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
  database: "Database",
};

/** A node's kind at a glance, before its name. */
const KIND_GLYPH: Record<MapNode["detail"]["kind"], string> = {
  shell: "▭",
  mfe: "▣",
  gear: "⚙",
  plugin: "⧉",
  "missing-gear": "⚠",
  technology: "⛁",
  database: "▤",
};

/** Well-apart hues; a group keeps its own across renders and projects. */
const HUES = [212, 152, 268, 28, 336, 188, 88, 300, 4, 124, 240, 48];
export function hueOf(group: string): number {
  let h = 0;
  for (const c of group) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

const STATE_WORDS: Record<MapNode["state"], string> = {
  ok: "",
  missing: "missing",
  bad: "stops a deploy",
  warn: "look at it",
  unused: "no screen uses it",
};

const DRAG_MFE = "application/x-pmap-mfe";
const LOOK_KEY = "studio.productMap.look";
type MapLook = "subsystems" | "compact";
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
  /** `subsystems`: each subsystem a column of cards that say what each part
   *  does, as an architecture diagram draws services; `compact`: names only. */
  const [look, setLook] = useState<MapLook>(() => {
    try {
      return localStorage.getItem(LOOK_KEY) === "compact" ? "compact" : "subsystems";
    } catch {
      return "subsystems";
    }
  });
  const pickLook = (l: MapLook) => {
    setLook(l);
    try {
      localStorage.setItem(LOOK_KEY, l);
    } catch {
      /* a viewer convenience only */
    }
  };
  const [layers, setLayers] = useState<Set<MapLayer>>(() => new Set(MAP_LAYERS.map((l) => l.id)));
  const [selected, setSelected] = useState<string | null>(null);
  const [link, setLink] = useState<MapLink | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Find on the map: matching nodes are lit, the rest dimmed. */
  const [find, setFind] = useState("");
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
      // The project's catalogue: the organization's and the project's own
      // components (ADR-0061), so a micro-frontend in its own repository --
      // Studio's, for Studioweb -- is found and keeps its screen previews.
      api.listComponents(token, projectId).catch(() => ({ nodes: [] })),
      api.listComponentProfiles(token, projectId).catch(() => ({ nodes: [] })),
      api.projectConfig(token, projectId).catch(() => null),
      api.productDescription(token, projectId).catch(() => null),
      infraStore(token, projectId).load().then(
        (r) => r.items,
        (): InfraService[] | null => null,
      ),
    ])
      .then(async ([p, targets, components, profiles, cfg, description, services]) => {
        // What a deploy to each environment does with the infra services:
        // what places Keycloak with the product or beside it.
        const plans = services?.length
          ? (
              await Promise.all(
                (targets?.environments ?? []).map(({ environment }) => api.infraPlan(token, projectId, environment.id).catch(() => null)),
              )
            ).filter((x): x is InfraPlan => !!x)
          : [];
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
          components: nodes,
          absence: frontendAbsence({
            picked: !!cfg?.frontend && typeof cfg.frontend === "object",
            described: description?.latest ? { revision: description.latest.revision, text: description.latest.text } : null,
          }),
          services,
          plans,
          description: description?.latest ? { revision: description.latest.revision, text: description.latest.text } : null,
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
            components: read.components,
            services: read.services,
            plans: read.plans,
            environments: (read.targets?.environments ?? []).map((e) => e.environment),
            description: read.description,
          })
        : null,
    [read, product, index],
  );
  /** Each gear's and plugin's config schema, by the name the node spells
   *  it: read once for the map's gears, so a node opens with its fields. */
  const schemaAsk = useMemo(
    () =>
      [...new Set((map?.nodes ?? []).filter((n) => (n.detail.kind === "gear" || n.detail.kind === "plugin") && n.detail.gear).map((n) => n.detail.gear!))]
        .sort()
        .join(","),
    [map],
  );
  const [schemas, setSchemas] = useState<Map<string, GearConfigSchema> | null>(null);
  useEffect(() => {
    if (!schemaAsk) return;
    let live = true;
    api
      .gearConfigSchemas(token, schemaAsk.split(","))
      .then((r) => live && setSchemas(new Map(r.items.map((s) => [s.gear, s]))))
      .catch(() => live && setSchemas(new Map()));
    return () => {
      live = false;
    };
  }, [token, schemaAsk]);
  const described = useMemo(() => describedConfigs(read?.description?.text ?? ""), [read]);
  const nodeById = useMemo(() => new Map((map?.nodes ?? []).map((n) => [n.id, n])), [map]);
  /** Each screen card's catalogue entry, by node: what its pictures are kept under. */
  const pictured = useMemo(() => {
    const out = new Map<string, { component: string; version: string | null }>();
    for (const place of product?.frontend?.mfes ?? []) {
      const cat = catalogueMfe(place, read?.mfes ?? []);
      if (cat) out.set(`mfe:${place.path}`, { component: cat.name, version: cat.version });
    }
    return out;
  }, [product, read]);
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
      {/* One row: the view (Diagram | product.gdl -- not "Map" again, the
          Product page's own tab is Map), the look, Find, the verdict, and
          the rarer actions (layers, fold) behind the "⋯". */}
      <div className="pmap-bar" data-pmap-bar>
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
              title={v === "map" ? "The product drawn: its parts and the links between them" : "The same product as the text Studio commits"}
            >
              {v === "map" ? "Diagram" : "product.gdl"}
            </button>
          ))}
        </div>
        {view === "map" && (
          <div className="doc-views" role="tablist" aria-label="Look">
            {(["subsystems", "compact"] as const).map((l) => (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={look === l}
                className={`doc-view${look === l ? " on" : ""}`}
                onClick={() => pickLook(l)}
                data-pmap-look={l}
                title={l === "subsystems" ? "Each subsystem a column of cards saying what each part does" : "Names only: the whole product at a glance"}
              >
                {l === "subsystems" ? "Subsystems" : "Compact"}
              </button>
            ))}
          </div>
        )}
        {view === "map" && (
          <input
            className="pmap-find"
            type="search"
            placeholder="Find on the map"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            aria-label="Find on the map"
            data-pmap-find
          />
        )}
        <span className="grow" />
        {busy && <span className="muted">{busy}</span>}
        {/* The engine's verdict is the product's, not a node's: the map names
            it and the Backend section lists it. */}
        {(product?.last_preview?.errors ?? 0) > 0 && (
          <StatusChip tone="danger" onClick={() => onSection("backend")} data-pmap-engine-errors={product?.last_preview?.errors}>
            {product?.last_preview?.errors} engine error{product?.last_preview?.errors === 1 ? "" : "s"} · Backend
          </StatusChip>
        )}
        <StatusChip tone={problems.some((p) => p.node.state !== "unused") ? "danger" : "ok"} data-pmap-problems={problems.length}>
          {problems.length === 0 ? "nothing wrong between the parts" : `${problems.length} problem${problems.length === 1 ? "" : "s"} between the parts`}
        </StatusChip>
        {view === "map" && (
          <HeaderMenu
            label={layers.size < MAP_LAYERS.length ? `⋯ ${layers.size}/${MAP_LAYERS.length} layers` : "⋯"}
            title="More: layers, fold all, unfold all"
          >
            {/* A layer's box keeps the menu open: several are often turned at once. */}
            <div className="pmap-menu-layers" aria-label="Layers" onClick={(e) => e.stopPropagation()}>
              <span className="pmap-menu-k">Layers</span>
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
            <button type="button" role="menuitem" onClick={() => setCollapsed(new Set(map.nodes.filter((n) => n.layer !== "frontend").map((n) => `${n.layer}:${n.group}`)))} data-pmap-fold-all>
              Fold all
            </button>
            <button type="button" role="menuitem" onClick={() => setCollapsed(new Set())} data-pmap-unfold-all>
              Unfold all
            </button>
          </HeaderMenu>
        )}
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
          token={token}
          projectId={projectId}
          busy={!!busy}
          onAddScreen={addScreen}
          onAddGear={addGear}
        />
        {view === "map" ? (
          <Canvas
            find={find}
            look={look}
            map={map}
            nodeById={nodeById}
            layers={layers}
            selected={selected}
            link={link}
            collapsed={collapsed}
            overlay={overlay}
            hasFrontend={!!product?.frontend}
            absence={read.absence}
            onFrontend={() => onSection("frontend")}
            token={token}
            pictured={pictured}
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
          token={token}
          projectId={projectId}
          map={map}
          node={shown}
          params={shown ? paramsOf(shown, product, described, schemas, read.description?.revision ?? null) : null}
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

/* ── A micro-frontend's screens, drawn ───────────────────────────────────── */

/** Each component's pictures, read once per page: a build adds them, and a
 *  reload is when a reader expects to see a new one. */
const pictures = new Map<string, Promise<ScreenPicture[]>>();

function usePictures(token: string, component: string | null): ScreenPicture[] | null {
  const [items, setItems] = useState<ScreenPicture[] | null>(null);
  useEffect(() => {
    if (!component) return;
    let live = true;
    let read = pictures.get(component);
    if (!read) {
      read = api.screenPreviews(token, component).then(
        (r) => r.items ?? [],
        (): ScreenPicture[] => [],
      );
      pictures.set(component, read);
    }
    void read.then((r) => {
      if (live) setItems(r);
    });
    return () => {
      live = false;
    };
  }, [token, component]);
  return component ? items : null;
}

/** What a micro-frontend puts in the shell, as a small window: the picture a
 *  build took of each screen when the catalogue keeps one for this version
 *  (scripts/mfe-screen-previews.mjs), otherwise drawn from what its manifest
 *  declares (mfe.json) and labelled a schematic. `screen` opens that one;
 *  `bare` leaves out the menu, for a page drawn inside the shell's window,
 *  whose own menu lists the screens. */
function ScreenPreview({
  name,
  screens,
  token,
  pictured,
  screen,
  bare = false,
}: {
  name: string;
  screens: string[];
  token: string;
  pictured: { component: string; version: string | null } | null;
  screen?: string | null;
  bare?: boolean;
}) {
  const items = usePictures(token, pictured?.component ?? null);
  const build = items ? previewBuild(items, pictured?.version ?? null) : null;
  if (build) return <BuiltPreview key={screen ?? ""} name={name} build={build} screen={screen ?? null} bare={bare} />;
  return <SchematicPreview name={name} screens={screens} screen={screen ?? null} bare={bare} />;
}

/** The pictures of one build: one screen large, every screen as a tab that
 *  shows it on hover. */
function BuiltPreview({ name, build, screen, bare }: { name: string; build: PreviewBuild; screen: string | null; bare: boolean }) {
  // Only a screen asked for is looked for: `null` would match one with no label.
  const [on, setOn] = useState(() => (screen === null ? 0 : Math.max(0, build.screens.findIndex((s) => s.label === screen || s.route === screen))));
  const shot = build.screens[Math.min(on, build.screens.length - 1)];
  return (
    <span className="pmap-preview-hold" onClick={(e) => e.stopPropagation()}>
      <span className="pmap-preview real" role="img" aria-label={`${name}: ${build.screens.map((s) => s.label ?? s.route).join(", ")}, built at ${build.commit}`}>
        <span className="pmap-preview-bar">
          <span className="pmap-preview-dots" />
          <span className="pmap-preview-url">{shot.route}</span>
          <span
            className="pmap-preview-tag built"
            title={`Taken by a build of ${build.commit}${build.version ? ` (version ${build.version})` : ""} at ${build.capturedAt}: the screen with an empty project, not real data`}
          >
            built {shortCommit(build.commit)}
          </span>
        </span>
        <img className="pmap-preview-shot" src={shot.image} alt={shot.label ?? shot.route} />
        {build.screens.length > 1 && !bare && (
          <span className="pmap-preview-thumbs">
            {build.screens.map((s, i) => (
              <span key={s.route} className={`pmap-preview-thumb${s === shot ? " on" : ""}`} onMouseEnter={() => setOn(i)} title={s.route}>
                <img src={s.image} alt="" />
                <span>{s.label ?? s.route}</span>
              </span>
            ))}
          </span>
        )}
      </span>
    </span>
  );
}

/** Drawn from what the manifest declares: the screens in the shell's
 *  navigation, the first one open. Not a picture of the running screen,
 *  which only a build can take. */
function SchematicPreview({ name, screens, screen, bare }: { name: string; screens: string[]; screen: string | null; bare: boolean }) {
  const shown = screens.slice(0, 8);
  const open = screen && screens.includes(screen) ? screen : (shown[0] ?? null);
  return (
    <span className="pmap-preview" role="img" aria-label={`${name}: ${screens.length ? screens.join(", ") : "no screens declared"}`}>
      <span className="pmap-preview-bar">
        <span className="pmap-preview-dots" />
        <span className="pmap-preview-url">/{(open ?? name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}</span>
        <span className="pmap-preview-tag">schematic</span>
      </span>
      <span className="pmap-preview-body">
        {!bare && <span className="pmap-preview-nav">
          {shown.length === 0 && <span className="pmap-preview-item muted">no screens</span>}
          {shown.map((s) => (
            <span key={s} className={`pmap-preview-item${s === open ? " on" : ""}`}>
              {s}
            </span>
          ))}
          {screens.length > shown.length && <span className="pmap-preview-item muted">+{screens.length - shown.length} more</span>}
        </span>}
        <span className="pmap-preview-page">
          <span className="pmap-preview-title">{open ?? name}</span>
          <span className="pmap-preview-line" style={{ width: "80%" }} />
          <span className="pmap-preview-line" style={{ width: "95%" }} />
          <span className="pmap-preview-line" style={{ width: "60%" }} />
          <span className="pmap-preview-cards">
            <span />
            <span />
            <span />
          </span>
        </span>
      </span>
    </span>
  );
}

/* ── The lanes and the links ─────────────────────────────────────────────── */

/** One drawn line: every link between the same two drawn ends (a folded
 *  group draws its nodes' links at its header), `count` of them. */
type Path = { key: string; d: string; link: MapLink; links: MapLink[]; count: number; mid: { x: number; y: number }; hue: number | null };

/** The groups of a lane in the order that crosses fewest lines: by the mean
 *  place of what links into them from the lane above (a barycentre). The
 *  engine's group of what is missing stays first; groups nothing above links
 *  to come after the rest, in their own order. */
function laneOrder(
  groups: { group: string; nodes: MapNode[] }[],
  above: Map<string, number>,
  links: readonly MapLink[],
): { group: string; nodes: MapNode[] }[] {
  if (above.size === 0) return groups;
  const score = (g: { nodes: MapNode[] }) => {
    const ids = new Set(g.nodes.map((n) => n.id));
    const at: number[] = [];
    for (const l of links) {
      if (ids.has(l.to) && above.has(l.from)) at.push(above.get(l.from)!);
      else if (ids.has(l.from) && above.has(l.to)) at.push(above.get(l.to)!);
    }
    return at.length ? at.reduce((a, b) => a + b, 0) / at.length : Number.POSITIVE_INFINITY;
  };
  return groups
    .map((g, i) => ({ g, i, s: g.group === MISSING_GROUP ? Number.NEGATIVE_INFINITY : score(g) }))
    .sort((a, b) => (a.s === b.s ? a.i - b.i : a.s - b.s))
    .map((x) => x.g);
}

function Canvas({
  find,
  look,
  map,
  nodeById,
  layers,
  selected,
  link,
  collapsed,
  overlay,
  hasFrontend,
  absence,
  onFrontend,
  token,
  pictured,
  onSelect,
  onLink,
  onToggleGroup,
  onDropScreen,
  onDropGear,
}: {
  find: string;
  look: MapLook;
  map: ReturnType<typeof productMap>;
  nodeById: Map<string, MapNode>;
  layers: Set<MapLayer>;
  selected: string | null;
  link: MapLink | null;
  collapsed: Set<string>;
  overlay?: MapOverlay;
  hasFrontend: boolean;
  absence: { text: string; tone: "none" | "warn" };
  onFrontend: () => void;
  token: string;
  pictured: Map<string, { component: string; version: string | null }>;
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
  /** The node the pointer is on: its links show as if it were selected. */
  const [hover, setHover] = useState<string | null>(null);
  // The screen hovered in the app window's menu, which its page shows.
  const [screenOn, setScreenOn] = useState<{ node: string; screen: string } | null>(null);
  const lanes = MAP_LAYERS.filter((l) => layers.has(l.id));
  const groupKey = (n: MapNode) => `${n.layer}:${n.group}`;

  // Each lane's groups ordered under what links into them from the lane
  // above, so lines run down rather than across.
  const laneGroups = useMemo(() => {
    const out = new Map<MapLayer, { group: string; nodes: MapNode[] }[]>();
    let above = new Map<string, number>();
    for (const lane of MAP_LAYERS) {
      const groups = laneOrder(groupsOf(map.nodes, lane.id), above, map.links);
      out.set(lane.id, groups);
      if (!layers.has(lane.id)) continue;
      const next = new Map<string, number>();
      groups.flatMap((g) => g.nodes).forEach((n, i) => next.set(n.id, i));
      above = next;
    }
    return out;
  }, [map, layers]);

  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const at = el.getBoundingClientRect();
    const rank = (layer: MapLayer) => MAP_LAYERS.findIndex((l) => l.id === layer);
    // A node in a folded group is drawn at its group's header.
    // `end` names what is drawn for a node -- its group's header while the
    // group is folded -- so links between the same drawn ends are one line.
    const endOf = (id: string) => {
      const n = nodeById.get(id);
      if (!n || !layers.has(n.layer)) return null;
      // A database is drawn only while its PostgreSQL is open: folded, the
      // gear's link to PostgreSQL itself says the same.
      if (n.parent && (collapsed.has(groupKey(n)) || collapsed.has(`dbs:${n.parent}`))) return null;
      const end = n.layer !== "frontend" && collapsed.has(groupKey(n)) ? `group:${groupKey(n)}` : id;
      const el = refs.current.get(end);
      const r = el?.getBoundingClientRect();
      if (!r) return null;
      // A node scrolled out of its row is drawn at the row's edge.
      const row = el!.closest(".pmap-lane-body.row")?.getBoundingClientRect();
      let left = r.left;
      let width = r.width;
      if (row) {
        const l = Math.max(left, row.left);
        const rr = Math.min(left + width, row.right);
        if (rr - l < 8) {
          left = left < row.left ? row.left : row.right - 8;
          width = 8;
        } else {
          left = l;
          width = rr - l;
        }
      }
      return { end, layer: n.layer, x: left - at.left, y: r.top - at.top, w: width, h: r.height };
    };
    type End = NonNullable<ReturnType<typeof endOf>>;
    const bundles = new Map<string, { a: End; b: End; links: MapLink[] }>();
    for (const l of map.links) {
      const a = endOf(l.from);
      const b = endOf(l.to);
      if (!a || !b || a.end === b.end) continue;
      const key = `${a.end}>${b.end}`;
      const had = bundles.get(key);
      if (had) had.links.push(l);
      else bundles.set(key, { a, b, links: [l] });
    }
    // Lines between lanes leave the bottom and arrive at the top; within a
    // lane both ends are at the bottom.
    const sides = (a: End, b: End) => {
      const same = rank(a.layer) === rank(b.layer);
      const down = rank(a.layer) < rank(b.layer);
      return { aBottom: same || down, bBottom: same || !down };
    };
    // A node's lines are spread along its edge in the order of their other
    // ends, so they fan out instead of leaving from one point.
    const edges = new Map<string, { key: string; other: number }[]>();
    const onEdge = (edge: string, key: string, other: End) =>
      edges.set(edge, [...(edges.get(edge) ?? []), { key, other: other.x + other.w / 2 }]);
    for (const [key, { a, b }] of bundles) {
      const { aBottom, bBottom } = sides(a, b);
      onEdge(`${a.end}:${aBottom ? "b" : "t"}`, key, b);
      onEdge(`${b.end}:${bBottom ? "b" : "t"}`, key, a);
    }
    const xOn = (end: End, edge: string, key: string) => {
      const list = [...(edges.get(edge) ?? [])].sort((p, q) => p.other - q.other);
      const k = list.findIndex((e) => e.key === key);
      const pad = Math.min(12, end.w / 4);
      const span = end.w - 2 * pad;
      return end.x + pad + (list.length <= 1 ? span / 2 : (span * k) / (list.length - 1));
    };
    const out: Path[] = [];
    for (const [key, { a, b, links }] of bundles) {
      const { aBottom, bBottom } = sides(a, b);
      const ax = xOn(a, `${a.end}:${aBottom ? "b" : "t"}`, key);
      const bx = xOn(b, `${b.end}:${bBottom ? "b" : "t"}`, key);
      const ay = aBottom ? a.y + a.h : a.y;
      const by = bBottom ? b.y + b.h : b.y;
      let d: string;
      let mid: { x: number; y: number };
      if (aBottom && bBottom) {
        const dip = Math.max(ay, by) + 24;
        d = `M${ax},${ay} C${ax},${dip} ${bx},${dip} ${bx},${by}`;
        mid = { x: (ax + bx) / 2, y: dip - 6 };
      } else {
        const m = (ay + by) / 2;
        d = `M${ax},${ay} C${ax},${m} ${bx},${m} ${bx},${by}`;
        mid = { x: (ax + bx) / 2, y: m };
      }
      // The line speaks for its worst link: a bad one is never hidden in a bundle.
      const link = links.find((l) => l.state === "bad") ?? links[0];
      // Coloured as the subsystem it arrives at, so a bundle reads by colour.
      const to = nodeById.get(link.to);
      out.push({ key, d, link, links, count: links.length, mid, hue: to && to.layer !== "frontend" ? hueOf(to.group) : null });
    }
    setPaths(out);
    setSize({ w: el.scrollWidth, h: el.scrollHeight });
  }, [map, nodeById, layers, collapsed, look, find]);

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
  // What is lit: the selection, else what the pointer is on.
  const lit = selected ?? (link ? null : hover);
  const touches = (l: MapLink) => (lit ? l.from === lit || l.to === lit : link ? l === link : false);
  const linked = new Set<string>();
  if (lit) for (const l of linksOf(map, lit)) linked.add(l.from === lit ? l.to : l.from);
  if (link) {
    linked.add(link.from);
    linked.add(link.to);
  }
  const q = find.trim().toLowerCase();
  const found = new Set(q ? map.nodes.filter((n) => n.label.toLowerCase().includes(q) || n.group.toLowerCase().includes(q)).map((n) => n.id) : []);
  if (!lit && !link) for (const id of found) linked.add(id);
  const focus = !!lit || !!link || !!q;

  const accepts = (layer: MapLayer, e: DragEvent) =>
    (layer === "frontend" && e.dataTransfer.types.includes(DRAG_MFE)) || (layer === "backend" && e.dataTransfer.types.includes(DRAG_GEAR));

  const chip = (n: MapNode) => {
    const run = overlay?.get(n.id);
    // A screen card's screens, as its manifest names them.
    const shows = n.detail.kind === "mfe" ? (n.detail.facts.find((f) => f.startsWith("Shows "))?.replace(/^Shows /, "").replace(/\.$/, "") ?? "") : "";
    return (
      <button
        key={n.id}
        ref={setRef(n.id)}
        type="button"
        className={`pmap-node ${n.state} ${n.detail.kind}${selected === n.id ? " on" : ""}${found.has(n.id) ? " found" : ""}${linked.has(n.id) ? " linked" : ""}${focus && !linked.has(n.id) && lit !== n.id ? " dim" : ""}`}
        onMouseEnter={() => setHover(n.id)}
        onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
        // A screen card shows its own preview, in either look; a tooltip would cover it.
        title={n.detail.kind === "mfe" ? undefined :`${KIND_WORDS[n.detail.kind]}: ${n.label}${STATE_WORDS[n.state] ? ` (${STATE_WORDS[n.state]})` : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(selected === n.id ? null : n.id);
        }}
        // Clicking opens its detail -- what it is, its parameters and its
        // configuration -- in the panel beside the map.
        aria-expanded={selected === n.id}
        aria-controls="pmap-detail"
        data-pmap-node={n.id}
        data-pmap-state={n.state}
      >
        <span className="pmap-node-label">
          <span className={`pmap-dot ${n.state}`} aria-hidden />
          <span className="pmap-glyph" aria-hidden>
            {KIND_GLYPH[n.detail.kind]}
          </span>
          {n.label}
        </span>
        {n.state !== "ok" && <span className="pmap-node-state">{STATE_WORDS[n.state]}</span>}
        {look === "subsystems" && n.detail.kind !== "mfe" && n.detail.kind !== "database" && <span className="pmap-node-what">{n.detail.what}</span>}
        {look === "subsystems" && n.detail.kind === "mfe" && (() => {
          // A screen card: what it shows and how many gears it calls.
          const calls = map.links.filter((l) => l.from === n.id && l.kind === "calls").length;
          return (
            <>
              <span className="pmap-node-what">{shows || n.detail.what}</span>
              <span className="pmap-node-meta">
                {shows ? `${shows.split(", ").length} screen${shows.split(", ").length === 1 ? "" : "s"} · ` : ""}calls {calls} gear{calls === 1 ? "" : "s"}
              </span>
            </>
          );
        })()}
        {n.detail.kind === "mfe" && hover === n.id && (
          <ScreenPreview name={n.label} screens={shows ? shows.split(", ") : []} token={token} pictured={pictured.get(n.id) ?? null} />
        )}
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

  /** A node and what is drawn under it: PostgreSQL and its databases, which
   *  fold under it on their own. */
  const withChildren = (n: MapNode, all: readonly MapNode[]) => {
    const kids = all.filter((k) => k.parent === n.id);
    if (kids.length === 0) return chip(n);
    const key = `dbs:${n.id}`;
    const folded = collapsed.has(key) && !kids.some((k) => found.has(k.id));
    return (
      <div key={n.id} className="pmap-parent" data-pmap-parent={n.id}>
        {chip(n)}
        <button
          type="button"
          className={`pmap-kids-h${kids.some((k) => linked.has(k.id) || k.id === selected) && folded ? " linked" : ""}`}
          aria-expanded={!folded}
          onClick={(e) => {
            e.stopPropagation();
            onToggleGroup(key);
          }}
          title={folded ? "Show the database each gear that keeps data gets" : "Fold the databases"}
          data-pmap-kids-toggle={n.id}
        >
          {folded ? "▸" : "▾"} {kids.length} database{kids.length === 1 ? "" : "s"}
        </button>
        {!folded && <div className="pmap-kids">{kids.map((k) => chip(k))}</div>}
      </div>
    );
  };

  return (
    <div className={`pmap-canvas ${look}`} ref={box} onClick={() => onSelect(null)} data-pmap-canvas>
      <svg className="pmap-links" width={size.w} height={size.h} aria-hidden>
        {paths.map((p) => {
          // Gear-to-gear and gear-to-database links show only for what is
          // selected or pointed at: the lanes would be a web otherwise.
          const on = p.links.some(touches);
          if (p.links.every((l) => l.kind === "depends" || l.kind === "stores-in") && !on) return null;
          const cls = `pmap-link ${p.link.kind} ${p.link.state}${on ? " on" : focus ? " dim" : ""}`;
          return (
            <g key={p.key}>
              <path
                className={cls}
                d={p.d}
                style={{
                  ...(p.count > 1 ? { strokeWidth: `${Math.min(5, 1.2 + Math.log2(p.count))}px` } : {}),
                  ...(p.hue !== null && p.link.state !== "bad" ? { stroke: `hsl(${p.hue} 62% 52%)` } : {}),
                }}
              />
              {p.count > 1 && (on || !focus) && (
                <text className="pmap-link-count" x={p.mid.x} y={p.mid.y} textAnchor="middle" dominantBaseline="middle">
                  {p.count}
                </text>
              )}
              <path
                className="pmap-link-hit"
                d={p.d}
                onClick={(e) => {
                  e.stopPropagation();
                  onLink(p.link);
                }}
              >
                <title>{p.count > 1 ? `${p.count} links: ${p.links.slice(0, 4).map((l) => l.why).join("; ")}${p.count > 4 ? "; …" : ""}` : p.link.why}</title>
              </path>
            </g>
          );
        })}
      </svg>
      {lanes.length === 0 && <p className="muted">Every layer is hidden: turn one on above.</p>}
      {lanes.map((lane) => {
        const groups = laneGroups.get(lane.id) ?? [];
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
            <div className={`pmap-lane-body${lane.id === "frontend" ? "" : " row"}`} onScroll={measure}>
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
                      aria-expanded={selected === shell.id}
                      aria-controls="pmap-detail"
                    >
                      <span className="pmap-app-url">
                        <b>{shell.label}</b>
                        {shell.detail.facts[1]?.startsWith("It signs") && <span className="pmap-app-lock"> · signs in</span>}
                      </span>
                      {shell.state !== "ok" && <span className="pmap-node-state"> {STATE_WORDS[shell.state]}</span>}
                    </button>
                    {(() => {
                      // The shell drawn as the app it is. Its menu is the
                      // screens, each group of them a micro-frontend: hovering
                      // one outlines it and names it, and its links to the
                      // gears start there. The page shows the screen hovered,
                      // as a build took it, labelled with what draws it.
                      const mounted = groups.flatMap((g) => g.nodes).filter((n) => n.id !== shell.id);
                      if (mounted.length === 0) return <p className="muted pmap-app-empty">No screens mounted: drag one here from the palette.</p>;
                      const screensOf = (n: MapNode) =>
                        n.detail.facts.find((f) => f.startsWith("Shows "))?.replace(/^Shows /, "").replace(/\.$/, "").split(", ") ?? [];
                      const pages = mounted.filter((n) => screensOf(n).length > 0);
                      const shared = mounted.filter((n) => screensOf(n).length === 0);
                      const shown = pages.find((n) => n.id === lit) ?? pages[0];
                      const screen = screenOn && screenOn.node === shown?.id ? screenOn.screen : null;
                      const MENU = 4;
                      return (
                        <>
                          <div className="pmap-app-body">
                            <nav className="pmap-app-nav" aria-label={`${shell.label}'s menu`}>
                              {pages.map((n) => (
                                <div
                                  key={n.id}
                                  ref={setRef(n.id)}
                                  role="button"
                                  tabIndex={0}
                                  className={`pmap-app-menu ${n.state}${shown?.id === n.id ? " on" : ""}${selected === n.id ? " picked" : ""}${focus && !linked.has(n.id) && lit !== n.id ? " dim" : ""}`}
                                  data-pmap-node={n.id}
                                  data-pmap-state={n.state}
                                  aria-expanded={selected === n.id}
                                  aria-controls="pmap-detail"
                                  onMouseEnter={() => setHover(n.id)}
                                  onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onSelect(selected === n.id ? null : n.id);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      onSelect(selected === n.id ? null : n.id);
                                    }
                                  }}
                                >
                                  <span className="pmap-app-mfe">
                                    {n.label}
                                    {n.state !== "ok" && ` · ${STATE_WORDS[n.state]}`}
                                  </span>
                                  {/* A picked micro-frontend lists every screen; each is
                                      reached by Tab as well as by the pointer. */}
                                  {screensOf(n)
                                    .slice(0, selected === n.id ? undefined : MENU)
                                    .map((s) => (
                                      <span
                                        key={s}
                                        role="button"
                                        tabIndex={0}
                                        aria-pressed={screen === s && shown?.id === n.id}
                                        className={`pmap-app-item${screen === s && shown?.id === n.id ? " on" : ""}`}
                                        onMouseEnter={() => setScreenOn({ node: n.id, screen: s })}
                                        onFocus={() => setScreenOn({ node: n.id, screen: s })}
                                      >
                                        {s}
                                      </span>
                                    ))}
                                  {selected !== n.id && screensOf(n).length > MENU && (
                                    <span className="pmap-app-item muted" title="Pick it to list every screen">
                                      +{screensOf(n).length - MENU} more
                                    </span>
                                  )}
                                </div>
                              ))}
                            </nav>
                            {shown && (
                              <div className="pmap-app-stage" data-pmap-stage={shown.id}>
                                <span className="pmap-app-drawn">{shown.label}</span>
                                <ScreenPreview name={shown.label} screens={screensOf(shown)} token={token} pictured={pictured.get(shown.id) ?? null} screen={screen} bare />
                              </div>
                            )}
                          </div>
                          {shared.length > 0 && (
                            <div className="pmap-app-shared">
                              <span className="sub">shared, no screens of its own</span>
                              {shared.map((n) => chip(n))}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                ) : (
                  <p className={`pmap-empty${absence.tone === "warn" && !hasFrontend ? " warn" : " muted"}`} data-pmap-frontend-absence={hasFrontend ? "reading" : absence.tone}>
                    {hasFrontend ? "Reading the frontend…" : absence.text}
                    {!hasFrontend && absence.tone === "warn" && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="linklike"
                          onClick={(e) => {
                            e.stopPropagation();
                            onFrontend();
                          }}
                        >
                          Open Frontend
                        </button>
                      </>
                    )}
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
                  const folded = collapsed.has(key) && !g.nodes.some((n) => found.has(n.id));
                  const worst = g.nodes.find((n) => n.state === "bad" || n.state === "missing");
                  return (
                    <div
                      key={key}
                      className={`pmap-group${folded ? " folded" : ""}`}
                      data-pmap-group={g.group}
                      style={{ "--g-h": hueOf(g.group) } as CSSProperties}
                    >
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
                        {folded ? "▸" : "▾"} {g.group} <span className="muted">{g.nodes.filter((n) => !n.parent).length}</span>
                      </button>
                      {!folded && <div className="pmap-chips">{g.nodes.filter((n) => !n.parent).map((n) => withChildren(n, g.nodes))}</div>}
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
  token,
  projectId,
  busy,
  onAddScreen,
  onAddGear,
}: {
  read: Read;
  product: ProjectProduct | null;
  catalogue: ReturnType<typeof useGearCatalogue>;
  infra: ReturnType<typeof infrastructureOf>["needs"];
  token: string;
  projectId: string;
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
              {/* In its subsystem's hue, as its column on the map. */}
              <div className="pmap-item-group" style={{ "--g-h": hueOf(g.category) } as CSSProperties}>
                {g.category}
              </div>
              {g.items.map((o) => (
                <div
                  key={o.name}
                  className="pmap-item"
                  style={{ "--g-h": hueOf(g.category) } as CSSProperties}
                  draggable={!busy}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_GEAR, o.name);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  title={o.description ?? undefined}
                  data-pmap-offer-gear={o.name}
                >
                  <div className="grow">
                    <div className="pmap-item-name">
                      <span className="pmap-glyph" aria-hidden>
                        ⚙
                      </span>
                      {o.label}
                    </div>
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
          {/* Deployable infra services (ADR-0064): each need of the gears
              met by a catalogue service, with its image or chart source. */}
          <InfraLane
            token={token}
            projectId={projectId}
            needs={infra}
            environments={(read.targets?.environments ?? []).map((e) => e.environment)}
          />
        </div>
      )}
    </aside>
  );
}

/* ── The detail panel ────────────────────────────────────────────────────── */

/** What a node's Parameters say: a gear's or plugin's configuration --
 *  the product's, over the saved product.gdl's -- read against its config
 *  schema; anything else's as the map drew them. */
type Params = { list: NodeParam[]; note: string | null };

function paramsOf(
  n: MapNode,
  product: ProjectProduct | null,
  described: ReadonlyMap<string, Record<string, unknown>>,
  schemas: ReadonlyMap<string, GearConfigSchema> | null,
  revision: number | null,
): Params {
  const d = n.detail;
  if ((d.kind !== "gear" && d.kind !== "plugin") || !d.gear) return { list: d.params ?? [], note: null };
  const config = gearConfigOf(d.gear, product?.config as Record<string, Record<string, unknown>> | undefined, described);
  const schema = schemas?.get(d.gear);
  const list = gearParams(d.gear, schema, config);
  const from = revision !== null ? ` product.gdl is revision ${revision}.` : "";
  return {
    list,
    note: !schemas
      ? `Reading its config schema…${from}`
      : !schema?.id
        ? `The gear corpus does not describe its configuration: only what the product sets is shown.${from}`
        : list.length === 0
          ? "It takes no configuration."
          : from.trim() || null,
  };
}

/** A node's parameters, as a list of fields: a secret only as set. */
function ParamList({ params }: { params: Params }) {
  const [open, setOpen] = useState(true);
  if (params.list.length === 0 && !params.note) return null;
  return (
    <>
      <button
        type="button"
        className="pmap-detail-kind pmap-params-h"
        aria-expanded={open}
        aria-controls="pmap-params"
        onClick={() => setOpen((o) => !o)}
        data-pmap-params-toggle
      >
        {open ? "▾" : "▸"} Parameters ({params.list.length})
      </button>
      {open && (
        <div id="pmap-params" data-pmap-params>
          {params.note && <p className="muted pmap-params-note">{params.note}</p>}
          {params.list.length > 0 && (
            <dl className="pmap-params">
              {params.list.map((p) => (
                <div key={p.key} className={`pmap-param${p.missing ? " missing" : ""}${p.secret ? " secret" : ""}`} data-pmap-param={p.key}>
                  <dt>
                    <code>{p.key}</code>
                  </dt>
                  <dd title={p.full}>
                    {p.secret ? <span className="pmap-param-secret">{p.value}</span> : p.value}
                    {p.note && <span className="muted"> · {p.note}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </>
  );
}

/** Which description file says a node: a gear's or a plugin's `gear.gdl`, a
 *  micro-frontend's or the shell's `frontx.gdl`. */
export function gdlOf(node: MapNode): { gear: string } | { path: string } | null {
  const d = node.detail;
  if ((d.kind === "gear" || d.kind === "plugin") && (d.gear ?? node.label)) return { gear: d.gear ?? node.label };
  if (d.kind === "mfe" && d.path) return { path: `${d.path.replace(/\/$/, "")}/frontx.gdl` };
  if (d.kind === "shell") {
    const at = d.params?.find((p) => p.key === "path")?.value;
    // Only a leading `./` or `/` goes: `.studio/shell` is a directory of its own.
    return { path: at ? `${at.replace(/^(\.\/|\/)+/, "").replace(/\/$/, "")}/frontx.gdl`.replace(/^\//, "") : "frontx.gdl" };
  }
  return null;
}

/** A node's description file, read when asked: what the engine reads it
 *  from, in the repository the server checked out. */
function GdlSection({ token, projectId, what }: { token: string; projectId: string; what: { gear: string } | { path: string } }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<{ source: string; path: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const name = "gear" in what ? "gear.gdl" : (what.path.split("/").pop() ?? what.path);
  // The ask by value: the node's detail makes a new object each render.
  const ask = JSON.stringify(what);
  useEffect(() => {
    if (!open || file || err) return;
    let live = true;
    api.gdlFile(token, projectId, JSON.parse(ask) as { gear: string } | { path: string }).then(
      (f) => live && setFile(f),
      (e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [open, file, err, token, projectId, ask]);
  return (
    <div className="pmap-gdl" data-pmap-gdl={name}>
      <button type="button" className="ghost pmap-gdl-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {name}
      </button>
      {open && !file && !err && <p className="muted">Reading {name}…</p>}
      {err && <p className="muted">{name} could not be read: {err}</p>}
      {file && (
        <>
          <div className="sub">
            {file.source}/{file.path}
          </div>
          <pre className="pmap-gdl-text">{file.text}</pre>
        </>
      )}
    </div>
  );
}

function Detail({
  token,
  projectId,
  map,
  node,
  params,
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
  token: string;
  projectId: string;
  map: ReturnType<typeof productMap>;
  node: MapNode | null;
  /** Its parameters and configuration (`paramsOf`). */
  params: Params | null;
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
      <aside className="pmap-detail" id="pmap-detail" data-pmap-detail="link">
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
      <aside className="pmap-detail" id="pmap-detail" data-pmap-detail="none">
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
    <aside className="pmap-detail" id="pmap-detail" data-pmap-detail={node.id}>
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
      {params && <ParamList key={`params:${node.id}`} params={params} />}
      {/* Keyed by what it reads: a shell keeps its id when its path changes. */}
      {gdlOf(node) && <GdlSection key={`gdl:${projectId}:${JSON.stringify(gdlOf(node))}`} token={token} projectId={projectId} what={gdlOf(node)!} />}
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
