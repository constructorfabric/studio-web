/* The Product page's strip: configure the product, save it to product.gdl,
 * build it, deploy it -- each step with what the project holds and, opened,
 * what to do next. The model is product-flow.ts.
 *
 * The save is the page's one: it composes the description from what the
 * sections configured (the gears and their configuration, the profile, the
 * frontend), shows what changes against the revision Studio keeps, and saves
 * the next revision. The build and the deploy take that revision. */

import { useEffect, useMemo, useState } from "react";

import { api, type ArtifactNode, type Deployment, type ProductDescriptionRevision, type ProductPreview, type ProjectConfig, type ProjectProduct, type ProjectTargets } from "./api";
import { buildsOf, ideBuildsOf, productBuildsOf, repoPathsOf, type BuildRun, type IdeBuild } from "./builds";
import { buildableEnvironments } from "./deploy-actions";
import { buildsHint, deploysHint, type PipelineTab } from "./pipeline";
import { errText } from "./problem";
import { lineDiff, productFlow, type DiffLine, type FlowState, type FlowStep } from "./product-flow";
import { infrastructureOf, type ProductSectionId } from "./product-sections";
import { deployableBuilds } from "./project-deploys";

const MARK: Record<FlowState, string> = { done: "✓", todo: "!", failed: "✗", unknown: "…", none: "–" };
const TONE: Record<FlowState, string> = { done: "ok", todo: "warn", failed: "bad", unknown: "", none: "" };

type Read = {
  product: ProjectProduct | null;
  cfg: ProjectConfig | null;
  targets: ProjectTargets | null;
  kept: { revision: number; text: string } | null | undefined;
  builds: IdeBuild[] | null;
  deployments: Deployment[] | null;
};

export function ProductFlow({
  token,
  projectId,
  round,
  section,
  hasParts,
  onSection,
  onOpenTab,
  onSaved,
}: {
  token: string;
  projectId: string;
  /** Bumped by the page when a section changed the product. */
  round: number;
  /** The section open below, marked among Configure's parts. */
  section: ProductSectionId;
  /** Whether the page has the Parts inventory to open. */
  hasParts: boolean;
  onSection: (id: ProductSectionId) => void;
  onOpenTab?: (tab: PipelineTab) => void;
  onSaved: () => void;
}) {
  const [read, setRead] = useState<Read | null>(null);
  const [mine, setMine] = useState(0);
  const [open, setOpen] = useState<FlowStep["id"] | null>(null);

  useEffect(() => {
    let live = true;
    const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    Promise.all([
      soft(api.projectProduct(token, projectId), null),
      soft(api.projectConfig(token, projectId), null),
      soft(api.projectTargets(token, projectId), null),
      api.productDescription(token, projectId).then(
        (d) => (d.latest ? { revision: d.latest.revision, text: d.latest.text } : null),
        () => undefined,
      ),
      soft(
        api.listArtifactNodes(token, "build", projectId, undefined, 50, { sort: "updated" }).then((p) => p.nodes ?? []),
        null as ArtifactNode[] | null,
      ),
      soft(
        api.listArtifactNodes(token, "workflow_run", projectId, undefined, 50, { sort: "updated" }).then((p) => buildsOf(p.nodes ?? [])),
        [] as BuildRun[],
      ),
      soft(
        api.listArtifactNodes(token, "repo", projectId, undefined, 200).then((p) => repoPathsOf(p.nodes ?? [])),
        new Map<string, string>(),
      ),
      soft(
        api.deployments(token, { project: projectId }).then((d) => d.items),
        null,
      ),
    ]).then(([product, cfg, targets, kept, buildNodes, runs, repoPaths, deployments]) => {
      if (!live) return;
      const builds = buildNodes ? productBuildsOf(ideBuildsOf(buildNodes), runs, cfg?.build, repoPaths) : null;
      setRead({ product, cfg, targets, kept, builds, deployments });
    });
    return () => {
      live = false;
    };
  }, [token, projectId, round, mine]);

  const steps = useMemo(() => {
    if (!read) return null;
    const envs = read.targets?.environments.map((e) => e.environment) ?? [];
    return productFlow({
      product: read.product,
      cfg: read.cfg,
      infra: read.targets || read.product ? infrastructureOf(read.product, read.targets) : null,
      kept: read.kept,
      build: read.builds ? buildsHint(read.builds, buildableEnvironments(envs).length > 0) : null,
      deploy:
        read.targets && read.deployments
          ? deploysHint({
              environments: read.targets.environments.length,
              bound: read.targets.bindings.length,
              deployable: deployableBuilds(read.builds ?? []).length,
              deployments: read.deployments,
            })
          : null,
    });
  }, [read]);

  if (!steps || !read) return <p className="muted">Reading where the product stands…</p>;
  // Configure stays open while one of its sections is below, unless another
  // step was asked for.
  const shown = steps.find((s) => s.id === (open ?? "configure"));

  return (
    <section className="card fc-steps" style={{ marginBottom: 12 }} data-product-flow>
      <div className="row" style={{ alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <b style={{ fontSize: 13 }}>From configured to running</b>
        <span className="muted" style={{ fontSize: 12 }}>
          Configure the product below, save it to <code>product.gdl</code>, then build and deploy what was saved.
        </span>
      </div>
      <ol>
        {steps.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={`fc-step ${TONE[s.state]}${shown?.id === s.id ? " on" : ""}`}
              aria-expanded={shown?.id === s.id}
              title={s.tab && onOpenTab ? `${s.status} Opens Releases.` : undefined}
              onClick={() => (s.tab && onOpenTab ? onOpenTab(s.tab) : setOpen(s.id))}
              data-flow-step={s.id}
              data-flow-state={s.state}
            >
              <span className="fc-step-mark">{MARK[s.state]}</span>
              <span className="fc-step-n">{i + 1}</span>
              {s.title}
              {s.tab && onOpenTab && <span aria-hidden> →</span>}
            </button>
          </li>
        ))}
      </ol>
      {shown && (
        <div className="fc-step-detail" data-flow-detail={shown.id}>
          {shown.parts ? (
            <div style={{ display: "grid", gap: 4 }}>
              {shown.parts.map((p) => (
                <div key={p.id} className="row" style={{ gap: 8, alignItems: "baseline" }} data-flow-part={p.id} data-flow-state={p.state}>
                  <button
                    type="button"
                    className={`fc-step ${TONE[p.state]}${section === p.id ? " on" : ""}`}
                    aria-pressed={section === p.id}
                    onClick={() => onSection(p.id)}
                    data-product-section-tab={p.id}
                  >
                    <span className="fc-step-mark">{MARK[p.state]}</span>
                    {p.title}
                  </button>
                  <span className="grow">{p.status}</span>
                  {section === p.id && <span className="muted">shown below</span>}
                </div>
              ))}
              {hasParts && (
                <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                  <button
                    type="button"
                    className={`fc-step${section === "parts" ? " on" : ""}`}
                    aria-pressed={section === "parts"}
                    onClick={() => onSection("parts")}
                    data-product-section-tab="parts"
                  >
                    Parts
                  </button>
                  <span className="grow muted">
                    Everything else the repositories hold: services and applications that are not gears.
                  </span>
                </div>
              )}
            </div>
          ) : shown.id === "save" ? (
            <SaveStep
              token={token}
              projectId={projectId}
              status={shown.status}
              product={read.product}
              kept={read.kept}
              onSaved={() => {
                setMine((n) => n + 1);
                onSaved();
              }}
            />
          ) : (
            <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
              <span className="grow">{shown.status}</span>
              {shown.tab && onOpenTab && (
                <button type="button" className="ghost" onClick={() => onOpenTab(shown.tab!)}>
                  Open Releases
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Compose the description from the product as configured, show what changes
 *  against the kept revision, save the next one. */
function SaveStep({
  token,
  projectId,
  status,
  product,
  kept,
  onSaved,
}: {
  token: string;
  projectId: string;
  status: string;
  product: ProjectProduct | null;
  kept: { revision: number; text: string } | null | undefined;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ProductPreview | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const productId = product?.product_id;
  const gears = product?.gears ?? [];

  async function compose(write: boolean) {
    if (!productId) return;
    setBusy(write ? "save" : "check");
    setErr(null);
    try {
      const result = await api.previewProduct(token, projectId, {
        product_id: productId,
        name: product?.name ?? productId,
        gears,
        profile: product?.profile,
        config: product?.config,
        ...(write ? { write: true, ...(kept ? { base_revision: kept.revision } : {}) } : {}),
      });
      setDraft(write ? null : result);
      if (write) onSaved();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  }

  const diff = draft ? lineDiff(kept?.text ?? "", draft.product_gdl) : null;
  const changes = diff?.filter((l) => l.kind !== "same").length ?? 0;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="grow">{status}</span>
        {!productId || gears.length === 0 ? (
          <span className="muted">Pick the product&apos;s gears under Backend first.</span>
        ) : (
          <>
            <button type="button" className="ghost" disabled={!!busy} onClick={() => void compose(false)} data-flow-check>
              {busy === "check" ? "Composing…" : "Check what changes"}
            </button>
            <button type="button" className="primary" disabled={!!busy} onClick={() => void compose(true)} data-flow-save>
              {busy === "save" ? "Saving…" : kept ? `Save revision ${kept.revision + 1}` : "Save the first revision"}
            </button>
          </>
        )}
      </div>
      {err && <div className="error">{err}</div>}
      {draft && diff && (
        <div data-flow-diff>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            {changes === 0
              ? `The product as configured is revision ${kept?.revision} as it is: nothing to save.`
              : `${changes} line${changes === 1 ? "" : "s"} change against ${kept ? `revision ${kept.revision}` : "nothing saved"}${
                  draft.ok ? "" : "; the engine does not resolve it yet (Backend says why)"
                }.`}
          </div>
          <Diff lines={diff} />
        </div>
      )}
      {kept && <Revisions token={token} projectId={projectId} latest={kept} onRestored={onSaved} />}
    </div>
  );
}

/** A line diff, `-` for what goes and `+` for what comes. */
function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <pre style={{ fontSize: 11, maxHeight: 320, overflow: "auto", margin: 0 }}>
      {lines.map((l, i) => (
        <div
          key={i}
          style={{
            background: l.kind === "add" ? "var(--success-soft)" : l.kind === "del" ? "var(--destructive-soft)" : undefined,
          }}
        >
          {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

const SOURCE_WORDS: Record<string, string> = {
  studio: "saved in Studio",
  repository: "read back from the repository",
  migrated: "taken from where the project last saved it",
};

/** The description's history (ADR-0053): every save is a revision. One opens
 *  as what changed from it to the latest; restoring it saves its text as the
 *  next revision, so nothing kept is lost. The product as configured is not
 *  changed by a restore: the next save composes from it again. */
function Revisions({
  token,
  projectId,
  latest,
  onRestored,
}: {
  token: string;
  projectId: string;
  latest: { revision: number; text: string };
  onRestored: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Omit<ProductDescriptionRevision, "text">[] | null>(null);
  const [shown, setShown] = useState<ProductDescriptionRevision | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .productDescriptionRevisions(token, projectId)
      .then((r) => live && setItems(r.items))
      .catch((e) => live && setErr(errText(e)));
    return () => {
      live = false;
    };
  }, [open, token, projectId, latest.revision]);

  async function show(revision: number) {
    setErr(null);
    try {
      setShown(revision === latest.revision ? null : await api.productDescriptionRevision(token, projectId, revision));
    } catch (e) {
      setErr(errText(e));
    }
  }

  async function restore(r: ProductDescriptionRevision) {
    setBusy(true);
    setErr(null);
    try {
      await api.saveProductDescription(token, projectId, { base_revision: latest.revision, text: r.text });
      setShown(null);
      onRestored();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-flow-history>
      <summary style={{ cursor: "pointer", fontSize: 12 }}>
        History: {latest.revision} revision{latest.revision === 1 ? "" : "s"}
      </summary>
      {err && <div className="error">{err}</div>}
      {open && !items && !err && <p className="muted">Reading the revisions…</p>}
      {items && (
        <ul className="rows" style={{ margin: "6px 0" }}>
          {items.map((r) => (
            <li key={r.revision} data-flow-revision={r.revision}>
              <div className="grow">
                <div className="name">
                  Revision {r.revision}
                  {r.revision === latest.revision && <span className="badge ok" style={{ marginLeft: 6 }}>current</span>}
                </div>
                <div className="sub">
                  {new Date(r.created_at).toLocaleString()} · {r.author === "studio" ? "Studio" : r.author.slice(0, 8)} ·{" "}
                  {SOURCE_WORDS[r.source] ?? r.source}
                </div>
              </div>
              {r.revision !== latest.revision && (
                <button type="button" className="ghost" onClick={() => void show(r.revision)}>
                  {shown?.revision === r.revision ? "Shown below" : "Compare with current"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {shown && (
        <div style={{ display: "grid", gap: 6 }} data-flow-revision-diff={shown.revision}>
          <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
            <span className="grow muted" style={{ fontSize: 12 }}>
              From revision {shown.revision} to the current one, {latest.revision}.
            </span>
            <button type="button" className="ghost" disabled={busy} onClick={() => void restore(shown)}>
              {busy ? "Restoring…" : `Restore as revision ${latest.revision + 1}`}
            </button>
          </div>
          <Diff lines={lineDiff(shown.text, latest.text)} />
        </div>
      )}
    </details>
  );
}
