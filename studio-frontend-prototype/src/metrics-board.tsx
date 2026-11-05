/* The metrics board (wave 4D): rows of panels over one time range, for a
 * scope -- an organization, or one of its workspaces or projects.
 *
 * It reads two things itself: `GET /studio-organizations/v1/metrics` for the
 * scope and range (Studio's spend, Insight's repository figures), and Studio's
 * deployments for the scope. The organization's overview is passed in by the
 * screen that already has it; without one, the panels that only it can fill
 * say so (or are left out with `exclude`).
 *
 * For a project (the PM dashboard):
 *
 *   <MetricsBoard token={token} org={orgId} scope={{ kind: "project", id: projectId }}
 *     overview={null} exclude={["waiting-on-nobody", "spec-health", "idle", "spend-by-workspace"]}
 *     onOpen={(target) => …} />
 *
 * An older backend without the endpoint is said once in the status line, and
 * the panels that need it say so; the rest still draw. */

import { useEffect, useMemo, useState } from "react";

import { ApiError, api, type Deployment, type MetricsRange, type MetricsScope, type OrgMetrics, type OrgOverview } from "./api";
import { money } from "./costs";
import { boardStatus, buildBoard, type PanelTarget } from "./metrics-model";
import { PanelRow, RangePicker, type TargetLabels } from "./metrics-panels";
import { errText } from "./problem";

export function MetricsBoard({
  token,
  org,
  scope = { kind: "organization" },
  overview,
  overviewLoading = false,
  exclude = [],
  onOpen,
  labels,
  initialRange = "30d",
}: {
  token: string;
  /** The organization the scope is in. */
  org: string;
  scope?: MetricsScope;
  /** The organization's overview, when the screen has one. */
  overview: OrgOverview | null;
  overviewLoading?: boolean;
  /** Panel keys to leave out (e.g. those only an organization's overview fills). */
  exclude?: string[];
  onOpen?: (target: PanelTarget) => void;
  /** Where a panel opens, in the screen's words (metrics-panels.tsx). */
  labels?: TargetLabels;
  initialRange?: MetricsRange;
}) {
  const [range, setRange] = useState<MetricsRange>(initialRange);
  const [metrics, setMetrics] = useState<OrgMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<{ status: number | null; text: string } | null>(null);
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [reading, setReading] = useState(true);
  const scopeKey = scope.kind === "organization" ? "org" : `${scope.kind}:${scope.id}`;

  useEffect(() => {
    let live = true;
    setReading(true);
    setMetrics(null);
    setMetricsError(null);
    api
      .orgMetrics(token, org, range, scope)
      .then((r) => live && setMetrics(r))
      .catch((e) => live && setMetricsError({ status: e instanceof ApiError ? e.status : null, text: errText(e) }))
      .finally(() => live && setReading(false));
    return () => {
      live = false;
    };
    // `scope` is read through its key.
  }, [token, org, range, scopeKey]);

  useEffect(() => {
    let live = true;
    setDeployments(null);
    const params = scope.kind === "project" ? { project: scope.id } : { org };
    api
      .deployments(token, params)
      .then((r) => live && setDeployments(r.items))
      .catch(() => live && setDeployments(null));
    return () => {
      live = false;
    };
  }, [token, org, scopeKey]);

  const currency = metrics?.spend?.currency || overview?.spend?.currency || "USD";
  const inputs = useMemo(
    () => ({
      range,
      metrics,
      metricsError,
      overview,
      // A workspace's deploys are its projects': the list is the organization's.
      deployments:
        deployments && scope.kind === "workspace"
          ? metrics
            ? deployments.filter((d) => metrics.project_ids.includes(d.project_id))
            : null
          : deployments,
      money: (n: number) => money(n, currency),
      loading: reading || overviewLoading,
    }),
    [range, metrics, metricsError, overview, deployments, scope.kind, currency, reading, overviewLoading],
  );
  const rows = useMemo(
    () =>
      buildBoard(inputs)
        .map((r) => ({ ...r, panels: r.panels.filter((p) => !exclude.includes(p.key)) }))
        .filter((r) => r.panels.length > 0),
    [inputs, exclude.join(",")],
  );
  const against = `previous ${range.replace("d", " d")}`;

  return (
    <div className="mb-board" data-metrics-board={scope.kind}>
      <div className="mb-toolbar">
        <RangePicker value={range} onChange={setRange} />
        <span className="mb-status" data-board-status>
          {boardStatus(inputs)}
        </span>
      </div>
      {rows.map((row) => (
        <PanelRow key={row.key} row={row} against={against} onOpen={onOpen} labels={labels} />
      ))}
    </div>
  );
}
