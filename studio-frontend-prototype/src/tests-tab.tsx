// A project's Tests tab: does what we built work, and is what the specs say
// checked? A PageHeader with the mainline's state and what could not be read
// (a chip; the server's text behind its "?"; Fix the connection opens
// Sources). Three cards -- the mainline's CI, the open pull requests', and
// Spec ↔ code, which only sums up what the Specs tab shows and opens it --
// then the CI runs of the last two weeks and the open pull requests.
//
// A "test" here is a CI job: the sync reads every run's jobs and the step a
// failed one failed at. Test cases out of the jobs' reports are a later phase.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { api, type CiRun, type CiRunList, type Conformance, type OpenPullRequest } from "./api";
import { ciReadFailures, repoPathsOf, type BuildStatus } from "./builds";
import { errText, relTime } from "./format";
import type { PullRequestChecks } from "./project-checks";
import {
  dailyStrip,
  durationLabel,
  failedJobLabel,
  failedJobs,
  mainline,
  passRate,
  pullRun,
  pullsCi,
  readProblem,
  runSeconds,
  runStatus,
  specCode,
} from "./tests-model";
import { EmptyState, InfoPopover, PageHeader, StatusChip, type Tone } from "./ui-standard";

const DAY_MS = 86_400_000;

interface Read {
  runs: CiRunList;
  repoPaths: Map<string, string>;
  failures: { repo: string; error: string }[];
  pulls: OpenPullRequest[] | null;
}

/** A build status as a StatusChip's tone. */
const chipTone = (s: BuildStatus): Tone =>
  s === "passed" ? "ok" : s === "failed" ? "danger" : s === "running" || s === "queued" ? "running" : "neutral";

/** A read that failed: a chip in a few words, the server's text behind its
 *  "?", and the way to fix it when it is the connection's. */
function ReadProblem({
  text,
  onFix,
  what,
  align,
}: {
  text: string;
  onFix?: () => void;
  what?: string;
  /** Which edge of the "?" the server's text lines up with. */
  align?: "start" | "end";
}) {
  const p = readProblem(text);
  return (
    <span className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }} data-read-problem>
      <StatusChip tone="danger">
        {what ? `${what}: ` : ""}
        {p.short}
      </StatusChip>
      <InfoPopover label="What the server said" align={align}>
        {text}
      </InfoPopover>
      {p.connection && onFix && (
        <button type="button" className="linklike" onClick={onFix} data-fix-connection>
          Fix the connection
        </button>
      )}
    </span>
  );
}

export function ProjectTests({
  token,
  projectId,
  workspaceId,
  onOpenSpecs,
  onOpenSources,
}: {
  token: string;
  projectId: string;
  workspaceId: string;
  /** Open the Specs tab, where spec ↔ code is shown in full. */
  onOpenSpecs?: () => void;
  /** Open Sources, where the project's connections are managed. */
  onOpenSources?: () => void;
}) {
  const [read, setRead] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read apart, because each is slow in its own way and the CI answers without them.
  const [checks, setChecks] = useState<PullRequestChecks | { error: string } | null>(null);
  const [conformance, setConformance] = useState<Conformance | { error: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const asking = useRef(projectId);

  useEffect(() => {
    const forProject = projectId;
    asking.current = forProject;
    setRead(null);
    setError(null);
    setChecks(null);
    setConformance(null);
    const mine = () => asking.current === forProject;
    Promise.all([
      api.ciRuns(token, forProject),
      api.listArtifactNodes(token, "repo", forProject, undefined, 200).catch(() => null),
      api.openPullRequests(token, forProject).catch(() => null),
    ])
      .then(([runs, repos, pulls]) => {
        if (!mine()) return;
        setRead({
          runs,
          repoPaths: repoPathsOf(repos?.nodes ?? []),
          failures: ciReadFailures(repos?.nodes ?? []),
          pulls: pulls?.items ?? null,
        });
      })
      .catch((e: unknown) => mine() && setError(errText(e)));
    // A preview: reads what the checks say, sets nothing on the host.
    api
      .runPullRequestChecks(token, forProject, false)
      .then((c) => mine() && setChecks(c))
      .catch((e: unknown) => mine() && setChecks({ error: errText(e) }));
    Promise.all([api.declaredCapabilities(token, forProject), api.capabilities(token, workspaceId)])
      .then(([declared, vocab]) =>
        api.conformance(token, forProject, declared.items.map((c) => c.key), vocab.items ?? []),
      )
      .then((c) => mine() && setConformance(c))
      .catch((e: unknown) => mine() && setConformance({ error: errText(e) }));
  }, [token, projectId, workspaceId]);

  // One instant per read, so the cards and the strip agree on what "today" is.
  const now = useMemo(() => Date.now(), [read]);
  const main = useMemo(() => (read ? mainline(read.runs, now) : null), [read, now]);
  const recent = useMemo(
    () => (read?.runs.items ?? []).filter((r) => Date.parse(r.created_at ?? "") >= now - 14 * DAY_MS),
    [read, now],
  );
  const strip = useMemo(() => dailyStrip(read?.runs.items ?? [], now), [read, now]);
  const prCi = useMemo(
    () => (read?.pulls ? pullsCi(read.pulls, read.runs.items, read.repoPaths) : null),
    [read],
  );
  const docCheck = useMemo(() => {
    const out = new Map<string, PullRequestChecks["items"][number]>();
    if (checks && "items" in checks) for (const c of checks.items) out.set(`${c.repo}#${c.number}`, c);
    return out;
  }, [checks]);
  const docFailing = checks && "items" in checks ? checks.items.filter((c) => c.state === "failure").length : null;
  const spec = conformance && "items" in conformance ? specCode(conformance) : null;

  return (
    <>
      <PageHeader
        title="Tests"
        info={
          <p>
            Whether what the project built works, and whether what its specs say is checked. A test here is a CI job:
            every sync reads the jobs of the project&apos;s CI runs and the step a failed one failed at.
          </p>
        }
        status={
          read && (
            <>
              {main ? (
                <StatusChip tone={chipTone(main.status)} data-tests-status="mainline">
                  mainline {main.status === "passed" ? "green" : main.status === "failed" ? "red" : main.status}
                </StatusChip>
              ) : (
                <span>no CI run yet</span>
              )}
              {prCi && prCi.red > 0 && (
                <StatusChip tone="danger" data-tests-status="pulls">
                  {prCi.red} pull request{prCi.red === 1 ? "" : "s"} red
                </StatusChip>
              )}
              {read.failures.map((f) => (
                <span key={f.repo} data-tests-ci-error>
                  <ReadProblem text={`Studio could not read the CI runs of ${f.repo}: ${f.error}`} what={f.repo} onFix={onOpenSources} />
                </span>
              ))}
            </>
          )
        }
      />
      {error && <div className="error">{error}</div>}
      {!error && !read && <div className="empty">Loading…</div>}
      {read && (
        <div className="dash-stats" data-tests-cards>
          <div className={`stat ${main ? (main.status === "passed" ? "ok" : main.status === "failed" ? "danger" : "") : ""}`} data-tests-mainline>
            <span className="stat-k">Mainline{main?.branch ? ` · ${main.branch}` : ""}</span>
            <span className="stat-n">{main ? (main.status === "passed" ? "CI passed" : main.status === "failed" ? "CI failed" : main.status) : "No run yet"}</span>
            {main && (
              <>
                <span className="stat-sub">
                  {main.run.workflow} · <code>{main.run.sha.slice(0, 7)}</code> · {relTime(main.run.created_at)}
                </span>
                {main.failed.map((j) => (
                  <span key={j.name} className="stat-sub" data-tests-mainline-failed>
                    ✗ {failedJobLabel(j)}
                  </span>
                ))}
                <span className="stat-sub">
                  {main.week ? `7 days: ${passRate(main.week)} of ${main.week.finished} runs green` : "No run in the last 7 days"}
                </span>
              </>
            )}
          </div>
          <div className={`stat ${prCi && prCi.red > 0 ? "danger" : prCi && prCi.green > 0 ? "ok" : ""}`} data-tests-pulls-card>
            <span className="stat-k">Open pull requests</span>
            <span className="stat-n">
              {read.pulls === null ? "—" : read.pulls.length === 0 ? "None open" : `${prCi?.green ?? 0}/${read.pulls.length} green`}
            </span>
            {prCi && read.pulls && read.pulls.length > 0 && (
              <span className="stat-sub">
                {[
                  prCi.red ? `${prCi.red} red` : null,
                  prCi.running ? `${prCi.running} running` : null,
                  prCi.none ? `${prCi.none} with no run` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "every one green"}
              </span>
            )}
            <span className="stat-sub">
              {checks === null
                ? "Checking documents…"
                : "error" in checks
                  ? "Documents could not be checked"
                  : checks.total === 0
                    ? "No document of a known type changed"
                    : docFailing
                      ? `${docFailing} document check${docFailing === 1 ? "" : "s"} fail`
                      : "Document checks pass"}
            </span>
          </div>
          {conformance && "error" in conformance ? (
            <div className="stat danger" data-tests-spec-card data-tests-spec-error>
              <span className="stat-k">Spec ↔ code</span>
              <span className="stat-n" style={{ fontSize: 14 }}>
                <ReadProblem text={conformance.error} onFix={onOpenSources} align="end" />
              </span>
            </div>
          ) : (
            <button
              type="button"
              className={`stat ${spec ? (spec.missing > 0 ? "warn" : "ok") : ""}`}
              disabled={!onOpenSpecs}
              onClick={onOpenSpecs}
              title="Spec ↔ code is shown in full on Specs"
              data-tests-spec-card
            >
              <span className="stat-k">Spec ↔ code</span>
              <span className="stat-n">{spec ? `${spec.implemented}/${spec.functional} covered` : "…"}</span>
              <span className="stat-sub">
                {spec
                  ? [spec.missing ? `${spec.missing} with no code` : "every capability has code", spec.nonfunctional ? `${spec.nonfunctional} non-functional` : null]
                      .filter(Boolean)
                      .join(" · ")
                  : "Reading the specs against the code…"}
              </span>
              {onOpenSpecs && <span className="stat-sub">Open Specs →</span>}
            </button>
          )}
        </div>
      )}

      {read && (
        <section className="card" data-tests-runs>
          <div className="card-head">
            <h2>
              CI runs, last 14 days{" "}
              <InfoPopover label="About the CI runs">Newest first. A run opens to its jobs; a job links to its page in CI.</InfoPopover>
            </h2>
          </div>
          <div className="tt-strip" aria-label="Runs per day, green and red" data-tests-strip>
            {strip.map((d) => (
              <span
                key={d.day}
                className={`tt-day${d.failed ? " red" : d.passed ? " green" : ""}`}
                title={`${d.day}: ${d.passed} green, ${d.failed} red`}
              />
            ))}
          </div>
          {recent.length === 0 ? (
            <EmptyState
              title="No CI run in the last 14 days."
              body="Runs arrive with a sync of the project's sources, if the connection can read the repositories' Actions."
            />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="table" data-tests-runs-table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Workflow</th>
                    <th>Branch</th>
                    <th>Commit</th>
                    <th>Failed</th>
                    <th>When</th>
                    <th>Took</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <RunRow key={r.id} run={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {read?.pulls && read.pulls.length > 0 && (
        <section className="card" data-tests-pulls>
          <div className="card-head">
            <h2>
              Pull requests{" "}
              <InfoPopover label="About the pull requests">
                Each open pull request&apos;s newest CI run on its branch, and what the document checks say about the
                documents it changes.
              </InfoPopover>
            </h2>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table" data-tests-pulls-table>
              <thead>
                <tr>
                  <th>Pull request</th>
                  <th>CI</th>
                  <th>Documents</th>
                  <th>Waiting</th>
                </tr>
              </thead>
              <tbody>
                {read.pulls.map((p) => {
                  const r = pullRun(p, read.runs.items, read.repoPaths);
                  const s = r ? runStatus(r) : null;
                  const doc = docCheck.get(`${p.repo}#${p.number}`);
                  return (
                    <tr key={p.id} data-tests-pull={s ?? "none"}>
                      <td style={{ minWidth: 240 }}>
                        {p.url ? (
                          <a href={p.url} target="_blank" rel="noreferrer">
                            #{p.number}
                          </a>
                        ) : (
                          `#${p.number}`
                        )}{" "}
                        {p.title}
                        {p.repo ? <span className="sub"> · {p.repo}</span> : null}
                      </td>
                      <td>
                        {r && s ? (
                          <>
                            <StatusChip tone={chipTone(s)}>{s}</StatusChip>
                            {failedJobs(r).map((j) => (
                              <div key={j.name} className="sub">
                                ✗ {failedJobLabel(j)}
                              </div>
                            ))}
                          </>
                        ) : (
                          <span className="sub">{p.source_branch ? "no run on its branch" : "branch unknown"}</span>
                        )}
                      </td>
                      <td>
                        {checks === null ? (
                          <span className="sub">…</span>
                        ) : doc ? (
                          <>
                            <StatusChip tone={doc.state === "success" ? "ok" : "warn"}>
                              {doc.state === "success" ? "pass" : "fail"}
                            </StatusChip>
                            {doc.files
                              .filter((f) => !f.conforms)
                              .map((f) => (
                                <div key={f.path} className="sub">
                                  {f.path}: {f.issues.join("; ")}
                                </div>
                              ))}
                          </>
                        ) : (
                          <span className="sub">no document</span>
                        )}
                      </td>
                      <td>
                        {p.days_open != null ? `${p.days_open} d open` : "—"}
                        {p.waiting_on.length > 0 && (
                          <div className="sub">on {p.waiting_on.map((w) => w.display_name ?? w.login).join(", ")}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/** A run, and under it its jobs when opened. */
function RunRow({ run, open, onToggle }: { run: CiRun; open: boolean; onToggle: () => void }) {
  const s = runStatus(run);
  const failed = failedJobs(run);
  const jobs = run.jobs ?? [];
  return (
    <Fragment>
      <tr data-tests-run={s} onClick={jobs.length ? onToggle : undefined} style={jobs.length ? { cursor: "pointer" } : undefined}>
        <td>
          <StatusChip tone={chipTone(s)}>{s}</StatusChip>
        </td>
        <td style={{ whiteSpace: "nowrap" }}>
          {run.url ? (
            <a href={run.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              {run.workflow}
            </a>
          ) : (
            run.workflow
          )}
          {jobs.length > 0 && <span className="sub"> · {open ? "▾" : "▸"} {jobs.length} jobs</span>}
        </td>
        <td>
          {run.branch ? (
            <StatusChip tone="neutral" className="chip-trunc" title={run.branch}>
              {run.branch}
            </StatusChip>
          ) : (
            "—"
          )}
        </td>
        <td className="tt-commit" title={run.title ?? undefined}>
          <code>{run.sha.slice(0, 7)}</code> {run.title}
        </td>
        <td>{failed.length ? failed.map(failedJobLabel).join(", ") : "—"}</td>
        <td style={{ whiteSpace: "nowrap" }}>{relTime(run.created_at)}</td>
        <td style={{ whiteSpace: "nowrap" }}>{durationLabel(runSeconds(jobs)) ?? "—"}</td>
      </tr>
      {open &&
        jobs.map((j) => {
          const js = runStatus(j);
          return (
            <tr key={`${run.id}:${j.name}`} className="tt-job" data-tests-job={js}>
              <td>
                <StatusChip tone={chipTone(js)}>{js}</StatusChip>
              </td>
              <td colSpan={3}>
                {j.url ? (
                  <a href={j.url} target="_blank" rel="noreferrer">
                    {j.name}
                  </a>
                ) : (
                  j.name
                )}
              </td>
              <td>{j.failed_step ?? "—"}</td>
              <td />
              <td>{durationLabel(j.duration_seconds) ?? "—"}</td>
            </tr>
          );
        })}
    </Fragment>
  );
}
