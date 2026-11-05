/* The metrics board's model: what each panel says, from what the server
 * answered. Pure, so it is tested without a backend (metrics-model.test.ts).
 *
 * Sources:
 *   - `GET /studio-organizations/v1/metrics` (OrgMetrics): Studio's spend and
 *     Insight's repository figures, composed on the server
 *     (`studio-backend/src/organizations/metrics.rs`);
 *   - the organization's overview (OrgOverview), for what it already knows:
 *     open pull requests and who they wait on, spec health, idle members;
 *   - Studio's deployments (`/studio-environments/v1/deployments`).
 *
 * The board is scoped (organization, workspace or project): every panel is
 * built from whatever of the three the scope has, and one it lacks says so.
 * Unknown is never zero: a panel whose source is missing, unreadable or empty
 * says which, in words. */

import type { Deployment, MetricsCell, MetricsRange, OrgMetrics, OrgOverview } from "./api";

/* ── Trend ──────────────────────────────────────────────────────────────── */

/** Which way is good for a number: up, down, or neither. */
export type Better = "up" | "down" | "none";

export interface Trend {
  /** "+12%", "−3 pp", "±0%", "new". */
  text: string;
  dir: "up" | "down" | "flat";
  /** Read with `Better`: good, bad, or just a direction. */
  tone: "good" | "bad" | "neutral";
}

function toneOf(dir: Trend["dir"], better: Better): Trend["tone"] {
  if (dir === "flat" || better === "none") return "neutral";
  return dir === better ? "good" : "bad";
}

const known = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** The change of a count or an amount against the previous period, in per
 *  cent. Null when either side is unknown: no trend is not a flat trend. */
export function trend(current: number | null | undefined, previous: number | null | undefined, better: Better): Trend | null {
  if (!known(current) || !known(previous)) return null;
  if (previous === 0) {
    if (current === 0) return { text: "±0%", dir: "flat", tone: "neutral" };
    return { text: "new", dir: "up", tone: toneOf("up", better) };
  }
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (pct === 0) return { text: "±0%", dir: "flat", tone: "neutral" };
  const dir = pct > 0 ? "up" : "down";
  return { text: pct > 0 ? `+${pct}%` : `−${-pct}%`, dir, tone: toneOf(dir, better) };
}

/** The change of a share (0..1) in percentage points. */
export function pointsTrend(current: number | null | undefined, previous: number | null | undefined, better: Better): Trend | null {
  if (!known(current) || !known(previous)) return null;
  const pp = Math.round((current - previous) * 1000) / 10;
  if (Math.abs(pp) < 0.1) return { text: "±0 pp", dir: "flat", tone: "neutral" };
  const dir = pp > 0 ? "up" : "down";
  return { text: `${pp > 0 ? "+" : "−"}${Math.abs(pp).toFixed(1)} pp`, dir, tone: toneOf(dir, better) };
}

/** The change of a small count (a bus factor) as a difference: "+2", "−1". */
export function deltaTrend(current: number | null | undefined, previous: number | null | undefined, better: Better): Trend | null {
  if (!known(current) || !known(previous)) return null;
  const d = Math.round(current - previous);
  if (d === 0) return { text: "±0", dir: "flat", tone: "neutral" };
  const dir = d > 0 ? "up" : "down";
  return { text: `${d > 0 ? "+" : "−"}${Math.abs(d)}`, dir, tone: toneOf(dir, better) };
}

/** `a / b`, or null when there is nothing to divide by. */
export function ratio(a: number | null | undefined, b: number | null | undefined): number | null {
  return known(a) && known(b) && b !== 0 ? a / b : null;
}

/* ── Formats ────────────────────────────────────────────────────────────── */

/** Hours as people read them: "45 min", "7.2 h", "2.3 d". */
export function hoursText(h: number | null | undefined): string {
  if (!known(h)) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

export function pctText(share: number | null | undefined): string {
  return known(share) ? `${(share * 100).toFixed(share >= 0.995 || share < 0.1 ? 1 : 0)}%` : "—";
}

/** 1,284 / 12.9K / 4.2M. */
export function compact(n: number | null | undefined): string {
  if (!known(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (a >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  if (a >= 100 || Number.isInteger(n)) return Math.round(n).toLocaleString("en-US");
  return n.toFixed(1);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-05" → "Oct 5". */
export function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : iso;
}

/* ── Series ─────────────────────────────────────────────────────────────── */

export interface Point {
  /** The bucket's first day. */
  bucket: string;
  /** Null: nothing to measure in that bucket (a gap), not zero. */
  value: number | null;
}

/** One value per bucket, in the board's order. A bucket the series does not
 *  name is `empty`: 0 for counts (nothing happened), null for medians and
 *  shares (nothing to measure). */
export function fill(buckets: readonly string[], series: readonly { bucket: string; value: number | null }[], empty: 0 | null): Point[] {
  const by = new Map(series.map((p) => [p.bucket, p.value]));
  return buckets.map((bucket) => ({ bucket, value: by.has(bucket) ? (by.get(bucket) ?? null) : empty }));
}

type Measure = OrgMetrics["insight"]["measures"][number];

export function measure(m: OrgMetrics | null, key: string): Measure | null {
  return m?.insight.measures.find((x) => x.key === key) ?? null;
}

/** Bucket → cell for one measure. */
function cells(m: Measure | null): Map<string, MetricsCell> {
  return new Map((m?.series ?? []).map((p) => [p.bucket, p]));
}

/** A share per bucket: `num / den`, a gap where `den` is 0 or absent. */
export function shareSeries(buckets: readonly string[], num: Measure | null, den: Measure | null): Point[] {
  const n = cells(num);
  const d = cells(den);
  return buckets.map((bucket) => ({ bucket, value: ratio(n.get(bucket)?.total ?? 0, d.get(bucket)?.total ?? 0) }));
}

/** Per-week rate of a total over `days`. */
export function perWeek(total: number | null | undefined, days: number): number | null {
  return known(total) && days > 0 ? (total * 7) / days : null;
}

/** Studio's deployments that ran (succeeded or failed) in `[from, to]` days,
 *  per bucket, and the previous window's count. */
export function deploymentCounts(
  deployments: readonly Deployment[],
  buckets: readonly string[],
  window: { previous_from: string; current_from: string; to: string },
): { current: number; previous: number; series: Point[] } {
  const ran = deployments.filter((d) => d.state === "succeeded" || d.state === "failed");
  const day = (d: Deployment) => (d.decided_at ?? d.requested_at ?? "").slice(0, 10);
  const series = buckets.map((bucket) => ({ bucket, value: 0 as number | null }));
  let current = 0;
  let previous = 0;
  for (const d of ran) {
    const at = day(d);
    if (!at || at > window.to || at < window.previous_from) continue;
    if (at < window.current_from) {
      previous += 1;
      continue;
    }
    current += 1;
    // The last bucket starting on or before the day.
    let i = buckets.length - 1;
    while (i > 0 && buckets[i] > at) i -= 1;
    if (series[i]) series[i].value = (series[i].value ?? 0) + 1;
  }
  return { current, previous, series };
}

/* ── Panels ─────────────────────────────────────────────────────────────── */

/** Where a panel's click goes; the screens a board can open. */
/** `specs` and `releases` are a project's own tabs (its Overview). */
export type PanelTarget = "projects" | "people" | "costs" | "environments" | "reports" | "tasks" | "specs" | "releases";

export type PanelState =
  /** Drawn from data. */
  | "ok"
  | "loading"
  /** The source answered and holds nothing for this scope. */
  | "empty"
  /** The source could not be asked. */
  | "unavailable"
  /** The caller may not see it. */
  | "hidden";

export type PanelChart =
  | { kind: "line" | "bars"; points: Point[]; format: (v: number) => string }
  | { kind: "rank"; rows: { label: string; value: number }[]; format: (v: number) => string };

export interface Panel {
  key: string;
  title: string;
  source: "Studio" | "Insight" | "Studio + Insight";
  state: PanelState;
  /** The headline, formatted. */
  value: string;
  /** What the headline is, in a few words ("merged per week"). */
  unit?: string;
  trend: Trend | null;
  /** A second line: context for the headline. */
  sub?: string;
  chart: PanelChart | null;
  /** The "?": what the number means and where it comes from. */
  info: string;
  /** Why there is no number, when `state` is not `ok`. */
  why?: string;
  target: PanelTarget;
}

export interface BoardRow {
  key: "delivery" | "quality" | "money" | "people" | "project";
  title: string;
  panels: Panel[];
}

/** What the board is built from. Every part may be missing. */
export interface BoardInputs {
  range: MetricsRange;
  /** The metrics answer; null while reading or when it failed (`metricsError`). */
  metrics: OrgMetrics | null;
  /** Why there is no metrics answer: a missing endpoint is said so. */
  metricsError: { status: number | null; text: string } | null;
  /** The organization's overview: only the organization scope has one. */
  overview: OrgOverview | null;
  /** Studio's deployments in scope; null when they could not be read. */
  deployments: Deployment[] | null;
  money: (n: number) => string;
  loading: boolean;
  /** Today, for windows worked out without the server; defaults to now. */
  now?: Date;
}

/** The windows a range compares, as the server cuts them
 *  (`organizations/metrics.rs`, `span`): UTC days, today included, buckets of
 *  a day for 7 days and Monday weeks otherwise. */
export function localSpan(
  range: MetricsRange,
  now: Date,
): { previous_from: string; current_from: string; to: string; buckets: string[] } {
  const day = 86_400_000;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = RANGE_DAYS[range];
  const from = today - (days - 1) * day;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const buckets: string[] = [];
  if (days === 7) for (let t = from; t <= today; t += day) buckets.push(iso(t));
  else {
    const sinceMonday = (new Date(from).getUTCDay() + 6) % 7;
    for (let t = from - sinceMonday * day; t <= today; t += 7 * day) buckets.push(iso(t));
  }
  return { previous_from: iso(from - days * day), current_from: iso(from), to: iso(today), buckets };
}

/** Days in a range. */
export const RANGE_DAYS: Record<MetricsRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** Why Insight's panels hold no number, or null when they can. */
export function insightWhy(i: BoardInputs): { state: PanelState; why: string } | null {
  if (i.metricsError) {
    if (i.metricsError.status === 404 || i.metricsError.status === 405)
      return {
        state: "unavailable",
        why: "Needs the metrics endpoint, which this server's build does not have yet.",
      };
    return { state: "unavailable", why: `The metrics could not be read: ${i.metricsError.text}` };
  }
  const m = i.metrics;
  if (!m) return i.loading ? { state: "loading", why: "Reading…" } : { state: "unavailable", why: "Not read." };
  switch (m.insight.state) {
    case "ok":
      return null;
    case "unconfigured":
      return { state: "unavailable", why: "Constructor Insight is not configured on this server, so there are no repository figures." };
    case "unreachable":
      return { state: "unavailable", why: `Constructor Insight did not answer${m.insight.detail ? `: ${m.insight.detail}` : "."}` };
    case "failed":
      return { state: "unavailable", why: `Constructor Insight could not answer${m.insight.detail ? `: ${m.insight.detail}` : "."}` };
    case "absent":
      return { state: "unavailable", why: "This deployment has no Insight integration." };
    case "no_repositories":
      return { state: "empty", why: "No project here names a repository, so there is nothing to ask Insight about." };
  }
}

const n0 = (v: number) => compact(v);

function off(base: Omit<Panel, "state" | "value" | "trend" | "chart">, s: { state: PanelState; why: string }): Panel {
  return { ...base, state: s.state, value: "—", trend: null, chart: null, why: s.why };
}

const INSIGHT_SRC =
  "Source: Constructor Insight, for the repositories this scope's projects are made of; bots are left out where people are counted.";

/** The board: four rows of panels, every panel saying where its number is from. */
export function buildBoard(i: BoardInputs): BoardRow[] {
  const m = i.metrics;
  const days = RANGE_DAYS[i.range];
  // Without the server's answer, the same windows worked out here.
  const win = m ?? localSpan(i.range, i.now ?? new Date());
  const buckets = win.buckets;
  const ins = insightWhy(i);
  const ov = i.overview;
  const span = `${days} d`;

  /* ── Delivery ── */
  const merged = measure(m, "git.pr_merged");
  const mergedPanel = (() => {
    const base = {
      key: "pr-throughput",
      title: "PR throughput",
      source: "Insight" as const,
      unit: "merged per week",
      info: `Pull requests merged per week over the last ${span}, against the ${span} before. ${INSIGHT_SRC}`,
      target: "projects" as const,
    };
    if (ins) return off(base, ins);
    if (!merged?.current) return off(base, { state: "empty", why: `No pull request merged in the last ${span}.` });
    return {
      ...base,
      state: "ok" as const,
      value: compact(perWeek(merged.current.total, days)),
      trend: trend(merged.current.total, merged.previous?.total ?? 0, "up"),
      sub: `${compact(merged.current.total)} merged in ${span}`,
      chart: { kind: "bars" as const, points: fill(buckets, merged.series.map((p) => ({ bucket: p.bucket, value: p.total })), 0), format: n0 },
    };
  })();

  const timing = (key: string, measureKey: string, title: string, what: string): Panel => {
    const x = measure(m, measureKey);
    const base = {
      key,
      title,
      source: "Insight" as const,
      unit: "median",
      info: `${what} The median over pull requests of the last ${span}, against the ${span} before; a week with no pull request is a gap, not zero. ${INSIGHT_SRC}`,
      target: "projects" as const,
    };
    if (ins) return off(base, ins);
    if (!x?.current || x.current.median === null) return off(base, { state: "empty", why: `No pull request to time in the last ${span}.` });
    return {
      ...base,
      state: "ok",
      value: hoursText(x.current.median),
      trend: trend(x.current.median, x.previous?.median ?? null, "down"),
      sub: `${compact(x.current.count)} pull requests`,
      chart: { kind: "line", points: fill(buckets, x.series.map((p) => ({ bucket: p.bucket, value: p.median })), null), format: hoursText },
    };
  };

  const deployPanel = ((): Panel => {
    const ci = measure(m, "ci.deployments");
    const studio = i.deployments ? deploymentCounts(i.deployments, buckets, win) : null;
    const base = {
      key: "deployments",
      title: "Deployments",
      source: "Studio + Insight" as const,
      unit: "per week",
      info:
        `Deployments per week over the last ${span}. The headline is the CI pipelines' deployments Insight counts for the scope's repositories ` +
        `(ci.deployments); the line under it is Studio's own deploys to its environments that ran (succeeded or failed). The two can overlap: a Studio deploy may run a pipeline.`,
      target: "environments" as const,
    };
    const studioText = studio ? `Studio: ${studio.current} deploy${studio.current === 1 ? "" : "s"} in ${span}` : "Studio's deploys could not be read";
    if (ci?.current && !ins)
      return {
        ...base,
        state: "ok",
        value: compact(perWeek(ci.current.total, days)),
        trend: trend(ci.current.total, ci.previous?.total ?? 0, "up"),
        sub: `${compact(ci.current.total)} by CI · ${studioText}`,
        chart: { kind: "bars", points: fill(buckets, ci.series.map((p) => ({ bucket: p.bucket, value: p.total })), 0), format: n0 },
      };
    if (studio)
      return {
        ...base,
        source: "Studio",
        state: "ok",
        value: compact(perWeek(studio.current, days)),
        trend: trend(studio.current, studio.previous, "up"),
        // Why Insight has no figure is the board's status line and the "?", once.
        sub: `${studio.current} in ${span} · ${ins ? "Studio's own deploys only" : "no CI deployments in Insight"}`,
        chart: { kind: "bars", points: studio.series, format: n0 },
      };
    return off(base, ins ?? { state: i.loading ? "loading" : "unavailable", why: studioText });
  })();

  const waitingPanel = ((): Panel => {
    const base = {
      key: "waiting-on-nobody",
      title: "Open PRs waiting on nobody",
      source: "Studio" as const,
      unit: "no reviewer asked",
      info:
        `Open pull requests stuck over ${ov?.stuck_days ?? 7} days with no reviewer asked, from the organization's overview (Studio reads every project's open pull requests). ` +
        "The bars are who the stuck ones wait on. It is now, not a range: there is no trend.",
      target: "projects" as const,
    };
    if (!ov) return off(base, { state: i.loading ? "loading" : "unavailable", why: i.loading ? "Reading…" : "Only the organization's overview counts these." });
    if (ov.waiting_on === null) return off(base, { state: "unavailable", why: "No project's pull requests could be read." });
    const nobody = ov.waiting_on.filter((q) => q.who === null).reduce((a, q) => a + q.count, 0);
    return {
      ...base,
      state: "ok",
      value: String(nobody),
      trend: null,
      sub: `${ov.delivery.open ?? "—"} open · median wait ${ov.delivery.median_wait_days ?? "—"} d`,
      chart:
        ov.waiting_on.length > 0
          ? { kind: "rank", rows: ov.waiting_on.slice(0, 5).map((q) => ({ label: q.who ?? "Nobody asked", value: q.count })), format: n0 }
          : null,
    };
  })();

  /* ── Quality ── */
  const share = (
    key: string,
    title: string,
    numKey: string,
    denKey: string,
    better: Better,
    unit: string,
    info: string,
    empty: string,
  ): Panel => {
    const num = measure(m, numKey);
    const den = measure(m, denKey);
    const base = { key, title, source: "Insight" as const, unit, info: `${info} ${INSIGHT_SRC}`, target: "projects" as const };
    if (ins) return off(base, ins);
    const cur = ratio(num?.current?.total ?? 0, den?.current?.total);
    if (cur === null) return off(base, { state: "empty", why: empty });
    const prev = ratio(num?.previous?.total ?? 0, den?.previous?.total);
    return {
      ...base,
      state: "ok",
      value: pctText(cur),
      trend: pointsTrend(cur, prev, better),
      sub: `${compact(num?.current?.total ?? 0)} of ${compact(den?.current?.total ?? 0)}`,
      chart: { kind: "line", points: shareSeries(buckets, num, den), format: pctText },
    };
  };

  const testRatio = ((): Panel => {
    const t = measure(m, "git.test_lines_added");
    const c = measure(m, "git.code_lines_added");
    const base = {
      key: "test-ratio",
      title: "Test-to-code lines",
      source: "Insight" as const,
      unit: "test lines per 100 code lines",
      info: `Lines added to tests for every 100 lines added to code over the last ${span} (test_lines_added / code_lines_added). Churn counts generated files too: read it as a direction. ${INSIGHT_SRC}`,
      target: "projects" as const,
    };
    if (ins) return off(base, ins);
    const cur = ratio(t?.current?.total ?? 0, c?.current?.total);
    if (cur === null) return off(base, { state: "empty", why: `No code line added in the last ${span}.` });
    const prev = ratio(t?.previous?.total ?? 0, c?.previous?.total);
    const series = shareSeries(buckets, t, c).map((p) => ({ ...p, value: p.value === null ? null : p.value * 100 }));
    return {
      ...base,
      state: "ok",
      value: compact(Math.round(cur * 1000) / 10),
      trend: trend(cur, prev, "up"),
      sub: `${compact(t?.current?.total ?? 0)} test · ${compact(c?.current?.total ?? 0)} code lines`,
      chart: { kind: "line", points: series, format: (v) => compact(Math.round(v * 10) / 10) },
    };
  })();

  const specPanel = ((): Panel => {
    const base = {
      key: "spec-health",
      title: "Spec health",
      source: "Studio" as const,
      unit: "failing specs",
      info: "Specs failing their checks and the open findings against them, across the organization's projects (Studio's spec quality, from the overview). It is now, not a range: Studio keeps no history of it yet. The bars are the workspaces with failing specs.",
      target: "projects" as const,
    };
    if (!ov) return off(base, { state: i.loading ? "loading" : "unavailable", why: i.loading ? "Reading…" : "Only the organization's overview counts these." });
    if (ov.specs.failing === null) return off(base, { state: "unavailable", why: "No project's specs could be read." });
    const rows = ov.workspaces
      .filter((w) => w.specs_failing > 0)
      .sort((a, b) => b.specs_failing - a.specs_failing)
      .slice(0, 5)
      .map((w) => ({ label: w.name, value: w.specs_failing }));
    return {
      ...base,
      state: "ok",
      value: String(ov.specs.failing),
      trend: null,
      sub: `${ov.specs.open_findings ?? "—"} open findings · ${ov.specs.specs ?? "—"} specs`,
      chart: rows.length ? { kind: "rank", rows, format: n0 } : null,
    };
  })();

  const bugsPanel = ((): Panel => {
    const fixed = measure(m, "task.bugs_fixed");
    const reopened = measure(m, "task.reopened_within_14d");
    const closed = measure(m, "task.tasks_closed");
    const base = {
      key: "bugs",
      title: "Bugs fixed",
      source: "Insight" as const,
      unit: `in ${span}`,
      info: `Issues typed Bug closed as fixed in the scope's repositories over the last ${span}, and how many were reopened within 14 days of closing. Insight reads the issues of the repositories themselves (GitHub issues today). ${INSIGHT_SRC}`,
      target: "projects" as const,
    };
    if (ins) return off(base, ins);
    if (!fixed && !reopened && !closed)
      return off(base, { state: "empty", why: "No issue data for these repositories: Insight holds no task records for them in this range." });
    const reopenedNow = reopened?.current?.total ?? 0;
    return {
      ...base,
      state: "ok",
      value: compact(fixed?.current?.total ?? 0),
      trend: trend(fixed?.current?.total ?? 0, fixed?.previous?.total ?? 0, "none"),
      sub: `${compact(reopenedNow)} reopened within 14 days${(reopened?.previous?.total ?? 0) > 0 || reopenedNow > 0 ? ` (was ${compact(reopened?.previous?.total ?? 0)})` : ""}`,
      chart: { kind: "bars", points: fill(buckets, (fixed?.series ?? []).map((p) => ({ bucket: p.bucket, value: p.total })), 0), format: n0 },
    };
  })();

  /* ── Money ── */
  const moneyWhy = ((): { state: PanelState; why: string } | null => {
    if (m) {
      if (m.costs === "hidden") return { state: "hidden", why: "Costs are not yours to see (it takes cost.view)." };
      if (m.costs === "unreadable") return { state: "unavailable", why: "The costs could not be read." };
      return null;
    }
    if (ov && i.range === "30d") {
      if (ov.costs === "hidden") return { state: "hidden", why: "Costs are not yours to see (it takes cost.view)." };
      if (ov.costs === "unreadable") return { state: "unavailable", why: "The costs could not be read." };
      return null;
    }
    if (i.loading) return { state: "loading", why: "Reading…" };
    return {
      state: "unavailable",
      why: i.metricsError ? "This server reports spend over 30 days only (the overview); pick 30d." : "Not read.",
    };
  })();
  // Without the metrics answer, the overview's 30 days stand in.
  const spendNow = m?.spend?.current ?? (m ? null : (ov?.spend?.current ?? null));
  const spendBefore = m?.spend?.previous ?? (m ? null : (ov?.spend?.previous ?? null));

  const spendPanel = ((): Panel => {
    const base = {
      key: "spend",
      title: "Spend",
      source: "Studio" as const,
      unit: `in ${span}`,
      info: `What the scope's model calls and IDE sessions cost over the last ${span}, against the ${span} before, at the organization's price list (Studio's usage metering). People's own keys are not the organization's money and are left out.`,
      target: "costs" as const,
    };
    if (moneyWhy) return off(base, moneyWhy);
    if (spendNow === null) return off(base, { state: "unavailable", why: "The costs could not be read." });
    const unpriced = m?.spend?.unpriced ?? ov?.spend?.unpriced ?? [];
    return {
      ...base,
      state: "ok",
      value: i.money(spendNow),
      trend: trend(spendNow, spendBefore, "none"),
      sub: unpriced.length ? `No price for ${unpriced.slice(0, 2).join(", ")}${unpriced.length > 2 ? "…" : ""}` : `was ${i.money(spendBefore ?? 0)}`,
      chart: m?.spend
        ? { kind: "line", points: fill(buckets, m.spend.series.map((p) => ({ bucket: p.bucket, value: p.cost })), 0), format: i.money }
        : null,
    };
  })();

  const byWsPanel = ((): Panel => {
    const base = {
      key: "spend-by-workspace",
      title: "Spend by workspace",
      source: "Studio" as const,
      unit: "the top workspace",
      info: `Where the money of the last ${span} went, the five workspaces that spent most (a project's spend is its workspace's; the organization's own is under its name). Studio's usage metering.`,
      target: "costs" as const,
    };
    if (moneyWhy) return off(base, moneyWhy);
    const rows =
      m?.spend?.by_workspace.map((w) => ({ name: w.name, cost: w.cost, previous: w.previous })) ??
      (m ? null : (ov?.workspaces.map((w) => ({ name: w.name, cost: w.spend ?? 0, previous: w.previous ?? 0 })) ?? null));
    if (!rows) return off(base, { state: "unavailable", why: "The costs could not be read." });
    const top = [...rows].filter((r) => r.cost > 0).sort((a, b) => b.cost - a.cost);
    if (top.length === 0) return off(base, { state: "empty", why: `Nothing spent in the last ${span}.` });
    const total = top.reduce((a, r) => a + r.cost, 0);
    return {
      ...base,
      state: "ok",
      value: i.money(top[0].cost),
      trend: trend(top[0].cost, top[0].previous, "none"),
      sub: `${top[0].name} · ${pctText(ratio(top[0].cost, total))} of the spend`,
      chart: { kind: "rank", rows: top.slice(0, 5).map((r) => ({ label: r.name, value: r.cost })), format: i.money },
    };
  })();

  const perPrPanel = ((): Panel => {
    const base = {
      key: "cost-per-pr",
      title: "Cost per merged PR",
      source: "Studio + Insight" as const,
      unit: "spend ÷ merged PRs",
      info: `The spend of the last ${span} (Studio) divided by the pull requests merged in it (Insight), against the same for the ${span} before. A rough unit cost of delivery, not a price: model calls also go to work that merges nothing.`,
      target: "costs" as const,
    };
    if (moneyWhy) return off(base, moneyWhy);
    if (ins) return off(base, ins);
    if (!m?.spend) return off(base, { state: "unavailable", why: "The costs could not be read." });
    const cur = ratio(m.spend.current, merged?.current?.total);
    if (cur === null) return off(base, { state: "empty", why: `No pull request merged in the last ${span}.` });
    const prev = ratio(m.spend.previous, merged?.previous?.total);
    const deploys = measure(m, "ci.deployments")?.current?.total;
    const mergedBy = cells(merged);
    return {
      ...base,
      state: "ok",
      value: i.money(cur),
      trend: trend(cur, prev, "down"),
      sub: deploys ? `${i.money(m.spend.current / deploys)} per deployment` : `${compact(merged?.current?.total ?? 0)} merged`,
      chart: {
        kind: "line",
        points: buckets.map((bucket) => ({
          bucket,
          value: ratio(m.spend?.series.find((p) => p.bucket === bucket)?.cost ?? 0, mergedBy.get(bucket)?.total ?? 0),
        })),
        format: i.money,
      },
    };
  })();

  /* ── People ── */
  const contributorsPanel = ((): Panel => {
    const x = measure(m, "git.contributors");
    const base = {
      key: "contributors",
      title: "Active contributors",
      source: "Insight" as const,
      unit: `committed in ${span}`,
      info: `Distinct commit authors in the scope's repositories over the last ${span}, bots left out. Insight keys them by their git identity, not by Studio member: one person with two addresses counts twice. ${INSIGHT_SRC}`,
      target: "people" as const,
    };
    if (ins) return off(base, ins);
    if (!x?.current) return off(base, { state: "empty", why: `Nobody committed in the last ${span}.` });
    return {
      ...base,
      state: "ok",
      value: String(x.current.people),
      trend: trend(x.current.people, x.previous?.people ?? 0, "up"),
      sub: `${compact(measure(m, "git.commit_count")?.current?.total ?? null)} commits`,
      chart: { kind: "bars", points: fill(buckets, x.series.map((p) => ({ bucket: p.bucket, value: p.people })), 0), format: n0 },
    };
  })();

  const reviewPanel = ((): Panel => {
    const cur = m?.insight.reviews.find((r) => r.period === "cur") ?? null;
    const prev = m?.insight.reviews.find((r) => r.period === "prev") ?? null;
    const base = {
      key: "review-spread",
      title: "Review load spread",
      source: "Insight" as const,
      unit: "reviewers do half the reviews",
      info:
        `The fewest reviewers who did half of the last ${span}'s reviews (a bus factor: 1 or 2 means reviews hang on very few people), against the ${span} before. ` +
        `The bars are the five busiest reviewers' shares, unnamed. ${INSIGHT_SRC}`,
      target: "people" as const,
    };
    if (ins) return off(base, ins);
    if (!cur || cur.reviews === 0) return off(base, { state: "empty", why: `No review in the last ${span}.` });
    return {
      ...base,
      state: "ok",
      value: String(cur.half),
      trend: deltaTrend(cur.half, prev?.half ?? null, "up"),
      sub: `of ${cur.reviewers} reviewers · ${compact(cur.reviews)} reviews · the busiest did ${pctText(ratio(cur.top[0] ?? 0, cur.reviews))}`,
      chart: { kind: "rank", rows: cur.top.map((v, k) => ({ label: `Reviewer #${k + 1}`, value: v / cur.reviews })), format: pctText },
    };
  })();

  const idlePanel = ((): Panel => {
    const base = {
      key: "idle",
      title: "Idle members",
      source: "Studio" as const,
      unit: "idle for 30 days",
      info: "Members with no model spend attributed to them and no open pull request they wrote or review in the last 30 days, from the organization's overview. It is now, not a range.",
      target: "people" as const,
    };
    if (!ov) return off(base, { state: i.loading ? "loading" : "unavailable", why: i.loading ? "Reading…" : "Only the organization's overview counts these." });
    if (ov.people.idle === null) return off(base, { state: "unavailable", why: "The members could not be read." });
    const idle = ov.people.idle.length;
    const active = ov.people.active ?? null;
    return {
      ...base,
      state: "ok",
      value: String(idle),
      trend: null,
      sub: active !== null ? `of ${active} active members` : "",
      chart:
        active !== null
          ? { kind: "rank", rows: [{ label: "Active", value: Math.max(0, active - idle) }, { label: "Idle", value: idle }], format: n0 }
          : null,
    };
  })();

  const aiPanel = ((): Panel => {
    const base = {
      key: "ai-usage",
      title: "AI usage",
      source: "Insight" as const,
      info: "AI assistant use (Claude, ChatGPT, Cursor) per person, from Insight's ai_* observations. Studio's own model calls are under Spend.",
      target: "costs" as const,
    };
    if (ins) return off(base, ins);
    const rows = m?.insight.ai_rows ?? null;
    if (rows === null) return off(base, { state: "unavailable", why: "Insight could not say whether its AI connectors hold data." });
    if (rows === 0) return off(base, { state: "empty", why: "No data yet: Insight's AI connectors have not been ingested." });
    return off(base, {
      state: "empty",
      why: "Insight holds AI usage, but not yet tied to this scope's repositories or members (identity resolution is thin).",
    });
  })();

  return [
    {
      key: "delivery",
      title: "Delivery",
      panels: [
        mergedPanel,
        timing("pr-cycle", "git.pr_cycle_hours", "PR cycle time", "Hours from a pull request opened to merged."),
        timing("first-review", "git.pr_first_review_hours", "Time to first review", "Hours from a pull request opened to its first review."),
        deployPanel,
        waitingPanel,
      ],
    },
    {
      key: "quality",
      title: "Quality",
      panels: [
        share(
          "ci-first-try",
          "CI first-try pass rate",
          "ci.gate_first_try_passed",
          "ci.gate_runs",
          "up",
          "gate runs green first time",
          `Gate runs that passed without a retry, of all gate runs, over the last ${span} (gate_first_try_passed / gate_runs); the trend is in percentage points.`,
          `No gate run in the last ${span}.`,
        ),
        share(
          "unapproved",
          "Merged without approval",
          "git.pr_merged_without_approval",
          "git.pr_merged",
          "down",
          "of merged PRs",
          `Pull requests merged with no approving review, of all merged, over the last ${span}; the trend is in percentage points.`,
          `No pull request merged in the last ${span}.`,
        ),
        testRatio,
        specPanel,
        bugsPanel,
      ],
    },
    { key: "money", title: "Money", panels: [spendPanel, byWsPanel, perPrPanel] },
    { key: "people", title: "People", panels: [contributorsPanel, reviewPanel, idlePanel, aiPanel] },
  ];
}

/** The board's status line: where its figures come from. */
export function boardStatus(i: BoardInputs): string {
  const m = i.metrics;
  if (i.metricsError) return insightWhy(i)?.why ?? "";
  if (!m) return i.loading ? "Reading the metrics…" : "";
  const repos = m.repositories.length;
  const scope = `${m.projects} project${m.projects === 1 ? "" : "s"} · ${repos} repositor${repos === 1 ? "y" : "ies"}`;
  const window = `${dayLabel(m.current_from)} – ${dayLabel(m.to)}`;
  return `${window} · ${scope}${m.insight.truncated ? " · Insight cut a page: some figures are partial" : ""}`;
}
