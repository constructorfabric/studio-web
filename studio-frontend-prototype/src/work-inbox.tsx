/**
 * What finished while you were working.
 *
 * Background work already reports itself: `studio-tasks` publishes a `task.*`
 * event for every transition, and `studio-events` carries them with a
 * per-tenant cursor. What was missing is somewhere to notice one. The Background
 * work screen answers "what is running" for someone who went looking; this
 * answers "did my thing finish" for someone who did not.
 *
 * Deliberately only the ENDINGS. A run that is queued or half-way through is
 * not news — it is the Background work screen's subject, and putting every
 * transition here would make the count meaningless within a minute.
 *
 * Deliberately not persisted, either. This is "since you opened the portal",
 * which is a question the event cursor can answer honestly; "everything you
 * have ever been told" needs a read model with a per-person read marker, and
 * inventing one in sessionStorage would be a second source of truth that
 * disagrees with the gear the first time two tabs are open.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { BellIcon } from "./icons";
import { EmptyState } from "./ui-standard";
import { subscribeStudioEvents, type RunEventPayload, type StudioEvent } from "./studio-events";

/** How many endings to keep. Older ones are answered by Background work. */
const KEEP = 30;

export interface CompletedRun {
  runId: string;
  /** `<gear>.<verb>` — `artifact.ingest`, `connector.graph_sync`, … */
  taskType: string;
  state: "succeeded" | "failed" | "cancelled";
  /** The handler's own line, or its reason for stopping. */
  line?: string;
  atMs: number;
}

const ENDINGS = new Set(["succeeded", "failed", "cancelled"]);

/** A task type as a person would say it: `artifact.ingest` → "Artifact ingest". */
export function taskLabel(taskType: string): string {
  const words = taskType.replace(/[._]/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Background work";
}

export function runLine(payload: RunEventPayload): string | undefined {
  const line = (payload.summary ?? payload.error ?? "").trim();
  return line || undefined;
}

/**
 * Watch the channel for endings.
 *
 * `onCompleted` fires for each one as it arrives — the caller uses it to tell
 * anything else that should hear, such as an open IDE session. It is held in a
 * ref so a caller may pass a fresh closure on every render without tearing the
 * subscription down and losing its cursor.
 */
export function useCompletedWork(
  token: string,
  onCompleted?: (run: CompletedRun) => void,
): {
  runs: CompletedRun[];
  unread: number;
  markRead: () => void;
} {
  const [runs, setRuns] = useState<CompletedRun[]>([]);
  const [unread, setUnread] = useState(0);
  const notify = useRef(onCompleted);
  notify.current = onCompleted;

  useEffect(() => {
    const unsubscribe = subscribeStudioEvents(token, {
      onEvent: (event: StudioEvent) => {
        if (event.subject_type !== "task_run") return;
        const payload = event.payload as RunEventPayload;
        if (!ENDINGS.has(payload.state)) return;
        // Studio's own work ends every few minutes; announcing it would bury
        // the import somebody is actually waiting for.
        if (payload.asked_by_person === false) return;
        const run: CompletedRun = {
          runId: payload.run_id ?? event.subject_id,
          taskType: payload.task_type ?? "background work",
          state: payload.state as CompletedRun["state"],
          line: runLine(payload),
          atMs: event.at_ms,
        };
        setRuns((prev) =>
          // The stream can replay across a reconnect; the cursor dedupes by
          // sequence, but a run that ends twice in one page is still one entry.
          prev.some((r) => r.runId === run.runId) ? prev : [run, ...prev].slice(0, KEEP),
        );
        setUnread((n) => n + 1);
        notify.current?.(run);
      },
    });
    return unsubscribe;
  }, [token]);

  const markRead = useCallback(() => setUnread(0), []);
  return { runs, unread, markRead };
}

/** How long ago, in the one unit that matters at this distance. */
function ago(atMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function WorkInbox({
  runs,
  unread,
  onOpen,
  onClose,
  open,
  onSeeAll,
}: {
  runs: CompletedRun[];
  unread: number;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Background work answers everything this panel deliberately does not. */
  onSeeAll: () => void;
}) {
  return (
    <div className="work-inbox">
      <button
        className="pill"
        title={unread > 0 ? `${unread} finished since you last looked` : "Recently finished"}
        aria-label="Recently finished"
        aria-expanded={open}
        onClick={() => (open ? onClose() : onOpen())}
      >
        <BellIcon />
        {unread > 0 && <span className="count">{unread}</span>}
      </button>
      {open && (
        <div className="work-inbox-panel" role="dialog" aria-label="Recently finished">
          <div className="work-inbox-head">
            <strong>Recently finished</strong>
            <button className="ghost" onClick={onSeeAll}>
              Background work
            </button>
          </div>
          {runs.length === 0 ? (
            <EmptyState
              title="Nothing has finished since you opened the portal."
              body="Anything still running is on the Background work screen."
            />
          ) : (
            <ul className="work-inbox-list">
              {runs.map((run) => (
                <li key={run.runId} className={`work-inbox-item ${run.state}`}>
                  <span className="work-inbox-state" aria-hidden>
                    {run.state === "succeeded" ? "✓" : run.state === "failed" ? "✕" : "–"}
                  </span>
                  <span className="work-inbox-body">
                    <span className="work-inbox-title">{taskLabel(run.taskType)}</span>
                    {run.line && <span className="work-inbox-line">{run.line}</span>}
                  </span>
                  <span className="work-inbox-when">{ago(run.atMs)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
