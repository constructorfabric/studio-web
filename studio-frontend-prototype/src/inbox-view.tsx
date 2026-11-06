/* ── Inbox: the person's page of everything that waits for them ──────────────
 *
 * The shell reads it once (`useInbox`) for the count on its Inbox button and
 * for this page. Each source of inbox-sources.ts is read on its own, so one
 * that cannot be read costs its own items and says so, not the page. Read
 * again every two minutes, after anything done from here, and when a review
 * event concerns the person. Marks are studio-user's `me/inbox-marks`. */

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "./api";
import { errText } from "./format";
import { InboxIcon } from "./icons";
import { countBySource, mergeInbox, type InboxAction, type InboxEntry, type InboxMark, type SourceResult } from "./inbox";
import { inboxSources, type InboxContext } from "./inbox-sources";
import { subscribeStudioEvents } from "./studio-events";
import { EmptyState, PageHeader, StatusChip } from "./ui-standard";
import { snoozeUntil } from "./waiting-on-me";

const REREAD_MS = 120_000;

/** The sign-in subject, read from the token: what a run names its asker by. */
function subjectOf(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

export interface InboxState {
  results: SourceResult[] | null;
  marks: InboxMark[];
  open: InboxEntry[];
  hidden: InboxEntry[];
  errors: { source: string; label: string; error: string }[];
  reload: () => void;
  mark: (entry: InboxEntry, state: "done" | "snoozed" | "open") => Promise<void>;
}

/** Every source read for the organization in view, merged with the marks. */
export function useInbox(
  token: string,
  org: { id: string } | null,
  workspaces: { id: string; name: string }[],
): InboxState {
  const [results, setResults] = useState<SourceResult[] | null>(null);
  const [marks, setMarks] = useState<InboxMark[]>([]);
  const [me, setMe] = useState<string[]>(() => [subjectOf(token)].filter((x): x is string => !!x));
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    api
      .myProfile(token)
      .then((p) => setMe((m) => [...new Set([...m, p.id])]))
      .catch(() => {});
  }, [token]);

  const wsKey = workspaces.map((w) => w.id).join(",");
  const meKey = me.join(",");
  useEffect(() => {
    if (!org) {
      setResults([]);
      return;
    }
    let live = true;
    const ctx: InboxContext = { token, orgId: org.id, workspaces, me };
    void (async () => {
      const [read, myMarks] = await Promise.all([
        Promise.all(
          inboxSources().map(async (s): Promise<SourceResult> => {
            try {
              return { source: s.id, label: s.label, entries: await s.read(ctx) };
            } catch (e) {
              return { source: s.id, label: s.label, entries: [], error: errText(e) };
            }
          }),
        ),
        api.inboxMarks(token).catch(() => [] as InboxMark[]),
      ]);
      if (!live) return;
      setResults(read);
      setMarks(myMarks);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, org?.id, wsKey, meKey, tick]);

  // Read again now and then, and when a review moves.
  useEffect(() => {
    const timer = window.setInterval(reload, REREAD_MS);
    const unsubscribe = subscribeStudioEvents(token, {
      onEvent: (frame) => {
        if (frame.subject_type === "review_request" || frame.subject_type === "deployment") reload();
      },
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [token, reload]);

  const merged = useMemo(() => mergeInbox(results ?? [], marks, new Date()), [results, marks]);

  const mark = useCallback(
    async (entry: InboxEntry, state: "done" | "snoozed" | "open") => {
      const until = state === "snoozed" ? snoozeUntil(new Date(), 1) : null;
      setMarks((all) => [
        { item_key: entry.key, state, until, updated_at: new Date().toISOString() },
        ...all.filter((m) => m.item_key !== entry.key),
      ]);
      try {
        await api.markInboxItem(token, entry.key, state, until);
      } catch {
        reload();
      }
    },
    [token, reload],
  );

  return { results, marks, ...merged, reload, mark };
}

/** The top bar's way in: the inbox icon and how many items are open. */
export function InboxButton({ count, active, onOpen }: { count: number | null; active: boolean; onOpen: () => void }) {
  return (
    <button
      className="pill"
      title={count ? `Inbox: ${count} waiting for you` : "Inbox"}
      aria-label={count ? `Inbox, ${count} waiting` : "Inbox"}
      aria-pressed={active}
      onClick={onOpen}
      data-inbox-button
    >
      <InboxIcon />
      {!!count && <span className="count">{count}</span>}
    </button>
  );
}

const TONE = { danger: "danger", warn: "warn", info: "info" } as const;

export function InboxView({
  inbox,
  onOpenProject,
  onOpenView,
}: {
  inbox: InboxState;
  onOpenProject: (workspaceId: string, projectId: string) => void;
  onOpenView: (view: string) => void;
}) {
  const [only, setOnly] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sources = inboxSources();
  const counts = countBySource(inbox.open);
  const list = (showHidden ? [...inbox.open, ...inbox.hidden] : inbox.open).filter((e) => !only || e.source === only);

  const act = async (entry: InboxEntry, a: InboxAction) => {
    if (a.kind === "link") {
      window.open(a.href, "_blank", "noopener,noreferrer");
      return;
    }
    if (a.kind === "open") {
      if (a.projectId && a.workspaceId) onOpenProject(a.workspaceId, a.projectId);
      else if (a.view) onOpenView(a.view);
      return;
    }
    let reason: string | undefined;
    if (a.ask) {
      const said = window.prompt(a.ask);
      if (said === null || !said.trim()) return;
      reason = said.trim();
    }
    setBusy(entry.key);
    setError(null);
    try {
      await a.run(reason);
      inbox.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="inbox" data-inbox>
      <PageHeader
        title="Inbox"
        status={
          inbox.results === null ? (
            <StatusChip tone="running">reading…</StatusChip>
          ) : (
            <StatusChip tone={inbox.open.length ? "warn" : "ok"}>
              {inbox.open.length ? `${inbox.open.length} waiting for you` : "nothing waits for you"}
            </StatusChip>
          )
        }
        info={
          <>
            Everything that waits for you, across the organization&apos;s projects: deploys to approve, reviews asked
            of you, pull requests whose next move is yours, and your background work that failed -- an undelivered
            notification among it. Each item is read from its fact, so it leaves when the fact changes; Done hides it
            until it changes again, Snooze for a day. An agent reads the same list through studio-mcp&apos;s{" "}
            <code>inbox</code> tool.
          </>
        }
      />
      <div className="card">
        <div className="dt-toolbar">
          <div className="dt-chips" role="group" aria-label="Show">
            <button className={`chip${only === null ? " on" : ""}`} onClick={() => setOnly(null)}>
              Everything<span className="dt-chip-n">{inbox.open.length}</span>
            </button>
            {sources.map((s) => (
              <button key={s.id} className={`chip${only === s.id ? " on" : ""}`} onClick={() => setOnly(only === s.id ? null : s.id)}>
                {s.label}
                <span className="dt-chip-n">{counts[s.id] ?? 0}</span>
              </button>
            ))}
          </div>
          <button className="ghost" onClick={inbox.reload}>
            Refresh
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {inbox.results === null ? (
          <p className="sub">Reading what waits for you…</p>
        ) : list.length === 0 ? (
          <EmptyState
            title={inbox.hidden.length ? "Nothing new." : "Nothing waits for you."}
            body={inbox.hidden.length ? `${inbox.hidden.length} done or snoozed.` : undefined}
          />
        ) : (
          <ul className="att-list inbox-list">
            {list.map((e) => {
              const isHidden = inbox.hidden.includes(e);
              return (
                <li key={e.key} className={`att-row tone-${e.overdue ? "warn" : e.tone}`} data-inbox-item={e.source} data-hidden-item={isHidden || undefined}>
                  <span className="att-text">
                    <StatusChip tone={TONE[e.tone]}>{e.label}</StatusChip> <b>{e.title}</b>
                    {e.detail && <span className="sub"> · {e.detail}</span>}
                    {e.at && <span className="sub"> · {e.at.slice(0, 10)}</span>}
                  </span>
                  <span className="inbox-actions">
                    {e.actions.map((a) => (
                      <button
                        key={a.label}
                        type="button"
                        className={a.kind === "call" && !a.danger ? "primary" : a.kind === "call" && a.danger ? "danger" : "ghost"}
                        disabled={busy === e.key}
                        onClick={() => void act(e, a)}
                      >
                        {a.label}
                      </button>
                    ))}
                    {isHidden ? (
                      <button type="button" className="linklike" onClick={() => void inbox.mark(e, "open")}>
                        Unmark
                      </button>
                    ) : (
                      <>
                        <button type="button" className="ghost" title="Hide it until it changes" onClick={() => void inbox.mark(e, "done")}>
                          Done
                        </button>
                        <button type="button" className="ghost" title="Hide it for a day" onClick={() => void inbox.mark(e, "snoozed")}>
                          Snooze
                        </button>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {inbox.hidden.length > 0 && (
          <p className="sub">
            {inbox.hidden.length} done or snoozed.{" "}
            <button className="linklike" onClick={() => setShowHidden((s) => !s)}>
              {showHidden ? "Hide them" : "Show them"}
            </button>
          </p>
        )}
        {inbox.errors.map((er) => (
          <p key={er.source} className="sub inbox-error">
            {er.label} could not be read: {er.error}
          </p>
        ))}
      </div>
    </div>
  );
}
