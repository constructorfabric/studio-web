/** A report's plan, as the Reports screen edits it: the planning team's
 *  `gears.yaml`, in the sections `GET /studio-reports/v1/reports/{id}/plan`
 *  answers and `PUT …/plan/{section}` saves one at a time. */

export interface LaneLabel {
  group: string;
  label: string;
}

export interface Lanes {
  order: string[];
  labels: LaneLabel[];
}

export interface PlanTeam {
  tag: string;
  name: string;
  color: string | null;
  people: number | null;
  power: number | null;
}

export interface PlanUnit {
  name: string;
  color: string | null;
  teams: PlanTeam[];
}

export interface PlanPerson {
  login: string;
  alias: string | null;
  team: string | null;
  unit: string | null;
  power: number | null;
  email: string | null;
}

export interface PlanProject {
  key: string;
  name: string;
  source_header: string | null;
}

export interface NeedCell {
  project: string;
  when: string;
}

export interface PlanNeed {
  number: string;
  title: string | null;
  gear: string | null;
  group: string | null;
  needs: NeedCell[];
}

export interface Plan {
  revision: number;
  from: string | null;
  changed_at: string | null;
  changed_by: string | null;
  /** The file the plan is read from, while it is. */
  file: string | null;
  lanes: Lanes;
  units: PlanUnit[];
  no_unit_color: string | null;
  people: PlanPerson[];
  projects: PlanProject[];
  needs: PlanNeed[];
}

export type PlanSection = "lanes" | "units" | "people" | "projects" | "needs";

/** The body `PUT …/plan/{section}` takes. */
export function sectionBody(section: PlanSection, plan: Plan): Record<string, unknown> {
  const revision = plan.revision;
  switch (section) {
    case "lanes":
      return { revision, lanes: plan.lanes };
    case "units":
      return { revision, units: plan.units, no_unit_color: plan.no_unit_color };
    case "people":
      return { revision, people: plan.people };
    case "projects":
      return { revision, projects: plan.projects };
    case "needs":
      return { revision, needs: plan.needs };
  }
}

/** A number field: empty is "not set", anything else must read as a number. */
export function parseNumber(text: string): number | null | undefined {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** An optional text field: blank is "not set". */
export function optional(text: string): string | null {
  const t = text.trim();
  return t ? t : null;
}

/** Every team tag, for a person's team picker: `tag — name (unit)`. */
export function teamChoices(units: PlanUnit[]): { tag: string; label: string }[] {
  return units.flatMap((u) => u.teams.map((t) => ({ tag: t.tag, label: `${t.tag} — ${t.name} (${u.name})` })));
}

/** One cell of the needs grid. */
export function needOf(need: PlanNeed, project: string): string {
  return need.needs.find((c) => c.project === project)?.when ?? "";
}

/** The need with one cell set; an emptied cell is dropped. Cells follow the
 *  projects' order, so the saved plan reads in the columns' order. */
export function withNeed(need: PlanNeed, project: string, when: string, projects: PlanProject[]): PlanNeed {
  const cells = new Map(need.needs.map((c) => [c.project, c.when]));
  if (when.trim()) cells.set(project, when.trim());
  else cells.delete(project);
  const order = projects.map((p) => p.key);
  const ordered = [...cells.entries()].sort(([a], [b]) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
  return { ...need, needs: ordered.map(([p, w]) => ({ project: p, when: w })) };
}

/** What a need's cell usually says, offered as suggestions. */
export const NEED_SUGGESTIONS = ["YES", "no", "?"];

/** The next quarters, `Q4'26` style, from `today`, for the suggestions. */
export function quarters(today: Date, count = 6): string[] {
  let q = Math.floor(today.getUTCMonth() / 3) + 1;
  let y = today.getUTCFullYear() % 100;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`Q${q}'${String(y).padStart(2, "0")}`);
    q += 1;
    if (q > 4) {
      q = 1;
      y += 1;
    }
  }
  return out;
}

/** Swap two rows of a list: what the up/down buttons do. */
export function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

/** One person in the plan, and who they are in Studio. */
export interface PlanPersonLink {
  login: string;
  alias: string | null;
  team: string | null;
  /** The Studio person whose confirmed GitHub account this login is. */
  person_id: string | null;
  /** Whether that person is an active member of the organization. */
  member: boolean;
}

/** `GET …/plan/people`: the plan's people against the organization's. */
export interface PlanPeople {
  /** Every person in the plan, in its order. */
  people: PlanPersonLink[];
  /** Members with a confirmed GitHub account the plan does not list. */
  unplanned: { person_id: string; github: string[] }[];
  members_without_github: number;
  /** False when the deployment cannot match anybody. */
  identities_available: boolean;
}

/** How a person in the plan stands in Studio, in a few words. */
export type LinkState =
  | { kind: "member"; personId: string }
  | { kind: "outsider"; personId: string }
  | { kind: "unknown" }
  | { kind: "unsaved" };

/** A login's link, read from the last saved plan's matches. A row typed since
 *  the last save has not been matched yet. */
export function linkOf(people: PlanPeople | null, login: string): LinkState {
  const l = people?.people.find((i) => i.login.trim().toLowerCase() === login.trim().toLowerCase());
  if (!l) return { kind: "unsaved" };
  if (!l.person_id) return { kind: "unknown" };
  return l.member ? { kind: "member", personId: l.person_id } : { kind: "outsider", personId: l.person_id };
}
