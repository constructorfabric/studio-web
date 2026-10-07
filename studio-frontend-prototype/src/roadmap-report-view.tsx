/** The roadmap report as a screen draws it: what the board plans, whether the
 *  plan holds, and a download of the planning team's workbook — the
 *  `back_roadmap.xlsx` (Summary, Roadmap, Gantt, People, a sheet per group,
 *  ALL) that `studio-reports` draws from what the last board sync stored and
 *  the plan the last refresh read. The body is the Reports screen's; the
 *  dialog is the same body, opened from the Components screen. */

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "./api";
import { errText } from "./format";
import { Modal } from "./modal";
import { demandText, type RoadmapGroup, type RoadmapReport } from "./roadmap-report";

const LAMP: Record<string, string> = {
  good: "var(--success, #16a34a)",
  watch: "var(--warning, #d97706)",
  bad: "var(--destructive, #dc2626)",
};

const TABLE: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12 };
const TH: CSSProperties = {
  textAlign: "left",
  padding: "4px 6px",
  borderBottom: "1px solid var(--border)",
  color: "var(--muted-foreground)",
  fontWeight: 500,
  whiteSpace: "nowrap",
};
const TD: CSSProperties = { padding: "4px 6px", borderBottom: "1px solid var(--border)", verticalAlign: "top" };
const DATE: CSSProperties = { ...TD, whiteSpace: "nowrap" };
const NUM: CSSProperties = { ...TD, textAlign: "right", fontVariantNumeric: "tabular-nums" };

/** The progress axes across the groups, in board order. */
function axisLabels(groups: RoadmapGroup[]): string[] {
  const out: string[] = [];
  for (const g of groups) for (const a of g.axes) if (!out.includes(a.label)) out.push(a.label);
  return out;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Save the report's workbook as the server draws it. */
export async function downloadReport(token: string, report = "roadmap", asOf = today(), org?: string) {
  const blob = await api.exportReport(token, report, asOf, org);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `back_${report}_${asOf}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

export function RoadmapReportDialog({
  token,
  org,
  onClose,
}: {
  token: string;
  org?: string;
  onClose: () => void;
}) {
  const [total, setTotal] = useState(0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal label="Roadmap report" onClose={onClose} cardStyle={{ width: "min(1100px, 100%)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, flex: 1 }}>Roadmap report</h2>
        <button
          className="iconbtn primary"
          disabled={!total || saving}
          onClick={() => {
            setSaving(true);
            downloadReport(token, "roadmap", undefined, org)
              .catch((e) => setErr(errText(e)))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Writing…" : "Download .xlsx"}
        </button>
        <button className="iconbtn" onClick={onClose}>
          Close
        </button>
      </div>
      {err && <p className="gcat-err">{err}</p>}
      <p className="gcat-hint" style={{ margin: 0 }}>
        Where the board and the plan come from is set once for the organization, under Reports.
      </p>
      <RoadmapReportBody token={token} org={org} onLoaded={(r) => setTotal(r.total)} />
    </Modal>
  );
}

/** The report's tables, read from `studio-reports`. `version` reloads it. */
export function RoadmapReportBody({
  token,
  org,
  version = 0,
  onLoaded,
}: {
  token: string;
  /** The organization whose report this is; the caller's home tenant when absent. */
  org?: string;
  version?: number;
  onLoaded?: (r: RoadmapReport) => void;
}) {
  const [report, setReport] = useState<RoadmapReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .reportSummary(token, "roadmap", org)
      .then((r) => {
        if (!live) return;
        setReport(r);
        onLoaded?.(r);
      })
      .catch((e) => live && setErr(errText(e)));
    return () => {
      live = false;
    };
    // `onLoaded` is a callback, not an input: a new one must not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, org, version]);

  const s = report?.summary;
  return (
    <>
      {err && <p className="gcat-err">{err}</p>}
      {!report && !err && <p className="gcat-hint">Reading the board…</p>}
      {report && s && (
        <>
          <p className="gcat-hint" style={{ margin: 0 }}>
            {report.total} gears on the roadmap board
            {report.not_in_code > 0 && ` · ${report.not_in_code} not in code yet`}
            {report.not_on_board > 0 &&
              ` · ${report.not_on_board} catalogued components are not on it — unplanned, or pin one through its Roadmap item field`}
          </p>
          {report.total === 0 ? (
            <p className="gcat-hint">
              No gears yet. Set the report&apos;s source under Reports and refresh it.
            </p>
          ) : (
            <>
              {s.by_group.length > 0 && (
                <section style={{ overflowX: "auto" }}>
                  <h3 style={{ fontSize: 13, margin: "4px 0" }}>By group</h3>
                  <table style={TABLE}>
                    <thead>
                      <tr>
                        <th style={TH} />
                        <th style={TH}>Gears</th>
                        <th style={TH}>Done</th>
                        <th style={TH}>In code</th>
                        {axisLabels(s.by_group).map((l) => (
                          <th key={l} style={TH}>
                            {l}
                          </th>
                        ))}
                        <th style={TH}>Estimated</th>
                        <th style={TH} title="person-days">Effort</th>
                        <th style={TH} title="person-days">Remaining</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.by_group.map((g) => (
                        <tr key={g.group}>
                          <td style={TD}>{g.group}</td>
                          <td style={NUM}>{g.total}</td>
                          <td style={NUM}>{g.done || ""}</td>
                          <td style={NUM}>{g.in_code}</td>
                          {axisLabels(s.by_group).map((l) => {
                            const avg = g.axes.find((a) => a.label === l)?.average;
                            return (
                              <td key={l} style={NUM}>
                                {avg === null || avg === undefined ? "" : `${avg}%`}
                              </td>
                            );
                          })}
                          <td style={NUM}>
                            {g.estimated} of {g.total}
                          </td>
                          <td style={NUM}>{g.effort_md ? `${g.effort_md} d` : ""}</td>
                          <td style={NUM}>{g.remaining_md ? `${Math.round(g.remaining_md)} d` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                <section>
                  <h3 style={{ fontSize: 13, margin: "4px 0" }}>Stage</h3>
                  <table style={TABLE}>
                    <tbody>
                      {s.by_stage.map((c) => (
                        <tr key={c.label}>
                          <td style={TD}>{c.label}</td>
                          <td style={NUM}>{c.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
                <section>
                  <h3 style={{ fontSize: 13, margin: "4px 0" }}>Plan</h3>
                  <table style={TABLE}>
                    <tbody>
                      {s.by_plan.map((c) => (
                        <tr key={c.label}>
                          <td style={TD}>{c.label}</td>
                          <td style={NUM}>{c.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
                <section>
                  <h3 style={{ fontSize: 13, margin: "4px 0" }}>Milestone</h3>
                  <table style={TABLE}>
                    <thead>
                      <tr>
                        <th style={TH} />
                        <th style={TH}>Due</th>
                        <th style={TH}>All</th>
                        <th style={TH}>Committed</th>
                        <th style={TH}>At risk</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.by_milestone.map((m) => (
                        <tr key={m.milestone}>
                          <td style={TD}>{m.milestone}</td>
                          <td style={DATE}>{m.due ?? ""}</td>
                          <td style={NUM}>{m.total}</td>
                          <td style={NUM}>{m.committed || ""}</td>
                          <td style={NUM}>{m.at_risk || ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
                {s.by_consumer.length > 0 && (
                  <section>
                    <h3 style={{ fontSize: 13, margin: "4px 0" }}>Consumers</h3>
                    <table style={TABLE}>
                      <thead>
                        <tr>
                          <th style={TH} />
                          <th style={TH}>P1</th>
                          <th style={TH}>P2</th>
                          <th style={TH}>P3</th>
                          <th style={TH} title="P1 demand whose plan is at risk or needs a check">
                            P1 off track
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.by_consumer.map((c) => (
                          <tr key={c.consumer}>
                            <td style={TD}>{c.consumer}</td>
                            <td style={NUM}>{c.p1 || ""}</td>
                            <td style={NUM}>{c.p2 || ""}</td>
                            <td style={NUM}>{c.p3 || ""}</td>
                            <td style={NUM}>{c.p1_not_on_track || ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                )}
              </div>
              {s.overdue.length > 0 && (
                <p className="gcat-err" style={{ margin: 0 }}>
                  Overdue: {s.overdue.join(", ")}
                </p>
              )}
              <div style={{ overflowX: "auto" }}>
                <table style={TABLE}>
                  <thead>
                    <tr>
                      {["Gear", "Stage", "Milestone", "Plan", "Demand", "Assignees", "Effort", "Grade"].map((h) => (
                        <th key={h} style={TH}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.items.map((row) => {
                      const r = row.readiness;
                      return (
                        <tr key={`${row.number ?? ""}:${row.title}`}>
                          <td style={TD}>
                            {r.roadmap_item ? (
                              <a href={r.roadmap_item} target="_blank" rel="noreferrer" title={row.roadmap_title ?? ""}>
                                {row.title}
                              </a>
                            ) : (
                              row.title
                            )}
                            <div style={{ color: "var(--muted-foreground)", fontSize: 11 }}>
                              {row.components.length ? row.components.join(", ") : "not in code yet"}
                            </div>
                          </td>
                          <td style={TD}>{r.stage ?? ""}</td>
                          <td style={DATE}>
                            {r.milestone ?? ""}
                            {r.due && <span style={{ color: "var(--muted-foreground)" }}> · {r.due}</span>}
                            {r.committed && " · committed"}
                          </td>
                          <td style={TD} title={r.plan_reasons.join("\n")}>
                            {r.plan && (
                              <span style={{ color: LAMP[r.plan_lamp ?? ""] ?? "inherit" }}>{r.plan}</span>
                            )}
                            {r.plan_reasons.length > 0 && (
                              <div style={{ color: "var(--muted-foreground)" }}>{r.plan_reasons.join("; ")}</div>
                            )}
                          </td>
                          <td style={TD}>{demandText(r.demand)}</td>
                          <td style={TD}>{row.assignees ?? ""}</td>
                          <td style={NUM}>
                            {row.effort_md === null ? "" : `${row.effort_md} d`}
                            {row.remaining_md !== null && row.remaining_md !== row.effort_md && (
                              <div style={{ color: "var(--muted-foreground)", fontSize: 11 }}>
                                {Math.round(row.remaining_md)} d left
                              </div>
                            )}
                          </td>
                          <td style={TD}>{r.grade ?? ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
