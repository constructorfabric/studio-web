import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  matchReason,
  type DeclaredCapability,
  type GearConfig,
  type GearboxStatus,
  type KitInstallation,
  type PlanRow,
  type KitMaterialization,
  type ProductChange,
  type ProductPreview,
  type ProjectProduct,
  type ProjectRepository,
  type StudioKit,
} from "./api";
import { When, useConfirm } from "./data-table";
import { errText } from "./format";
import {
  PRODUCT_PROFILES,
  defaultPicks,
  gearLabel,
  isPickable,
  productIdFrom,
  corpusErrors,
  groupDiagnostics,
} from "./product";
import { usePortalNav, type PortalNav } from "./portal-nav";
import { DesktopMissingHint, desktopLink, useDesktopLauncher } from "./open-in-desktop";

export function ProjectKits({
  token,
  projectId,
  projectName,
  workspaceId,
  section = "components",
}: {
  token: string;
  projectId: string;
  /** Names the product a picked set of gears is composed into. */
  projectName: string;
  /** The parent workspace — documents and the capability vocabulary hang off it. */
  workspaceId: string;
  /** Which tab this is: the specs-to-product journey, or the project's kits.
   *  One component, because both read the project's IDE repositories. */
  section?: "components" | "kits";
}) {
  const [catalog, setCatalog] = useState<StudioKit[] | null>(null);
  const [installed, setInstalled] = useState<KitInstallation[]>([]);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<ProjectRepository[] | null>(null);
  const [repositoriesNote, setRepositoriesNote] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [scopes, setScopes] = useState<Record<string, boolean>>({});
  // Slug@version pairs already reconciled on this mount, so a reload does not
  // re-run a rollout that has nothing left to do.
  const reconciled = useRef(new Set<string>());
  const product = useProjectProduct(token, projectId, projectName);
  /** How many capabilities the documents declare; null until they are read. */
  const [capCount, setCapCount] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    let current: KitInstallation[] = [];
    try {
      const [kits, installations] = await Promise.all([
        api.kits(token),
        api.kitInstallations(token, projectId),
      ]);
      current = installations.items;
      setCatalog(kits.items);
      setInstalled(current);
      setVersions((previous) => {
        const next = { ...previous };
        for (const kit of kits.items) {
          const existing = current.find((item) => item.kit_slug === kit.slug);
          if (!next[kit.slug]) next[kit.slug] = existing?.version ?? kit.default_version;
        }
        return next;
      });
    } catch (cause) {
      setError(errText(cause));
      setCatalog([]);
    }

    // Loaded apart from the catalogue, and its failure is not an error banner.
    // The repository list comes from the running IDE, so "no session yet" is
    // the ordinary state of this page -- folding it into the load above would
    // blank the kit grid every time someone opens the tab before the IDE.
    let mounted: ProjectRepository[] | null = null;
    try {
      mounted = (await api.projectRepositories(token, projectId)).items;
      setRepositories(mounted);
      setRepositoriesNote(null);
    } catch (cause) {
      setRepositories(null);
      setRepositoriesNote(errText(cause));
    }

    /*
     * The automatic half of "install in every repository".
     *
     * A kit scoped that way is meant to reach a repository that joined the
     * project after it was installed, and a running session is the only moment
     * the portal can see that such a repository exists. The call is idempotent
     * -- the backend skips repositories already at this version -- and it is
     * keyed by slug@version here so a reload does not keep asking.
     */
    if (!mounted) return;
    const pending = current.filter(
      (installation) =>
        installation.scope === "all-repositories" &&
        installation.status !== "installing" &&
        !reconciled.current.has(`${installation.kit_slug}@${installation.version}`),
    );
    if (pending.length === 0) return;
    for (const installation of pending) {
      reconciled.current.add(`${installation.kit_slug}@${installation.version}`);
      try {
        await api.reconcileKitInstallation(token, projectId, installation.kit_slug);
      } catch {
        // Per-repository outcomes are recorded on the rows either way; the
        // refresh below is what surfaces them.
      }
    }
    try {
      setInstalled((await api.kitInstallations(token, projectId)).items);
    } catch {
      // Keep what is on screen rather than blanking it over a refresh.
    }
  }, [projectId, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const bySlug = useMemo(
    () => new Map(installed.map((installation) => [installation.kit_slug, installation])),
    [installed],
  );

  /*
   * Where a kit lands, most specific first: what the user picked, then the
   * repository this kit was last materialized into (so "Reinstall / update"
   * does not silently move it), then the project repository.
   *
   * Undefined is a valid answer -- with no session the list is unknown, the
   * request goes out without `repository_id`, and the IDE resolves the project
   * repository itself. That is the same call this page made before the picker
   * existed.
   */
  const defaultRepositoryId = useMemo(
    () =>
      repositories?.find((repository) => repository.kind === "project")?.repository_id ??
      repositories?.[0]?.repository_id,
    [repositories],
  );

  const targetFor = (slug: string): string | undefined =>
    targets[slug] ?? bySlug.get(slug)?.repository_id ?? defaultRepositoryId;

  const everyRepository = (slug: string): boolean =>
    scopes[slug] ?? bySlug.get(slug)?.scope === "all-repositories";

  /*
   * The label recorded at materialization time wins: it is what the repository
   * was called when the kit landed there, and it stays readable after the IDE
   * is closed. The live list only fills gaps -- rows upgraded from a
   * pre-materializations document have no label of their own.
   */
  const repositoryLabel = (entry: KitMaterialization): string => {
    const mounted = repositories?.find(
      (repository) => repository.repository_id === entry.repository_id,
    );
    const name = entry.repository_label ?? mounted?.label ?? entry.repository_id;
    return mounted?.kind === "project" ? `${name} · whole project` : name;
  };

  const install = async (kit: StudioKit) => {
    const version = (versions[kit.slug] ?? kit.default_version).trim();
    if (!version) return;
    setBusy(kit.slug);
    setError(null);
    try {
      const scope = everyRepository(kit.slug) ? "all-repositories" : "project";
      await api.requestKitInstallation(token, projectId, {
        kit_slug: kit.slug,
        version,
        install_mode: "copy",
        scope,
      });
      if (scope === "all-repositories") {
        // One call covers every repository, so there is no target to choose
        // and no point materializing one of them first.
        reconciled.current.add(`${kit.slug}@${version}`);
        await api.reconcileKitInstallation(token, projectId, kit.slug);
      } else {
        await api.materializeKitInstallation(token, projectId, kit.slug, targetFor(kit.slug));
      }
      await reload();
    } catch (cause) {
      await reload();
      setError(errText(cause));
    } finally {
      setBusy(null);
    }
  };

  const [ask, confirmDialog] = useConfirm();
  /** Asks first (docs/list-standard.md); a failure keeps the dialog open. */
  const remove = (kit: StudioKit) =>
    ask(
      {
        title: `Remove ${kit.name || kit.slug} from this project?`,
        body: "The installation record goes. Files it already wrote into the repositories stay until they are removed there.",
        confirmLabel: "Remove",
      },
      async () => {
        setBusy(kit.slug);
        try {
          await api.removeKitInstallation(token, projectId, kit.slug);
          await reload();
        } finally {
          setBusy(null);
        }
      },
    );

  return (
    <section className="kits-view">
      {/* The page reads as the question a person brings to it: what do my
          documents ask for, which components answer that, and what product do
          they make -- ending in the IDE, where the product is built. It used to
          open on the product and leave the documents' suggestions behind a
          button further down, which is the answer before the question. */}
      {section === "components" && (
        <>
      <JourneyStrip capabilities={capCount} product={product} />
      {product.gearbox && !product.gearbox.enabled && (
        <p className="hint" style={{ fontSize: 12 }}>
          Composing a product from gears needs the Gearbox engine, which is off in this deployment
          {product.gearbox.problem ? ` (${product.gearbox.problem})` : ""}.
        </p>
      )}
      <SuggestedComponents
        token={token}
        projectId={projectId}
        workspaceId={workspaceId}
        product={product}
        onCapabilities={setCapCount}
      />
      {product.composing && (
        <ProductCard token={token} projectId={projectId} projectName={projectName} product={product} />
      )}
      <SpecAgainstCode token={token} projectId={projectId} workspaceId={workspaceId} />
        </>
      )}
      {section === "kits" && (
        <>

      <div className="card-head">
        <div>
          <h2>Project kits</h2>
          <p className="subtitle">
            Reusable Studio workflows and conventions, pinned to a Git version for this project.
          </p>
        </div>
        <button className="ghost" onClick={() => void reload()} disabled={busy !== null}>
          Refresh
        </button>
      </div>

      <div className="notice">
        Open this project's IDE first. Install requests are sent through the authenticated backend
        to its trusted <code>cfs</code> runner; the browser never executes repository scripts.
      </div>
      {repositoriesNote && (
        <div className="notice">
          The IDE has not reported its repositories yet, so a kit will be installed into the
          project repository. Open the IDE and press Refresh to choose a different one.
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {catalog === null ? (
        <p className="empty">Loading kit registry…</p>
      ) : catalog.length === 0 ? (
        <p className="empty">No kits are published in this registry.</p>
      ) : (
        <div className="kit-grid">
          {catalog.map((kit) => {
            const installation = bySlug.get(kit.slug);
            const isBusy = busy === kit.slug;
            return (
              <article className="card kit-card" key={kit.slug}>
                <div className="kit-card-head">
                  <div>
                    <span className="badge info">{kit.publisher}</span>
                    <h3>{kit.name}</h3>
                  </div>
                  {installation && (
                    <span className={`badge ${installation.status}`}>{installation.status}</span>
                  )}
                </div>
                <p>{kit.description}</p>
                <p className="sub">
                  <a href={kit.repository_url} target="_blank" rel="noreferrer">
                    {kit.repository_url} ↗
                  </a>
                  <br />Manifest: <code>{kit.manifest_path}</code>
                </p>
                <div className="kit-controls">
                  <label>
                    Version / Git ref
                    <input
                      value={versions[kit.slug] ?? kit.default_version}
                      onChange={(event) =>
                        setVersions((current) => ({ ...current, [kit.slug]: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Source policy
                    <input value="Official GitHub kit · managed copy" disabled />
                  </label>
                  {repositories && repositories.length > 1 && (
                    <label className="kit-scope">
                      <input
                        type="checkbox"
                        checked={everyRepository(kit.slug)}
                        onChange={(event) =>
                          setScopes((current) => ({
                            ...current,
                            [kit.slug]: event.target.checked,
                          }))
                        }
                      />
                      Install in every repository
                    </label>
                  )}
                  {repositories && repositories.length > 1 && !everyRepository(kit.slug) && (
                    <label>
                      Repository
                      <select
                        value={targetFor(kit.slug) ?? ""}
                        onChange={(event) =>
                          setTargets((current) => ({ ...current, [kit.slug]: event.target.value }))
                        }
                      >
                        {repositories.map((repository) => (
                          <option key={repository.repository_id} value={repository.repository_id}>
                            {repository.kind === "project"
                              ? `${repository.label} · whole project`
                              : repository.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                {installation && (
                  <p className="sub">
                    Requested <code>{installation.version}</code> · {installation.install_mode} ·{" "}
                    <When iso={installation.requested_at} />
                  </p>
                )}
                {installation && installation.materializations?.length ? (
                  <ul className="sub kit-materializations">
                    {installation.materializations.map((entry) => (
                      <li key={entry.repository_id}>
                        {repositoryLabel(entry)} · <code>{entry.version}</code> ·{" "}
                        <When iso={entry.materialized_at} />
                        {entry.status === "failed" && (
                          <span className="badge failed"> failed</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {installation?.failure_reason && (
                  <div className="error">{installation.failure_reason}</div>
                )}
                <div className="inline kit-actions">
                  <button className="primary" disabled={isBusy} onClick={() => void install(kit)}>
                    {isBusy ? "Installing…" : installation ? "Reinstall / update" : "Install in IDE"}
                  </button>
                  {installation && (
                    <button className="ghost" disabled={isBusy} onClick={() => remove(kit)}>
                      Remove
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
        </>
      )}
      {confirmDialog}
    </section>
  );
}

/*
 * What this project could be built from, read off its own documents.
 *
 * The question — "из каких компонентов, которые мы знаем в нашей системе, можно
 * построить этот продукт" — is the Components tab's question, and until now it
 * could only be asked from the other end: open one PRD, press Compose, get
 * a modal. That reads one document; a project is a stack of them.
 *
 * Two things it deliberately does NOT do. It does not load on mount: the
 * catalogue and its profiles are a few hundred kilobytes, and a tab that opens
 * to install a kit should not pay for them. And it does not hide a candidate
 * that was never built -- it labels it and sorts it last (see compose.ts). A
 * design may legitimately name a component that is still only a design; what
 * would be wrong is answering "build it from these" with a directory of docs.
 */
/** Do the specs and the code agree? Per declared capability, whether the
 *  code depends on a component that fills it; the components the code uses
 *  that no capability accounts for; and the Gearbox engine's view of the
 *  code's own gears. */
function SpecAgainstCode({ token, projectId, workspaceId }: { token: string; projectId: string; workspaceId: string }) {
  const [report, setReport] = useState<import("./api").Conformance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = usePortalNav();
  const compare = async () => {
    setBusy(true);
    setError(null);
    try {
      const [declared, vocab] = await Promise.all([
        api.declaredCapabilities(token, projectId),
        api.capabilities(token, workspaceId),
      ]);
      setReport(await api.conformance(token, projectId, declared.items.map((c) => c.key), vocab.items ?? []));
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setBusy(false);
    }
  };
  const missing = report?.items.filter((r) => r.status === "missing").length ?? 0;
  return (
    <div className="card" style={{ marginTop: 12 }} data-spec-against-code>
      <div className="card-head">
        <div>
          <h2>Specs ↔ code</h2>
          <p className="subtitle">
            What the project&apos;s documents declare, against what its code depends on — read from every
            Cargo.toml in the gear repository.
          </p>
        </div>
        <button className="ghost" disabled={busy} onClick={() => void compare()}>
          {busy ? "Comparing…" : "Compare"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {report && (
        <div style={{ fontSize: 12 }}>
          <p style={{ margin: "0 0 8px", opacity: 0.8 }}>
            <code>{report.repo}</code> uses {report.components_in_code.length} catalogue components ·{" "}
            {report.total - missing} of {report.total} declared capabilities implemented
            {missing > 0 ? ` · ${missing} missing` : ""}
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {report.items.map((r) => (
              <li key={r.capability} style={{ margin: "0 0 4px" }}>
                <span className={`badge ${r.status === "implemented" ? "ok" : "failed"}`}>{r.capability}</span>{" "}
                {r.status === "implemented" ? (
                  r.implemented_by.map((i, n) => (
                    <span key={i.name}>
                      {n > 0 && ", "}
                      <ComponentLink nav={nav} name={i.name} />
                      {i.declared ? "" : <span style={{ opacity: 0.5 }} title="matched by words, not declared"> ~</span>}
                    </span>
                  ))
                ) : (
                  <span style={{ opacity: 0.8 }}>
                    nothing in the code fills it
                    {r.candidates.length > 0 && <> · the catalogue has {r.candidates.map(gearLabel).join(", ")}</>}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {report.unexplained.length > 0 && (
            <p style={{ margin: "8px 0 0" }}>
              <b>In the code, not in the specs:</b>{" "}
              {report.unexplained.map((u, n) => (
                <span key={u.name}>
                  {n > 0 && ", "}
                  <ComponentLink nav={nav} name={u.name} />
                  {u.declares.length > 0 && <span style={{ opacity: 0.6 }}> ({u.declares.join(", ")})</span>}
                </span>
              ))}
              <span style={{ opacity: 0.7 }}> — a capability the specs do not declare, or a dependency to drop.</span>
            </p>
          )}
          {report.gearbox.length > 0 && (
            <div style={{ margin: "8px 0 0" }}>
              <b>Gearbox on the code&apos;s own gears:</b>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {report.gearbox.map((g) => (
                  <li key={`${g.gear}-${g.reason}`}>
                    {g.added ? "needs " : "cannot run: "}
                    <ComponentLink nav={nav} name={g.gear} /> — {g.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SuggestedComponents({
  token,
  projectId,
  workspaceId,
  product,
  onCapabilities,
}: {
  token: string;
  projectId: string;
  workspaceId: string;
  product: ProductState;
  onCapabilities?: (count: number) => void;
}) {
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  /** Which documents declare each capability, to say where a row comes from. */
  const [sources, setSources] = useState<Record<string, DeclaredCapability["sources"]>>({});
  const [docCount, setDocCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = usePortalNav();

  const suggest = async () => {
    setBusy(true);
    setError(null);
    try {
      // The catalogue and the profiles are read by the server now, which is
      // also where the matching rules live. What still travels from here is the
      // workspace's own capability vocabulary.
      const [declared, vocab] = await Promise.all([
        api.declaredCapabilities(token, projectId),
        api.capabilities(token, workspaceId),
      ]);
      // Every capability the project's documents declare, in the order first
      // met -- Studio's own documents and the repository files bound to a type
      // alike. The server indexes these from front matter, so this is a read.
      const caps = declared.items.map((c) => c.key);
      setSources(Object.fromEntries(declared.items.map((c) => [c.key, c.sources])));
      onCapabilities?.(caps.length);
      setDocCount(new Set(declared.items.flatMap((c) => c.sources.map((s) => s.id))).size);
      const next = (await api.composePlan(token, caps, vocab.items ?? [])).items;
      setPlan(next);
      // A product nobody has picked for yet starts from the best built gear
      // per capability. One that has picks keeps them: suggestions are a
      // source of candidates, not the product.
      if (product.composing && product.loaded && product.picks.length === 0) {
        void product.seed(defaultPicks(next));
      }
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setBusy(false);
    }
  };

  // Read on arrival: the documents are the question this page answers, so it
  // should not wait for a button to ask it.
  useEffect(() => {
    void suggest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const recommended = plan ? defaultPicks(plan).filter((n) => !product.picks.includes(n)) : [];
  const built = plan?.flatMap((r) => r.candidates).filter((c) => c.built !== "docs-only").length ?? 0;
  const gaps = plan?.filter((r) => r.gap).length ?? 0;
  const unbuilt = plan?.filter((r) => r.unbuilt).length ?? 0;
  const composing = product.composing;

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>1 · What your specs ask for</h2>
          <p className="subtitle">
            The capabilities this project&apos;s documents declare, and the components in the
            catalogue that provide each. Built components come first.
            {composing && " + puts one into the product below; a name opens its page in the catalogue."}
          </p>
        </div>
        <span style={{ display: "flex", gap: 6 }}>
          {composing && recommended.length > 0 && (
            <button
              className="primary"
              disabled={busy}
              title={`The best built component for each capability: ${recommended.join(", ")}`}
              onClick={() => product.setPicks((current) => [...current, ...recommended.filter((n) => !current.includes(n))])}
            >
              Add recommended ({recommended.length})
            </button>
          )}
          <button className="ghost" onClick={() => void suggest()} disabled={busy}>
            {busy ? "Matching…" : "Refresh"}
          </button>
        </span>
      </div>

      {error && <div className="error">{error}</div>}

      {plan !== null &&
        (plan.length === 0 ? (
          <p className="empty" style={{ fontSize: 13 }}>
            {docCount === 0
              ? "No document in this project declares a capability yet. Fill a PRD's questionnaire, or put `capabilities: auth, storage` in the front matter of a PRD in the repository and confirm it on the Specs tab — this reads them from there."
              : "The documents declare no capabilities to match."}
          </p>
        ) : (
          <>
            <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 12px" }}>
              {plan.length} capabilit{plan.length === 1 ? "y" : "ies"} from {docCount} document
              {docCount === 1 ? "" : "s"} · {built} built candidate{built === 1 ? "" : "s"} ·{" "}
              {unbuilt} with nothing built yet · {gaps} with nothing at all.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {plan.map((row) => (
                <div
                  key={row.capability}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 10px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <code style={{ fontSize: 12, fontWeight: 700 }}>{row.capability}</code>
                    {(sources[row.capability] ?? []).length > 0 && (
                      <span style={{ fontSize: 11, opacity: 0.65 }} title="The documents that declare it">
                        from {(sources[row.capability] ?? []).map((src) => src.label).join(", ")}
                      </span>
                    )}
                    {row.gap && (
                      <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.75 }}>
                        NOTHING IN THE CATALOGUE
                      </span>
                    )}
                    {row.unbuilt && (
                      <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.75 }}>
                        NOTHING BUILT YET
                      </span>
                    )}
                  </div>
                  {row.candidates.length > 0 && (
                    <div
                      style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}
                    >
                      {row.candidates.map((c) => {
                        const pickable = composing && isPickable(c);
                        const picked = pickable && product.picks.includes(c.name);
                        return (
                          <span
                            key={c.name}
                            title={
                              matchReason(c) +
                              (c.built === "docs-only"
                                ? " · the catalogue found no crate under this component — docs and a manifest only"
                                : "")
                            }
                            style={{
                              ...chipStyle(picked),
                              opacity: c.built === "docs-only" ? 0.6 : 1,
                            }}
                          >
                            {pickable && (
                              <button
                                type="button"
                                aria-pressed={picked}
                                title={picked ? "In the product — click to take it out" : "Put it into the product"}
                                onClick={() => product.toggle(c.name)}
                                style={chipToggleStyle}
                              >
                                {picked ? "✓" : "+"}
                              </button>
                            )}
                            <ComponentLink nav={nav} name={c.name} />
                            <span style={{ opacity: 0.6, marginLeft: 5 }}>{c.kind}</span>
                            {c.step === "contract" ? (
                              <span title={matchReason(c)} style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, color: "var(--success, var(--primary))" }}>
                                CONTRACT
                              </span>
                            ) : c.declared ? (
                              <span title="The gear declares this capability itself" style={{ marginLeft: 5, fontSize: 9, fontWeight: 700 }}>
                                DECLARED
                              </span>
                            ) : (
                              <span title={matchReason(c)} style={{ marginLeft: 5, fontSize: 9, opacity: 0.55 }}>
                                by words
                              </span>
                            )}
                            {c.composable === "runs" && (
                              <span title="Described for composition: the Gearbox engine can put it into a product" style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, color: "var(--success, var(--primary))" }}>
                                GDL
                              </span>
                            )}
                            {c.composable === "blocked" && (
                              <span title={`Described, but cannot run from this corpus: ${c.composable_why ?? ""}`} style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, color: "var(--danger, #c33)" }}>
                                BLOCKED
                              </span>
                            )}
                            {c.built === "docs-only" && (
                              <span style={{ marginLeft: 5, fontWeight: 700 }}>docs only</span>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        ))}
    </section>
  );
}

/* ── The project's product ────────────────────────────────────────────────── */

type ProductState = {
  /** The engine's status; null while loading or when the call failed. */
  gearbox: GearboxStatus | null;
  /** Whether previews run here at all. */
  composing: boolean;
  /** The saved record has been read, so picks can be written back. */
  loaded: boolean;
  record: ProjectProduct | null;
  picks: string[];
  setPicks: (update: (current: string[]) => string[]) => void;
  toggle: (name: string) => void;
  /** How the product configures its gears, kept and written with the picks. */
  config: GearConfig;
  /** Set one field of one gear; `undefined` removes it. */
  setField: (gear: string, field: string, value: unknown) => void;
  profile: string;
  setProfile: (profile: string) => void;
  /** Re-read the record, after a preview wrote its verdict into it. */
  refresh: () => Promise<void>;
  /** What completion last changed, with its reasons; empty when nothing did. */
  adjustments: ProductChange[];
  /** Bumped whenever completion replaces the picks, so a preview can follow. */
  completedAt: number;
  /** Start the product from these picks, completed into a set that resolves. */
  seed: (picks: string[]) => Promise<void>;
  /** Complete the current picks. */
  complete: () => Promise<void>;
  saveError: string | null;
};

/** The project's product as the server keeps it: read on mount, and written
 *  back as picks and profile change, so leaving the tab keeps what was chosen
 *  and every screen that asks sees the same product. */
function useProjectProduct(token: string, projectId: string, projectName: string): ProductState {
  const [gearbox, setGearbox] = useState<GearboxStatus | null>(null);
  const [record, setRecord] = useState<ProjectProduct | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [picks, setPicksState] = useState<string[]>([]);
  const [config, setConfigState] = useState<GearConfig>({});
  const [profile, setProfileState] = useState("dev");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [adjustments, setAdjustments] = useState<ProductChange[]>([]);
  const [completedAt, setCompletedAt] = useState(0);
  // Set by the person's changes and cleared by a write, so what was just
  // read from the server is never written straight back.
  const dirty = useRef(false);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    void Promise.all([
      api.gearboxStatus(token).catch(() => null),
      api.projectProduct(token, projectId).catch(() => null),
    ]).then(([engine, saved]) => {
      if (!live) return;
      setGearbox(engine);
      setRecord(saved);
      setPicksState(saved?.gears ?? []);
      setConfigState(saved?.config ?? {});
      setProfileState(saved?.profile ?? "dev");
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [token, projectId]);

  useEffect(() => {
    if (!loaded || !dirty.current) return;
    const timer = setTimeout(() => {
      dirty.current = false;
      api
        .saveProjectProduct(token, projectId, {
          product_id: productIdFrom(projectName),
          name: projectName,
          gears: picks,
          profile,
          config,
        })
        .then((saved) => {
          setRecord(saved.value);
          setSaveError(null);
        })
        .catch((cause) => setSaveError(errText(cause)));
    }, 400);
    return () => clearTimeout(timer);
  }, [picks, profile, config, loaded, token, projectId, projectName]);

  const setPicks = useCallback((update: (current: string[]) => string[]) => {
    dirty.current = true;
    setPicksState(update);
  }, []);

  // Completion is advice the person can undo: it replaces the picks, keeps
  // its reasons on screen, and if the engine is unreachable the picks stand.
  const completeInto = async (start: string[]) => {
    try {
      const done = await api.completeProduct(token, start, config);
      setAdjustments(done.changes);
      dirty.current = true;
      setConfigState(done.config ?? {});
      setPicks(() => done.gears);
      setCompletedAt(Date.now());
    } catch (cause) {
      setSaveError(errText(cause));
      setPicks(() => start);
    }
  };

  return {
    gearbox,
    composing: gearbox?.enabled === true,
    loaded,
    record,
    picks,
    setPicks,
    toggle: (name) => {
      // A gear taken out takes its configuration with it.
      if (picks.includes(name) && config[name]) {
        setConfigState((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
      }
      setPicks((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name]));
    },
    config,
    setField: (gear, field, value) => {
      dirty.current = true;
      setConfigState((current) => {
        const fields = { ...(current[gear] ?? {}) };
        if (value === undefined) delete fields[field];
        else fields[field] = value;
        const next = { ...current };
        if (Object.keys(fields).length === 0) delete next[gear];
        else next[gear] = fields;
        return next;
      });
    },
    profile,
    setProfile: (next) => {
      dirty.current = true;
      setProfileState(next);
    },
    refresh: async () => {
      const saved = await api.projectProduct(token, projectId).catch(() => null);
      if (saved) setRecord(saved);
    },
    saveError,
    adjustments,
    completedAt,
    seed: (start) => completeInto(start),
    complete: () => completeInto(picks),
  };
}

const chipStyle = (picked: boolean) =>
  ({
    fontSize: 11,
    display: "inline-flex",
    alignItems: "center",
    border: picked ? "1px solid var(--primary)" : "1px solid var(--border)",
    background: picked ? "var(--accent)" : "transparent",
    borderRadius: 999,
    padding: "2px 8px",
  }) as const;

const chipToggleStyle = {
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  padding: "0 4px 0 0",
  font: "inherit",
  fontWeight: 700,
} as const;

/** What a person typed, as the JSON value it means: `true`/`false`, a
 *  number, or else the text itself. */
function configValue(text: string): unknown {
  const t = text.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return text;
}

/** The product's configuration of its gears: each field it sets, editable
 *  and removable, and a way to set one more. What `Make it resolve` sets
 *  (a plugin's vendor aligned with its host's) lands here too. */
function GearConfigEditor({ product }: { product: ProductState }) {
  const [gear, setGear] = useState("");
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const rows = Object.entries(product.config).flatMap(([g, fields]) =>
    Object.entries(fields).map(([f, v]) => ({ g, f, v })),
  );
  if (product.picks.length === 0) return null;
  return (
    <div style={{ fontSize: 12, marginTop: 8 }} data-gear-config>
      <div style={{ opacity: 0.7, marginBottom: 4 }}>Configuration</div>
      {rows.length === 0 && (
        <div style={{ opacity: 0.6 }}>No gear is configured; each runs with its defaults.</div>
      )}
      {rows.map(({ g, f, v }) => (
        <div key={`${g}.${f}`} style={{ display: "flex", gap: 6, alignItems: "center", margin: "2px 0" }}>
          <code>{gearLabel(g)}</code>
          <span style={{ opacity: 0.6 }}>·</span>
          <code>{f}</code>
          <span>=</span>
          <input
            aria-label={`${g} ${f}`}
            defaultValue={typeof v === "string" ? v : JSON.stringify(v)}
            onBlur={(e) => product.setField(g, f, configValue(e.target.value))}
            style={{ fontSize: 12, width: 180 }}
          />
          <button
            type="button"
            className="ghost"
            title="Remove this setting"
            aria-label={`Remove ${g} ${f}`}
            onClick={() => product.setField(g, f, undefined)}
          >
            ×
          </button>
        </div>
      ))}
      <form
        style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!gear || !field.trim()) return;
          product.setField(gear, field.trim(), configValue(value));
          setField("");
          setValue("");
        }}
      >
        <select value={gear} onChange={(e) => setGear(e.target.value)} aria-label="Gear to configure" style={{ fontSize: 12 }}>
          <option value="">gear…</option>
          {product.picks.map((p) => (
            <option key={p} value={p}>
              {gearLabel(p)}
            </option>
          ))}
        </select>
        <input placeholder="field" value={field} onChange={(e) => setField(e.target.value)} style={{ fontSize: 12, width: 120 }} />
        <input placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} style={{ fontSize: 12, width: 160 }} />
        <button type="submit" className="ghost" disabled={!gear || !field.trim()}>
          Set
        </button>
      </form>
    </div>
  );
}

/** A component's name that opens its page in the platform catalogue. */
function ComponentLink({ nav, name, label }: { nav: PortalNav | null; name: string; label?: string }) {
  const text = label ?? gearLabel(name);
  if (!nav) return <b>{text}</b>;
  return (
    <button
      type="button"
      className="link"
      title={`Open ${name} in the component catalogue`}
      onClick={() => nav.openComponent(name)}
      style={{ border: "none", background: "transparent", padding: 0, font: "inherit", fontWeight: 700, color: "var(--primary)", cursor: "pointer" }}
    >
      {text}
    </button>
  );
}

/** The product this project is made of: the gears in it, each leading to its
 *  catalogue page; the engine's verdict on them; and the two ways onward — into
 *  the project's repository, and into the IDE where the language server keeps
 *  checking it. */
/** Where the person is in the page's three steps, at a glance. */
function JourneyStrip({ capabilities, product }: { capabilities: number | null; product: ProductState }) {
  const last = product.record?.last_preview;
  const steps: { n: number; label: string; state: string; done: boolean }[] = [
    {
      n: 1,
      label: "Your specs ask for",
      state: capabilities == null ? "reading…" : `${capabilities} capabilit${capabilities === 1 ? "y" : "ies"}`,
      done: (capabilities ?? 0) > 0,
    },
    {
      n: 2,
      label: "Your product",
      state:
        product.picks.length === 0
          ? "no components yet"
          : `${product.picks.length} component${product.picks.length === 1 ? "" : "s"}` +
            (last ? (last.ok ? " · resolves" : " · does not resolve") : ""),
      done: !!last?.ok,
    },
    {
      n: 3,
      label: "Built in Studio-ide",
      state: product.record?.written ? `product.gdl on ${product.record.written.branch}` : "not yet",
      done: !!product.record?.written,
    },
  ];
  return (
    <ol className="journey-strip" style={{ display: "flex", gap: 8, listStyle: "none", padding: 0, margin: "0 0 12px", flexWrap: "wrap" }}>
      {steps.map((st) => (
        <li
          key={st.n}
          style={{
            flex: "1 1 200px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12,
            background: st.done ? "var(--accent)" : "transparent",
          }}
        >
          <b>
            {st.done ? "✓" : st.n} · {st.label}
          </b>
          <div style={{ opacity: 0.7 }}>{st.state}</div>
        </li>
      ))}
    </ol>
  );
}

function ProductCard({
  token,
  projectId,
  projectName,
  product,
}: {
  token: string;
  projectId: string;
  projectName: string;
  product: ProductState;
}) {
  const nav = usePortalNav();
  const { gearbox, picks, profile, record } = product;
  const [asPr, setAsPr] = useState(false);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProductPreview | null>(null);
  // A product project owns the repository its wizard created, so saving goes
  // onto the base branch the IDE opens. Any other project's gear repo may be
  // shared, and gets a `product/…` branch instead.
  const [ownsRepo, setOwnsRepo] = useState(false);
  useEffect(() => {
    api
      .projectConfig(token, projectId)
      .then((c) => setOwnsRepo(c?.kind === "product"))
      .catch(() => setOwnsRepo(false));
  }, [token, projectId]);
  // The picks and profile the shown preview answers. Anything else and the
  // preview is about a different product, which the screen has to say.
  const [asked, setAsked] = useState<string | null>(null);
  const question = JSON.stringify([profile, [...picks].sort()]);
  const stale = preview !== null && asked !== question;
  const productId = productIdFrom(projectName);
  // The crate behind an engine id, for linking a resolved gear to its page.
  const crateOf = (id: string) => preview?.gears.find((g) => g.id === id)?.crate_name ?? `cf-gears-${id}`;

  const run = async (write: boolean): Promise<ProductPreview | null> => {
    setBusy(write ? "save" : "preview");
    setError(null);
    try {
      const result = await api.previewProduct(token, projectId, {
        product_id: productId,
        name: projectName,
        gears: picks,
        profile,
        config: product.config,
        ...(write ? { write: true, open_pr: asPr, onto_base: ownsRepo } : {}),
      });
      setPreview(result);
      setAsked(question);
      await product.refresh();
      return result;
    } catch (cause) {
      setError(errText(cause));
      return null;
    } finally {
      setBusy(null);
    }
  };

  /** The last step of the page, and the first of the desktop's: the product's
   *  description saved to the project's repository, then the desktop Studio
   *  opened on the project -- it clones the sources and opens product.gdl in
   *  the Gearbox perspective, bringing in the branch it was saved on. A web
   *  session cannot take this on: Gearbox is the desktop's. A product already
   *  saved and unchanged is opened as it is. */
  const desktop = useDesktopLauncher();
  const openOnDesktop = (branch: string | undefined) =>
    desktop.launch(
      desktopLink({ id: projectId, name: projectName, product: record?.written?.path ?? "product.gdl", branch }),
    );
  const buildInTheia = async () => {
    let branch = record?.written?.branch;
    if (!branch || stale || !preview) {
      const saved = await run(true);
      if (!saved?.written) return;
      branch = saved.written.branch;
    }
    openOnDesktop(branch);
  };

  // Completion replaced the picks: show at once what the engine makes of them.
  useEffect(() => {
    if (product.completedAt > 0 && picks.length > 0) void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.completedAt]);

  const errors = preview?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
  const warnings = preview?.diagnostics.filter((d) => d.severity === "warning").length ?? 0;
  const last = record?.last_preview;

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>
            2 · Your product <code style={{ fontSize: 13, fontWeight: 500 }}>{productId}</code>
          </h2>
          <p className="subtitle">
            The components this project ships as one product, composed and checked by the Gearbox
            engine. Make it resolve, then build it in Studio-ide: that saves <code>product.gdl</code> to
            the repository and opens the desktop Studio on it, in its Gearbox view.
          </p>
        </div>
        <span className="hint" style={{ fontSize: 11 }}>
          {gearbox?.engine_version ?? "gearbox"} · {gearbox?.corpus_ref}
          {gearbox?.corpus_commit ? `@${gearbox.corpus_commit.slice(0, 7)}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {picks.length === 0 ? (
          <span className="empty" style={{ fontSize: 12 }}>
            Nothing in the product yet — add the recommended components above, or pick them with +.
          </span>
        ) : (
          picks.map((name) => (
            <span key={name} style={chipStyle(true)}>
              <ComponentLink nav={nav} name={name} />
              <button
                type="button"
                title="Take it out of the product"
                aria-label={`Remove ${name}`}
                onClick={() => product.toggle(name)}
                style={{ ...chipToggleStyle, padding: "0 0 0 6px", opacity: 0.6 }}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      <GearConfigEditor product={product} />
      {product.adjustments.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 8 }}>
          <div style={{ opacity: 0.7 }}>Adjusted so the product can resolve — each can be undone:</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {product.adjustments.map((c) => (
              <li key={`${c.gear}-${c.added}-${c.reason}`}>
                <b>{c.added ? "+" : "−"}</b> <ComponentLink nav={nav} name={c.gear} />
                <span style={{ opacity: 0.75 }}> — {c.reason}</span>
                {!c.added && !picks.includes(c.gear) && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => product.setPicks((current) => [...current, c.gear])}
                    style={{ border: "none", background: "transparent", color: "var(--primary)", cursor: "pointer", fontSize: 12 }}
                  >
                    put back
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {product.saveError && <div className="error">Not saved: {product.saveError}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
        <select value={profile} onChange={(e) => product.setProfile(e.target.value)} aria-label="Deployment profile">
          {PRODUCT_PROFILES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button className="primary" disabled={busy !== null || picks.length === 0} onClick={() => void run(false)}>
          {busy === "preview" ? "Resolving…" : "Preview product"}
        </button>
        <button
          className="ghost"
          disabled={busy !== null || picks.length === 0}
          title="Take out what the catalogue shows cannot run, add the plugins and hosts that are missing, then preview"
          onClick={() => void product.complete()}
        >
          Make it resolve
        </button>
        <button
          className="primary"
          disabled={busy !== null || picks.length === 0}
          title="Save product.gdl to the repository and open the desktop Studio on it: it clones the project and opens the product in the Gearbox view"
          onClick={() => void buildInTheia()}
          style={{ marginLeft: "auto" }}
        >
          {busy === "save" ? "Saving…" : "Build it in Studio-ide →"}
        </button>
        {desktop.missing && <DesktopMissingHint />}
        {!preview && last && (
          <span style={{ fontSize: 12 }}>
            <span className={`badge ${last.ok ? "ok" : "failed"}`}>
              {last.ok ? `resolved for ${last.profile}` : `did not resolve for ${last.profile}`}
            </span>{" "}
            <span style={{ opacity: 0.7 }}>
              {last.errors} error{last.errors === 1 ? "" : "s"} · {last.warnings} warning
              {last.warnings === 1 ? "" : "s"}
              {last.applications.length > 0 ? ` · ${last.applications.join(", ")}` : ""}
              {record?.updated_at ? ` · ${new Date(record.updated_at).toLocaleString()}` : ""}
            </span>
          </span>
        )}
      </div>
      {error && <div className="error">{error}</div>}

      {preview && (
        <div style={{ marginTop: 10, opacity: stale ? 0.55 : 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className={`badge ${preview.ok ? "ok" : "failed"}`}>
              {preview.ok ? `resolves for ${preview.profile}` : `does not resolve for ${preview.profile}`}
            </span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              {errors} error{errors === 1 ? "" : "s"} · {warnings} warning{warnings === 1 ? "" : "s"}
            </span>
            {stale && <span className="badge warn">the product changed since — preview again</span>}
          </div>

          {(() => {
            const c = corpusErrors(preview.diagnostics);
            if (c.errors === 0) return null;
            return (
              <p className="error" style={{ fontSize: 12 }} data-corpus-errors>
                {c.errors === errors ? "Every error here is" : `${c.errors} of these errors are`} in the gear
                corpus&apos;s own descriptions ({c.files} <code>gear.gdl</code> file{c.files === 1 ? "" : "s"} in{" "}
                <code>{gearbox?.corpus_ref ?? "the corpus"}</code>), not in this product. The Gearbox engine (
                {gearbox?.engine_version ?? "its version"}) cannot read them, so the engine and the corpus disagree
                — nothing picked here can fix that; the deployment has to move the engine or pin the corpus.
              </p>
            );
          })()}

          {preview.not_described.length > 0 && (
            <p className="hint" style={{ fontSize: 12 }}>
              Left out, because no <code>gear.gdl</code> describes{" "}
              {preview.not_described.length === 1 ? "it" : "them"} yet:{" "}
              {preview.not_described.map((n, i) => (
                <span key={n}>
                  {i > 0 && ", "}
                  <ComponentLink nav={nav} name={n} />
                </span>
              ))}
              .
            </p>
          )}
          {preview.added.length > 0 && (
            <p className="hint" style={{ fontSize: 12 }}>
              Added: {preview.added.map((a) => `${a.id} (${a.reason})`).join(", ")}.
            </p>
          )}

          {preview.plugin_options.length > 0 && (
            <div style={{ fontSize: 12, margin: "8px 0" }}>
              {preview.plugin_options.map((o) => (
                <div key={o.host} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", margin: "0 0 4px" }}>
                  <span>
                    <b>{o.host}</b> needs a plugin:
                  </span>
                  {o.available.map((name) => (
                    <span key={name} style={chipStyle(picks.includes(name))}>
                      <button
                        type="button"
                        disabled={picks.includes(name)}
                        title="Put this plugin into the product, then preview again"
                        onClick={() => product.setPicks((current) => (current.includes(name) ? current : [...current, name]))}
                        style={chipToggleStyle}
                      >
                        {picks.includes(name) ? "✓" : "+"}
                      </button>
                      <ComponentLink nav={nav} name={name} />
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}

          {preview.diagnostics.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: "8px 0", fontSize: 12 }}>
              {groupDiagnostics(preview.diagnostics).map((d, i) => (
                <li key={`${d.code}-${i}`} style={{ margin: "0 0 6px" }}>
                  <span className={`badge ${d.severity === "error" ? "danger" : d.severity === "warning" ? "warn" : "info"}`}>
                    {d.code}
                  </span>{" "}
                  {d.message}
                  {d.profiles.length > 0 && <span style={{ opacity: 0.6 }}> · {d.profiles.join(", ")}</span>}
                  {d.file && (
                    <span style={{ opacity: 0.6 }}>
                      {" "}
                      — {d.file}
                      {d.line ? `:${d.line}` : ""}
                    </span>
                  )}
                  {d.help && <div style={{ opacity: 0.7, marginLeft: 8 }}>{d.help}</div>}
                </li>
              ))}
            </ul>
          )}

          {preview.applications.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "8px 0" }}>
              {preview.applications.map((a) => (
                <div
                  key={a.name}
                  style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 12 }}
                >
                  <b>{a.name}</b>
                  <span style={{ opacity: 0.6 }}>
                    {" "}
                    · {a.kind}
                    {a.replicas > 1 ? ` · ×${a.replicas}` : ""}
                    {a.listens.length > 0 ? ` · ${a.listens.map((l) => `${l.name} ${l.address}`).join(", ")}` : ""}
                  </span>
                  <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {a.gears.map((g) => {
                      const why = preview.gears.find((x) => x.id === g)?.reasons ?? [];
                      const pulled = why.length > 0 && !why.includes("selected");
                      return (
                        <span key={g} title={why.join("; ")} style={{ opacity: pulled ? 0.7 : 1 }}>
                          <ComponentLink nav={nav} name={crateOf(g)} label={g} />
                          {pulled && <span style={{ fontSize: 10 }}> ({why[0]})</span>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          <details style={{ margin: "8px 0" }}>
            <summary style={{ fontSize: 12, cursor: "pointer" }}>product.gdl</summary>
            <pre style={{ fontSize: 11, maxHeight: 320, overflow: "auto" }}>{preview.product_gdl}</pre>
          </details>
        </div>
      )}

      {(preview || record?.written) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
          {preview && (
            <>
              <button className="ghost" disabled={busy !== null || stale} onClick={() => void run(true)}>
                {busy === "save" ? "Saving…" : "Save product.gdl to the repository"}
              </button>
              <label style={{ fontSize: 12 }}>
                <input type="checkbox" checked={asPr} onChange={(e) => setAsPr(e.target.checked)} /> as a pull
                request
              </label>
            </>
          )}
          {record?.written && (
            <button
              className="ghost"
              title="Opens the desktop Studio on this project with the product in the Gearbox perspective: resolution, graph, lock and conflicts, and the GDL language checking the file as you edit"
              onClick={() => openOnDesktop(record.written?.branch)}
            >
              Open in Studio-ide
            </button>
          )}
        </div>
      )}
      {record?.written && (
        <p className="hint" style={{ fontSize: 12 }}>
          {record.written.pr_url ? (
            <>
              product.gdl is in a pull request:{" "}
              <a href={record.written.pr_url} target="_blank" rel="noreferrer">
                {record.written.pr_url}
              </a>
            </>
          ) : (
            <>
              product.gdl is committed on <code>{record.written.branch}</code> as{" "}
              <code>{record.written.commit_sha.slice(0, 7)}</code>.
            </>
          )}{" "}
          {ownsRepo
            ? "The IDE opens the repository's sources from the Sources tab; if the project repository is not there yet, add it there first."
            : "This project's gear repository may be shared, so the description went onto its own branch; the IDE shows it once that branch is merged or checked out."}
        </p>
      )}
    </section>
  );
}
