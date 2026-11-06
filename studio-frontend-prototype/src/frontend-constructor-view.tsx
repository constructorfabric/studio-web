/* The Product tab's Frontend section (ADR-0050): the product's UI as a FrontX shell
 * with micro-frontends mounted in it. Above, the steps a build of it takes —
 * the shell, the micro-frontends, their FrontX versions, sign-in, the
 * backend, the gears behind the screens, build, ship — each with what the
 * constructor found, so the way to a running frontend is visible before it is
 * built. Below, the packages one can add on the left,
 * from the catalogue; the shell in the middle, drawn as the portal draws it —
 * navigation, the page, the sidebar, overlays and popups — filled with the
 * screens the picked packages bring; the selected package on the right, with
 * the gears it calls and whether the product has them. The model is
 * `frontend-constructor.ts`.
 *
 * The pick is kept with the product (`frontend` of its record), and its
 * product.gdl says it as `frontend = frontx_product(...)` (GDL 1.5): the shell
 * and each package by repository and directory, the gears each calls, and the
 * libraries they share that the shell lacks. A project that picked before
 * keeps `project.config.frontend`, read until the first save. */

import { useEffect, useMemo, useState, type DragEvent } from "react";

import { api, type ScreenPreview } from "./api";
import { repoPathsOf } from "./builds";
import {
  FRONTX_SHELL_TEMPLATE,
  assemblySteps,
  stepsSummary,
  chosenShell,
  coverage,
  fitOf,
  frontendPick,
  frontxDefaultsOf,
  frontxSuggestion,
  librariesFrom,
  mfesFrom,
  offersFor,
  picksOf,
  placementLabel,
  projectRepos,
  shellRefOf,
  shellsFrom,
  splitTemplates,
  withFrontxSource,
  zonesOf,
  type FrontxDefaults,
  type Library,
  type Mfe,
  type Placement,
  type Shell,
  type ShellPassport,
  type Step,
} from "./frontend-constructor";
import { Modal } from "./modal";
import { errText } from "./problem";
import { pictureOf, previewBuild, shortCommit, type PreviewBuild } from "./screen-previews";
import { StatusChip, StepFlow, type FlowStep, type StepState } from "./ui-standard";

type Loaded = {
  /** The micro-frontends a product can add. */
  mfes: Mfe[];
  /** Templates and examples: where a new micro-frontend starts. */
  templates: Mfe[];
  /** Packages micro-frontends share: brought along when the shell lacks them. */
  libraries: Library[];
  gears: string[];
  /** The shells in the catalogue: what a frontend can be assembled on. */
  shells: Shell[];
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

/** Each package's pictures, read once per page: a build adds them, and a
 *  reload is when a reader expects to see a new one. */
const pictures = new Map<string, Promise<ScreenPreview[]>>();

/** The build whose pictures each of `mfes` shows, by package name, as the
 *  product map picks it (`previewBuild`): `null` while reading and for a
 *  package no build pictured at its catalogue version. */
function usePictureBuilds(token: string, mfes: readonly Mfe[]): Map<string, PreviewBuild | null> {
  const ask = mfes.map((m) => m.name).join(",");
  const [items, setItems] = useState<Map<string, ScreenPreview[]>>(() => new Map());
  useEffect(() => {
    if (!ask) return;
    let live = true;
    for (const name of ask.split(",")) {
      let read = pictures.get(name);
      if (!read) {
        read = api.screenPreviews(token, name).then(
          (r) => r.items ?? [],
          (): ScreenPreview[] => [],
        );
        pictures.set(name, read);
      }
      void read.then((r) => {
        if (live) setItems((m) => (m.get(name) === r ? m : new Map(m).set(name, r)));
      });
    }
    return () => {
      live = false;
    };
  }, [token, ask]);
  return useMemo(() => {
    const out = new Map<string, PreviewBuild | null>();
    for (const m of mfes) {
      const got = items.get(m.name);
      out.set(m.name, got ? previewBuild(got, m.version) : null);
    }
    return out;
  }, [items, mfes]);
}

/** A screen's picture, larger, over the page. */
function ShotModal({ shot, build, onClose }: { shot: ScreenPreview; build: PreviewBuild; onClose: () => void }) {
  return (
    <Modal label={`${shot.label ?? shot.route}, as a build drew it`} onClose={onClose} cardStyle={{ width: "min(1000px, 100%)" }}>
      <div className="fc-shot-modal-h">
        <b>{shot.label ?? shot.route}</b>
        <code>{shot.route}</code>
        <span className="muted">
          {shot.component}
          {build.version ? `@${build.version}` : ""} · built at {shortCommit(build.commit)}
        </span>
        <button type="button" onClick={onClose} style={{ marginLeft: "auto" }}>
          Close
        </button>
      </div>
      <img className="fc-shot-big" src={shot.image} alt={shot.label ?? shot.route} />
    </Modal>
  );
}

/** The deployment's FrontX starting points, asked once per page load. */
let frontxAsked: Promise<FrontxDefaults> | null = null;
let frontxKnown: FrontxDefaults | null = null;

export function loadFrontxDefaults(token: string): Promise<FrontxDefaults> {
  frontxAsked ??= api.gearboxStatus(token).then(
    (st) => (frontxKnown = frontxDefaultsOf(st)),
    () => {
      // Asked again next time; the built-in templates meanwhile.
      frontxAsked = null;
      return frontxDefaultsOf(null);
    },
  );
  return frontxAsked;
}

/** [`loadFrontxDefaults`] for a view: the built-in templates until it answers. */
export function useFrontxDefaults(token: string): FrontxDefaults {
  const [d, setD] = useState<FrontxDefaults>(() => frontxKnown ?? frontxDefaultsOf(null));
  useEffect(() => {
    let alive = true;
    void loadFrontxDefaults(token).then((x) => alive && setD(x));
    return () => {
      alive = false;
    };
  }, [token]);
  return d;
}

export function FrontendConstructor({ token, projectId }: { token: string; projectId: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  /** Whether the product record keeps the frontend, which is what its
   *  product.gdl is written from; a pick from before is only in the
   *  project configuration. */
  const [inProduct, setInProduct] = useState(false);
  /** The shell it is assembled on, as `github:owner/repo//dir@ref`. */
  const [shellRef, setShellRef] = useState<string>(FRONTX_SHELL_TEMPLATE);
  const [savedShell, setSavedShell] = useState<string>(FRONTX_SHELL_TEMPLATE);
  /** The step whose detail is open; `null` shows them all folded. */
  const [openStep, setOpenStep] = useState<Step["id"] | null>(null);
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
  const frontx = useFrontxDefaults(token);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.listComponents(token, projectId),
      api.listComponentProfiles(token, projectId).catch(() => ({ nodes: [] })),
      api.projectProduct(token, projectId).catch(() => null),
      api.projectConfig(token, projectId).catch(() => null),
      api.listArtifactNodes(token, "repo", projectId, undefined, 50).catch(() => ({ nodes: [] })),
      api.catalogSources(token).catch(() => ({ items: [] })),
      api.getProjectGearRepo(token, projectId).catch(() => ({ nodes: [] })),
      loadFrontxDefaults(token),
    ])
      .then(([components, profiles, product, cfg, repos, sources, gearRepo, defaults]) => {
        if (!alive) return;
        const byName: Record<string, Record<string, unknown>> = {};
        for (const n of profiles.nodes ?? []) {
          const name = typeof n.value.gear_name === "string" ? n.value.gear_name : "";
          if (name) byName[name] = n.value as Record<string, unknown>;
        }
        const all = mfesFrom(components.nodes ?? [], byName);
        const { addable, templates } = splitTemplates(all, defaults.source.repo);
        setData({
          mfes: addable,
          templates,
          libraries: librariesFrom(components.nodes ?? [], byName),
          gears: product?.gears ?? [],
          shells: shellsFrom(components.nodes ?? [], byName),
          suggestion: frontxSuggestion(
            projectRepos({
              gearRepo: gearRepo.nodes?.[0]?.value.repo,
              sources: cfg?.sources,
              writtenPrUrl: product?.written?.pr_url,
              artifactRepos: [...repoPathsOf(repos.nodes ?? []).values()],
            }),
            sources.items ?? [],
          ),
        });
        // The product's own record first; a project that picked before it
        // kept one has its picks in the project configuration.
        const kept = product?.frontend ? picksOf(product.frontend, all) : null;
        setInProduct(!!kept);
        const own = kept?.picks ?? cfg?.frontend?.mfes ?? [];
        setPicks(own);
        setSaved(own);
        const shell = kept?.shellRef ?? cfg?.frontend?.shell ?? defaults.shellTemplate;
        setShellRef(shell);
        setSavedShell(shell);
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
  const shell = useMemo(() => chosenShell(data?.shells ?? [], shellRef), [data, shellRef]);
  const steps = useMemo(
    () => assemblySteps({ shellRef, shell, picked, productGears: data?.gears ?? [] }),
    [shellRef, shell, picked, data],
  );
  /** The packages whose pictures the page shows: the picked ones, and the
   *  one the inspector is about. */
  const pictured = useMemo(() => {
    const sel = selected ? data?.mfes.find((m) => m.name === selected) : undefined;
    return sel && !picked.includes(sel) ? [...picked, sel] : picked;
  }, [data, picked, selected]);
  const builds = usePictureBuilds(token, pictured);
  /** The picture open large; `null` when none is. */
  const [enlarged, setEnlarged] = useState<{ shot: ScreenPreview; build: PreviewBuild } | null>(null);

  if (err) return <div className="error">{err}</div>;
  if (!data) return <p className="muted">Reading the micro-frontends in the catalogue…</p>;

  const add = (name: string) => setPicks((p) => (p.includes(name) ? p : [...p, name]));
  const remove = (name: string) => {
    setPicks((p) => p.filter((x) => x !== name));
    if (selected === name) setSelected(null);
  };
  const dirty = !inProduct || JSON.stringify(picks) !== JSON.stringify(saved) || shellRef !== savedShell;
  // Picks the catalogue does not list (a legacy project's, or one removed
  // since) are not on the page; saving must not drop them silently.
  const unknown = picks.filter((n) => !data.mfes.some((m) => m.name === n));
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      if (unknown.length > 0)
        throw new Error(`The catalogue does not list ${unknown.join(", ")}; sync the catalogue, then save.`);
      const chosen = picks.map((n) => data?.mfes.find((m) => m.name === n)).filter((m): m is Mfe => !!m);
      const { pick, unplaced } = frontendPick(shellRef, chosen, data?.libraries ?? [], data?.gears ?? []);
      if (!pick) throw new Error(`The shell \`${shellRef}\` is not a repository and directory.`);
      if (unplaced.length > 0)
        throw new Error(
          `The catalogue does not say where ${unplaced.join(", ")} ${unplaced.length === 1 ? "is" : "are"} yet; sync the catalogue, then save.`,
        );
      await api.saveProjectProduct(token, projectId, { frontend: pick });
      setSaved(picks);
      setSavedShell(shellRef);
      setInProduct(true);
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
      <BuildSteps
        steps={steps}
        open={openStep}
        onOpen={setOpenStep}
        shells={data.shells}
        shell={shell}
        shellRef={shellRef}
        onShell={setShellRef}
      />
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
        <button type="button" className="primary" disabled={!dirty || busy || unknown.length > 0} onClick={save}>
          {busy ? "Saving…" : !inProduct ? "Save to the product" : dirty ? "Save" : "Saved"}
        </button>
      </div>
      {unknown.length > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }} data-frontend-unknown-picks>
          The catalogue does not list {unknown.join(", ")}, so {unknown.length === 1 ? "it is" : "they are"} not on the
          page. Sync the catalogue to bring {unknown.length === 1 ? "it" : "them"} back, or{" "}
          <button type="button" className="link" onClick={() => unknown.forEach(remove)}>
            drop {unknown.length === 1 ? "it" : "them"}
          </button>{" "}
          before saving.
        </p>
      )}
      <p className="muted" style={{ margin: 0, fontSize: 12 }} data-frontend-gdl-note>
        {inProduct ? (
          <>
            Kept with the product. Its <code>product.gdl</code> says it as <code>frontend = frontx_product(...)</code> from
            the next revision: step 2 above, Save to product.gdl, shows the block and saves it.
          </>
        ) : (
          <>
            Picked before the product kept its frontend, so <code>product.gdl</code> does not say it yet. Save to the
            product, then step 2 above, Save to product.gdl, writes <code>frontend = frontx_product(...)</code>.
          </>
        )}
      </p>
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
                  href={`https://github.com/${frontx.source.repo}/tree/${frontx.source.git_ref}/template-mfe/src-app/mfe_packages`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <code>{frontx.source.repo}</code>
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
          <div className="pm-h">
            The product&apos;s shell
            {shell && (
              <span className="fc-shell-name">
                {" "}
                · {shell.name}
                {shell.version ? `@${shell.version}` : ""}
                {shell.signsIn === false && <span className="fc-tag bad">no sign-in</span>}
                {shell.signsIn === true && <span className="fc-tag ok">signs in</span>}
                {shell.runtimeEnv === true && <span className="fc-tag ok">reads /env.js at start</span>}
                {shell.runtimeEnv === false && <span className="fc-tag">addresses fixed at build</span>}
                {(shell.signsIn !== null || shell.runtimeEnv !== null) && <SourceMark described={shell.described} />}
                <DriftMark drift={shell.drift} />
              </span>
            )}
          </div>
          {shell?.passport && <ShellPassportLine passport={shell.passport} />}
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
                    build={builds.get(shown.mfe.name) ?? null}
                    onOpen={() => setSelected(shown.mfe.name)}
                    onEnlarge={setEnlarged}
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
          shell={shell}
          gears={data.gears}
          missing={selectedMfe ? (cover.missing.get(selectedMfe.name) ?? []) : []}
          picked={selectedMfe ? picks.includes(selectedMfe.name) : false}
          build={selectedMfe ? (builds.get(selectedMfe.name) ?? null) : null}
          onRemove={remove}
          onAdd={add}
          onEnlarge={setEnlarged}
        />
      </div>
      {enlarged && <ShotModal shot={enlarged.shot} build={enlarged.build} onClose={() => setEnlarged(null)} />}
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

/** The page the selected screen fills: the picture a build took of it when
 *  the catalogue keeps one for its version (scripts/mfe-screen-previews.mjs),
 *  otherwise drawn as lines. The card selects its package; the picture opens
 *  larger. */
function PageCard({
  mfe,
  placement,
  missing,
  build,
  onOpen,
  onEnlarge,
}: {
  mfe: Mfe;
  placement: Placement;
  missing: string[];
  build: PreviewBuild | null;
  onOpen: () => void;
  onEnlarge: (x: { shot: ScreenPreview; build: PreviewBuild }) => void;
}) {
  const shot = pictureOf(build, placement);
  return (
    <div className="fc-pagecard" onClick={onOpen} data-screen-shot={shot ? "built" : "none"}>
      <div className="fc-pagecard-h">
        <Glyph icon={placement.icon} label={placementLabel(placement)} />
        <b>{placementLabel(placement)}</b>
        {placement.route && <code>{placement.route}</code>}
        {shot && build && (
          <span className="fc-shot-tag" title={`Captured ${shot.captured_at}`}>
            built at {shortCommit(build.commit)}
          </span>
        )}
      </div>
      {shot && build ? (
        <button
          type="button"
          className="fc-shot"
          onClick={(e) => {
            e.stopPropagation();
            onEnlarge({ shot, build });
          }}
          title="Open the picture larger"
        >
          <img src={shot.image} alt={`${placementLabel(placement)}, as a build drew it`} />
        </button>
      ) : (
        <>
          <div className="fc-skeleton" aria-hidden="true">
            <i style={{ width: "60%" }} />
            <i style={{ width: "90%" }} />
            <i style={{ width: "75%" }} />
            <i style={{ width: "40%" }} />
          </div>
          <span className="fc-noshot">No screenshot of this screen yet</span>
        </>
      )}
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
    </div>
  );
}

/** A passport that disagrees with its package.json or mfe.json: the
 *  passport still counts, and the tag says which facts drifted. */
function DriftMark({ drift }: { drift?: string[] }) {
  if (!drift || drift.length === 0) return null;
  return (
    <span className="fc-tag warn" title={drift.join("\n")}>
      frontx.gdl drifts from its manifests ({drift.length})
    </span>
  );
}

/** The shell's passport, compactly: where its screens call the backend, what
 *  it reads at start, how it is built. */
function ShellPassportLine({ passport: p }: { passport: ShellPassport }) {
  const envKeys = Object.keys(p.env);
  const parts: { k: string; v: string; title?: string }[] = [];
  if (p.apiPrefix) parts.push({ k: "API", v: p.apiPrefix, title: "The path its screens call the backend under, proxied to the API Gateway" });
  if (envKeys.length > 0)
    parts.push({
      k: "reads at start",
      v: envKeys.join(", "),
      title: Object.entries(p.env)
        .map(([k, v]) => `${k} ← ${v}`)
        .join("\n"),
    });
  if (p.buildEnv.length > 0) parts.push({ k: "needs at build", v: p.buildEnv.join(", ") });
  if (p.build) parts.push({ k: "build", v: p.output ? `${p.build} → ${p.output}/` : p.build });
  if (p.node) parts.push({ k: "node", v: p.node });
  if (parts.length === 0) return null;
  return (
    <div className="fc-passport muted" aria-label="What the shell's frontx.gdl says">
      {parts.map((x) => (
        <span key={x.k} title={x.title}>
          {x.k} <code>{x.v}</code>
        </span>
      ))}
    </div>
  );
}

/** Where a package's facts came from: its own `frontx.gdl`, or the scan's
 *  reading of its files. */
function SourceMark({ described }: { described?: boolean }) {
  return described ? (
    <span className="fc-tag ok" title="The package states this in its frontx.gdl">
      declared in frontx.gdl
    </span>
  ) : (
    <span className="fc-tag" title="The package has no frontx.gdl that reads; the scan inferred this from its files">
      guessed from the source
    </span>
  );
}

function Inspector({
  mfe,
  shell,
  gears,
  missing,
  picked,
  build,
  onRemove,
  onAdd,
  onEnlarge,
}: {
  mfe: Mfe | undefined;
  shell: Shell | null;
  gears: string[];
  missing: string[];
  picked: boolean;
  build: PreviewBuild | null;
  onRemove: (name: string) => void;
  onAdd: (name: string) => void;
  onEnlarge: (x: { shot: ScreenPreview; build: PreviewBuild }) => void;
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
        {mfe.placements.map((p) => {
          const shot = pictureOf(build, p);
          return (
            <div key={p.id} className="fc-place">
              {shot && build ? (
                <button
                  type="button"
                  className="fc-thumb"
                  onClick={() => onEnlarge({ shot, build })}
                  title={`Open the picture of ${placementLabel(p)}`}
                >
                  <img src={shot.image} alt="" />
                </button>
              ) : (
                <span className="fc-thumb none" title="No screenshot yet" />
              )}
              <span>
                <b>{placementLabel(p)}</b> · {p.domain}
                {p.route && (
                  <>
                    {" "}
                    · <code>{p.route}</code>
                  </>
                )}
                {p.level && <span className="muted"> · {p.level} level</span>}
              </span>
            </div>
          );
        })}
      </section>
      <section>
        <div className="pm-h">
          Gears it calls <SourceMark described={mfe.described} />
        </div>
        {mfe.calls.length === 0 && (
          <span className="muted">
            {mfe.described ? "Its frontx.gdl requires no gear." : "Its API services name no /cf/<gear>/v route."}
          </span>
        )}
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
      {mfe.roles && (
        <section>
          <div className="pm-h">
            Roles its screens need <SourceMark described />
          </div>
          {mfe.roles.length === 0 ? (
            <span className="muted">None: its frontx.gdl lists no role.</span>
          ) : (
            mfe.roles.map((r) => (
              <code key={r} style={{ marginRight: 6 }}>
                {r}
              </code>
            ))
          )}
        </section>
      )}
      <FitSection mfe={mfe} shell={shell} />
      {mfe.drift && mfe.drift.length > 0 && (
        <p className="pm-why" style={{ margin: 0 }}>
          <DriftMark drift={mfe.drift} /> {mfe.drift.join("; ")}
        </p>
      )}
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

/** A constructor step as the StepFlow strip draws it. */
const STEP_STATE: Record<Step["state"], StepState> = { ok: "done", warn: "warn", bad: "failed", todo: "todo", info: "current" };

/** The steps a build of this frontend takes, in order, each marked with what
 *  the constructor found: folded to how many are ready ("5/8"), unfolded a
 *  StepFlow strip where one opens to say why. The first step is where the
 *  shell is chosen. */
function BuildSteps({
  steps,
  open,
  onOpen,
  shells,
  shell,
  shellRef,
  onShell,
}: {
  steps: Step[];
  open: Step["id"] | null;
  onOpen: (id: Step["id"] | null) => void;
  shells: Shell[];
  shell: Shell | null;
  shellRef: string;
  onShell: (ref: string) => void;
}) {
  const [unfolded, setUnfolded] = useState(false);
  const refs = shells.map((s) => ({ shell: s, ref: shellRefOf(s) })).filter((x): x is { shell: Shell; ref: string } => !!x.ref);
  const summary = stepsSummary(steps);
  const flow: FlowStep[] = steps.map((s) => ({
    id: s.id,
    title: s.title,
    state: STEP_STATE[s.state],
    status: s.detail,
    body: (
      <>
        {s.id === "shell" && (
          <label className="fc-shell-pick">
            Assemble on{" "}
            <select value={shellRef} onChange={(e) => onShell(e.target.value)} aria-label="The shell">
              {!refs.some((r) => r.ref === shellRef) && <option value={shellRef}>{shellRef}</option>}
              {refs.map(({ shell: s, ref }) => (
                <option key={ref} value={ref}>
                  {s.name}
                  {s.version ? `@${s.version}` : ""} · {ref.replace(/^github:/, "")}
                  {s.signsIn === true ? " · signs in" : s.signsIn === false ? " · no sign-in" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {s.id === "shell" && shell && (
          <div className="fc-carries">
            {Object.entries(shell.carries)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([pkg, v]) => (
                <code key={pkg}>
                  {pkg.replace("@gears-frontx/", "")} {v}
                </code>
              ))}
          </div>
        )}
        {s.id === "build" && (
          <ol className="fc-commands">
            <li>
              <code>npm ci</code>
            </li>
            <li>
              <code>npm run build:packages</code> — the FrontX packages the shell carries
            </li>
            <li>
              <code>npm run build:mfes</code> — each micro-frontend, a module-federation remote
            </li>
            <li>
              <code>npm run generate:mfe-manifests</code> — what the shell reads to mount them
            </li>
            <li>
              <code>vite build</code> — the static site
            </li>
          </ol>
        )}
      </>
    ),
  }));
  return (
    <div className="fc-build" aria-label="How this frontend gets built" data-build-steps data-unfolded={unfolded}>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <span className="pm-h" style={{ margin: 0 }}>
          How it gets built
        </span>
        <StatusChip tone={summary.tone} data-build-steps-count>
          {summary.text}
        </StatusChip>
        <button type="button" className="ghost" onClick={() => setUnfolded((u) => !u)} aria-expanded={unfolded} data-build-steps-toggle>
          {unfolded ? "Hide the steps" : `Show all ${steps.length} steps`}
        </button>
      </div>
      {summary.fix.length > 0 && (
        <ul className="fc-fix" data-build-steps-fix>
          {summary.fix.map((s) => (
            <li key={s.id} data-build-step-fix={s.id} data-state={s.state}>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setUnfolded(true);
                  onOpen(s.id);
                }}
              >
                {steps.indexOf(s) + 1}. {s.title}
              </button>
              <span className="sub"> — {s.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {unfolded && (
        <StepFlow
          steps={flow}
          look="strip"
          label="How this frontend gets built"
          open={open}
          onOpen={(id) => onOpen(id as Step["id"] | null)}
        />
      )}
    </div>
  );
}

/** A micro-frontend's FrontX pins against the shell's: what a build gets. */
function FitSection({ mfe, shell }: { mfe: Mfe; shell: Shell | null }) {
  const pins = Object.keys(mfe.wants ?? {}).length;
  return (
    <section data-fit>
      <div className="pm-h">FrontX it pins</div>
      {pins === 0 ? (
        <span className="muted">Not read yet: sync the catalogue to see the versions it asks for.</span>
      ) : !shell ? (
        <span className="muted">The shell is not in the catalogue, so what it carries is unknown.</span>
      ) : (
        <table className="fc-fit">
          <tbody>
            {fitOf(mfe, shell).map((f) => (
              <tr key={f.pkg} className={f.verdict} data-verdict={f.verdict}>
                <td>
                  <code>{f.pkg.replace("@gears-frontx/", "")}</code>
                </td>
                <td>{f.wants}</td>
                <td>
                  {f.verdict === "fits"
                    ? `✓ ${f.has}`
                    : f.verdict === "differs"
                      ? `→ ${f.has}`
                      : "from the registry"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pins > 0 && shell && fitOf(mfe, shell).some((f) => f.verdict === "differs") && (
        <p className="pm-why" style={{ margin: "6px 0 0" }}>
          The shell carries other versions; the build gets the shell&apos;s. It builds only if the package uses nothing
          they lack: try a shell its versions match.
        </p>
      )}
    </section>
  );
}
