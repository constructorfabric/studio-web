// The reports a Studio draws, as `studio-reports` serves them
// (`studio-backend/src/reports`), and the little logic the Reports screen
// needs that is worth testing without a screen: what a save sends, whether a
// refresh can work, and how a source's state reads.

export interface PlanSnapshot {
  /** `owner/repo:path@ref`, or `upload`. */
  from: string;
  sha: string | null;
  read_at: string;
  size: number;
}

/** What a read plan holds: what People, the Gantt's lanes and the project
 *  columns are drawn from. */
export interface PlanSummary {
  board: string | null;
  people: number;
  teams: number;
  projects: number;
}

/** The schedule that refreshes a report on its own. */
export interface ReportSchedule {
  enabled: boolean;
  cron: string | null;
  next_run_at: string | null;
  last_run: string | null;
}

export interface ReportRefresh {
  at: string;
  sync_run: string | null;
  error: string | null;
}

export interface ReportSource {
  report: string;
  connection_id: string | null;
  plan_file: string | null;
  plan_uploaded: boolean;
  board: string | null;
  roots: string[];
  consumers: Record<string, string>;
  snapshot: PlanSnapshot | null;
  plan: PlanSummary | null;
  last_refresh: ReportRefresh | null;
  /** Why the board the last refresh synced was not read, once that sync finished. */
  board_error?: string | null;
}

export interface Report {
  id: string;
  title: string;
  description: string;
  definition: string;
  sheets: string[];
  definition_error: string | null;
  source: ReportSource;
}

/** What `PUT …/reports/{id}/source` takes: a field left out keeps its value. */
export interface ReportSourceInput {
  connection_id?: string | null;
  plan_file?: string;
  plan_yaml?: string;
  board?: string;
  roots?: string[];
  consumers?: Record<string, string>;
}

/** What the Source form edits. */
export interface SourceDraft {
  connectionId: string;
  planFile: string;
  /** Text of a file the person picked, not yet saved; `""` clears an upload. */
  planYaml: string | null;
  board: string;
  roots: string;
  consumers: string;
}

export function draftOf(s: ReportSource): SourceDraft {
  return {
    connectionId: s.connection_id ?? "",
    planFile: s.plan_file ?? "",
    planYaml: null,
    board: s.board ?? "",
    roots: s.roots.join(" "),
    consumers: Object.entries(s.consumers)
      .map(([k, v]) => `${k}=${v}`)
      .join(", "),
  };
}

/** `A=Acronis, C=Constructor` → `{ A: "Acronis", C: "Constructor" }`. */
export function parseConsumers(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/[,;\n]/)) {
    const [k, ...v] = part.split("=");
    const key = k?.trim();
    const value = v.join("=").trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/** The body a save sends: everything the form shows, the upload only when
 *  the person picked or cleared one. */
export function inputOf(d: SourceDraft): ReportSourceInput {
  const input: ReportSourceInput = {
    connection_id: d.connectionId || null,
    plan_file: d.planFile.trim(),
    board: d.board.trim(),
    roots: d.roots.split(/[\s,;]+/).filter(Boolean),
    consumers: parseConsumers(d.consumers),
  };
  if (d.planYaml !== null) input.plan_yaml = d.planYaml;
  return input;
}

/** Whether a refresh can find a board: one in the form, a plan file that may
 *  name one, a plan being uploaded that may, or the plan read last naming one. */
export function canRefresh(d: SourceDraft, s: ReportSource): boolean {
  return !!(d.board.trim() || d.planFile.trim() || (d.planYaml && d.planYaml.trim()) || s.plan?.board);
}

export type SourceState =
  | { kind: "empty" }
  | { kind: "unread"; what: string }
  | { kind: "failed"; error: string }
  /** The refresh went through, but the board sync it queued could not read the board. */
  | { kind: "board-unread"; error: string }
  /** The board is known, but there is no plan to draw people and teams from. */
  | { kind: "no-plan" }
  /** A plan was read, but it names nobody. */
  | { kind: "no-people"; from: string }
  | { kind: "ready"; from: string; at: string; plan: PlanSummary | null };

/** Where a source stands, in one line's worth. */
export function stateOf(s: ReportSource): SourceState {
  if (s.last_refresh?.error) return { kind: "failed", error: s.last_refresh.error };
  if (s.board_error) return { kind: "board-unread", error: s.board_error };
  if (s.snapshot) {
    if (s.plan && s.plan.people === 0) return { kind: "no-people", from: s.snapshot.from };
    return { kind: "ready", from: s.snapshot.from, at: s.snapshot.read_at, plan: s.plan };
  }
  if (s.plan_file) return { kind: "unread", what: s.plan_file };
  if (s.board) return { kind: "no-plan" };
  return { kind: "empty" };
}

/** Whether the state is one a person has to act on. */
export function needsAttention(st: SourceState): boolean {
  return st.kind === "failed" || st.kind === "board-unread" || st.kind === "no-plan" || st.kind === "no-people";
}

const EMPTY_WITHOUT_PLAN = "People, the Gantt's team lanes and the project columns stay empty without one";

export function stateText(st: SourceState): string {
  const from = (f: string) => (f === "upload" ? "an uploaded file" : f === "studio" ? "Studio (edited here)" : f);
  switch (st.kind) {
    case "empty":
      return "Not configured: name the plan file (it can name the board itself), or upload it.";
    case "unread":
      return `${st.what} has not been read yet — refresh to read it and sync the board.`;
    case "failed":
      return `The last refresh failed: ${st.error}`;
    case "board-unread":
      return `The board was not read, so the report has no gears: ${st.error}`;
    case "no-plan":
      return `No plan: load gears.yaml or name the plan file. ${EMPTY_WITHOUT_PLAN}.`;
    case "no-people":
      return `The plan from ${from(st.from)} names no people. ${EMPTY_WITHOUT_PLAN} of them.`;
    case "ready": {
      const what = st.plan
        ? ` — ${st.plan.people} people, ${st.plan.teams} teams, ${st.plan.projects} projects`
        : "";
      return `Plan from ${from(st.from)}, read ${st.at.slice(0, 16).replace("T", " ")}${what}.`;
    }
  }
}
