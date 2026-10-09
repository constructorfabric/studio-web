import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  matchReason,
  type Candidate,
  type DeclaredCapability,
  type GearConfig,
  type GearboxStatus,
  type KitInstallation,
  type PlanRow,
  type ProfileAdvice,
  type KitMaterialization,
  type Conformance,
  type ProductChange,
  type ProductPreview,
  type ProjectProduct,
  type ProjectRepository,
  type StudioKit,
} from "./api";
import { When, useConfirm } from "./data-table";
import { errText } from "./format";
import { GearConfigForm } from "./gear-config-form";
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
import { ScaffoldModal } from "./documents";
import { ProjectCandidate } from "./component-registry";
import {
  candidateReasons,
  candidateTier,
  tierReason,
  tierTag,
  candidateStrength,
  couldBecomeGear,
  coverageSummary,
  gearProblem,
  lookingFor,
  picksBeyondShortlist,
  rowCoverage,
  specReasons,
} from "./spec-coverage";
import { DesktopMissingHint, desktopLink, useDesktopLauncher } from "./open-in-desktop";
import {
  alsoCovers,
  applyFix,
  codeDiff,
  codeFor,
  codeGears,
  fixesFrom,
  nextStep,
  plainText,
  rowShortlist,
  type Fix,
  type NextAction,
  type NextStep,
} from "./components-flow";

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
  /** What section 1 found: capabilities asked, how many the product leaves
   *  open, and the recommended gears. */
  const [flow, setFlow] = useState<{ capabilities: number | null; open: number; recommended: string[] }>({
    capabilities: null,
    open: 0,
    recommended: [],
  });
  /** What the product card last heard from the engine. */
  const [verdict, setVerdict] = useState<{ resolves: boolean | null; fixes: number }>({ resolves: null, fixes: 0 });
  /** The next-step line asks the product card to act. */
  const [command, setCommand] = useState<{ kind: ProductCommand; at: number } | null>(null);
  const code = useCodeReport(token, projectId, workspaceId, section === "components");

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
      <NextStepBar
        step={nextStep({
          capabilities: flow.capabilities,
          open: flow.open,
          picks: product.picks.length,
          inCode: code.report ? codeGears(code.report).length : null,
          resolves: verdict.resolves,
          fixes: verdict.fixes,
          written: !!product.record?.written && verdict.resolves !== null,
          composing: product.composing,
        })}
        onAct={(action) => {
          if (action === "add-recommended") {
            product.setPicks((current) => [...current, ...flow.recommended.filter((n) => !current.includes(n))]);
          } else {
            setCommand({ kind: action, at: Date.now() });
          }
        }}
      />
      {product.gearbox && !product.gearbox.enabled && (
        <p className="hint" style={{ fontSize: 12 }}>
          Composing a product from gears needs the Gearbox engine, which is off in this deployment
          {product.gearbox.problem ? ` (${product.gearbox.problem})` : ""}.
        </p>
      )}
      <SuggestedComponents
        token={token}
        projectId={projectId}
        product={product}
        code={code}
        onFlow={setFlow}
      />
      {product.composing && (
        <ProductCard
          token={token}
          projectId={projectId}
          projectName={projectName}
          product={product}
          code={code}
          command={command}
          onVerdict={setVerdict}
        />
      )}
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
type ProductCommand = Exclude<NextAction, "add-recommended">;

/** What the code depends on, against what the specs declare: read from every
 *  Cargo.toml in the project's repositories (`POST /conformance`). Read on
 *  arrival, because section 1 shows it per capability and the product card
 *  starts the product from it. */
type CodeReport = { report: Conformance | null; busy: boolean; error: string | null; reload: () => void };

function useCodeReport(token: string, projectId: string, workspaceId: string, on: boolean): CodeReport {
  const [report, setReport] = useState<Conformance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
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
  }, [token, projectId, workspaceId]);
  useEffect(() => {
    if (on) void load();
  }, [on, load]);
  return { report, busy, error, reload: () => void load() };
}

/** The page's one sentence: where the person is, and the button for the next
 *  step. It replaces three tiles that had to be read and combined. */
function NextStepBar({ step, onAct }: { step: NextStep; onAct: (action: NextAction) => void }) {
  const label: Record<NextAction, string> = {
    "add-recommended": "Add the recommended gears",
    "take-from-code": "Take the product from the code",
    preview: "Check it",
    fix: "Show the fixes",
    build: "Build it in Studio-ide →",
    open: "Open in Studio-ide",
  };
  return (
    <div
      className={`next-step ${step.tone}`}
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 12px",
        margin: "0 0 12px",
        background: step.tone === "done" ? "var(--success-soft)" : step.tone === "warn" ? "var(--warning-soft)" : "var(--accent)",
      }}
    >
      <b style={{ fontSize: 13 }}>Next:</b>
      <span style={{ fontSize: 13 }}>{step.text}</span>
      {step.action && (
        <button className="primary" style={{ marginLeft: "auto" }} onClick={() => onAct(step.action as NextAction)}>
          {label[step.action]}
        </button>
      )}
    </div>
  );
}

function SuggestedComponents({
  token,
  projectId,
  product,
  code,
  onFlow,
}: {
  token: string;
  projectId: string;
  product: ProductState;
  code: CodeReport;
  onFlow?: (flow: { capabilities: number | null; open: number; recommended: string[] }) => void;
}) {
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  /** Where the documents say the product runs: the profile to default to. */
  const [advice, setAdvice] = useState<ProfileAdvice | null>(null);
  /** Which documents declare each capability, to say where a row comes from. */
  const [sources, setSources] = useState<Record<string, DeclaredCapability["sources"]>>({});
  const [docCount, setDocCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = usePortalNav();
  /** Rows whose "why" is open: `true` for the capability, a name for one candidate. */
  const [whyOpen, setWhyOpen] = useState<Record<string, string | true>>({});
  /** The capability a new gear is being scaffolded for. */
  const [scaffoldFor, setScaffoldFor] = useState<PlanRow | null>(null);
  /** Rows showing every candidate, not just the recommended one and the picks. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleWhy = (capability: string, candidate?: string) =>
    setWhyOpen((current) => {
      const next = { ...current };
      const want: string | true = candidate ?? true;
      if (next[capability] === want) delete next[capability];
      else next[capability] = want;
      return next;
    });

  const suggest = async () => {
    setBusy(true);
    setError(null);
    try {
      // One read: the spec-mapping gear assembles what the specifications
      // need, the vocabulary, the recorded decisions and the catalogue on
      // the server, where the rules live.
      const answer = await api.projectPlan(token, projectId);
      const next = answer.items;
      setSources(Object.fromEntries(next.map((r) => [r.capability, r.sources ?? []])));
      setDocCount(new Set(next.flatMap((r) => (r.sources ?? []).map((s) => s.id))).size);
      setPlan(next);
      setAdvice(answer.profile ?? null);
      // An empty product is not filled in here: the next-step line offers
      // the code's gears or the recommended ones, and the person chooses.
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setBusy(false);
    }
  };

  /** Record a member's decision on one proposal, against the first document
   *  that needs the capability, then read the plan again so the ranking shows it. */
  const decide = async (capability: string, c: Candidate, decision: "confirmed" | "rejected") => {
    const source = (sources[capability] ?? [])[0];
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      await api.decideMapping(token, {
        project_id: projectId,
        document: source.id,
        document_node: source.node_id ?? null,
        document_revision: source.revision ?? "",
        capability,
        gear: c.name,
        gear_version: c.version ?? null,
        step: c.step ?? "evidence",
        decision,
      });
    } catch (cause) {
      setError(errText(cause));
      setBusy(false);
      return;
    }
    await suggest();
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
  const coverage = plan ? coverageSummary(plan, product.picks) : null;
  const covers = useMemo(() => (plan ? alsoCovers(plan) : {}), [plan]);
  const recommendedKey = recommended.join(",");
  useEffect(() => {
    onFlow?.({ capabilities: plan ? plan.length : null, open: coverage?.open ?? 0, recommended });
    // The arrays are fresh per render; their content is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, coverage?.open, recommendedKey]);
  const report = code.report;

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
              className="ghost"
              disabled={busy}
              style={{ whiteSpace: "nowrap" }}
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
              ? "No specification in this project says what it needs yet. This reads the functional requirements of the project's PRDs, as they are written, and of the documents Studio holds; sync the repository if its specs are not on the Specs tab yet."
              : "The documents declare no capabilities to match."}
          </p>
        ) : (
          <>
            <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 12px" }}>
              {plan.length} capabilit{plan.length === 1 ? "y" : "ies"} from {docCount} document
              {docCount === 1 ? "" : "s"} · {built} built candidate{built === 1 ? "" : "s"} ·{" "}
              {unbuilt} with nothing built yet · {gaps} with nothing at all
              {report && ` · the code depends on ${report.components_in_code.length} catalogue components`}
              {code.busy && " · reading the code…"}.
            </p>
            {code.error && <div className="hint" style={{ fontSize: 12 }}>The code could not be read: {code.error}</div>}
            {advice && (
              <p
                style={{ fontSize: 12, margin: "0 0 12px", display: "flex", gap: 8, alignItems: "center" }}
                title={advice.because.map(plainText).join("\n")}
              >
                <span>
                  The documents say where it runs: <code>{advice.profile}</code> ({advice.kind}) — “
                  {plainText(advice.because[0] ?? "")}”{advice.because.length > 1 && ` and ${advice.because.length - 1} more`}.
                </span>
                {composing && product.profile !== advice.profile && (
                  <button className="ghost" onClick={() => product.setProfile(advice.profile)}>
                    Use {advice.profile}
                  </button>
                )}
              </p>
            )}
            {composing && coverage && coverage.total > 0 && (
              <p style={{ fontSize: 13, margin: "0 0 12px" }}>
                <b>
                  Your product closes {coverage.covered} of {coverage.total} capabilit
                  {coverage.total === 1 ? "y" : "ies"}
                </b>
                {coverage.weak > 0 && ` · ${coverage.weak} only by a gear that mentions its words`}
                {coverage.open > 0 && ` · ${coverage.open} not closed by any gear in it`}.
              </p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {plan.map((row) => {
                const cover = rowCoverage(row, product.picks);
                const open = whyOpen[row.capability];
                const shown = typeof open === "string" ? row.candidates.find((c) => c.name === open) : undefined;
                const beyond = composing ? picksBeyondShortlist(row, product.picks) : [];
                const rowSources = sources[row.capability] ?? [];
                // Nothing in the product closes it and nothing built could:
                // the honest next step is a gear of the project's own.
                const needsGear =
                  !row.nonfunctional && (row.gap || row.unbuilt || (composing && cover.cover === "open" && !row.candidates.some((c) => c.built === "built")));
                const reasons = open === true ? specReasons(row) : [];
                const inCode = codeFor(report, row.capability);
                const { shown: shortlist, hidden } = rowShortlist(row, product.picks, !!expanded[row.capability]);
                return (
                  <div
                    key={row.capability}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "8px 10px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <code style={{ fontSize: 12, fontWeight: 700 }}>{row.capability}</code>
                      {row.label && row.label.toLowerCase() !== row.capability && (
                        <span style={{ fontSize: 12 }}>{row.label}</span>
                      )}
                      {composing && cover.cover === "covered" && (
                        <span
                          className="badge ok"
                          title="A gear in the product provides its contract, declares it, or a member confirmed it"
                        >
                          closed by {cover.strong.join(", ")}
                        </span>
                      )}
                      {composing && cover.cover === "weak" && (
                        <span
                          className="badge warn"
                          title="The product's gears only mention its words: they talk about the subject, which does not prove they do the job"
                        >
                          only by words: {cover.weak.join(", ")}
                        </span>
                      )}
                      {composing && cover.cover === "open" && (
                        <span className="badge danger" title="No gear in the product fills it">
                          not closed
                        </span>
                      )}
                      {inCode && !row.nonfunctional && (
                        <span
                          className={`badge ${inCode.status === "implemented" ? "ok" : ""}`}
                          title="What the project's code depends on, read from its Cargo.toml files"
                        >
                          {inCode.status === "implemented"
                            ? `in the code: ${inCode.by.map((b) => gearLabel(b.name)).join(", ")}`
                            : "not in the code"}
                        </span>
                      )}
                      {rowSources.length > 0 && (
                        <span style={{ fontSize: 11, opacity: 0.65 }}>
                          from {rowSources.map((src) => src.label).join(", ")}
                          {rowSources.every((src) => src.inferred) && " · read from the requirements"}
                          {rowSources.every((src) => src.confirmed === false) && " · unconfirmed"}
                        </span>
                      )}
                      {row.gap && (
                        <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.75 }}>NOTHING IN THE CATALOGUE</span>
                      )}
                      {row.unbuilt && (
                        <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.75 }}>NOTHING BUILT YET</span>
                      )}
                      {row.nonfunctional && (
                        <span
                          style={{ fontSize: 10, fontWeight: 700, opacity: 0.75 }}
                          title="Answered by the deployment profile, not by a gear"
                        >
                          WHERE IT RUNS — THE PROFILE, NOT A GEAR
                        </span>
                      )}
                      {needsGear && (
                        <button
                          type="button"
                          className="linklike"
                          style={{ marginLeft: "auto", fontSize: 12 }}
                          title="Scaffold a gear for it, with the specs' requirements as its PRD: into the project's gear repository, else the organization's — the dialog says which"
                          onClick={() => setScaffoldFor(row)}
                        >
                          Create a gear for it
                        </button>
                      )}
                      <button
                        type="button"
                        className="linklike"
                        style={{ marginLeft: needsGear ? undefined : "auto", fontSize: 12 }}
                        aria-expanded={open === true}
                        onClick={() => toggleWhy(row.capability)}
                      >
                        {open === true ? "Hide why" : "Why?"}
                      </button>
                    </div>
                    {open === true && (
                      <div style={whyPanelStyle}>
                        <div style={{ fontWeight: 700, marginBottom: 2 }}>Why the specs ask for it</div>
                        {reasons.length === 0 ? (
                          <div style={{ opacity: 0.7 }}>No document is recorded for it.</div>
                        ) : (
                          reasons.map((r) => (
                            <div key={r.document} style={{ marginBottom: 4 }}>
                              <code>{r.document}</code>
                              {r.lines.map((l) => (
                                <div key={l}>{l}</div>
                              ))}
                            </div>
                          ))
                        )}
                        {!row.nonfunctional && (
                          <div style={{ opacity: 0.75, marginTop: 4 }}>
                            {lookingFor(row)} A gear&apos;s ? says why it was offered.
                          </div>
                        )}
                      </div>
                    )}
                    {(row.candidates.length > 0 || beyond.length > 0) && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                        {shortlist.map((c) => {
                          const pickable = composing && isPickable(c);
                          const others = (covers[c.name] ?? []).filter((k) => k !== row.capability);
                          const picked = pickable && product.picks.includes(c.name);
                          const strong = candidateStrength(c) === "strong";
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
                              <ComponentLink nav={c.origin === "project" ? null : nav} name={c.name} />
                              <span style={{ opacity: 0.6, marginLeft: 5 }}>{c.kind}</span>
                              {couldBecomeGear(c) ? (
                                <span
                                  title={`This project's own code${c.path ? ` at ${c.path}` : ""} looks like a gear and is not declared one: it could become a gear`}
                                  style={{ marginLeft: 5, fontSize: 9, fontWeight: 700 }}
                                  data-could-become-gear
                                >
                                  COULD BE A GEAR
                                </span>
                              ) : (
                                (() => {
                                  // Whose gear it is (ADR-0042): the platform's,
                                  // the organization's, or this project's own.
                                  const tier = candidateTier(c);
                                  if (!tier) return null;
                                  const where = tier === "project" && c.path ? ` (${c.path})` : "";
                                  return (
                                    <span
                                      title={`${tierReason(tier)}${where}`}
                                      style={{
                                        marginLeft: 5,
                                        fontSize: 9,
                                        fontWeight: tier === "platform" ? 400 : 700,
                                        opacity: tier === "platform" ? 0.6 : 1,
                                      }}
                                      data-tier={tier}
                                    >
                                      {tierTag(tier)}
                                    </span>
                                  );
                                })()
                              )}
                              <span
                                style={{
                                  marginLeft: 5,
                                  fontSize: 9,
                                  fontWeight: strong ? 700 : 400,
                                  opacity: strong ? 1 : 0.55,
                                  color: strong ? "var(--success, var(--primary))" : undefined,
                                }}
                              >
                                {c.step === "contract" ? "CONTRACT" : c.declared ? "DECLARED" : strong ? "CONFIRMED" : "words"}
                              </span>
                              {c.composable === "blocked" && (
                                <span style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, color: "var(--danger, #c33)" }}>
                                  BLOCKED
                                </span>
                              )}
                              {c.built === "docs-only" && <span style={{ marginLeft: 5, fontWeight: 700 }}>docs only</span>}
                              {c.decision?.decision === "rejected" && !c.decision.needs_review && (
                                <span style={{ marginLeft: 5, fontSize: 9, fontWeight: 700 }}>REJECTED</span>
                              )}
                              {c.decision?.needs_review && (
                                <span style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, opacity: 0.6 }}>REVIEW</span>
                              )}
                              <button
                                type="button"
                                title="Why this gear is offered for this capability"
                                aria-expanded={shown?.name === c.name}
                                onClick={() => toggleWhy(row.capability, c.name)}
                                style={{ ...chipToggleStyle, marginLeft: 6, padding: "0 2px" }}
                              >
                                ?
                              </button>
                              {others.length > 0 && (
                                <span
                                  style={{ marginLeft: 4, fontSize: 9, opacity: 0.6 }}
                                  title={`The same gear is offered for ${others.join(", ")} too: one gear, several answers`}
                                >
                                  also {others.join(", ")}
                                </span>
                              )}
                            </span>
                          );
                        })}
                        {(hidden > 0 || expanded[row.capability]) && (
                          <button
                            type="button"
                            className="linklike"
                            style={{ fontSize: 11 }}
                            onClick={() => setExpanded((e) => ({ ...e, [row.capability]: !e[row.capability] }))}
                          >
                            {expanded[row.capability] ? "fewer" : `${hidden} more`}
                          </button>
                        )}
                        {beyond.map((p) => (
                          <span
                            key={p.name}
                            title="In the product and fills this capability; ranked below the candidates shown"
                            style={chipStyle(true)}
                          >
                            <span style={{ ...chipToggleStyle, cursor: "default" }}>✓</span>
                            <ComponentLink nav={nav} name={p.name} />
                            <span style={{ marginLeft: 5, fontSize: 9, opacity: p.strong ? 1 : 0.55 }}>
                              in the product{p.strong ? "" : " · words"}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                    {shown && (
                      <div style={whyPanelStyle}>
                        <div style={{ fontWeight: 700, marginBottom: 2 }}>
                          Why {shown.name} for {row.capability}
                        </div>
                        {candidateReasons(shown, row.capability).map((l) => (
                          <div key={l}>{l}</div>
                        ))}
                        {couldBecomeGear(shown) && <ProjectCandidate token={token} name={shown.name} projectId={projectId} />}
                        {rowSources.length > 0 && (
                          <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <button type="button" disabled={busy} onClick={() => void decide(row.capability, shown, "confirmed")}>
                              It fills {row.capability}
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              disabled={busy}
                              onClick={() => void decide(row.capability, shown, "rejected")}
                            >
                              It does not
                            </button>
                            <span style={{ opacity: 0.65 }}>
                              Recorded for the project: a confirmed gear closes the capability and ranks first; a
                              rejected one stops being offered for it.
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {report && report.unexplained.length > 0 && (
              <p style={{ fontSize: 12, margin: "10px 0 0" }}>
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
          </>
        ))}
      {scaffoldFor && (
        <ScaffoldModal
          capability={scaffoldFor.capability}
          token={token}
          projectTenantId={projectId}
          problem={gearProblem(scaffoldFor)}
          declares={[scaffoldFor.capability]}
          onClose={() => {
            setScaffoldFor(null);
            void suggest();
          }}
        />
      )}
    </section>
  );
}

const whyPanelStyle = {
  fontSize: 12,
  margin: "6px 0 2px",
  padding: "6px 8px",
  background: "var(--muted, rgba(0,0,0,0.04))",
  borderRadius: 6,
} as const;

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

function ProductCard({
  token,
  projectId,
  projectName,
  product,
  code,
  command,
  onVerdict,
}: {
  token: string;
  projectId: string;
  projectName: string;
  product: ProductState;
  code: CodeReport;
  command: { kind: ProductCommand; at: number } | null;
  onVerdict: (v: { resolves: boolean | null; fixes: number }) => void;
}) {
  const nav = usePortalNav();
  const cardRef = useRef<HTMLElement | null>(null);
  /** The engine's completion of a product that does not resolve, as fixes. */
  const [fixes, setFixes] = useState<Fix[] | null>(null);
  /** "Take the product from the code" is open. */
  const [fromCode, setFromCode] = useState(false);
  /** A fix was applied: preview again once the product has changed. */
  const recheck = useRef(false);
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
  const question = JSON.stringify([profile, [...picks].sort(), product.config]);
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

  // Ask the engine on arrival, so the verdict and its fixes are on screen
  // without a click; a product with nothing in it has nothing to ask.
  const asked0 = useRef(false);
  useEffect(() => {
    if (!product.loaded || asked0.current || picks.length === 0) return;
    asked0.current = true;
    void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.loaded, picks.length]);

  // A fix changed the product: check it again.
  useEffect(() => {
    if (!recheck.current || picks.length === 0) return;
    recheck.current = false;
    const timer = setTimeout(() => void run(false), 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question]);

  // A product that does not resolve: ask the engine how it would, without
  // applying it, and list each change as its own fix.
  useEffect(() => {
    if (!preview || preview.ok || stale) {
      setFixes(null);
      return;
    }
    let live = true;
    api
      .completeProduct(token, picks, product.config)
      .then((done) => live && setFixes(fixesFrom(picks, product.config, done)))
      .catch(() => live && setFixes([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, stale]);

  useEffect(() => {
    onVerdict({ resolves: preview && !stale ? preview.ok : null, fixes: fixes?.length ?? 0 });
  }, [preview, stale, fixes, onVerdict]);

  const applyOne = (fix: Fix) => {
    recheck.current = true;
    if (fix.kind === "config") product.setField(fix.gear, fix.field, fix.value);
    else if (fix.kind === "remove") product.toggle(fix.gear);
    else product.setPicks((current) => applyFix(current, product.config, fix).picks);
  };

  // The next-step line's button.
  useEffect(() => {
    if (!command) return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (command.kind === "preview") void run(false);
    if (command.kind === "fix" && fixes && fixes.length > 0) document.getElementById("product-fixes")?.focus();
    if (command.kind === "build") void buildInTheia();
    if (command.kind === "open") openOnDesktop(record?.written?.branch);
    if (command.kind === "take-from-code") setFromCode(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.at]);

  const inCode = code.report ? codeGears(code.report) : [];
  const diff = codeDiff(picks, inCode);
  const resolvesNow = !!preview?.ok && !stale;

  const errors = preview?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
  const warnings = preview?.diagnostics.filter((d) => d.severity === "warning").length ?? 0;
  const last = record?.last_preview;

  return (
    <section className="card" style={{ marginBottom: 16 }} ref={cardRef}>
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
            Nothing in the product yet — take it from the code, add the recommended components above, or pick them with +.
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
      <GearConfigForm token={token} product={product} />
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
        {inCode.length > 0 && (
          <button
            className="ghost"
            aria-expanded={fromCode}
            title="The gears the project's code already depends on, read from its Cargo.toml files"
            onClick={() => setFromCode((v) => !v)}
          >
            From the code ({inCode.length})
          </button>
        )}
        <button
          className={resolvesNow ? "primary" : "ghost"}
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

      {fromCode && code.report && (
        <div style={{ fontSize: 12, marginTop: 10, border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            The code depends on {inCode.length} gear{inCode.length === 1 ? "" : "s"} ({code.report.repo})
          </div>
          {diff.add.length > 0 && (
            <div>
              <b>Not in the product yet:</b> {diff.add.map(gearLabel).join(", ")}
            </div>
          )}
          {diff.drop.length > 0 && (
            <div>
              <b>In the product, not in the code:</b> {diff.drop.map(gearLabel).join(", ")}
            </div>
          )}
          {diff.add.length === 0 && diff.drop.length === 0 && <div>The product is exactly what the code uses.</div>}
          {code.report.gearbox.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <b>What the engine says about the code&apos;s gears:</b>
              <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
                {code.report.gearbox.map((g) => (
                  <li key={`${g.gear}-${g.reason}`}>
                    {g.added ? "needs " : "cannot run: "}
                    <ComponentLink nav={nav} name={g.gear} /> — {g.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button
              className="primary"
              disabled={busy !== null}
              title="Replace the product with the code's gears, then let the engine complete it so it resolves"
              onClick={() => {
                setFromCode(false);
                void product.seed(inCode);
              }}
            >
              Make the product the code&apos;s
            </button>
            {diff.add.length > 0 && picks.length > 0 && (
              <button
                className="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setFromCode(false);
                  void product.seed([...picks, ...diff.add]);
                }}
              >
                Add the {diff.add.length} missing
              </button>
            )}
            <button className="ghost" onClick={() => code.reload()} disabled={code.busy}>
              {code.busy ? "Reading…" : "Read the code again"}
            </button>
          </div>
        </div>
      )}

      {fixes && fixes.length > 0 && (
        <div
          id="product-fixes"
          tabIndex={-1}
          style={{ fontSize: 12, marginTop: 10, border: "1px solid var(--warning, #c90)", borderRadius: 8, padding: "8px 10px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <b>
              How to make it resolve — {fixes.length} fix{fixes.length === 1 ? "" : "es"} from the engine
            </b>
            <button className="primary" style={{ marginLeft: "auto" }} disabled={busy !== null} onClick={() => void product.complete()}>
              Apply all
            </button>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {fixes.map((f) => (
              <li
                key={`${f.kind}-${f.gear}-${f.kind === "config" ? f.field : ""}`}
                style={{ display: "flex", alignItems: "center", gap: 8, margin: "3px 0" }}
              >
                <span>
                  {f.kind === "add" && (
                    <>
                      Add <ComponentLink nav={nav} name={f.gear} />
                    </>
                  )}
                  {f.kind === "remove" && (
                    <>
                      Take out <ComponentLink nav={nav} name={f.gear} />
                    </>
                  )}
                  {f.kind === "config" && (
                    <>
                      Set <code>{gearLabel(f.gear)}</code> · <code>{f.field}</code> ={" "}
                      <code>{typeof f.value === "string" ? f.value : JSON.stringify(f.value)}</code>
                    </>
                  )}
                  <span style={{ opacity: 0.7 }}> — {f.reason}</span>
                </span>
                <button className="ghost" style={{ marginLeft: "auto" }} disabled={busy !== null} onClick={() => applyOne(f)}>
                  Apply
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview && !preview.ok && !stale && fixes && fixes.length === 0 && (
        <p className="hint" style={{ fontSize: 12 }}>
          The engine offers no change that makes it resolve; the errors below say what it needs.
        </p>
      )}

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
