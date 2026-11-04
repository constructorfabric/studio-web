/* The organization's overview, for the people who lead it: opened by clicking
 * the organization in the path (UI standard, wave 3).
 *
 *   - One header: the organization, and how much needs attention.
 *   - "Needs attention": ONE list, grouped -- what waits on you (reviews,
 *     pull requests; waiting-on-me-view.tsx) and what waits on others
 *     (refused connections, spend, who the stuck pull requests wait on,
 *     components to decide, idle people). A row is one sentence and one
 *     action.
 *   - Four tiles -- Spend, Delivery, Spec health, People -- each opening its
 *     section; Spend opens where the money goes (the top five, and Costs).
 *
 * The workspaces table moved to the Workspaces tab (projects.tsx), with its
 * columns. One request: `GET /studio-organizations/v1/overview` composes it on
 * the server, rules and all. Words: `org-dashboard-model.ts`. */

import { useCallback, useEffect, useRef, useState } from "react";

import { api, type OrgOverview } from "./api";
import { money } from "./costs";
import { errText } from "./format";
import { OrgMark } from "./level-marks";
import {
  attentionStatus,
  growthText,
  moneyFor,
  moneyLabel,
  othersAttention,
  topMoney,
  type NeedTarget,
} from "./org-dashboard-model";
import { EmptyState, KpiTile, PageHeader, StatusChip } from "./ui-standard";
import { WaitingOnYou, type OnMeWorkspace } from "./waiting-on-me-view";

type Target = NeedTarget | "platform";

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
  const [moneyOpen, setMoneyOpen] = useState(false);

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
  const closeMoney = useCallback(() => setMoneyOpen(false), []);
  const cash = (n: number) => money(n, o?.spend?.currency || "USD");
  const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));
  const spend = o?.spend ?? null;
  const people = o?.people;
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
            What needs you, where the problems are, what it costs and whether work moves.
            <br />
            <br />
            <b>For you</b>: reviews somebody asked you for, and open pull requests in your projects whose next step is
            yours, overdue first. Done or snoozed items stay away until they change.
            <br />
            <b>For others</b>: refused connections, spend against the same days last month, pull requests stuck over{" "}
            {o?.stuck_days ?? 7} days and who they wait on, components to decide, idle people.
            <br />
            <br />
            Each tile opens its section; Spend opens where the money goes.
          </>
        }
      />

      {error && <p className="gcat-err">{error}</p>}

      <div className="dash-stats org-trends">
        <div className="org-spend" data-trend="spend">
          <KpiTile
            label="Spend, 30 days"
            value={spend ? cash(spend.current) : o ? "—" : "…"}
            sub={
              o?.costs === "hidden"
                ? "not yours to see"
                : o?.costs === "unreadable"
                  ? "could not be read"
                  : spend
                    ? `${growthText(spend.current, spend.previous)} vs last month · ends near ${cash(spend.forecast)}`
                    : ""
            }
            onOpen={() => (o?.costs === "shown" ? setMoneyOpen((v) => !v) : onOpen("costs"))}
          />
          {moneyOpen && o && <MoneyDrill o={o} cash={cash} onClose={closeMoney} onCosts={() => onOpen("costs")} />}
        </div>
        <KpiTile
          label="Delivery"
          value={o ? n(o.delivery.merged) : "…"}
          sub={o ? `merged in ${o.delivery.window_days} d · ${n(o.delivery.open)} open` : ""}
          onOpen={() => onOpen("projects")}
        />
        <KpiTile
          label="Spec health"
          value={o ? n(o.specs.failing) : "…"}
          tone={o?.specs.failing ? "danger" : undefined}
          sub={o ? `failing · ${n(o.specs.open_findings)} open findings` : ""}
          onOpen={() => onOpen("projects")}
        />
        <KpiTile
          label="People"
          value={o ? n(people?.active) : "…"}
          sub={
            people?.with_spend !== null && people?.with_spend !== undefined
              ? `active · ${people.with_spend} used a model`
              : "active members"
          }
          onOpen={() => onOpen("people")}
        />
      </div>

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
  );
}

/** Where the money goes: the Spend tile's drill-down -- the five projects
 *  that spent most, and the way to Costs. */
function MoneyDrill({
  o,
  cash,
  onClose,
  onCosts,
}: {
  o: OrgOverview;
  cash: (n: number) => string;
  onClose: () => void;
  onCosts: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const down = (e: MouseEvent) => {
      // The tile's own button toggles it; a click there is not "outside".
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !ref.current.parentElement?.contains(t)) onClose();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", down);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", down);
    };
  }, [onClose]);
  const rows = topMoney(moneyFor(o, "project", false));
  const spend = o.spend;
  return (
    <div ref={ref} className="ui-info-pop org-money-pop" role="dialog" aria-label="Where the money goes" data-org-money>
      <strong>Where the money goes</strong>
      {rows.length === 0 ? (
        <span className="sub">Nothing spent in the last 60 days.</span>
      ) : (
        <table className="org-money">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key || "-"}>
                <td>
                  {moneyLabel("project", r)}
                  {r.unpriced && <span className="sub"> · unpriced</span>}
                </td>
                <td className="num">{cash(r.cost)}</td>
                <td className={`num${r.previous > 0 && (r.cost - r.previous) / r.previous >= o.growth_alert ? " grows" : ""}`}>
                  {growthText(r.cost, r.previous)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {spend && spend.unpriced.length > 0 && <span className="sub">No price for {spend.unpriced.join(", ")}.</span>}
      <button type="button" className="linklike org-money-all" onClick={onCosts}>
        All costs →
      </button>
    </div>
  );
}

const ORG_DASH_CSS = `
.org-dash .card-head h3 { margin:0; font-size:14px; }
.org-dash .sub { color:var(--muted-foreground); font-size:12px; overflow-wrap:anywhere; }
.org-dash .org-trends { margin-bottom:16px; }
.org-dash .org-trends .stat-sub { white-space:normal; }
.org-dash .org-spend { position:relative; display:grid; }
.org-dash .org-money-pop { top:calc(100% + 4px); left:0; min-width:320px; }
.org-dash .org-money-all { align-self:flex-start; }
.org-dash table.org-money { width:100%; border-collapse:collapse; font-size:13px; }
.org-dash table.org-money td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--border); }
.org-dash table.org-money .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.org-dash table.org-money td.grows { color:var(--warning); font-weight:600; }
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
