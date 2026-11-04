// The project's path on Overview (project-path.ts holds the rules), and the
// one-line "what you do here" hint every project tab carries.

import { api } from "./api";
import { buildsOf, latestFinished, mainBranch } from "./builds";
import type { ProjTab } from "./project-overview";
import { stripState } from "./project-overview-model";
import { kindStatus, proposeKind } from "./product-kind";
import { readKindFacts } from "./product-kind-view";
import { type PathFacts, type PathStep, TAB_HOWTO, pathProgress, specQueues } from "./project-path";
import { InfoPopover, StatusChip, StepFlow, type FlowStep } from "./ui-standard";

/** The read behind a step, or null when it failed: a gear that is down marks
 *  its step unknown and leaves the rest of the path alone. */
async function soft<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/** Builds are read off the newest few runs only: the path asks one question
 *  ("did the last build pass"), not for the history the Builds tab shows. */
const RUNS = 50;

/** What the path is read from. `repositories` and `synced` are counted by
 *  Overview, which reads the sources anyway; null when that read failed. */
export async function readPathFacts(
  token: string,
  projectId: string,
  repositories: number | null,
  synced: number | null,
): Promise<PathFacts> {
  const [rows, model, findings, product, runs, kind] = await Promise.all([
    soft(api.specRows(token, projectId)),
    soft(api.specModel(token, projectId)),
    soft(api.specModelFindings(token, projectId)),
    // Boxed, because the product read answers null for "nothing picked yet"
    // and soft() answers null for a failure.
    soft(api.projectProduct(token, projectId).then((value) => ({ value }))),
    soft(api.listArtifactNodes(token, "workflow_run", projectId, undefined, RUNS, { sort: "updated" })),
    soft(readKindFacts(token, projectId)),
  ]);
  const open = findings ? findings.items.filter((f) => !f.decision) : null;
  const built = runs ? buildsOf(runs.nodes ?? []) : null;
  const last = built ? latestFinished(built, mainBranch(built)) : null;
  return {
    repositories,
    synced,
    specs: rows ? specQueues(rows.sources.counts) : null,
    model: model
      ? {
          documents: model.documents.length,
          extracted: model.documents.filter((d) => d.state === "extracted").length,
          facts: model.facts.length,
          running: model.build.running,
        }
      : null,
    findings: open ? { open: open.length, high: open.filter((f) => f.severity === "high").length } : null,
    kind: kind ? ((k) => ({ done: k.done, status: k.text }))(kindStatus(kind.choice, proposeKind(kind.facts))) : null,
    product: product
      ? {
          gears: product.value?.gears?.length ?? 0,
          resolves: product.value?.last_preview ? product.value.last_preview.ok : null,
          errors: product.value?.last_preview?.errors ?? 0,
          written: !!(product.value?.written || product.value?.description),
        }
      : null,
    build: built === null ? null : last ? { status: last.status, sha: last.shortSha } : "none",
  };
}

/** "Path of the project" as one row: the steps as a StepFlow strip, the
 *  current one outlined. A step's line is on its title (hover) and opens below
 *  it (click), with the button to the tab where it is done. */
export function ProjectPath({
  steps,
  facts,
  onOpenTab,
}: {
  /** Null while reading. */
  steps: PathStep[] | null;
  facts: PathFacts | null | undefined;
  onOpenTab: (tab: ProjTab) => void;
}) {
  const progress = steps ? pathProgress(steps) : null;
  const flow: FlowStep[] = (steps ?? []).map((s) => ({
    id: s.id,
    state: stripState(s, facts),
    title: (
      <span title={s.status} data-path-step={s.id} data-state={s.state}>
        {s.title}
      </span>
    ),
    status: s.state === "unknown" ? `${s.status} (unknown)` : s.status,
    body: (
      <button className={s.state === "current" ? "primary" : "ghost"} onClick={() => onOpenTab(s.tab)}>
        {s.action}
      </button>
    ),
  }));
  return (
    <section className="card ppath ppath-strip" data-project-path aria-label="Path of the project">
      <div className="ppath-head">
        <h2>
          Path{" "}
          <InfoPopover label="About the path of the project">
            The steps a project goes through, from its sources to a running product, in the order they are done. Each
            says where it stands, read from the project&apos;s data: hover a step for its line, click it for the line and
            the tab where it is done. A step whose data could not be read is marked unknown and leaves the rest alone.
          </InfoPopover>
        </h2>
        {progress && (
          <StatusChip tone={progress.done === progress.total ? "ok" : "neutral"} data-path-progress>
            {progress.done} of {progress.total} done
          </StatusChip>
        )}
      </div>
      {steps === null ? (
        <p className="sub ppath-reading">Reading where the project stands…</p>
      ) : (
        <StepFlow look="strip" steps={flow} label="Path of the project" />
      )}
    </section>
  );
}

/** The "what you do here" line on top of a project tab; nothing for a tab
 *  without one. */
export function ProjectTabHowto({ tab }: { tab: ProjTab }) {
  const line = TAB_HOWTO[tab];
  if (!line) return null;
  return (
    <p className="dm-howto" data-tab-howto={tab}>
      <b>{line.lead}</b> <InfoPopover label="What you do here">{line.rest}</InfoPopover>
    </p>
  );
}
