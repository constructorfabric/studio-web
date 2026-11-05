import { describe, expect, it } from "vitest";

import type { Deployment, OrgMetrics, OrgOverview } from "./api";
import {
  boardStatus,
  buildBoard,
  compact,
  dayLabel,
  deltaTrend,
  deploymentCounts,
  fill,
  hoursText,
  insightWhy,
  localSpan,
  perWeek,
  pointsTrend,
  ratio,
  shareSeries,
  trend,
  type BoardInputs,
  type Panel,
} from "./metrics-model";

const cell = (total: number, extra: Partial<{ median: number | null; count: number; people: number }> = {}) => ({
  total,
  median: null,
  count: 1,
  people: 1,
  ...extra,
});

const BUCKETS = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"];

function metrics(extra: Partial<OrgMetrics> = {}, insight: Partial<OrgMetrics["insight"]> = {}): OrgMetrics {
  return {
    organization_id: "org",
    scope: "organization",
    scope_id: "org",
    range: "30d",
    days: 30,
    bucket: "week",
    current_from: "2026-10-06",
    to: "2026-11-04",
    previous_from: "2026-09-06",
    previous_to: "2026-10-05",
    buckets: BUCKETS,
    repositories: ["acme/api", "acme/web"],
    projects: 2,
    project_ids: ["p1", "p2"],
    insight: {
      state: "ok",
      detail: null,
      truncated: false,
      measures: [
        {
          key: "git.pr_merged",
          current: cell(60),
          previous: cell(40),
          series: [
            { bucket: "2026-10-05", ...cell(10) },
            { bucket: "2026-10-19", ...cell(50) },
          ],
        },
        {
          key: "git.pr_cycle_hours",
          current: cell(500, { median: 6, count: 60 }),
          previous: cell(400, { median: 12 }),
          series: [{ bucket: "2026-10-12", ...cell(100, { median: 5 }) }],
        },
        { key: "ci.gate_runs", current: cell(200), previous: cell(100), series: [{ bucket: "2026-10-05", ...cell(200) }] },
        {
          key: "ci.gate_first_try_passed",
          current: cell(180),
          previous: cell(80),
          series: [{ bucket: "2026-10-05", ...cell(180) }],
        },
        { key: "git.contributors", current: cell(90, { people: 12 }), previous: cell(80, { people: 10 }), series: [] },
      ],
      reviews: [
        { period: "cur", reviewers: 10, reviews: 100, half: 2, top: [40, 20, 10] },
        { period: "prev", reviewers: 8, reviews: 80, half: 3, top: [30] },
      ],
      ai_rows: 0,
      ...insight,
    },
    costs: "shown",
    spend: {
      currency: "USD",
      current: 120,
      previous: 100,
      series: BUCKETS.map((bucket) => ({ bucket, cost: 24 })),
      by_workspace: [
        { id: "w1", name: "Alpha", cost: 90, previous: 60 },
        { id: "w2", name: "Beta", cost: 30, previous: 40 },
      ],
      unpriced: [],
    },
    ...extra,
  };
}

const inputs = (extra: Partial<BoardInputs> = {}): BoardInputs => ({
  range: "30d",
  metrics: metrics(),
  metricsError: null,
  overview: null,
  deployments: [],
  money: (n) => `$${n.toFixed(2)}`,
  loading: false,
  ...extra,
});

function panel(i: BoardInputs, key: string): Panel {
  const p = buildBoard(i)
    .flatMap((r) => r.panels)
    .find((x) => x.key === key);
  if (!p) throw new Error(`no panel ${key}`);
  return p;
}

describe("trend maths", () => {
  it("says the change in per cent, and which way is good", () => {
    expect(trend(120, 100, "up")).toEqual({ text: "+20%", dir: "up", tone: "good" });
    expect(trend(80, 100, "up")).toEqual({ text: "−20%", dir: "down", tone: "bad" });
    expect(trend(80, 100, "down")).toMatchObject({ tone: "good" });
    expect(trend(130, 100, "none")).toMatchObject({ text: "+30%", tone: "neutral" });
    expect(trend(100.2, 100, "up")).toEqual({ text: "±0%", dir: "flat", tone: "neutral" });
  });

  it("calls growth from nothing 'new', and nothing to nothing flat", () => {
    expect(trend(5, 0, "up")).toEqual({ text: "new", dir: "up", tone: "good" });
    expect(trend(0, 0, "up")).toMatchObject({ dir: "flat" });
  });

  it("has no trend when a side is unknown -- not a flat one", () => {
    expect(trend(null, 10, "up")).toBeNull();
    expect(trend(10, undefined, "up")).toBeNull();
    expect(trend(Number.NaN, 10, "up")).toBeNull();
  });

  it("moves shares in percentage points", () => {
    expect(pointsTrend(0.9, 0.8, "up")).toEqual({ text: "+10.0 pp", dir: "up", tone: "good" });
    expect(pointsTrend(0.05, 0.1, "down")).toEqual({ text: "−5.0 pp", dir: "down", tone: "good" });
    expect(pointsTrend(0.5, 0.5, "up")).toMatchObject({ dir: "flat" });
    expect(pointsTrend(null, 0.5, "up")).toBeNull();
  });

  it("says a small count's change as a difference", () => {
    expect(deltaTrend(7, 1, "up")).toEqual({ text: "+6", dir: "up", tone: "good" });
    expect(deltaTrend(2, 3, "up")).toEqual({ text: "−1", dir: "down", tone: "bad" });
    expect(deltaTrend(2, 2, "up")).toMatchObject({ dir: "flat" });
    expect(deltaTrend(2, null, "up")).toBeNull();
  });

  it("divides only by something", () => {
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(1, null)).toBeNull();
    expect(perWeek(60, 30)).toBe(14);
  });
});

describe("formats", () => {
  it("reads hours, counts and days the way people do", () => {
    expect(hoursText(0.25)).toBe("15 min");
    expect(hoursText(7.24)).toBe("7.2 h");
    expect(hoursText(30)).toBe("30 h");
    expect(hoursText(72)).toBe("3.0 d");
    expect(hoursText(null)).toBe("—");
    expect(compact(1284)).toBe("1,284");
    expect(compact(12_900)).toBe("12.9K");
    expect(compact(4_200_000)).toBe("4.2M");
    expect(dayLabel("2026-10-05")).toBe("Oct 5");
  });
});

describe("series", () => {
  it("fills a count's missing bucket with 0 and a median's with a gap", () => {
    const s = [{ bucket: "2026-10-12", value: 3 }];
    expect(fill(BUCKETS.slice(0, 3), s, 0).map((p) => p.value)).toEqual([0, 3, 0]);
    expect(fill(BUCKETS.slice(0, 3), s, null).map((p) => p.value)).toEqual([null, 3, null]);
  });

  it("makes a share per bucket, a gap where nothing ran", () => {
    const m = metrics();
    const num = m.insight.measures.find((x) => x.key === "ci.gate_first_try_passed")!;
    const den = m.insight.measures.find((x) => x.key === "ci.gate_runs")!;
    expect(shareSeries(BUCKETS.slice(0, 2), num, den).map((p) => p.value)).toEqual([0.9, null]);
  });

  it("counts Studio deploys that ran, per bucket and against the window before", () => {
    const d = (state: Deployment["state"], at: string) => ({ state, requested_at: at, decided_at: null }) as unknown as Deployment;
    const c = deploymentCounts(
      [
        d("succeeded", "2026-10-06T10:00:00Z"),
        d("failed", "2026-10-20T10:00:00Z"),
        d("declined", "2026-10-20T10:00:00Z"),
        d("succeeded", "2026-09-10T10:00:00Z"),
        d("succeeded", "2026-08-01T10:00:00Z"),
      ],
      BUCKETS,
      metrics(),
    );
    expect(c.current).toBe(2);
    expect(c.previous).toBe(1);
    expect(c.series.map((p) => p.value)).toEqual([1, 0, 1, 0, 0]);
  });
});

describe("windows worked out without the server", () => {
  it("cuts them as the server does", () => {
    const now = new Date("2026-11-04T15:00:00Z");
    expect(localSpan("30d", now)).toEqual({
      previous_from: "2026-09-06",
      current_from: "2026-10-06",
      to: "2026-11-04",
      buckets: BUCKETS,
    });
    const week = localSpan("7d", now);
    expect(week.current_from).toBe("2026-10-29");
    expect(week.previous_from).toBe("2026-10-22");
    expect(week.buckets).toHaveLength(7);
    expect(localSpan("90d", now).buckets[0]).toBe("2026-08-03");
  });
});

describe("the board's panels", () => {
  it("draws the four rows, and every panel says where it is from", () => {
    const rows = buildBoard(inputs());
    expect(rows.map((r) => r.key)).toEqual(["delivery", "quality", "money", "people"]);
    for (const p of rows.flatMap((r) => r.panels)) {
      expect(p.info.length).toBeGreaterThan(20);
      expect(["Studio", "Insight", "Studio + Insight"]).toContain(p.source);
    }
  });

  it("computes the headlines and their trends", () => {
    const i = inputs();
    expect(panel(i, "pr-throughput")).toMatchObject({ state: "ok", value: "14", trend: { text: "+50%", tone: "good" } });
    expect(panel(i, "pr-cycle")).toMatchObject({ value: "6.0 h", trend: { text: "−50%", tone: "good" } });
    expect(panel(i, "ci-first-try")).toMatchObject({ value: "90%", trend: { text: "+10.0 pp" } });
    expect(panel(i, "contributors")).toMatchObject({ value: "12", trend: { text: "+20%" } });
    expect(panel(i, "review-spread")).toMatchObject({ value: "2", trend: { text: "−1", tone: "bad" } });
    expect(panel(i, "spend")).toMatchObject({ value: "$120.00", trend: { text: "+20%", tone: "neutral" } });
    expect(panel(i, "spend-by-workspace")).toMatchObject({ value: "$90.00", sub: "Alpha · 75% of the spend" });
    // $120 / 60 merged against $100 / 40.
    expect(panel(i, "cost-per-pr")).toMatchObject({ value: "$2.00", trend: { text: "−20%", tone: "good" } });
  });

  it("says a measure with no observation is empty, not zero", () => {
    const i = inputs({ metrics: metrics({}, { measures: [] }) });
    expect(panel(i, "pr-throughput")).toMatchObject({ state: "empty", value: "—" });
    expect(panel(i, "bugs")).toMatchObject({ state: "empty" });
    expect(panel(i, "bugs").why).toMatch(/No issue data/);
  });

  it("shows AI usage as not ingested rather than a zero", () => {
    const p = panel(inputs(), "ai-usage");
    expect(p.state).toBe("empty");
    expect(p.value).toBe("—");
    expect(p.why).toBe("No data yet: Insight's AI connectors have not been ingested.");
  });

  it("keeps the Studio panels when Insight is unconfigured", () => {
    const i = inputs({ metrics: metrics({}, { state: "unconfigured", measures: [], reviews: [], ai_rows: null }) });
    expect(insightWhy(i)?.why).toMatch(/not configured/);
    expect(panel(i, "pr-throughput").state).toBe("unavailable");
    expect(panel(i, "contributors").state).toBe("unavailable");
    expect(panel(i, "spend").state).toBe("ok");
    expect(panel(i, "spend-by-workspace").state).toBe("ok");
    expect(panel(i, "cost-per-pr").state).toBe("unavailable");
  });

  it("says a missing endpoint is an older server, and falls back to the overview's 30 days", () => {
    const overview = {
      costs: "shown",
      spend: { currency: "USD", current: 50, previous: 25, unpriced: [] },
      workspaces: [{ name: "Alpha", spend: 50, previous: 25, specs_failing: 2 }],
      specs: { specs: 10, failing: 2, open_findings: 7 },
      waiting_on: [{ person_id: null, who: null, count: 3, oldest_days: 9 }],
      delivery: { merged: 4, window_days: 30, open: 6, median_wait_days: 2 },
      people: { active: 5, with_spend: 2, per_person: 10, idle: [{ person_id: "x", name: "X" }] },
      stuck_days: 7,
    } as unknown as OrgOverview;
    const i = inputs({ metrics: null, metricsError: { status: 404, text: "Not Found" }, overview });
    expect(insightWhy(i)?.why).toMatch(/build does not have/);
    expect(boardStatus(i)).toMatch(/build does not have/);
    expect(panel(i, "pr-throughput").state).toBe("unavailable");
    expect(panel(i, "spend")).toMatchObject({ state: "ok", value: "$50.00", trend: { text: "+100%" } });
    expect(panel(i, "waiting-on-nobody")).toMatchObject({ state: "ok", value: "3" });
    expect(panel(i, "spec-health")).toMatchObject({ value: "2", sub: "7 open findings · 10 specs" });
    expect(panel(i, "idle")).toMatchObject({ value: "1", sub: "of 5 active members" });
    // Studio's deploys still count, over windows worked out here.
    const d = { state: "succeeded", requested_at: "2026-10-20T10:00:00Z", decided_at: null } as unknown as Deployment;
    const dep = panel({ ...i, deployments: [d], now: new Date("2026-11-04T15:00:00Z") }, "deployments");
    expect(dep).toMatchObject({ state: "ok", source: "Studio", trend: { text: "new" } });
    // Another range has no stand-in.
    expect(panel({ ...i, range: "7d" }, "spend").state).toBe("unavailable");
  });

  it("hides money from someone who may not see costs", () => {
    const i = inputs({ metrics: metrics({ costs: "hidden", spend: null }) });
    expect(panel(i, "spend")).toMatchObject({ state: "hidden" });
    expect(panel(i, "cost-per-pr")).toMatchObject({ state: "hidden" });
  });

  it("is loading while nothing is read, and says so once", () => {
    const i = inputs({ metrics: null, loading: true, deployments: null });
    expect(panel(i, "pr-throughput").state).toBe("loading");
    expect(boardStatus(i)).toBe("Reading the metrics…");
  });

  it("names the window and the scope in the status line", () => {
    expect(boardStatus(inputs())).toBe("Oct 6 – Nov 4 · 2 projects · 2 repositories");
  });
});
