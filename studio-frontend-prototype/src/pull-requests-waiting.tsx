/* ── Pull requests — who they're waiting on ───────────────────────────────────
 *
 * The project page's answer to "is anything stuck, and on whom": every open
 * pull request of the project's repositories, under the person it waits on.
 * One read (`/studio-artifact-ingest/v1/open-pull-requests`); the backend puts
 * each pull request in its bucket, `pull-request-waits.ts` makes the queues and
 * says every word, and this file only lays them out.
 *
 * Its own component, with its own request, so a project whose repositories
 * were never synced still gets the rest of its dashboard at once. */

import { useEffect, useMemo, useState } from "react";

import { api } from "./api";
import type { OpenPullRequest, PullWaiting } from "./api";
import { errText, initials } from "./format";
import {
  WAITING_LABEL,
  WAITING_ORDER,
  WAITING_SENTENCE,
  WAITING_TONE,
  ageLine,
  bucketTotals,
  emptyMessage,
  isQuiet,
  prRef,
  queuesByPerson,
} from "./pull-request-waits";
import { EmptyState, InfoPopover, StatusChip, type Tone } from "./ui-standard";

/** How many queues are open on arrival; the rest are one click away. */
const OPEN_QUEUES = 3;

export function PullRequestsWaiting({
  token,
  projectId,
  repositories,
  synced,
}: {
  token: string;
  projectId: string;
  /** Repositories attached to the project. */
  repositories: number;
  /** Whether any of them has been synced into the graph. */
  synced: boolean;
}) {
  const [items, setItems] = useState<OpenPullRequest[] | null>(null);
  const [membersKnown, setMembersKnown] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // One page of 200 holds any project we have seen; keep reading if not.
        const all: OpenPullRequest[] = [];
        let known = true;
        for (let offset = 0; ; ) {
          const page = await api.openPullRequests(token, projectId, offset);
          all.push(...page.items);
          known = known && page.members_known;
          offset += page.items.length;
          if (page.items.length === 0 || offset >= page.total) break;
        }
        if (!live) return;
        setItems(all);
        setMembersKnown(known);
        setError(null);
      } catch (e) {
        if (live) setError(errText(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [token, projectId]);

  const queues = useMemo(() => queuesByPerson(items ?? []), [items]);
  const totals = useMemo(() => bucketTotals(items ?? []), [items]);
  const empty = emptyMessage({ repositories, synced, open: items?.length ?? 0 });

  return (
    <div className="card prw">
      <div className="card-head">
        <h2>
          Pull requests — who they're waiting on{" "}
          <InfoPopover label="About pull requests">
            A pull request is a proposed change that somebody has to review before it goes in. Each
            open one is listed under the person it is waiting on right now, as of the last sync of the
            project's repositories.
          </InfoPopover>
        </h2>
        {items && items.length > 0 && <StatusChip tone="neutral">{items.length} open</StatusChip>}
      </div>

      {error ? (
        <EmptyState title="Pull requests could not be read." body={error} />
      ) : items === null ? (
        <p className="empty">Reading pull requests…</p>
      ) : empty ? (
        <EmptyState title={empty} />
      ) : (
        <>
          <div className="dash-mix prw-totals">
            {WAITING_ORDER.filter((w) => totals[w] > 0).map((w) => (
              <StatusChip key={w} tone={WAITING_TONE[w] as Tone} title={WAITING_SENTENCE[w]}>
                {totals[w]} {WAITING_LABEL[w]}
              </StatusChip>
            ))}
          </div>
          {!membersKnown && (
            <p className="hint">
              People are shown by their account names: the organization's member list could not be
              read, so nobody is marked as outside it.
            </p>
          )}
          <div className="prw-queues">
            {queues.map((q, i) => (
              <details key={q.key} className={`prw-queue ${q.kind}`} open={i < OPEN_QUEUES}>
                <summary>
                  <span className="avatar" aria-hidden>
                    {q.kind === "nobody" ? "?" : initials(q.name)}
                  </span>
                  <span className="prw-who">
                    <span className="name">{q.name}</span>
                    <span className="sub">{q.sub}</span>
                  </span>
                  <span className="prw-counts">
                    {WAITING_ORDER.filter((w) => q.counts[w] > 0).map((w: PullWaiting) => (
                      <StatusChip key={w} tone={WAITING_TONE[w] as Tone}>
                        {q.counts[w]} {WAITING_LABEL[w]}
                      </StatusChip>
                    ))}
                  </span>
                </summary>
                <ul className="rows">
                  {q.pulls.map((pr) => (
                    <li key={pr.id}>
                      <div className="grow">
                        <div className="name">
                          {pr.url ? (
                            <a href={pr.url} target="_blank" rel="noreferrer">
                              {pr.title}
                            </a>
                          ) : (
                            pr.title
                          )}
                        </div>
                        <div className="sub">
                          {prRef(pr)} · {pr.reason}
                        </div>
                        <div className="sub">
                          {ageLine(pr)}
                          {isQuiet(pr) && <StatusChip tone="warn" className="prw-quiet">quiet</StatusChip>}
                        </div>
                      </div>
                      <StatusChip tone={WAITING_TONE[pr.waiting] as Tone}>
                        {WAITING_LABEL[pr.waiting]}
                      </StatusChip>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
