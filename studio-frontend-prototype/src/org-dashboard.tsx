/* The organization's overview, for the people who lead it: opened by clicking
 * the organization in the path (UI standard, wave 3; metrics board, wave 4D).
 *
 *   - One header: the organization, and how much needs attention.
 *   - A metrics board (metrics-board.tsx), in rows like a Grafana board --
 *     Delivery, Quality, Money, People -- over one time range (7 / 30 / 90
 *     days). Each panel has its headline, its trend against the days before,
 *     a small chart, a "?" saying what it is and where it comes from (Studio
 *     or Constructor Insight), and a click-through to its screen.
 *   - "Needs attention" beside it: ONE list, grouped -- what waits on you
 *     (reviews, pull requests; waiting-on-me-view.tsx) and what waits on
 *     others (refused connections, spend, who the stuck pull requests wait
 *     on, components to decide, idle people). A row is one sentence and one
 *     action.
 *
 * Two requests of its own: `GET /studio-organizations/v1/overview` (needs,
 * open pull requests, spec health, idle people) and the board's
 * `GET /studio-organizations/v1/metrics`. Words: `org-dashboard-model.ts` and
 * `metrics-model.ts`. */

import { useCallback, useEffect, useState } from "react";

import { api, type OrgOverview } from "./api";
import { money } from "./costs";
import { errText } from "./format";
import { OrgMark } from "./level-marks";
import { MetricsBoard } from "./metrics-board";
import { attentionStatus, othersAttention, type NeedTarget } from "./org-dashboard-model";
import { EmptyState, PageHeader, StatusChip } from "./ui-standard";
import { WaitingOnYou, type OnMeWorkspace } from "./waiting-on-me-view";

type Target = NeedTarget | "platform" | "environments" | "reports";

export function OrgDashboard<W extends OnMeWorkspace>({
  token,
  org,
  workspaces,
  onOpen,
  onOpenWorkspace,
}: {
  token: string;
  org: { id: string; name: string };
  /** The organization's workspaces: what waits on you is read across them. */
  workspaces: W[];
  onOpen: (target: Target) => void;
  onOpenWorkspace: (ws: W) => void;
}) {
  const [o, setO] = useState<OrgOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setO(null);
    setError(null);
    api
      .orgOverview(token, org.id)
      .then((r) => live && setO(r))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token, org.id]);

  const onCount = useCallback((n: number | null) => setMine(n), []);
  const cash = (n: number) => money(n, o?.spend?.currency || "USD");
  const others = o ? othersAttention(o, cash) : [];
  const total = (mine ?? 0) + others.length;

  return (
    <div className="dash org-dash" data-org-dashboard>
      <style>{ORG_DASH_CSS}</style>
      <PageHeader
        icon={<OrgMark token={token} orgId={org.id} name={org.name} />}
        title={org.name}
        status={
          o || mine !== null ? (
            <StatusChip tone={total > 0 ? "warn" : "ok"} data-attention-status>
              {attentionStatus(mine, others.length)}
            </StatusChip>
          ) : error ? (
            <StatusChip tone="danger">overview not readable</StatusChip>
          ) : (
            <StatusChip tone="running">reading…</StatusChip>
          )
        }
        info={
          <>
            How the organization delivers, how good the work is, what it costs and who does it -- and what needs
            attention now.
            <br />
            <br />
            <b>The board</b>: four rows over the range you pick (7, 30 or 90 days), each panel against the same number
            of days before. Studio's own figures (spend, deployments, open pull requests, spec health, members) sit
            beside Constructor Insight's, which are read for the repositories the organization's projects are made of.
            Each panel's "?" says which.
            <br />
            <br />
            <b>Needs attention</b>: for you, reviews somebody asked you for and open pull requests whose next step is
            yours; for others, refused connections, spend against the same days last month, pull requests stuck over{" "}
            {o?.stuck_days ?? 7} days and who they wait on, components to decide, idle people.
          </>
        }
      />

      {error && <p className="gcat-err">{error}</p>}

      <div className="org-layout">
        <MetricsBoard
          token={token}
          org={org.id}
          overview={o}
          overviewLoading={o === null && error === null}
          onOpen={(t) => {
            // `specs` and `releases` are a project's tabs: no organization panel opens them.
            if (t !== "specs" && t !== "releases") onOpen(t);
          }}
        />

        <section className="card org-needs" data-org-needs>
          <div className="card-head">
            <h3>Needs attention</h3>
          </div>
          <WaitingOnYou token={token} workspaces={workspaces} onOpenWorkspace={onOpenWorkspace} onCount={onCount} />
          <div className="att-group" data-attention-group="others">
            <h3 className="att-group-title">
              For others{others.length > 0 && <span className="att-count">{others.length}</span>}
            </h3>
            {o === null ? (
              <p className="sub att-empty">{error ? "Not readable." : "Reading the organization…"}</p>
            ) : others.length === 0 ? (
              <EmptyState title="Nothing waits on anybody in the organization." />
            ) : (
              <ul className="att-list">
                {others.map((r) => (
                  <li key={r.key} className={`att-row tone-${r.tone}`} data-attention={r.key.split(":")[0]}>
                    <span className="att-text">
                      <b>{r.sentence}</b>
                      {r.detail && <span className="sub"> · {r.detail}</span>}
                    </span>
                    <button type="button" className="ghost att-action" onClick={() => onOpen(r.action.target)}>
                      {r.action.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const ORG_DASH_CSS = `
/* The layout (.org-layout, .org-needs) is in styles.css, wave 4G. */
.org-dash .card-head h3 { margin:0; font-size:14px; }
.org-dash .sub { color:var(--muted-foreground); font-size:12px; overflow-wrap:anywhere; }
.org-dash .att-group + .att-group { margin-top:14px; }
.org-dash .att-group-title { margin:0 0 6px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--muted-foreground); display:flex; align-items:center; gap:6px; }
.org-dash .att-count { font-size:11px; padding:0 6px; border-radius:999px; background:var(--accent); color:var(--foreground); text-transform:none; }
.org-dash .att-list { list-style:none; margin:0; padding:0; display:grid; gap:4px; }
.org-dash .att-row { display:flex; align-items:center; gap:10px; padding:4px 10px; min-height:34px; border-radius:8px; border:1px solid var(--border); border-left:3px solid var(--border); }
.org-dash .att-row.tone-danger { border-left-color:var(--destructive); }
.org-dash .att-row.tone-warn { border-left-color:var(--warning); }
.org-dash .att-row.tone-info { border-left-color:var(--primary); }
.org-dash .att-text { flex:1; min-width:0; font-size:13px; display:inline-flex; flex-wrap:wrap; align-items:center; gap:4px; }
.org-dash .att-text b { font-weight:600; }
.org-dash .att-action { flex:none; font-size:12px; white-space:nowrap; padding:2px 8px; min-height:0; }
.org-dash .att-empty { margin:0; display:flex; align-items:center; gap:6px; }
.org-dash .att-hidden { margin:6px 0 0; }
.org-dash .att-more { position:relative; flex:none; }
.org-dash .att-more summary { list-style:none; cursor:pointer; padding:0 6px; color:var(--muted-foreground); border-radius:6px; }
.org-dash .att-more summary::-webkit-details-marker { display:none; }
.org-dash .att-more-list { position:absolute; right:0; top:calc(100% + 4px); z-index:30; display:flex; flex-direction:column; min-width:200px; padding:4px; background:var(--card); border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.14); }
.org-dash .att-more-list button { all:unset; cursor:pointer; padding:6px 8px; font-size:13px; border-radius:6px; }
.org-dash .att-more-list button:hover { background:var(--accent); }
.org-dash .org-needs .dt-empty { padding:6px 0; text-align:left; align-items:flex-start; }
`;
