/* ── Waiting on you ────────────────────────────────────────────────────────────
 *
 * The "For you" half of the organization overview's "Needs attention" list:
 * what somebody waits on the reader for, across every project they can see --
 * the reviews somebody asked them for, and the open pull requests whose next
 * move is theirs. The overdue first; a row is one sentence and one action. Each item is read from its fact, so it leaves by itself when the
 * fact changes; what the reader keeps is a mark — done, or snoozed — which
 * follows them to any browser (studio-user `me/inbox-marks`).
 *
 * Reads per workspace: `review-requests?workspace_id=&waiting_on=me` and
 * `open-pull-requests?workspace_id=&waiting_on=me`. The backend decides who
 * "me" is — the person behind the sign-in — so a reader who signed in another
 * way still gets their own list. A review event about the reader reads it
 * again (studio-events, `review_request.*`). */

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "./api";
import type { OpenPullRequest } from "./api";
import { errText } from "./format";
import {
  MY_LABEL,
  WAITING_SENTENCE,
  WAITING_TONE,
  ageLine,
  isQuiet,
  myEmptyMessage,
  myPullsInOrder,
  prRef,
} from "./pull-request-waits";
import type { ReviewRequest } from "./review-requests";
import { subscribeStudioEvents } from "./studio-events";
import { InfoPopover, StatusChip, type Tone } from "./ui-standard";
import { concernsMe, inboxItems, snoozeUntil, type InboxItem, type InboxMark } from "./waiting-on-me";

export interface OnMeWorkspace {
  id: string;
  name: string;
}

export function WaitingOnYou<W extends OnMeWorkspace>({
  token,
  workspaces,
  onOpenWorkspace,
  onCount,
}: {
  token: string;
  workspaces: W[];
  onOpenWorkspace: (ws: W) => void;
  /** How many items are open, once read (null until then). */
  onCount?: (n: number | null) => void;
}) {
  const [pulls, setPulls] = useState<{ workspace: string; items: OpenPullRequest[] }[] | null>(null);
  const [reviews, setReviews] = useState<{ workspace: string; items: ReviewRequest[] }[]>([]);
  const [marks, setMarks] = useState<InboxMark[]>([]);
  const [membersKnown, setMembersKnown] = useState(true);
  const [failed, setFailed] = useState<string[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    api
      .myProfile(token)
      .then((p) => setMe(p.id))
      .catch(() => setMe(null));
  }, [token]);

  // Re-read only when the set of workspaces changes, not on every new array.
  const key = workspaces.map((w) => w.id).join(",");
  useEffect(() => {
    let live = true;
    (async () => {
      let known = true;
      const errors: string[] = [];
      const [perPulls, perReviews, myMarks] = await Promise.all([
        Promise.all(
          workspaces.map(async (ws) => {
            try {
              const items: OpenPullRequest[] = [];
              for (let offset = 0; ; ) {
                const page = await api.pullRequestsWaitingOnMe(token, ws.id, offset);
                items.push(...page.items);
                known = known && page.members_known;
                offset += page.items.length;
                if (page.items.length === 0 || offset >= page.total) break;
              }
              return { workspace: ws.id, items: myPullsInOrder(items) };
            } catch (e) {
              errors.push(`${ws.name}: ${errText(e)}`);
              return { workspace: ws.id, items: [] };
            }
          }),
        ),
        // A backend from before reviews answers 404: there are simply none.
        Promise.all(
          workspaces.map(async (ws) => ({
            workspace: ws.id,
            items: await api
              .reviewRequestsWaitingOnMe(token, ws.id)
              .then((r) => r.items)
              .catch(() => [] as ReviewRequest[]),
          })),
        ),
        api.inboxMarks(token).catch(() => [] as InboxMark[]),
      ]);
      if (!live) return;
      setPulls(perPulls);
      setReviews(perReviews);
      setMarks(myMarks);
      setMembersKnown(known);
      setFailed(errors);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, key, tick]);

  // A review asked of the reader, or decided on what they asked: read again.
  useEffect(() => {
    if (!me) return;
    let timer: number | undefined;
    const unsubscribe = subscribeStudioEvents(token, {
      onEvent: (frame) => {
        if (!concernsMe(frame, me)) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setTick((t) => t + 1), 300);
      },
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [token, me]);

  const { open, hidden, hiddenItems } = useMemo(
    () => inboxItems(reviews, pulls ?? [], marks, new Date()),
    [reviews, pulls, marks],
  );

  const mark = useCallback(
    async (item: InboxItem, state: "done" | "snoozed" | "open") => {
      const until = state === "snoozed" ? snoozeUntil(new Date(), 1) : null;
      // Shown at once; the server's answer replaces it.
      setMarks((all) => [
        { item_key: item.key, state, until, updated_at: new Date().toISOString() },
        ...all.filter((m) => m.item_key !== item.key),
      ]);
      try {
        await api.markInboxItem(token, item.key, state, until);
      } catch {
        setTick((t) => t + 1);
      }
    },
    [token],
  );

  // "Unmark all": the hidden items' marks only, every request awaited; on
  // any failure the marks are read again rather than shown cleared (#744).
  const unmarkHidden = useCallback(async () => {
    const keys = hiddenItems.map((i) => i.key);
    const results = await Promise.allSettled(keys.map((k) => api.markInboxItem(token, k, "open", null)));
    if (results.some((r) => r.status === "rejected")) {
      setTick((t) => t + 1);
    } else {
      setMarks((all) => all.filter((m) => !keys.includes(m.item_key)));
    }
    setShowHidden(false);
  }, [hiddenItems, token]);

  const shown = showHidden ? [...open, ...hiddenItems] : open;
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "";
  const wsOf = (id: string) => workspaces.find((w) => w.id === id);

  // The overview's header counts these with the organization's own.
  useEffect(() => {
    onCount?.(pulls === null ? null : open.length);
  }, [onCount, pulls, open.length]);

  return (
    <div className="att-group" data-attention-group="you">
      <h3 className="att-group-title">
        For you{pulls !== null && open.length > 0 ? <span className="att-count">{open.length}</span> : null}
      </h3>
      {pulls === null ? (
        <p className="sub att-empty">Reading what waits for you…</p>
      ) : shown.length === 0 ? (
        <p className="sub att-empty">
          {failed.length === workspaces.length && failed.length > 0
            ? `Pull requests could not be read: ${failed[0]}`
            : hidden > 0
              ? `Nothing new. ${hidden} item${hidden === 1 ? " is" : "s are"} done or snoozed.`
              : (
                <>
                  Nothing waits on you.{" "}
                  <InfoPopover label="Why is nothing here?">{myEmptyMessage({ membersKnown, workspaces: workspaces.length })}</InfoPopover>
                </>
              )}
        </p>
      ) : (
        <ul className="att-list">
          {shown.map((item) => {
            const isHidden = hiddenItems.includes(item);
            return (
              <li
                key={item.key}
                className={`att-row tone-${item.overdue ? "warn" : "info"}`}
                data-attention={item.kind}
                data-hidden-item={isHidden || undefined}
              >
                <span className="att-text">
                  {item.kind === "review" ? (
                    <>
                      Review <b>{item.review.title}</b>
                      <span className="sub">
                        {" "}
                        · {item.review.requested_by_name ?? "a colleague"} asked, {wsName(item.workspace)}
                        {item.due && <> · due {item.due.slice(0, 10)}</>}
                      </span>
                      {item.overdue && <StatusChip tone="warn">overdue</StatusChip>}
                    </>
                  ) : (
                    <>
                      <b>{item.pull.title}</b>
                      <span className="sub">
                        {" "}
                        · {prRef(item.pull)}, {wsName(item.workspace)} · {ageLine(item.pull)}
                      </span>{" "}
                      <StatusChip tone={chipTone(WAITING_TONE[item.pull.waiting])} title={WAITING_SENTENCE[item.pull.waiting]}>
                        {MY_LABEL[item.pull.waiting]}
                      </StatusChip>
                      {isQuiet(item.pull) && <StatusChip tone="warn">quiet</StatusChip>}
                    </>
                  )}
                </span>
                {item.kind === "pull" && item.pull.url ? (
                  <a className="att-action" href={item.pull.url} target="_blank" rel="noreferrer">
                    Open pull request ↗
                  </a>
                ) : (
                  <button
                    type="button"
                    className="ghost att-action"
                    onClick={() => {
                      const ws = wsOf(item.workspace);
                      if (ws) onOpenWorkspace(ws);
                    }}
                  >
                    Open project
                  </button>
                )}
                {isHidden ? (
                  <button type="button" className="linklike att-mark" title="Show it again" onClick={() => void mark(item, "open")}>
                    Unmark
                  </button>
                ) : (
                  <details className="att-more">
                    <summary aria-label="More" title="Done or snooze">
                      ⋯
                    </summary>
                    <div className="att-more-list" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}>
                      <button type="button" onClick={() => void mark(item, "done")}>
                        Done: hide until it changes
                      </button>
                      <button type="button" onClick={() => void mark(item, "snoozed")}>
                        Snooze 1 day
                      </button>
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pulls !== null && hidden > 0 && (
        <p className="sub att-hidden">
          {hidden} done or snoozed.{" "}
          <button className="linklike" onClick={() => setShowHidden((s) => !s)}>
            {showHidden ? "Hide them again" : "Show them"}
          </button>
          {showHidden && (
            <button className="linklike" style={{ marginLeft: 8 }} onClick={() => void unmarkHidden()}>
              Unmark all
            </button>
          )}
        </p>
      )}
      {pulls !== null && open.length > 0 && failed.length > 0 && (
        <p className="sub att-hidden">Some projects could not be read: {failed.join("; ")}</p>
      )}
    </div>
  );
}

/** A waiting state's tone (pull-request-waits.ts, a `.badge` class) as a StatusChip's. */
function chipTone(badge: string): Tone {
  return badge === "danger" || badge === "bad" ? "danger" : badge === "warn" ? "warn" : badge === "ok" ? "ok" : badge === "info" ? "info" : "neutral";
}
