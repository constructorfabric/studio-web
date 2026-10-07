/* The /architecture/ page: how Studio is built, drawn from the backend that is
 * running and the prototype that was built beside it. The model is in
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
  apiDocsUrl,
  commitUrl,
  commitsDiffer,
  dependents,
  designDocUrl,
  fileTitle,
  gearTitle,
  joinPrototype,
  layered,
  restSurfaces,
  screenTitle,
  shortCommit,
  summary,
} from "./architecture";
import type { Manifest, ManifestGear, PrototypeMap, PrototypeScreen } from "./architecture";
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

/* ── Pieces ──────────────────────────────────────────────────────────────── */

function kindLabel(gear: ManifestGear): string {
  const origin = gear.origin === "studio" ? "Studio" : "Platform";
  const role = gear.role === "plugin" ? "plugin" : gear.role === "system" ? "system gear" : "gear";
  return `${origin} ${role}`;
}

function GearChip({
  gear,
  state,
  onSelect,
  chipRef,
}: {
  gear: ManifestGear;
  state: "selected" | "dependency" | "dependent" | "dim" | "plain";
  onSelect: (name: string) => void;
  chipRef?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      type="button"
      ref={chipRef}
      className={`arch-gear origin-${gear.origin === "studio" ? "studio" : "platform"} role-${gear.role} is-${state}`}
      aria-pressed={state === "selected"}
      title={`${gear.name} — ${kindLabel(gear)}`}
      data-gear={gear.name}
      onClick={() => onSelect(gear.name)}
    >
      <span className="arch-gear-name">{gear.name}</span>
    </button>
  );
}

function Legend() {
  return (
    <ul className="arch-legend" aria-label="Legend">
      <li>
        <span className="arch-swatch origin-studio role-gear" /> Studio gear — written in this repository
      </li>
      <li>
        <span className="arch-swatch origin-platform role-gear" /> Platform gear — from gears-rust
      </li>
      <li>
        <span className="arch-swatch origin-platform role-system" /> Platform system gear — the runtime itself
      </li>
      <li>
        <span className="arch-swatch origin-studio role-plugin" /> Plugin — an implementation another gear
        chooses
      </li>
      <li>
        <span className="arch-line-key" style={{ color: "var(--arch-needs)" }} /> needs
      </li>
      <li>
        <span className="arch-line-key" style={{ color: "var(--arch-needed-by)" }} /> is needed by
      </li>
    </ul>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="arch-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
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

/* ── The diagram ─────────────────────────────────────────────────────────── */

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: "dependency" | "dependent";
}

function Diagram({
  gears,
  selected,
  onSelect,
}: {
  gears: ManifestGear[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const rows = useMemo(() => layered(gears), [gears]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const chips = useRef(new Map<string, HTMLButtonElement>());
  const [lines, setLines] = useState<Line[]>([]);

  const current = gears.find((g) => g.name === selected) ?? null;
  const deps = new Set(current?.depends_on ?? []);
  const users = new Set(current ? dependents(gears, current.name) : []);

  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box || !current) {
      setLines([]);
      return;
    }
    const origin = box.getBoundingClientRect();
    const centre = (name: string) => {
      const el = chips.current.get(name);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.left - origin.left + r.width / 2,
        top: r.top - origin.top,
        bottom: r.bottom - origin.top,
      };
    };
    const from = centre(current.name);
    if (!from) return setLines([]);
    const out: Line[] = [];
    for (const name of current.depends_on) {
      const to = centre(name);
      if (to) out.push({ x1: from.x, y1: from.top, x2: to.x, y2: to.bottom, kind: "dependency" });
    }
    for (const name of dependents(gears, current.name)) {
      const to = centre(name);
      if (to) out.push({ x1: from.x, y1: from.bottom, x2: to.x, y2: to.top, kind: "dependent" });
    }
    setLines(out);
  }, [current, gears]);

  useLayoutEffect(() => {
    measure();
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(box);
    return () => observer.disconnect();
  }, [measure]);

  const stateOf = (name: string) =>
    !current
      ? "plain"
      : name === current.name
        ? "selected"
        : deps.has(name)
          ? "dependency"
          : users.has(name)
            ? "dependent"
            : "dim";

  return (
    <div className="arch-diagram" ref={boxRef}>
      <svg className="arch-lines" aria-hidden="true">
        {lines.map((l, i) => (
          <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className={`arch-line ${l.kind}`} />
        ))}
      </svg>
      {rows.map((row, depth) => (
        <section key={depth} className="arch-layer" aria-label={`Layer ${depth + 1}`}>
          <h3 className="arch-layer-title">
            {depth === 0 ? "Starts first — needs nothing" : `Layer ${depth + 1} — needs the layers above`}
          </h3>
          <div className="arch-layer-gears">
            {row.map((gear) => (
              <GearChip
                key={gear.name}
                gear={gear}
                state={stateOf(gear.name)}
                onSelect={onSelect}
                chipRef={(el) => {
                  if (el) chips.current.set(gear.name, el);
                  else chips.current.delete(gear.name);
                }}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ── The detail of one gear ──────────────────────────────────────────────── */

function GearDetail({
  gear,
  gears,
  commit,
  surface,
  screens,
  onSelect,
}: {
  gear: ManifestGear;
  gears: ManifestGear[];
  commit?: string | null;
  surface?: { prefixes: string[]; component: string; tags: string[]; operations: number };
  screens: PrototypeScreen[];
  onSelect: (name: string) => void;
}) {
  const users = dependents(gears, gear.name);
  const byName = new Map(gears.map((g) => [g.name, g]));
  const chip = (name: string) => {
    const g = byName.get(name);
    return g ? (
      <GearChip key={name} gear={g} state="plain" onSelect={onSelect} />
    ) : (
      <code key={name}>{name}</code>
    );
  };
  return (
    <div className="arch-detail-body" data-detail={gear.name}>
      <h2 className="arch-detail-title">{gearTitle(gear.name)}</h2>
      <p className="arch-detail-sub">
        <code>{gear.name}</code> <span className="badge">{kindLabel(gear)}</span>
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
        <p>
          <a href={designDocUrl(gear.design_doc, commit)} target="_blank" rel="noopener noreferrer">
            Read its design
          </a>{" "}
          <span className="arch-muted">
            ({gear.design_doc} at {shortCommit(commit)})
          </span>
        </p>
      )}
      <dl className="arch-facts">
        {gear.role === "plugin" && (
          <Fact label="Plugs into">
            {gear.extends ? chip(gear.extends) : <span className="arch-muted">not said by its name</span>}
          </Fact>
        )}
        <Fact label="Needs">
          {gear.depends_on.length ? (
            <span className="arch-chips">{gear.depends_on.map(chip)}</span>
          ) : (
            <span className="arch-muted">nothing — it can start first</span>
          )}
        </Fact>
        <Fact label="Needed by">
          {users.length ? (
            <span className="arch-chips">{users.map(chip)}</span>
          ) : (
            <span className="arch-muted">no other gear</span>
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
              <a
                className="arch-api-link"
                href={apiDocsUrl(surface.component)}
                target="_blank"
                rel="noopener"
              >
                Open in Docs &amp; API
              </a>
            </span>
          ) : (
            <span className="arch-muted">serves no REST paths of its own</span>
          )}
        </Fact>
        <Fact label="Prototype screens that call it">
          {screens.length ? (
            <ul className="arch-screen-list">
              {screens.map((s) => (
                <li key={`${s.file}#${s.name}`}>
                  {screenTitle(s.name)} <span className="arch-muted">({s.file})</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="arch-muted">none</span>
          )}
        </Fact>
      </dl>
      <p className="arch-muted arch-caps">
        Capabilities: {gear.capabilities.join(", ") || "none"} · starts #{gear.order + 1}
      </p>
    </div>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

function selectedFromHash(): string | null {
  const m = window.location.hash.match(/^#gear=(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function ArchitecturePage() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [selected, setSelected] = useState<string | null>(selectedFromHash);
  const detailRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    load().then(setData, (e: unknown) =>
      setError(
        e && typeof e === "object" && "kind" in e
          ? (e as LoadError)
          : { kind: "failed", message: e instanceof Error ? e.message : String(e) },
      ),
    );
  }, []);

  const select = useCallback((name: string) => {
    setSelected(name);
    history.replaceState(null, "", `#gear=${encodeURIComponent(name)}`);
    // On a narrow screen the detail is below the diagram: bring it into view.
    if (window.matchMedia("(max-width: 900px)").matches) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }, []);

  const gears = data?.manifest.gears ?? [];
  const names = useMemo(() => gears.map((g) => g.name), [gears]);
  const surfaces = useMemo(() => (data?.openapi ? restSurfaces(data.openapi, names) : null), [data, names]);
  const joined = useMemo(() => (data?.map ? joinPrototype(data.map, names) : null), [data, names]);

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
  const backendCommit = manifest.build.commit ?? null;
  const prototypeCommit = map?.commit ?? null;
  const current = gears.find((g) => g.name === selected) ?? null;
  const screensByFile = new Map<string, PrototypeScreen[]>();
  for (const screen of map?.screens ?? []) {
    const list = screensByFile.get(screen.file) ?? [];
    list.push(screen);
    screensByFile.set(screen.file, list);
  }

  return (
    <main className="arch">
      <header className="arch-head">
        <h1>How Studio is built</h1>
        <p className="arch-lede">
          Studio's backend is one program assembled from <strong>gears</strong>: self-contained parts that
          each do one job and say which other gears they need. This page is drawn from the backend that is
          running right now, so it shows what is actually deployed — not a diagram someone drew once.
        </p>
        <dl className="arch-build">
          <Fact label="Backend built from">
            <CommitLink commit={backendCommit} />
            {manifest.build.features.length > 0 && (
              <span className="arch-muted"> · features: {manifest.build.features.join(", ")}</span>
            )}
          </Fact>
          <Fact label="This prototype built from">
            {map ? (
              <CommitLink commit={prototypeCommit} />
            ) : (
              <span className="arch-muted">no map was bundled with this build</span>
            )}
          </Fact>
          <Fact label="IDE session image">
            {manifest.sessions_enabled && manifest.session_image ? (
              <code className="arch-image">{manifest.session_image}</code>
            ) : (
              <span className="arch-muted">sessions are off in this deployment</span>
            )}
          </Fact>
        </dl>
        {commitsDiffer(backendCommit, prototypeCommit) && (
          <div className="arch-warn" role="status">
            The backend and this prototype were built from different commits. The gears below are the
            backend's; the screens are the prototype's, and a screen may call something this backend does not
            have yet — or no longer has.
          </div>
        )}
        <p className="arch-counts">
          <strong>{counts.total}</strong> gears are running: <strong>{counts.studio}</strong> written for
          Studio and <strong>{counts.platform}</strong> from the platform; <strong>{counts.plugins}</strong>{" "}
          of them are plugins.
        </p>
      </header>

      <section className="card arch-section">
        <h2>Gears and what they need</h2>
        <p className="arch-muted">
          A gear starts only after everything it needs, so each row needs only rows above it. Choose a gear to
          see what it is for, what it needs (lines up) and what needs it (lines down).
        </p>
        <Legend />
        <div className="arch-main">
          <Diagram gears={gears} selected={selected} onSelect={select} />
          <aside className="arch-detail" ref={detailRef} aria-live="polite">
            {current ? (
              <GearDetail
                gear={current}
                gears={gears}
                commit={backendCommit}
                surface={surfaces?.byGear.get(current.name)}
                screens={joined?.screensOf.get(current.name) ?? []}
                onSelect={select}
              />
            ) : (
              <p className="arch-muted">Choose a gear in the diagram.</p>
            )}
          </aside>
        </div>
        {!data.openapi && (
          <p className="arch-muted">The REST paths are missing: {OPENAPI_URL} could not be read.</p>
        )}
      </section>

      <section className="card arch-section">
        <h2>The prototype: which screen calls which gear</h2>
        <p className="arch-muted">
          Read from this prototype's source code when it was built. A screen is listed under the file it is
          written in; choose a gear to find it in the diagram.
        </p>
        {!map || !joined ? (
          <p className="arch-muted">No prototype map was bundled with this build.</p>
        ) : (
          <div className="arch-proto">
            {[...screensByFile.entries()].map(([file, screens]) => (
              <div key={file} className="arch-proto-file">
                <h3>
                  {fileTitle(file)} <span className="arch-muted">{file}</span>
                </h3>
                <ul>
                  {screens.map((screen) => {
                    const owned = joined.gearsOf.get(screen) ?? [];
                    return (
                      <li key={screen.name} className="arch-proto-screen">
                        <span className="arch-proto-name" title={screen.name}>
                          {screenTitle(screen.name)}
                        </span>
                        <span className="arch-chips">
                          {owned.map((name) => {
                            const gear = gears.find((g) => g.name === name);
                            return gear ? (
                              <GearChip
                                key={name}
                                gear={gear}
                                state="plain"
                                onSelect={(n) => {
                                  select(n);
                                  document
                                    .querySelector(".arch-diagram")
                                    ?.scrollIntoView({ behavior: "smooth" });
                                }}
                              />
                            ) : null;
                          })}
                          {owned.length === 0 && (
                            <span className="arch-muted">only paths this backend does not serve</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {joined.unowned.length > 0 && (
              <p className="arch-muted">
                Called by the prototype but served by no gear of this backend:{" "}
                {joined.unowned.map((p) => (
                  <code key={p}>{p} </code>
                ))}
              </p>
            )}
          </div>
        )}
      </section>
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
