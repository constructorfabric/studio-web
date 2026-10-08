/* ── Pull requests waiting on you ──────────────────────────────────────────────
 *
 * The Home page's answer to "what is somebody waiting on me for": the open
 * pull requests of every project the reader can see, kept to the ones whose
 * next move is theirs. The project page shows a project's queues by person
 * (`pull-requests-waiting.tsx`); this is one person's queue across projects.
 *
 * One read per workspace (`open-pull-requests?workspace_id=&waiting_on=me`).
 * The backend decides who "me" is — the person behind the sign-in, through
 * the accounts they confirmed — so a reader who signed in another way still
 * gets their own list. */

import { useEffect, useMemo, useState } from "react";

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

export interface OnMeWorkspace {
  id: string;
  name: string;
}

export function PullRequestsOnMe<W extends OnMeWorkspace>({
  token,
  workspaces,
  onOpenWorkspace,
}: {
  token: string;
  workspaces: W[];
  onOpenWorkspace: (ws: W) => void;
}) {
  const [found, setFound] = useState<{ ws: W; pulls: OpenPullRequest[] }[] | null>(null);
  const [membersKnown, setMembersKnown] = useState(true);
  const [failed, setFailed] = useState<string[]>([]);

  // Re-read only when the set of workspaces changes, not on every new array.
  const key = workspaces.map((w) => w.id).join(",");
  useEffect(() => {
    let live = true;
    (async () => {
      let known = true;
      const errors: string[] = [];
      const per = await Promise.all(
        workspaces.map(async (ws) => {
          try {
            const pulls: OpenPullRequest[] = [];
            for (let offset = 0; ; ) {
              const page = await api.pullRequestsWaitingOnMe(token, ws.id, offset);
              pulls.push(...page.items);
              known = known && page.members_known;
              offset += page.items.length;
              if (page.items.length === 0 || offset >= page.total) break;
            }
            return { ws, pulls: myPullsInOrder(pulls) };
          } catch (e) {
            errors.push(`${ws.name}: ${errText(e)}`);
            return { ws, pulls: [] };
          }
        }),
      );
      if (!live) return;
      setFound(per.filter((x) => x.pulls.length > 0));
      setMembersKnown(known);
      setFailed(errors);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, key]);

  const total = useMemo(() => (found ?? []).reduce((n, x) => n + x.pulls.length, 0), [found]);

  return (
    <div className="card span-all prw">
      <div className="card-head">
        <h2>Waiting on you</h2>
        {total > 0 && <span className="hint">{total} pull requests</span>}
      </div>
      <p className="hint">
        Open pull requests in your projects whose next step is yours — a review somebody asked you
        for, changes asked of you, or your own one ready to merge. As of each project's last sync.
      </p>
      {found === null ? (
        <p className="empty">Reading pull requests…</p>
      ) : total === 0 ? (
        <p className="empty">
          {failed.length === workspaces.length && failed.length > 0
            ? `Pull requests could not be read: ${failed[0]}`
            : myEmptyMessage({ membersKnown, workspaces: workspaces.length })}
        </p>
      ) : (
        found.map(({ ws, pulls }) => (
          <div key={ws.id} className="prw-onme">
            <div className="prw-onme-head">
              <span className="name">{ws.name}</span>
              <button className="linklike" onClick={() => onOpenWorkspace(ws)}>
                Open project →
              </button>
            </div>
            <ul className="rows">
              {pulls.map((pr) => (
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
                      {isQuiet(pr) && <span className="badge warn prw-quiet">quiet</span>}
                    </div>
                  </div>
                  <span className={`badge ${WAITING_TONE[pr.waiting]}`} title={WAITING_SENTENCE[pr.waiting]}>
                    {MY_LABEL[pr.waiting]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {found !== null && total > 0 && failed.length > 0 && (
        <p className="hint">Some projects could not be read: {failed.join("; ")}</p>
      )}
    </div>
  );
}
