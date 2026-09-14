/**
 * Background work — the Platform surface over `studio-tasks` and
 * `studio-scheduler`.
 *
 * Two lists, because they answer different questions. **Runs** is "what has
 * this deployment been doing, and what went wrong" — the durable history that
 * replaced three in-memory registries. **Schedules** is "what fires on its
 * own", with the one control a person needs: run it now.
 *
 * Scope note: runs are tenant-scoped and this page reads the caller's own
 * tenant, which on the Platform surface is the platform root — where every
 * *scheduled* run lives. A repository import started inside an organization
 * belongs to that organization's tenant and is not listed here.
 */

import { Fragment, useEffect, useMemo, useState } from "react";

import { api, type TaskRun, type TaskSchedule } from "./api";
import { errText } from "./format";
import { subscribeStudioEvents } from "./studio-events";

/** How often the list refreshes while something is still moving. */
const LIVE_POLL_MS = 4000;

const STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

/** Run state → the badge the rest of the prototype already uses. */
function stateBadge(state: string): string {
  switch (state) {
    case "succeeded":
      return "ok";
    case "running":
      return "syncing";
    case "failed":
      return "failed";
    case "cancelled":
      return "warn";
    default:
      return "neutral";
  }
}

function when(iso?: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/** How long a run took, or has been going. */
function duration(run: TaskRun): string {
  if (!run.started_at) return "—";
  const from = new Date(run.started_at).getTime();
  const to = run.finished_at ? new Date(run.finished_at).getTime() : Date.now();
  const ms = to - from;
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * The one line worth showing per run: what it did, why it stopped, or where it
 * has got to — in that order. Same rule the backend's own poll endpoint uses.
 */
function headline(run: TaskRun): string {
  return run.summary || run.last_error || run.progress || "—";
}

export function BackgroundWork({ token, query }: { token: string; query: string }) {
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [schedules, setSchedules] = useState<TaskSchedule[] | null>(null);
  const [taskTypes, setTaskTypes] = useState<string[]>([]);
  const [state, setState] = useState<string>("");
  const [taskType, setTaskType] = useState<string>("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const load = async () => {
    const [runPage, typePage] = await Promise.all([
      api.taskRuns(token, { state: state || undefined, taskType: taskType || undefined, limit: 200 }),
      api.taskTypes(token),
    ]);
    setRuns(runPage.items);
    setTaskTypes(typePage.items);
    // The scheduler is optional — a deployment can run background work with
    // nothing firing on its own — so its absence is a note, not an error.
    try {
      const schedulePage = await api.schedules(token);
      setSchedules(schedulePage.items);
    } catch {
      setSchedules([]);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const run = () =>
      load().then(
        () => {
          if (!cancelled) setUnavailable(null);
        },
        (reason) => {
          if (cancelled) return;
          const text = errText(reason);
          // 503 means studio-tasks has no database in this deployment, which
          // is a configuration fact rather than a failure to report as one.
          if (text.includes("not available in this deployment")) {
            setUnavailable(text);
            setRuns([]);
            setSchedules([]);
          } else {
            setError(text);
            setRuns([]);
          }
        },
      );
    run();
    return () => {
      cancelled = true;
    };
  }, [token, state, taskType]);

  // studio-tasks announces every run transition on studio-events, so the list
  // refreshes when something actually happens rather than on a timer. The
  // interval stays as a floor: it covers a deployment without the channel, and
  // a reload is cheap next to a missed state change.
  const live = (runs ?? []).some((r) => r.state === "queued" || r.state === "running");
  useEffect(() => {
    const refresh = () => {
      load().catch(() => {
        /* a failed refresh keeps the last good list */
      });
    };
    // A busy run reports progress several times a second; one reload per burst
    // is what the list actually needs.
    let coalesce: ReturnType<typeof setTimeout> | null = null;
    const refreshSoon = () => {
      if (coalesce) return;
      coalesce = setTimeout(() => {
        coalesce = null;
        refresh();
      }, 300);
    };
    const unsubscribe = subscribeStudioEvents(token, {
      onEvent: (event) => {
        if (event.subject_type === "task_run") refreshSoon();
      },
    });
    const stop = () => {
      if (coalesce) clearTimeout(coalesce);
      unsubscribe();
    };
    if (!live) return stop;
    const timer = setInterval(refresh, LIVE_POLL_MS);
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [live, token, state, taskType]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return runs ?? [];
    return (runs ?? []).filter((run) =>
      [run.task_type, run.state, headline(run), run.partition_key ?? "", run.id]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [runs, query]);

  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    for (const run of runs ?? []) by[run.state] = (by[run.state] ?? 0) + 1;
    return by;
  }, [runs]);

  async function act(run: TaskRun, what: "cancel" | "retry") {
    setBusyId(run.id);
    setError(null);
    try {
      if (what === "cancel") await api.cancelTaskRun(token, run.id);
      else await api.retryTaskRun(token, run.id);
      await load();
    } catch (reason) {
      setError(errText(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function fire(schedule: TaskSchedule) {
    setBusyId(schedule.id);
    setError(null);
    try {
      await api.runScheduleNow(token, schedule.id);
      await load();
    } catch (reason) {
      setError(errText(reason));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Background work</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Every run this deployment has queued, and the schedules that fire them. Runs survive a
            restart, are retried with backoff, and end up in a dead-letter table rather than
            nowhere.
          </p>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {unavailable && <div className="hint">{unavailable}</div>}

      <div className="card">
        <h2>Runs</h2>
        <div className="chips" style={{ marginBottom: 12 }}>
          <button className={`chip ${state === "" ? "on" : ""}`} onClick={() => setState("")}>
            All <span className="chip-n">{(runs ?? []).length}</span>
          </button>
          {STATES.map((s) => (
            <button
              key={s}
              className={`chip ${state === s ? "on" : ""}`}
              onClick={() => setState(state === s ? "" : s)}
            >
              {s} <span className="chip-n">{counts[s] ?? 0}</span>
            </button>
          ))}
          {taskTypes.length > 0 && (
            <select
              value={taskType}
              onChange={(e) => setTaskType(e.target.value)}
              style={{ marginLeft: 8 }}
            >
              <option value="">every task type</option>
              {taskTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          {live && <span className="sub" style={{ marginLeft: 8 }}>live · refreshing</span>}
        </div>

        {runs === null ? (
          <p className="hint">Loading runs…</p>
        ) : filtered.length === 0 ? (
          <p className="empty">
            {(runs ?? []).length === 0
              ? "Nothing has been queued yet."
              : "No runs match the filter."}
          </p>
        ) : (
          <table className="ptable">
            <thead>
              <tr>
                <th>Task</th>
                <th>State</th>
                <th>What happened</th>
                <th>Tries</th>
                <th>Took</th>
                <th>Started</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((run) => {
                const open = expanded === run.id;
                const finished =
                  run.state === "succeeded" || run.state === "failed" || run.state === "cancelled";
                return (
                  <Fragment key={run.id}>
                    <tr className="prow">
                      <td>
                        <div className="pname plain">{run.task_type}</div>
                        <div className="sub">{run.id.slice(0, 8)}</div>
                      </td>
                      <td>
                        <span className={`badge ${stateBadge(run.state)}`}>{run.state}</span>
                        {run.cancel_requested && !finished && (
                          <div className="sub" style={{ marginTop: 4 }}>
                            stop requested
                          </div>
                        )}
                      </td>
                      <td className="sub">{headline(run)}</td>
                      <td className="sub">{run.attempts}</td>
                      <td className="sub">{duration(run)}</td>
                      <td className="sub">{when(run.started_at ?? run.created_at)}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button
                          className="linklike"
                          onClick={() => setExpanded(open ? null : run.id)}
                        >
                          {open ? "less" : "details"}
                        </button>
                        {!finished && (
                          <button
                            className="ghost"
                            disabled={busyId === run.id || run.cancel_requested}
                            onClick={() => act(run, "cancel")}
                            title="Cooperative: a handler that never checks will not stop"
                            style={{ marginLeft: 8 }}
                          >
                            Cancel
                          </button>
                        )}
                        {(run.state === "failed" || run.state === "cancelled") && (
                          <button
                            className="ghost"
                            disabled={busyId === run.id}
                            onClick={() => act(run, "retry")}
                            style={{ marginLeft: 8 }}
                          >
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7}>
                          <div className="rows">
                            <Detail label="Run id" value={run.id} />
                            <Detail label="Requested by" value={run.requested_by} />
                            {run.partition_key && (
                              <Detail label="Ordered with" value={run.partition_key} />
                            )}
                            <Detail label="Created" value={when(run.created_at)} />
                            <Detail label="Finished" value={when(run.finished_at)} />
                            {run.progress && <Detail label="Last phase" value={run.progress} />}
                            {run.last_error && <Detail label="Error" value={run.last_error} />}
                            <Json label="Payload" value={run.payload} />
                            {run.result && <Json label="Result" value={run.result} />}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Schedules</h2>
        {schedules === null ? (
          <p className="hint">Loading schedules…</p>
        ) : schedules.length === 0 ? (
          <p className="empty">
            Nothing is scheduled. Schedules are platform-level and fire under a database lock, so
            one deployment fires each instant once however many replicas are running.
          </p>
        ) : (
          <table className="ptable">
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Runs</th>
                <th>Cadence</th>
                <th>Policies</th>
                <th>Next</th>
                <th>Last</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule.id} className="prow">
                  <td>
                    <div className="pname plain">{schedule.name}</div>
                    {!schedule.enabled && <span className="badge warn">disabled</span>}
                  </td>
                  <td className="sub">{schedule.task_type}</td>
                  <td className="sub">
                    {schedule.expression}
                    <div className="sub">
                      {schedule.expression_kind} · {schedule.timezone}
                    </div>
                  </td>
                  <td className="sub">
                    {schedule.concurrency} · {schedule.missed_policy}
                    {schedule.missed_policy === "backfill" && ` (≤${schedule.max_catch_up_runs})`}
                  </td>
                  <td className="sub">{when(schedule.next_run_at)}</td>
                  <td className="sub">{when(schedule.last_fired_at)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      className="ghost"
                      disabled={busyId === schedule.id}
                      onClick={() => fire(schedule)}
                    >
                      Run now
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {taskTypes.length > 0 && (
        <div className="card">
          <h2>What this deployment can run</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            One entry per registered handler. A task type missing from this list cannot run here
            because the gear that owns it is not linked into the assembly.
          </p>
          <div className="chipset">
            {taskTypes.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <li>
      <div className="grow">
        <div className="sub">{label}</div>
        <div className="name" style={{ fontWeight: 400, wordBreak: "break-word" }}>
          {value}
        </div>
      </div>
    </li>
  );
}

function Json({ label, value }: { label: string; value: Record<string, unknown> }) {
  return (
    <li>
      <div className="grow">
        <div className="sub">{label}</div>
        <pre
          style={{
            margin: "4px 0 0",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 12,
          }}
        >
          {JSON.stringify(value, null, 2)}
        </pre>
      </div>
    </li>
  );
}
