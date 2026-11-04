/* An organization's Costs section (issue #781).
 *
 * What its model calls and IDE sessions cost over a period, grouped by
 * project, person, model, source or who paid, with a switch for what people
 * spent on their own keys; the monthly budgets and where this month stands
 * against them (warnings only, nothing is stopped); and the price list those
 * costs are priced with.
 * The records are quantities kept by the platform's usage collector; the money
 * is computed from the price list when the report is read, so changing a price
 * reprices the past too. */

import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  api,
  type BudgetList,
  type BudgetStatus,
  type CostGroup,
  type CostReport,
  type ModelPrice,
  type PriceList,
  type SessionPrice,
} from "./api";
import { budgetProblem, budgetWarnings, budgetsOf, levelBadge, nextPlace, percent, placeLabel, rowsOf, standingText, type BudgetRow } from "./budgets";
import { GROUPS, PERIODS, blankModel, hours, money, periodRange, priceProblem, rowLabel, tokens, type Period } from "./costs";
import { errText } from "./format";
import { Modal } from "./modal";
import { EmptyState, PageHeader, StatusChip } from "./ui-standard";
import "./org-screens.css";

const CSS = `
.costs .cost-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 4px 0 12px; }
.costs .cost-controls label { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; }
.costs table { width: 100%; border-collapse: collapse; font-size: 13px; }
.costs th, .costs td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.costs th.num, .costs td.num { text-align: right; font-variant-numeric: tabular-nums; }
.costs tfoot td { font-weight: 600; border-bottom: none; }
.costs .cost-unpriced { color: var(--muted-foreground); font-size: 12px; }
.costs .price-grid input { width: 100%; box-sizing: border-box; }
.costs .price-grid input[type=number] { max-width: 110px; }
.costs .price-actions { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
.costs .budget-warnings { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); }
.costs .budget-warnings ul { margin: 6px 0 0; padding-left: 18px; font-size: 13px; }
.costs .budget-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); }
.costs .budget-badge[data-level=warning] { color: var(--warning, #b45309); border-color: currentColor; }
.costs .budget-badge[data-level=over] { color: var(--destructive, #dc2626); border-color: currentColor; }
.costs .budget-grid select { max-width: 320px; }
.costs .budget-grid input[type=number] { max-width: 130px; }
`;

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function OrgCosts({ token, org, you }: { token: string; org: { id: string; name: string }; you?: string }) {
  const [prices, setPrices] = useState<PriceList | null>(null);
  const [report, setReport] = useState<CostReport | null>(null);
  const [period, setPeriod] = useState<Period>("this-month");
  const [group, setGroup] = useState<CostGroup>("project");
  const [personal, setPersonal] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The report's own failure: a later good read clears it, and a save leaves it alone.
  const [reportError, setReportError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The editor's working copy of the price list.
  const [models, setModels] = useState<ModelPrice[]>([]);
  const [session, setSession] = useState<SessionPrice | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** The report, or the price list it is priced with: two tabs, not one page. */
  const [tab, setTab] = useState<"report" | "prices">("report");
  /** The budgets, a header action: open in a dialog. */
  const [budgetsOpen, setBudgetsOpen] = useState(false);
  /** This month's budgets that warn, for the header's status. */
  const [budgetAlerts, setBudgetAlerts] = useState(0);

  const loadPrices = useCallback(() => {
    let live = true;
    api
      .prices(token, org.id)
      .then((p) => {
        if (!live) return;
        setPrices(p);
        setModels(p.models);
        setSession(p.session ?? null);
        setCurrency(p.currency || "USD");
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof ApiError && e.status === 404 ? "This Studio does not count costs yet (the backend predates them)." : errText(e));
      });
    return () => {
      live = false;
    };
  }, [token, org.id]);
  useEffect(loadPrices, [loadPrices]);

  useEffect(() => {
    if (!prices?.may_view_costs) return;
    let live = true;
    setLoading(true);
    api
      .costs(token, org.id, { ...periodRange(period), group_by: group, include_personal: personal })
      .then((r) => {
        if (!live) return;
        setReport(r);
        setReportError(null);
      })
      .catch((e) => live && setReportError(errText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [token, org.id, prices?.may_view_costs, period, group, personal, prices]);

  const problem = priceProblem(models, session, currency);
  const save = async () => {
    if (problem) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const saved = await api.updatePrices(token, org.id, { currency, models, session });
      setPrices(saved);
      setNotice("Prices saved. The report is priced with them, past usage included.");
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };
  const setModel = (i: number, patch: Partial<ModelPrice>) =>
    setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const editable = prices?.may_manage ?? false;
  /** Nothing is priced, saved: every cost would read $0. */
  const unpricedList = !!prices && prices.models.length === 0 && !prices.session;

  return (
    <div className="costs" data-org-costs>
      <style>{CSS}</style>
      <PageHeader
        title="Costs"
        status={
          <>
            {report && prices?.may_view_costs && !unpricedList && (
              <span data-costs-total>
                {money(report.total, report.currency)} · {PERIODS.find((p) => p.id === period)?.label.toLowerCase()}
              </span>
            )}
            {unpricedList && (
              <StatusChip tone="warn" onClick={() => setTab("prices")} data-costs-no-prices>
                no prices set
              </StatusChip>
            )}
            {budgetAlerts > 0 && (
              <StatusChip tone="warn" onClick={() => setBudgetsOpen(true)} data-costs-budget-alerts>
                {budgetAlerts === 1 ? "1 budget needs attention" : `${budgetAlerts} budgets need attention`}
              </StatusChip>
            )}
            {prices && !prices.may_view_costs && <StatusChip tone="neutral">costs are the administrators&apos;</StatusChip>}
          </>
        }
        info={
          <>
            <p>
              What {org.name}&apos;s model calls and IDE sessions cost. Usage is recorded as tokens and pod time; the
              money comes from the price list, so a changed price reprices the past too.
            </p>
            <p>
              Budgets say what the organization, a workspace or a project may spend in a calendar month. They warn; they
              never stop anyone.
            </p>
            {prices && !prices.may_view_costs && (
              <p>Only the organization&apos;s administrators, or people granted cost.view, see the costs.</p>
            )}
          </>
        }
        actions={
          prices?.may_view_costs && (
            <button className="primary" onClick={() => setBudgetsOpen(true)} data-costs-budgets>
              Budgets
            </button>
          )
        }
      />
      {error && <div className="error">{error}</div>}
      {notice && <div className="hint">{notice}</div>}

      {prices?.may_view_costs && (
        <OrgBudgets
          token={token}
          org={org}
          personal={personal}
          prices={prices}
          open={budgetsOpen}
          onClose={() => setBudgetsOpen(false)}
          onAlerts={setBudgetAlerts}
        />
      )}

      {prices && (
        <div className="org-toolbar">
          <span className="chips org-tabs" role="tablist" aria-label="Costs">
            {prices.may_view_costs && (
              <button type="button" role="tab" aria-selected={tab === "report"} className={`chip ${tab === "report" ? "on" : ""}`} onClick={() => setTab("report")} data-costs-tab="report">
                Report
              </button>
            )}
            <button type="button" role="tab" aria-selected={tab === "prices" || !prices.may_view_costs} className={`chip ${tab === "prices" || !prices.may_view_costs ? "on" : ""}`} onClick={() => setTab("prices")} data-costs-tab="prices">
              Price list
            </button>
          </span>
        </div>
      )}

      {prices?.may_view_costs && tab === "report" && unpricedList && (
        <EmptyState
          title="No prices set: usage is counted, cost shows $0"
          action={
            <button className="primary" onClick={() => setTab("prices")} data-costs-set-prices>
              Set prices
            </button>
          }
        />
      )}

      {prices?.may_view_costs && tab === "report" && !unpricedList && (
        <section className="card" data-cost-report>
          {reportError && <div className="error">{reportError}</div>}
          <div className="cost-controls">
            <label>
              Period
              <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="Period">
                {PERIODS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              By
              <select value={group} onChange={(e) => setGroup(e.target.value as CostGroup)} aria-label="Group by">
                {GROUPS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
            <label title="What people spent on keys in their own profiles or personal connections">
              <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} data-cost-personal />
              Include people&apos;s own keys
            </label>
            {loading && <span className="hint">Counting…</span>}
          </div>
          {report && report.rows.length === 0 && <EmptyState title="Nothing was used in this period." />}
          {report && report.rows.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>{GROUPS.find((g) => g.id === group)?.label}</th>
                  <th className="num">Input</th>
                  <th className="num">Output</th>
                  <th className="num">Cache read</th>
                  <th className="num">Cache write</th>
                  <th className="num">Sessions</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.key || "-"} data-cost-row={r.key}>
                    <td>{rowLabel(r, group, you)}</td>
                    <td className="num">{tokens(r.input_tokens)}</td>
                    <td className="num">{tokens(r.output_tokens)}</td>
                    <td className="num">{tokens(r.cache_read_tokens)}</td>
                    <td className="num">{tokens(r.cache_write_tokens)}</td>
                    <td className="num">{hours(r.session_seconds)}</td>
                    <td className="num">
                      {money(r.cost, report.currency)}
                      {r.unpriced && <span className="cost-unpriced" title="Part of this row has no price"> *</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td colSpan={5} />
                  <td className="num" data-cost-total>
                    {money(report.total, report.currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
          {report && report.unpriced.length > 0 && (
            <p className="cost-unpriced" data-cost-unpriced>
              * No price for {report.unpriced.join(", ")}: counted above, not in the cost.{" "}
              <button type="button" className="linklike" onClick={() => setTab("prices")}>
                Add a price
              </button>
            </p>
          )}
        </section>
      )}

      {prices && (tab === "prices" || !prices.may_view_costs) && (
        <section className="card" data-price-list>
          <p className="hint">
            Per model, the price of a million tokens of each kind; for IDE sessions, an hour of a requested CPU core and
            GiB of memory. A model ending in * prices every model that starts with the rest.
          </p>
          <table className="price-grid">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th className="num">Input / 1M</th>
                <th className="num">Output / 1M</th>
                <th className="num">Cache read / 1M</th>
                <th className="num">Cache write / 1M</th>
                {editable && <th />}
              </tr>
            </thead>
            <tbody>
              {models.map((m, i) => (
                <tr key={i}>
                  <td>
                    <input value={m.provider} disabled={!editable} onChange={(e) => setModel(i, { provider: e.target.value })} aria-label="Provider" />
                  </td>
                  <td>
                    <input value={m.model} disabled={!editable} onChange={(e) => setModel(i, { model: e.target.value })} aria-label="Model" placeholder="claude-sonnet-5-5*" />
                  </td>
                  {(["input_per_mtok", "output_per_mtok", "cache_read_per_mtok", "cache_write_per_mtok"] as const).map((k) => (
                    <td key={k} className="num">
                      <input type="number" min={0} step="0.01" value={m[k]} disabled={!editable} onChange={(e) => setModel(i, { [k]: num(e.target.value) })} aria-label={k} />
                    </td>
                  ))}
                  {editable && (
                    <td>
                      <button type="button" className="ghost" onClick={() => setModels((ms) => ms.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {models.length === 0 && (
                <tr>
                  <td colSpan={editable ? 7 : 6} className="empty">
                    No model is priced: model calls are counted but cost nothing in the report.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="price-actions">
            <label>
              IDE session, per CPU core hour{" "}
              <input type="number" min={0} step="0.001" value={session?.cpu_core_hour ?? ""} disabled={!editable} placeholder="unpriced" onChange={(e) => setSession({ cpu_core_hour: num(e.target.value), memory_gib_hour: session?.memory_gib_hour ?? 0 })} aria-label="CPU core hour" />
            </label>
            <label>
              per GiB hour{" "}
              <input type="number" min={0} step="0.001" value={session?.memory_gib_hour ?? ""} disabled={!editable} placeholder="unpriced" onChange={(e) => setSession({ cpu_core_hour: session?.cpu_core_hour ?? 0, memory_gib_hour: num(e.target.value) })} aria-label="GiB hour" />
            </label>
            <label>
              Currency{" "}
              <input value={currency} disabled={!editable} maxLength={3} size={4} onChange={(e) => setCurrency(e.target.value.toUpperCase())} aria-label="Currency" />
            </label>
          </div>
          {editable && (
            <div className="price-actions">
              <button type="button" onClick={() => setModels((ms) => [...ms, blankModel()])}>
                Add a model
              </button>
              <button type="button" className="primary" disabled={saving || !!problem} onClick={() => void save()} data-price-save>
                {saving ? "Saving…" : "Save prices"}
              </button>
              {problem && <span className="error">{problem}</span>}
            </div>
          )}
          {!editable && <p className="hint">Only the organization&apos;s administrators, or people granted cost.manage, change prices.</p>}
        </section>
      )}
    </div>
  );
}

/** The organization's monthly budgets: this month's standing, worst first,
 *  and the editor for whoever holds cost.manage. Spend on people's own keys
 *  counts as the report's switch says. */
function OrgBudgets({
  token,
  org,
  personal,
  prices,
  open,
  onClose,
  onAlerts,
}: {
  token: string;
  org: { id: string; name: string };
  personal: boolean;
  prices: PriceList;
  /** Shown in a dialog; closed, it still reads the standing for the header. */
  open: boolean;
  onClose: () => void;
  onAlerts?: (n: number) => void;
}) {
  const [list, setList] = useState<BudgetList | null>(null);
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [rows, setRows] = useState<BudgetRow[]>([]);
  const [warnAt, setWarnAt] = useState(80);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .budgets(token, org.id)
      .then((l) => {
        if (!live) return;
        setList(l);
        setRows(rowsOf(l.budgets));
        setWarnAt(l.warn_at_percent);
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof ApiError && e.status === 404 ? "This Studio has no budgets yet (the backend predates them)." : errText(e));
      });
    return () => {
      live = false;
    };
  }, [token, org.id]);

  // A changed price reprices this month too, so the standing follows `prices`.
  useEffect(() => {
    if (!list || list.budgets.length === 0) {
      setStatus(null);
      return;
    }
    let live = true;
    api
      .budgetStatus(token, org.id, personal)
      .then((st) => live && setStatus(st))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token, org.id, personal, list, prices]);

  const warnings = budgetWarnings(status);
  useEffect(() => {
    onAlerts?.(warnings.length);
  }, [warnings.length, onAlerts]);
  if (!open || (!list && !error)) return null;
  const currency = status?.currency ?? list?.currency ?? prices.currency;
  const problem = budgetProblem(rows, warnAt);
  const editable = list?.may_manage ?? false;
  const places = list?.places ?? [];
  const free = nextPlace(places, rows);
  const setRow = (i: number, patch: Partial<BudgetRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    if (problem) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const l = await api.updateBudgets(token, org.id, { warn_at_percent: warnAt, budgets: budgetsOf(rows) });
      setList(l);
      setRows(rowsOf(l.budgets));
      setWarnAt(l.warn_at_percent);
      setNotice("Budgets saved.");
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal label="Budgets this month" onClose={onClose} cardStyle={{ width: "min(860px, 100%)" }}>
    <section className="costs" data-budgets>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Budgets this month</h3>
        <button type="button" className="ghost" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="hint">{notice}</div>}
      {warnings.length > 0 && status && (
        <div className="budget-warnings" role="status" data-budget-warnings>
          <strong>
            {warnings.length === 1 ? "One budget needs attention" : `${warnings.length} budgets need attention`}
          </strong>
          <ul>
            {warnings.map((w) => (
              <li key={w.tenant_id ?? "org"} data-budget-warning={w.level}>
                {w.label}: {standingText(w, currency)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="hint">
        What the organization, a workspace or a project may spend in a calendar month (UTC), in {currency}. A budget
        warns at {list?.warn_at_percent ?? warnAt}% and when this month&apos;s pace would pass it; it never stops anyone.
        {!personal && " People's own keys are left out, as in the report."}
      </p>
      {status && status.standings.length > 0 && (
        <table data-budget-standings>
          <thead>
            <tr>
              <th>Budget for</th>
              <th className="num">Spent</th>
              <th className="num">Budget</th>
              <th className="num">Used</th>
              <th className="num">Month&apos;s end</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {status.standings.map((st) => (
              <tr key={st.tenant_id ?? "org"} data-budget-row={st.tenant_id ?? "org"}>
                <td>{st.label}</td>
                <td className="num">{money(st.spent, currency)}</td>
                <td className="num">{money(st.monthly, currency)}</td>
                <td className="num">{percent(st.spent, st.monthly)}%</td>
                <td className="num" title={st.forecast == null ? "Projected from the fourth day of the month" : undefined}>
                  {st.forecast == null ? "—" : money(st.forecast, currency)}
                </td>
                <td>
                  <span className="budget-badge" data-level={st.level}>
                    {levelBadge(st)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {status && status.unpriced.length > 0 && (
        <p className="cost-unpriced">
          No price for {status.unpriced.join(", ")}: not in the spend above, so a budget may be nearer than it shows.
        </p>
      )}
      {list && list.budgets.length === 0 && !editable && <p className="empty">No budget is set.</p>}

      {editable && (
        <>
          <table className="budget-grid">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <select value={r.tenant_id} onChange={(e) => setRow(i, { tenant_id: e.target.value })} aria-label="Budget for">
                      {places.map((p) => {
                        const value = p.kind === "organization" ? "" : p.id;
                        return (
                          <option key={p.id} value={value}>
                            {placeLabel(p)}
                          </option>
                        );
                      })}
                    </select>
                  </td>
                  <td className="num">
                    <input type="number" min={0} step="1" value={Number.isNaN(r.monthly) ? "" : r.monthly} onChange={(e) => setRow(i, { monthly: num(e.target.value) })} aria-label="Monthly budget" />{" "}
                    {currency} / month
                  </td>
                  <td>
                    <button type="button" className="ghost" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="price-actions">
            <button type="button" disabled={free === null} onClick={() => free !== null && setRows((rs) => [...rs, { tenant_id: free, monthly: 0 }])}>
              Add a budget
            </button>
            <label>
              Warn at{" "}
              <input type="number" min={1} max={99} step="1" value={warnAt} onChange={(e) => setWarnAt(num(e.target.value))} aria-label="Warn at percent" size={3} />%
            </label>
            <button type="button" className="primary" disabled={saving || !!problem} onClick={() => void save()} data-budget-save>
              {saving ? "Saving…" : "Save budgets"}
            </button>
            {problem && <span className="error">{problem}</span>}
          </div>
        </>
      )}
      {list && !editable && <p className="hint">Only the organization&apos;s administrators, or people granted cost.manage, change budgets.</p>}
    </section>
    </Modal>
  );
}
