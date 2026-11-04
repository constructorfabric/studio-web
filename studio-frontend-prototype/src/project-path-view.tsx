// The project's path on Overview (project-path.ts holds the rules), and the
// one-line "what you do here" hint every project tab carries.

import { useEffect, useState } from "react";

import { api } from "./api";
import { buildsOf, latestFinished, mainBranch } from "./builds";
import type { ProjTab } from "./project-overview";
import { type PathFacts, type PathStep, TAB_HOWTO, pathProgress, projectPath, specQueues } from "./project-path";

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

async function gather(
  token: string,
  projectId: string,
  repositories: number | null,
  synced: number | null,
): Promise<PathFacts> {
  const [rows, model, findings, product, runs] = await Promise.all([
    soft(api.specRows(token, projectId)),
    soft(api.specModel(token, projectId)),
    soft(api.specModelFindings(token, projectId)),
    // Boxed, because the product read answers null for "nothing picked yet"
    // and soft() answers null for a failure.
    soft(api.projectProduct(token, projectId).then((value) => ({ value }))),
    soft(api.listArtifactNodes(token, "workflow_run", projectId, undefined, RUNS, { sort: "updated" })),
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

const MARK: Record<PathStep["state"], string> = { done: "✓", current: "→", todo: "", unknown: "?" };

/** "Path of the project": six steps, each with its state, one line read off the
 *  data, and a button to the tab where it is done. */
export function ProjectPath({
  token,
  projectId,
  repositories,
  synced = null,
  onOpenTab,
}: {
  token: string;
  projectId: string;
  /** Counted by Overview already; null when its read failed. */
  repositories: number | null;
  /** How many of them a sync has read, counted by Overview too. */
  synced?: number | null;
  onOpenTab: (tab: ProjTab) => void;
}) {
  const [steps, setSteps] = useState<PathStep[] | null>(null);

  useEffect(() => {
    let live = true;
    void gather(token, projectId, repositories, synced).then((facts) => live && setSteps(projectPath(facts)));
    return () => {
      live = false;
    };
  }, [token, projectId, repositories, synced]);

  const progress = steps ? pathProgress(steps) : null;
  return (
    <div className="card ppath" data-project-path>
      <div className="card-head">
        <h2>Path of the project</h2>
        {progress && (
          <span className="sub">
            {progress.done} of {progress.total} done
          </span>
        )}
      </div>
      {steps === null ? (
        <p className="empty">Reading where the project stands…</p>
      ) : (
        <ol className="ppath-steps">
          {steps.map((s, i) => (
            <li key={s.id} className={`ppath-step ${s.state}`} data-step={s.id} data-state={s.state}>
              <span className="ppath-mark" aria-hidden>
                {MARK[s.state] || i + 1}
              </span>
              <div className="ppath-body">
                <div className="ppath-title">
                  {s.title}
                  {s.state === "unknown" && <span className="badge neutral">unknown</span>}
                </div>
                <div className="ppath-status">{s.status}</div>
              </div>
              <button className={s.state === "current" ? "primary" : "ghost"} onClick={() => onOpenTab(s.tab)}>
                {s.action}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The "what you do here" line on top of a project tab; nothing for a tab
 *  without one. */
export function ProjectTabHowto({ tab }: { tab: ProjTab }) {
  const line = TAB_HOWTO[tab];
  if (!line) return null;
  return (
    <p className="dm-howto" data-tab-howto={tab}>
      <b>{line.lead}</b>
      {line.rest}
    </p>
  );
}
