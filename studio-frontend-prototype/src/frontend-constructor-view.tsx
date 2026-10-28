/* The Product tab's Frontend section (ADR-0050): the product's UI as a FrontX shell
 * with micro-frontends mounted in it. The packages one can add on the left,
 * from the catalogue; the shell in the middle, drawn as the portal draws it —
 * navigation, the page, the sidebar, overlays and popups — filled with the
 * screens the picked packages bring; the selected package on the right, with
 * the gears it calls and whether the product has them. The model is
 * `frontend-constructor.ts`.
 *
 * The pick is kept in `project.config.frontend` until product.gdl has a
 * frontend block (ADR-0050 phase 2). */

import { useEffect, useMemo, useState, type DragEvent } from "react";

import { api } from "./api";
import { repoPathsOf } from "./builds";
import {
  SUGGESTED_FRONTX_SOURCE,
  coverage,
  frontxSuggestion,
  mfesFrom,
  offersFor,
  placementLabel,
  splitTemplates,
  withFrontxSource,
  zonesOf,
  type Mfe,
  type Placement,
} from "./frontend-constructor";
import { errText } from "./problem";

type Loaded = {
  /** The micro-frontends a product can add. */
  mfes: Mfe[];
  /** Templates and examples: where a new micro-frontend starts. */
  templates: Mfe[];
  gears: string[];
  /** The project's repository to read micro-frontends from, when the
   *  catalogue does not read it yet. */
  suggestion: string | null;
};

/** A lucide icon id (`lucide:users`) as one letter in a circle: the shell's
 *  icons are not bundled here, and a letter says which item it is. */
function Glyph({ icon, label }: { icon: string | null; label: string }) {
  const letter = (icon?.split(":").pop() ?? label).slice(0, 1).toUpperCase();
  return (
    <span className="fc-glyph" aria-hidden="true">
      {letter}
    </span>
  );
}

export function FrontendConstructor({ token, projectId }: { token: string; projectId: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped to read the catalogue again, after the suggested source synced. */
  const [loads, setLoads] = useState(0);
  /** Where adding the suggested FrontX source has got to; `null` when idle. */
  const [suggesting, setSuggesting] = useState<string | null>(null);
  /** The product's gears no picked screen calls, listed on demand. */
  const [showUnseen, setShowUnseen] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.listComponents(token),
      api.listComponentProfiles(token).catch(() => ({ nodes: [] })),
      api.projectProduct(token, projectId).catch(() => null),
      api.projectConfig(token, projectId).catch(() => null),
      api.listArtifactNodes(token, "repo", projectId, undefined, 50).catch(() => ({ nodes: [] })),
      api.catalogSources(token).catch(() => ({ items: [] })),
    ])
      .then(([components, profiles, product, cfg, repos, sources]) => {
        if (!alive) return;
        const byName: Record<string, Record<string, unknown>> = {};
        for (const n of profiles.nodes ?? []) {
          const name = typeof n.value.gear_name === "string" ? n.value.gear_name : "";
          if (name) byName[name] = n.value as Record<string, unknown>;
        }
        const { addable, templates } = splitTemplates(mfesFrom(components.nodes ?? [], byName));
        setData({
          mfes: addable,
          templates,
          gears: product?.gears ?? [],
          suggestion: frontxSuggestion([...repoPathsOf(repos.nodes ?? []).values()], sources.items ?? []),
        });
        const own = cfg?.frontend?.mfes ?? [];
        setPicks(own);
        setSaved(own);
      })
      .catch((e) => alive && setErr(errText(e)));
    return () => {
      alive = false;
    };
  }, [token, projectId, loads]);

  /** Add `repo` to the organization's catalogue sources as FrontX (unless it
   *  is there already) and sync them, the way a scheduled sync does: no body,
   *  so the run reads every stored source. */
  async function addSource(repo: string) {
    setErr(null);
    setSuggesting("Adding the source…");
    try {
      const { items } = await api.catalogSources(token);
      const next = withFrontxSource(items ?? [], repo);
      if (next) await api.saveCatalogSources(token, next);
      setSuggesting("Syncing the catalogue…");
      const { run_id } = await api.syncComponents(token);
      const deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const t = await api.componentsCatalogTask(token, run_id);
        if (t.status === "succeeded") break;
        if (t.status === "failed" || t.status === "cancelled") throw new Error(t.message || `The sync ${t.status}.`);
        if (Date.now() > deadline) throw new Error("The sync is still running; come back to this tab when it is done.");
        setSuggesting(`Syncing the catalogue: ${(t.message || t.status).replace(/…$/, "")}…`);
      }
      setSuggesting(null);
      setLoads((n) => n + 1);
    } catch (e) {
      setSuggesting(null);
      setErr(errText(e));
    }
  }

  const picked = useMemo(
    () => (data ? picks.map((n) => data.mfes.find((m) => m.name === n)).filter((m): m is Mfe => !!m) : []),
    [data, picks],
  );
  const zones = useMemo(() => zonesOf(picked), [picked]);
  const cover = useMemo(() => coverage(picked, data?.gears ?? []), [picked, data]);

  if (err) return <div className="error">{err}</div>;
  if (!data) return <p className="muted">Reading the micro-frontends in the catalogue…</p>;

  const add = (name: string) => setPicks((p) => (p.includes(name) ? p : [...p, name]));
  const remove = (name: string) => {
    setPicks((p) => p.filter((x) => x !== name));
    if (selected === name) setSelected(null);
  };
  const dirty = JSON.stringify(picks) !== JSON.stringify(saved);
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const cfg = (await api.projectConfig(token, projectId)) ?? {};
      await api.putProjectConfig(token, projectId, { ...cfg, frontend: { ...(cfg.frontend ?? {}), mfes: picks } });
      setSaved(picks);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const screens = zones.find((z) => z.domain === "screen")?.items ?? [];
  const shown = screens.find((s) => s.placement.id === page) ?? screens[0];
  const missingCount = [...cover.missing.values()].reduce((n, l) => n + l.length, 0);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const name = e.dataTransfer.getData("text/plain") || dragging;
    if (name) add(name);
    setDragging(null);
  };
  const selectedMfe = selected ? data.mfes.find((m) => m.name === selected) : undefined;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="pm-status" role="status">
        <span className="pm-summary" data-frontend-summary>
          {picked.length} micro-frontend{picked.length === 1 ? "" : "s"} · {screens.length} screen
          {screens.length === 1 ? "" : "s"}
        </span>
        {missingCount > 0 ? (
          <span className="pm-pill todo">
            {missingCount} gear{missingCount === 1 ? "" : "s"} the screens call {missingCount === 1 ? "is" : "are"} not in the product
          </span>
        ) : picked.length > 0 ? (
          <span className="pm-pill ok">✓ Every screen has its gears</span>
        ) : null}
        {cover.unseen.length > 0 && (
          <button
            type="button"
            className="pm-pill todo"
            aria-expanded={showUnseen}
            onClick={() => setShowUnseen((v) => !v)}
            data-unseen-chip
          >
            {cover.unseen.length} gear{cover.unseen.length === 1 ? " has" : "s have"} no screen {showUnseen ? "▾" : "▸"}
          </button>
        )}
        <button type="button" className="primary" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>
      {showUnseen && cover.unseen.length > 0 && (
        <div className="pm-box" data-unseen-list>
          {cover.unseen.map((g) => {
            const could = data.mfes.filter((m) => offersFor(g, [m]).length > 0);
            return (
              <div key={g} style={{ fontSize: 12.5 }}>
                <code>{g}</code>
                {could.length > 0 ? (
                  <>
                    {" "}
                    — shown by{" "}
                    {could.map((m, i) => (
                      <span key={m.name}>
                        {i > 0 && ", "}
                        <button type="button" className="pm-link" onClick={() => add(m.name)}>
                          {m.name}
                        </button>
                      </span>
                    ))}
                  </>
                ) : (
                  <span className="muted"> — no micro-frontend in the catalogue calls it</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="pm-work">
        <div className="pm-box pm-palette" aria-label="Micro-frontends you can add">
          <div className="pm-h">Micro-frontends you can add</div>
          <input
            type="search"
            placeholder="What should it show? people, specs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Find a micro-frontend"
          />
          {data.mfes.length === 0 && (
            <div className="muted" style={{ fontSize: 12, margin: 0, display: "grid", gap: 6 }} data-frontx-suggestion>
              <span>
                No micro-frontend to add yet: they come from a repository the catalogue reads as <b>frontx</b>, one
                package with an <code>mfe.json</code> under <code>src-app/mfe_packages/</code> each.
              </span>
              {data.suggestion ? (
                <>
                  <span>
                    Read this project&apos;s own repository, <code>{data.suggestion}</code>: its micro-frontends land here
                    with their screens.
                  </span>
                  <span>
                    <button
                      type="button"
                      className="primary"
                      disabled={suggesting !== null}
                      onClick={() => data.suggestion && void addSource(data.suggestion)}
                      data-frontx-add-own
                    >
                      {suggesting ?? "Add and sync"}
                    </button>
                  </span>
                </>
              ) : (
                <span>Add a repository with micro-frontends under Components › Repositories, mode frontx, and sync.</span>
              )}
            </div>
          )}
          {data.mfes
            .filter((m) => !picks.includes(m.name))
            .filter((m) => {
              const q = query.trim().toLowerCase();
              if (!q) return true;
              return [m.name, m.description, ...m.calls, ...m.placements.map(placementLabel)].some((t) =>
                t.toLowerCase().includes(q),
              );
            })
            .map((m) => (
              <div
                key={m.name}
                className="pm-offer"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", m.name);
                  setDragging(m.name);
                }}
                onDragEnd={() => setDragging(null)}
                data-mfe={m.name}
              >
                <span className="fc-glyph" aria-hidden="true">
                  ◧
                </span>
                <b style={{ overflowWrap: "anywhere" }}>{m.name}</b>
                <button type="button" className="pm-link" onClick={() => add(m.name)}>
                  Add
                </button>
                <p>
                  {m.placements.length > 0
                    ? `${m.placements.map(placementLabel).join(", ")}`
                    : "No screens declared"}
                  {m.calls.length > 0 && <> · calls {m.calls.join(", ")}</>}
                </p>
              </div>
            ))}
          <details className="fc-templates" data-mfe-templates>
            <summary>Start a new micro-frontend from a template</summary>
            <p className="muted" style={{ fontSize: 12, margin: "6px 0" }}>
              Copy a template into your repository&apos;s <code>src-app/mfe_packages/</code>, give it its screens, and
              sync: it lands above as one to add.
            </p>
            {data.templates.length > 0 ? (
              data.templates.map((t) => (
                <div key={t.name} style={{ fontSize: 12.5 }}>
                  <code>{t.name}</code>
                  {t.kind ? <span className="muted"> · {t.kind}</span> : null}
                  {t.placements.length > 0 ? (
                    <span className="muted"> · {t.placements.map(placementLabel).join(", ")}</span>
                  ) : null}
                </div>
              ))
            ) : (
              <div style={{ fontSize: 12.5 }}>
                The templates are in{" "}
                <a
                  href={`https://github.com/${SUGGESTED_FRONTX_SOURCE.repo}/tree/${SUGGESTED_FRONTX_SOURCE.git_ref}/template-mfe/src-app/mfe_packages`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <code>{SUGGESTED_FRONTX_SOURCE.repo}</code>
                </a>
                : a blank one, a demo, two widgets.
              </div>
            )}
          </details>
        </div>

        <div
          className={`pm-box fc-shell${dragging ? " over" : ""}`}
          aria-label="The shell"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
        >
          <div className="pm-h">The product's shell</div>
          <div className="fc-frame">
            <div className="fc-top">
              <span className="fc-dot" />
              <span className="fc-dot" />
              <span className="fc-dot" />
              <span className="fc-url">{shown?.placement.route ?? "/"}</span>
            </div>
            <div className="fc-body">
              <nav className="fc-nav" aria-label="Navigation the screens make">
                {screens.length === 0 && <div className="fc-empty">Screens land here</div>}
                {screens.map(({ mfe, placement }) => (
                  <button
                    key={placement.id}
                    type="button"
                    className={`fc-nav-item${shown?.placement.id === placement.id ? " on" : ""}`}
                    onClick={() => {
                      setPage(placement.id);
                      setSelected(mfe.name);
                    }}
                    title={`${mfe.name}${placement.level ? ` · ${placement.level} level` : ""}`}
                  >
                    <Glyph icon={placement.icon} label={placementLabel(placement)} />
                    {placementLabel(placement)}
                  </button>
                ))}
              </nav>
              <main className="fc-page" aria-label="The page">
                {shown ? (
                  <PageCard
                    mfe={shown.mfe}
                    placement={shown.placement}
                    missing={cover.missing.get(shown.mfe.name) ?? []}
                    onOpen={() => setSelected(shown.mfe.name)}
                  />
                ) : (
                  <div className="fc-empty big">Drag a micro-frontend here, or press Add.</div>
                )}
              </main>
              <aside className="fc-side" aria-label="Sidebar">
                <ZoneItems zone={zones.find((z) => z.domain === "sidebar")} onOpen={setSelected} />
              </aside>
            </div>
            <div className="fc-strips">
              {zones
                .filter((z) => z.domain !== "screen" && z.domain !== "sidebar")
                .map((z) => (
                  <div key={z.domain} className="fc-strip">
                    <ZoneItems zone={z} onOpen={setSelected} />
                  </div>
                ))}
            </div>
          </div>
        </div>

        <Inspector
          mfe={selectedMfe}
          gears={data.gears}
          missing={selectedMfe ? (cover.missing.get(selectedMfe.name) ?? []) : []}
          picked={selectedMfe ? picks.includes(selectedMfe.name) : false}
          onRemove={remove}
          onAdd={add}
        />
      </div>
    </div>
  );
}

function ZoneItems({
  zone,
  onOpen,
}: {
  zone: ReturnType<typeof zonesOf>[number] | undefined;
  onOpen: (name: string) => void;
}) {
  if (!zone) return null;
  return (
    <>
      <div className="fc-zone-h" title={zone.hint}>
        {zone.title}
      </div>
      {zone.items.length === 0 && <div className="fc-empty">empty</div>}
      {zone.items.map(({ mfe, placement }) => (
        <button key={placement.id} type="button" className="fc-chip" onClick={() => onOpen(mfe.name)} title={mfe.name}>
          <Glyph icon={placement.icon} label={placementLabel(placement)} />
          {placementLabel(placement)}
        </button>
      ))}
    </>
  );
}

function PageCard({
  mfe,
  placement,
  missing,
  onOpen,
}: {
  mfe: Mfe;
  placement: Placement;
  missing: string[];
  onOpen: () => void;
}) {
  return (
    <button type="button" className="fc-pagecard" onClick={onOpen}>
      <div className="fc-pagecard-h">
        <Glyph icon={placement.icon} label={placementLabel(placement)} />
        <b>{placementLabel(placement)}</b>
        {placement.route && <code>{placement.route}</code>}
      </div>
      <div className="fc-skeleton" aria-hidden="true">
        <i style={{ width: "60%" }} />
        <i style={{ width: "90%" }} />
        <i style={{ width: "75%" }} />
        <i style={{ width: "40%" }} />
      </div>
      <small>
        from <code>{mfe.name}</code>
      </small>
      <span className="fc-calls">
        {mfe.calls.length === 0 && <span className="muted">calls no gear it names</span>}
        {mfe.calls.map((c) => (
          <span key={c} className={`fc-call${missing.includes(c) ? " missing" : ""}`}>
            {missing.includes(c) ? "✗" : "✓"} {c}
          </span>
        ))}
      </span>
    </button>
  );
}

function Inspector({
  mfe,
  gears,
  missing,
  picked,
  onRemove,
  onAdd,
}: {
  mfe: Mfe | undefined;
  gears: string[];
  missing: string[];
  picked: boolean;
  onRemove: (name: string) => void;
  onAdd: (name: string) => void;
}) {
  if (!mfe) {
    return (
      <div className="pm-box pm-inspector" aria-label="About the selected micro-frontend">
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Pick a screen or a micro-frontend to see where it shows and which gears it calls: ✓ the product has the gear,
          ✗ add it under Backend.
        </p>
      </div>
    );
  }
  return (
    <div className="pm-box pm-inspector" aria-label="About the selected micro-frontend">
      <h3 style={{ overflowWrap: "anywhere" }}>{mfe.name}</h3>
      {mfe.description && <p style={{ margin: 0 }}>{mfe.description}</p>}
      <section>
        <div className="pm-h">Where it shows</div>
        {mfe.placements.length === 0 && <span className="muted">Its mfe.json declares no extension.</span>}
        {mfe.placements.map((p) => (
          <div key={p.id} style={{ fontSize: 12.5 }}>
            <b>{placementLabel(p)}</b> · {p.domain}
            {p.route && (
              <>
                {" "}
                · <code>{p.route}</code>
              </>
            )}
            {p.level && <span className="muted"> · {p.level} level</span>}
          </div>
        ))}
      </section>
      <section>
        <div className="pm-h">Gears it calls</div>
        {mfe.calls.length === 0 && <span className="muted">Its API services name no /cf/&lt;gear&gt;/v route.</span>}
        {mfe.calls.map((c) => (
          <span
            key={c}
            className={`fc-call${missing.includes(c) ? " missing" : ""}`}
            title={mfe.via[c] ? `through ${mfe.via[c]}` : "from its own API services"}
          >
            {missing.includes(c) ? "✗ not in the product" : "✓"} {c}
            {mfe.via[c] && <span style={{ opacity: 0.7 }}> · via {mfe.via[c]}</span>}
          </span>
        ))}
        {missing.length > 0 && (
          <p className="pm-why" style={{ margin: "6px 0 0" }}>
            Add {missing.join(", ")} on the Product tab, or this screen has nothing to talk to.
          </p>
        )}
        <small className="muted">
          Read from the base URLs of its API services and of the FrontX packages it depends on;{" "}
          {gears.length} gears are in the product.
        </small>
      </section>
      {mfe.version && <small className="muted">version {mfe.version}</small>}
      {picked ? (
        <button type="button" onClick={() => onRemove(mfe.name)}>
          Remove from the shell
        </button>
      ) : (
        <button type="button" className="primary" onClick={() => onAdd(mfe.name)}>
          Add to the shell
        </button>
      )}
    </div>
  );
}
