/* The Product page's strip: configure the product, save it to product.gdl,
 * build it, deploy it -- a StepFlow strip, each step with what the project
 * holds; Save opens below it, Configure opens the map, Build and Deploy open
 * Releases. The model is product-flow.ts.
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
import { lineDiff, productFlow, type DiffLine, type FlowState, type FlowStep as ModelStep } from "./product-flow";
import { profilesToCheck } from "./product";
import { infrastructureOf, type ProductSectionId } from "./product-sections";
import { deployableBuilds } from "./project-deploys";
import { StatusChip, StepFlow, type FlowStep, type StepState } from "./ui-standard";

/** A flow state as the StepFlow strip draws it. */
const STEP_STATE: Record<FlowState, StepState> = { done: "done", todo: "warn", failed: "failed", unknown: "todo", none: "todo" };

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
  open,
  onOpen,
  onSection,
  onOpenTab,
  onSaved,
  onSteps,
}: {
  token: string;
  projectId: string;
  /** Bumped by the page when a section changed the product. */
  round: number;
  /** The step opened below the strip (the page's header opens Save). */
  open: string | null;
  onOpen: (id: string | null) => void;
  onSection: (id: ProductSectionId) => void;
  onOpenTab?: (tab: PipelineTab) => void;
  onSaved: () => void;
  /** The steps as read, for the page's header and its sections' dots. */
  onSteps?: (steps: ModelStep[]) => void;
}) {
  const [read, setRead] = useState<Read | null>(null);
  const [mine, setMine] = useState(0);

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

  useEffect(() => {
    if (steps) onSteps?.(steps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps]);

  if (!steps || !read) return <p className="muted">Reading where the product stands…</p>;

  const flow: FlowStep[] = steps.map((s) => ({
    id: s.id,
    title: s.title,
    state: STEP_STATE[s.state],
    status: s.status,
    // Configure is the sections below; Build and Deploy are Releases'.
    onSelect:
      s.id === "configure"
        ? () => onSection("map")
        : s.tab && onOpenTab
          ? () => onOpenTab(s.tab!)
          : undefined,
    body:
      s.id === "save" ? (
        <SaveStep
          token={token}
          projectId={projectId}
          product={read.product}
          profile={profilesToCheck(read.targets?.bindings ?? [])[0]}
          kept={read.kept}
          onSaved={() => {
            setMine((n) => n + 1);
            onSaved();
          }}
        />
      ) : undefined,
  }));

  return (
    <div className="product-flow" data-product-flow>
      <StepFlow steps={flow} look="strip" label="From configured to running" open={open} onOpen={onOpen} />
    </div>
  );
}

/** Compose the description from the product as configured, show what changes
 *  against the kept revision, save the next one. */
function SaveStep({
  token,
  projectId,
  product,
  profile,
  kept,
  onSaved,
}: {
  token: string;
  projectId: string;
  product: ProjectProduct | null;
  /** The profile the save checks too: the first an environment runs. The
   *  description is the same for any (ADR-0057). */
  profile: string;
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
      const ask = { product_id: productId, name: product?.name ?? productId, gears, profile, config: product?.config };
      // A save answers within the gateway's limit and is sent again when the
      // gateway loses its answer (the same save is the same revision), so it
      // need not wait out a check first: one still running when the save
      // answers lands on the product's record by itself.
      const result = await api.previewProduct(token, projectId, {
        ...ask,
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
        <span className="grow" />
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
          <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 12, marginBottom: 4 }} data-flow-diff-summary>
            {changes === 0 ? (
              <StatusChip tone="ok">nothing to save</StatusChip>
            ) : (
              <StatusChip tone="info">
                {changes} line{changes === 1 ? "" : "s"} change
              </StatusChip>
            )}
            {!draft.ok && (
              <StatusChip tone="warn" title="The engine does not resolve it yet; Backend says why">
                does not resolve yet
              </StatusChip>
            )}
            <span className="muted">
              {changes === 0
                ? `The product as configured is revision ${kept?.revision} as it is.`
                : `Against ${kept ? `revision ${kept.revision}` : "nothing saved"}.`}
            </span>
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
                  {r.revision === latest.revision && (
                    <StatusChip tone="ok" style={{ marginLeft: 6 }}>
                      current
                    </StatusChip>
                  )}
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
