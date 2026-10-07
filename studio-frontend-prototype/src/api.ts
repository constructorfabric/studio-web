import { parseProblem, type Problem } from "./problem";
import type { ComponentSnapshot } from "./field-trend";
import type { RoadmapReport } from "./roadmap-report";
import type { Report, ReportSchedule, ReportSource, ReportSourceInput } from "./reports-model";
import type { DomainEntity } from "./domain-model.gen";
import type { DomainQuery, DomainQueryResult } from "./domain-query";

// Minimal typed client for the studio-backend REST API (/cf prefix).
// The live OpenAPI contract is /cf/openapi.json, shown grouped by component
// at /api-docs/ (src/api-docs.ts).

export interface Me {
  subject_id: string;
  subject_type?: string;
  subject_tenant_id: string;
}

export interface Tenant {
  id: string;
  name: string;
  tenant_type: string;
  self_managed: boolean;
}

export interface User {
  id: string;
  username: string;
  email?: string;
  display_name?: string;
}

/** Keycloak-backed identity visible only in the platform administration area. */
export interface PlatformIdentity {
  id: string;
  username: string;
  email?: string;
  display_name?: string;
  identity_provider?: string;
  first_seen_at_epoch_ms?: number;
  status: "platform_admin" | "assigned" | "unassigned";
  /** The IdP's attributes — not rewritten when a membership changes. */
  home_tenant_id?: string;
  home_tenant_name?: string;
  organization_role?: string;
  /** Where Studio records them as belonging — the authority (ADR-0011 §2).
   *  Absent when studio-user could not be asked; `status` then follows the
   *  attributes. Includes the platform root for a platform admin. */
  memberships?: DirectoryMembership[] | null;
}

export interface DirectoryMembership {
  org_id: string;
  org_name?: string | null;
  role: string;
  status: "active" | "suspended" | string;
}

/** The roles a membership may carry (studio-user `MEMBERSHIP_ROLES`). Only an
 *  active `owner` administers: the backend keeps its access-config grant in
 *  step with the membership. */
export type MembershipRole = "owner" | "admin" | "member";

/** One member of an organization, from `GET /studio-user/v1/organizations/{id}/members`. */
export interface OrgMember {
  user_id: string;
  display_name?: string | null;
  email?: string | null;
  role: MembershipRole | string;
  status: "active" | "suspended";
  /** creation | assignment | invitation | bootstrap | first_login | manual */
  source: string;
  created_at_epoch_ms: number;
  updated_at_epoch_ms: number;
}

/** One way a person signs in. For `provider: "keycloak"` the subject is the
 *  realm user id — the `id` of a `PlatformIdentity`. */
export interface PersonLogin {
  provider: string;
  subject: string;
  verified: boolean;
  linked_at_epoch_ms: number;
}

/** An external account attributed to a person (`github`, `email`, …). */
export interface PersonAlias {
  kind: string;
  external_id: string;
  /** suggested | claimed | confirmed */
  confidence: string;
  /** Activity on it counts as theirs — only when confirmed. */
  attributes: boolean;
  added_at_epoch_ms: number;
}

/** A member's identities, from
 *  `GET /studio-user/v1/organizations/{org}/members/{user}/identities`. */
export interface MemberIdentities {
  user_id: string;
  logins: PersonLogin[];
  aliases: PersonAlias[];
}

export interface OrgInvitation {
  id: string;
  org_id: string;
  email: string;
  role: string;
  expires_at_epoch_ms: number;
  accepted_at_epoch_ms?: number | null;
}

/* ── studio-tasks / studio-scheduler ── */

export type RunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** One count from a run's `result`, 0 when the run has not reported it. */
export function runCount(run: Pick<TaskRun, "result">): (key: string) => number {
  return (key) => {
    const v = run.result?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
}

/** What a poller shows for a run: what it did if it finished, why it stopped
 *  if it failed, where it is if it is still going. */
export function runMessage(run: Pick<TaskRun, "summary" | "last_error" | "progress">): string | null {
  return run.summary ?? run.last_error ?? run.progress ?? null;
}

/** One unit of background work. `GET /studio-tasks/v1/runs`. */
export interface TaskRun {
  id: string;
  tenant_id: string;
  /** `<gear>.<verb>` — `connector.graph_sync`, `notify.deliver`. */
  task_type: string;
  /** `queued` | `running` | `succeeded` | `failed` | `cancelled`. */
  state: string;
  /** What the handler was given. Shape belongs to the task type. */
  payload: Record<string, unknown>;
  /** What the run was told not to overtake, when ordering was asked for. */
  partition_key?: string | null;
  attempts: number;
  /** The phase the handler last reported; kept after it ends. */
  progress?: string | null;
  /** One line about what it did, once it succeeded. */
  summary?: string | null;
  /** The handler's structured result, where it has one. */
  result?: Record<string, unknown> | null;
  last_error?: string | null;
  cancel_requested: boolean;
  requested_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

/** A recurring trigger. `GET /studio-scheduler/v1/schedules`. */
export interface TaskSchedule {
  id: string;
  name: string;
  task_type: string;
  payload: Record<string, unknown>;
  /** `cron` | `interval`. */
  expression_kind: string;
  /** A 5-field cron expression, or an ISO-8601 duration. */
  expression: string;
  timezone: string;
  /** `allow` | `forbid` | `replace`. */
  concurrency: string;
  /** `skip` | `catch_up` | `backfill`. */
  missed_policy: string;
  max_catch_up_runs: number;
  enabled: boolean;
  next_run_at: string;
  last_fired_at?: string | null;
  /** The run the last firing produced. */
  last_run_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Page<T> {
  items: T[];
  page_info?: { next_cursor: string | null; prev_cursor: string | null; limit: number };
}

/** A platform listing read to its end: account-management pages by cursor
 *  (`?cursor=` / `?limit=`, next page in `page_info.next_cursor`). Returned as
 *  one `Page` so callers written against the first page keep working. Bounded,
 *  so a cursor that never ends cannot hang a screen. */
async function allCursorPages<T>(path: string, token: string, limit = 200, maxPages = 50): Promise<Page<T>> {
  const items: T[] = [];
  let cursor: string | null | undefined;
  for (let n = 0; n < maxPages; n++) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const page = await request<Page<T>>(`${path}?${query}`, token);
    items.push(...(page.items ?? []));
    cursor = page.page_info?.next_cursor;
    if (!cursor) break;
  }
  return { items };
}

export const PLATFORM_ROOT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

// Studio tenant types seeded by studio-backend config (types-registry.config.entities).
export const TENANT_TYPES = {
  organization: "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~",
  workspace: "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~",
  /** A project is now its own AM tenant, child of a workspace — its codebase
   *  context (sources, IDE, artifacts, spec-quality) is tenant-scoped on it. */
  project: "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~",
} as const;

/** Project attributes stored as tenant metadata on the project tenant. */
export const PROJECT_CONFIG_TYPE =
  "gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~";

/** The three shapes the Gearbox engine scaffolds a gear in. */
export type GearKind = "service" | "minimal" | "plugin";

/** A host a new plugin gear can fill: `GET /gearbox/extension-points`. */
export interface GearboxExtensionPoint {
  host: string;
  host_id: string;
  /** The SDK crate the extension point is declared in. */
  sdk: string;
  /** The point's GTS spec id; a host may declare several. */
  spec: string;
  /** The interface a plugin of this point implements. */
  trait_ident: string;
  runs: boolean;
}

/** Spec against code for one project (`POST /conformance`). */
export interface Conformance {
  repo: string;
  components_in_code: string[];
  items: {
    capability: string;
    status: "implemented" | "missing";
    implemented_by: { name: string; declared: boolean }[];
    candidates: string[];
  }[];
  total: number;
  unexplained: { name: string; declares: string[] }[];
  gearbox: ProductChange[];
}

/** A capability a project's documents declare, and the documents that do. */
export interface DeclaredCapability {
  key: string;
  sources: { kind: "document" | "file"; id: string; label: string }[];
}

/** What the project is for, chosen at creation:
 *  - `new_gears`  — build new gears (repo: create new, or an existing gear store);
 *  - `product`    — assemble a product from gears (repo: always a new one);
 *  - `existing`   — import a gears-based app already built (repo: its existing one). */
export type ProjectKind = "new_gears" | "product" | "existing";

/** The project attributes carried in PROJECT_CONFIG_TYPE metadata. */
export interface ProjectConfig {
  mode?: ProjectMode;
  kind?: ProjectKind;
  stages?: string[];
  status?: ProjectStatus;
  /** Seed source: a git url, a brief, or an uploaded file id. */
  source_git_url?: string;
  brief?: string;
  /** The project's repositories: the one record of them (`project-sources.ts`). */
  sources?: import("./project-sources").ProjectSource[];
}

// Workspace settings live as AM tenant metadata (schema seeded by the backend config).
export const WS_SETTINGS_TYPE = "gts.cf.core.am.tenant_metadata.v1~cf.studio.workspace.settings.v1~";
// Organization access config (model + roles) — AM tenant metadata, same
// mechanism as workspace settings (schema seeded by the backend config).
export const ACCESS_TYPE = "gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~";

/** The two creation shapes. A greenfield project has no source to import; a
 *  modernization has exactly one. Carried in a project's config metadata. */
export type ProjectMode = "greenfield" | "modernize";

/** Forward-only: draft -> active -> archived, and archived is terminal. */
export type ProjectStatus = "draft" | "active" | "archived";

/** The status ladder in order — used to enforce forward-only transitions in
 *  the UI now that the studio-project gear no longer guards them server-side. */
export const STATUS_LADDER: ProjectStatus[] = ["draft", "active", "archived"];

/** One journey stage, as the catalogue serves it.
 *
 *  This used to be a hardcoded array here, left behind when the studio-project
 *  gear was retired and `GET /studio-project/v1/stages` went with it. It is the
 *  path a product takes through the studio, so an organization has to be able
 *  to change it — which a constant in a client cannot express. ADR-0014
 *  section 7 moved the catalogue back to the server; `api.stages()` reads it.
 *
 *  What comes back is already the EFFECTIVE list for that workspace: the
 *  platform catalogue, overlaid by the organization, overlaid by the workspace,
 *  with hidden entries removed and the whole thing in catalogue order. A client
 *  must not re-sort it or assume `intent` is present — a workspace may have
 *  replaced it. */
/** One capability a product may need, and the words that find components
 *  providing it.
 *
 *  Was `CAP_KEYWORDS` in documents.tsx — a table in a UI file that decided
 *  which components a workspace could be offered. It is catalogue data now,
 *  overlaid the same three ways as everything else. */
/** What the catalogue can say about whether a component was ever built.
 *
 *  `"unknown"` is not a maybe — it means the question does not apply or was
 *  never asked. A FrontX package carries no crate count at all, and a component
 *  with no profile has not been scanned. Neither is evidence of absence. */
export type BuildState = "built" | "docs-only" | "unknown";

/** What the Gearbox engine said about a component, as the catalogue sync
 *  recorded it: it can go into a product (`runs`), it is described but cannot
 *  run from this corpus (`blocked`), or nothing describes it for composition
 *  (`undescribed`). A different question from `built`. */
export type Composability = "runs" | "blocked" | "undescribed";

/** One component offered for one capability. */
export interface Candidate {
  name: string;
  kind: string;
  /** Which step proposed it: `contract` (the engine reports the gear provides
   *  one of the capability's contracts) or `evidence` (its words were found in
   *  what the gear says about itself). Every `contract` comes first. */
  step?: "contract" | "evidence";
  /** The provided contracts that satisfy the capability (`contract` only). */
  contracts?: string[];
  /** The text around the first term found (`evidence` only). */
  passage?: string | null;
  /** The document the passage is quoted from, when it came from the gear's
   *  own documentation rather than the catalogue's text. */
  cites?: string | null;
  /** The gear declares this capability itself (gear.toml, or its catalogue
   *  page) -- a statement, not a match on the words it uses. */
  declared?: boolean;
  /** How many of the capability's terms this component mentions. */
  score: number;
  /** Which terms they were, so a suggestion can be argued with. */
  why: string[];
  built: BuildState;
  composable: Composability;
  /** The engine's reason, when `blocked`. */
  composable_why?: string | null;
}

/** Why a candidate was offered, in the words of the step that offered it. */
export function matchReason(c: Candidate): string {
  if (c.step === "contract") return `provides ${(c.contracts ?? []).join(", ")}`;
  const how = c.declared ? "the gear declares this capability" : `matched by words: ${c.why.join(", ")}`;
  const quoted = c.passage ? `${how} — “${c.passage}”` : how;
  return c.cites ? `${quoted} (${c.cites})` : quoted;
}

/** One capability, and what could fill it. */
export interface PlanRow {
  capability: string;
  candidates: Candidate[];
  /** No candidate at all — the capability has nothing to build from. */
  gap: boolean;
  /** Candidates exist, but none of them has been built. */
  unbuilt: boolean;
}

/** One weekly bar of a gear's churn. */
export interface ActivityPoint {
  /** The bucket's first day (a Monday), `YYYY-MM-DD`. */
  date: string;
  commits: number;
  lines_added: number;
  lines_removed: number;
}

/** Pull requests touching one gear, by the state they are in now.
 *
 *  Attributed through the files their commits changed, so one touching three
 *  gears counts in all three: these rows do NOT partition the repository, and
 *  a screen showing them has to say so. */
export interface GearPullRequests {
  open: number;
  merged: number;
  closed: number;
  total: number;
  /** Null when nothing merged in the window — not the same as zero hours. */
  merged_cycle_hours: number | null;
  authors: number;
}

/** What one gear did over the window. */
export interface GearActivity {
  gear: string;
  commits: number;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  authors: number;
  /** Null when no pull request in the window touched this gear — not zeros. */
  pull_requests?: GearPullRequests | null;
  /** The same totals over the window of the same length just before, when
   *  asked with `compare`; what the tiles' "vs previous" is measured against. */
  pull_requests_previous?: GearPullRequests | null;
  /** Ascending by date, gaps filled with zeros. */
  points: ActivityPoint[];
}

/** One document under a type in the Spec pipeline.
 *
 *  `conforms` travels with it so a screen holding a fresher verdict — a
 *  "Validate all" run that supersedes what the record was saved with — can
 *  apply its own without asking again. */
export interface PipelineEntry {
  id: string;
  /** An authored document's title, or a bound file's last path segment. */
  name: string;
  conforms?: boolean | null;
  /** `draft` | `review` | `approved` for an authored document; null for a
   *  repository file, which has no editorial status. */
  status?: string | null;
}

/** One document type, and what the project has of it. */
export interface PipelineRow {
  type_key: string;
  type_name: string;
  type_description: string;
  authored: PipelineEntry[];
  bound: PipelineEntry[];
  /** Shown, and deliberately NOT in `total`: a guess is not coverage. */
  proposed: PipelineEntry[];
  untouched: boolean;
  valid: number;
  total: number;
}

/** One spec a project has, whichever way it got there. */
export interface SpecRow {
  id: string;
  /** `repository` or `authored` — where the bytes live. */
  origin: "repository" | "authored";
  name: string;
  /** Empty for an authored document: no path until somebody commits it. */
  path: string;
  type_key?: string | null;
  /** Graph node id for a repository row — what findings are keyed on. */
  node_id?: string | null;
  state?: DocBindingState | null;
  /** `draft` | `review` | `approved` for an authored row; null otherwise. */
  status?: Doc["status"] | null;
  conforms?: boolean | null;
  updated_at: string;
  /** Instance id of the repo node this file came from. Empty for an authored row. */
  repo: string;
  /** Which queues this row is in. Decided by the server, because a second
   *  portal deciding it again is how two screens start disagreeing about what
   *  needs review. */
  queues: SpecFilter[];
}

export type SpecFilter = "not-scanned" | "needs-review" | "bound" | "not-documents" | "all";
/** One repository's movement over a window, from the graph a sync filled. */
export interface RepoActivity {
  /** Instance id of the repo node these numbers are about. */
  repo: string;
  /** Open right now, however old — deliberately not windowed. */
  open: number;
  /** Merged inside the window; a rate, so it is. */
  merged: number;
  commits: number;
  /** One bucket per day, oldest first, always the window's length. */
  days: number[];
}

export type ActivityEventKind = "check" | "comment";

/** One thing that happened to a project. */
export interface ActivityEvent {
  id: string;
  kind: ActivityEventKind;
  event: string;
  subject: string;
  by: string;
  /** RFC 3339, or null. An undated row sorts last, not first. */
  recorded?: string | null;
  severity?: string | null;
}

/** One document's share of the duplication a `bloat` run found.
 *
 *  Folded by `spec_quality/analysis.rs` when the analysis runs, and stored in
 *  the result as `by_document`. A run made before that existed does not carry
 *  it, and a reader is told so rather than shown an empty table. */
export interface DocDuplication {
  path: string;
  /** Clusters this document takes part in — a per-cluster fact, so a file
   *  appearing three times in one cluster still takes part in one. */
  clusters: number;
  /** Times its text turns up in one, which is the count that can exceed
   *  `clusters`. */
  occurrences: number;
  /** Words in those occurrences, in the detector's own unit. */
  words: number;
  /** The other documents it shares text with. Empty means it only repeats
   *  itself — a different and lesser complaint. */
  partners: string[];
}

/** One field's answer, as the catalogue stores it.
 *
 *  Every part optional: a source that knows the value but not its grade says
 *  so rather than inventing one. `n` is the number itself — thousands
 *  separators are a locale decision the server does not hold, so a portal
 *  formats `n` when it is there. */
export interface FieldVal {
  v?: string;
  b?: string;
  n?: number;
  s?: "good" | "watch" | "bad" | "none";
  l?: string;
  u?: string;
}

/** One component with its three sources reconciled: crates.io < scan < profile.
 *
 *  A field a person CLEARED is present and null; absent means nothing
 *  answered. The precedence lives in `components_catalog/values.rs`. */
export interface ComponentValues {
  name: string;
  values: Record<string, FieldVal | null>;
  /** Empty when nothing files it anywhere — a fact, not a missing label. */
  category: string;
  /** Every source that answered something about it, layered in order. */
  sources?: ComponentSource[];
  /** Known from a roadmap board alone: planned, no code catalogued yet. */
  planned?: boolean;
}

/** One place a component's facts came from. */
export interface ComponentSource {
  kind: "crates_io" | "repository" | "roadmap" | "gearbox" | "person" | string;
  label: string;
}

export interface Capability {
  key: string;
  label: string;
  /** Empty means "match the key itself". */
  terms: string[];
  /** What the Gearbox engine can report a gear as providing, any of which
   *  satisfies the capability. Matched before `terms`. */
  contracts?: string[];
  owner: string;
  owner_tenant_id?: string | null;
}

export interface JourneyStage {
  key: string;
  label: string;
  required: boolean;
  position: number;
  /** Document-type keys this stage is not complete without. */
  requires: string[];
  /** Detectors every required document must pass before the stage completes. */
  gates: string[];
  /** "builtin" | "organization" | "workspace" — which level defined it. */
  owner: string;
  owner_tenant_id?: string | null;
}

/** Normalise a stage selection against a catalogue: the required entries plus
 *  what was chosen, in catalogue order.
 *
 *  Takes the catalogue rather than closing over one, because there is no longer
 *  a single right answer — it depends on the workspace. */
export function normalizeStages(
  selected: readonly string[],
  catalogue: readonly JourneyStage[],
): string[] {
  const chosen = new Set(selected);
  return catalogue.filter((s) => s.required || chosen.has(s.key)).map((s) => s.key);
}

export type RepoSource = "local" | "git" | "github" | "gitlab";

/** One workspace source — mirrored into .cf-workspace.toml by the backend. */
export interface RepoEntry {
  /** Directory name under the workspace root: [a-z0-9_-]+ */
  name: string;
  /** UI-level source flavor; github/gitlab are git with a composed URL. */
  source: RepoSource;
  url?: string;
  path?: string;
  /** Mount/clone target relative to the workspace root (defaults to name). */
  target?: string;
  branch?: string;
  /** credstore secret reference holding the repo PAT (private repos). */
  token_ref?: string;
  /** A project source's `share_mode` (`project-sources.ts`), shown on its
   *  row; never sent with a session — the IDE reads it from the config. */
  share_mode?: "branch" | "pull_request";
}

/* ── studio-connector: source connections ── */

/** A provider this deployment can serve, i.e. one whose driver plugin is linked. */
export interface ConnectorProvider {
  provider: string;
  display_name: string;
  default_base_url: string;
  /** GTS instance id of the driver plugin — shown so the UI can prove it is plugin-backed. */
  instance_id: string;
  /** "source_code" = repositories can be browsed; "ai" = credential only. */
  category: string;
  /** Label for the credential field, e.g. "API Key" vs "Personal Access Token (PAT)". */
  credential_label: string;
  /** Placeholder hinting at the credential shape, e.g. "sk-ant-…". */
  credential_hint: string;
  /** `notification` providers only: true when the credential itself fixes the
   *  channel — an incoming webhook — so there is no channel to pick and no
   *  `target` to send. */
  fixed_target?: boolean;
}

/** One channel a notification connection can post to.
 *  `GET /studio-connector/v1/connections/{id}/targets`. */
export interface NotifyTarget {
  /** Provider-native id — what `target` expects; its shape differs per platform. */
  id: string;
  name: string;
  /** The server or workspace the channel belongs to (a Discord guild). */
  container?: string | null;
  private: boolean;
  /** True for Zulip: a message to this channel must carry a `topic`. */
  topic_required: boolean;
}

/** Where a message landed, as the platform reported it. */
export interface SentMessage {
  connection_id: string;
  provider: string;
  /** Not necessarily what was asked for: a webhook resolves its own channel. */
  target: string;
  message_id?: string | null;
}

export interface Connection {
  id: string;
  /** Tenant holding this connection: the viewed one, or an ancestor when inherited. */
  owner_tenant_id: string;
  provider: string;
  label: string;
  /** Account the credential belongs to, captured when it was verified. */
  account: string;
  base_url: string;
  /** personal | workspace | organization */
  scope: string;
  /** credstore reference of the token — pass as token_ref when launching a session. */
  secret_ref: string;
  created_at_epoch_secs: number;
}

/** How a document binding's type was decided. */
export type DocDetectionSource = "front_matter" | "heuristic" | "spec_quality" | "manual";

/** Where a binding stands on "do we know what this file is?". */
export type DocBindingState = "detected" | "confirmed" | "manual" | "unknown" | "not_a_document";

export interface DocTypeCandidate {
  type_key: string;
  /** 0.0–1.0. */
  confidence: number;
  /** Why this type scored what it did, in words. */
  why: string;
}

/** An ingested repository file joined to a document type. The content is NOT
 *  here — it stays in the artifact graph, addressed by `node_id`. */
export interface DocBinding {
  id: string;
  tenant_id: string;
  project_id?: string | null;
  inherited: boolean;
  node_id: string;
  path: string;
  type_key?: string | null;
  state: DocBindingState;
  confidence?: number | null;
  source?: DocDetectionSource | null;
  candidates: DocTypeCandidate[];
  conforms?: boolean | null;
  /** The last validation in full — which sections are missing or thin. */
  validation?: DocValidation | null;
  content_sha: string;
  created_at: string;
  updated_at: string;
}

/** One detector's verdict on one document, as it is kept in the artifact graph.
 *
 *  A finding is a node of its own (`gts.cf.studio.artifact.spec_finding`) joined
 *  to the document by a `finding_on` edge, and it carries the subject's id in
 *  its own payload — so reading them back is one listing, not a graph walk. */
export interface SpecFinding {
  /** `bloat` | `purpose` | `leak` | `traceability`. */
  detector: string;
  /** Instance id of the document node this is about. */
  subject: string;
  path?: string | null;
  /** The detector's own word for how it went, e.g. `gate-passed`, `high`. */
  severity?: string | null;
  summary?: string | null;
  /** Whatever number the detector reports, when it reports one. */
  score?: number | null;
  /** The raw result, kept so a later reader is not limited to what this build
   *  thought worth summarising. A run recorded by the server carries
   *  `details.findings` — read them with {@link findingItems}. */
  details?: unknown;
}

/** Where in the analysed text a finding is. Lines, not characters: the
 *  service's character offsets do not match its text, its lines do. For a
 *  `purpose` or `leak` section `line_start` is the first line of its body. */
export interface SpecFindingAnchor {
  section?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  /** The passage (bloat), reflowed onto one line. */
  quote?: string | null;
}

/** One thing a detector found in one document — what
 *  `GET /studio-spec-quality/v1/verdicts` answers in `findings[]`, and what a
 *  recorded `spec_finding` keeps under `details.findings`. */
export interface SpecFindingItem {
  /** Stable across re-runs and edits elsewhere in the document. */
  id: string;
  rule: string;
  path?: string | null;
  severity: "high" | "medium" | "low";
  message: string;
  anchor?: SpecFindingAnchor | null;
  related: { path: string; anchor: SpecFindingAnchor }[];
  evidence: string[];
  confidence?: number | null;
}

/** The findings a recorded detector verdict carries. Empty for a verdict
 *  recorded before the server kept them, which still counts as one row. */
export function findingItems(f: SpecFinding): SpecFindingItem[] {
  const items = (f.details as { findings?: unknown } | null | undefined)?.findings;
  return Array.isArray(items) ? (items as SpecFindingItem[]) : [];
}

/** One document type a stage cannot do without, and how the project stands on it. */
export interface StageRequirement {
  type_key: string;
  /** A document of this type exists in the project — written here, or a
   *  repository file someone bound to the type. */
  present: boolean;
  /** It passes its type's structural check. */
  conforms: boolean;
  /** Detectors the stage gates on that have not passed: missing, pending or
   *  failed. Empty when the stage gates nothing, or everything passed. */
  analyses_outstanding: string[];
}

/** Where a project stands against one stage of its workspace's journey. */
export interface StageStatus {
  key: string;
  label: string;
  required: boolean;
  complete: boolean;
  requirements: StageRequirement[];
}

/** A pull request opened for a published change, or the one already open. */
export interface OpenedPullRequest {
  number: number;
  url?: string | null;
  /** False when a request for this branch and base was already open. */
  created: boolean;
}

/** One file written into a repository through a connection. */
export interface WrittenFile {
  path: string;
  branch?: string | null;
  /** Blob sha after the write. */
  sha: string;
  /** The commit the write produced, when the provider reports it. */
  commit?: string | null;
  /** Browser URL for the file, when the provider gives one. */
  url?: string | null;
  /** False when this call created the file. */
  updated: boolean;
  /** True when this call also created the branch it committed on. */
  branch_created: boolean;
  /** The pull request opened or reused, when one was asked for. */
  pull_request?: OpenedPullRequest | null;
}

export interface ConnectorIdentity {
  account: string;
  display_name?: string;
}

export interface ConnectionTest extends ConnectorIdentity {
  connection: Connection;
}

export interface RemoteRepo {
  id: string;
  name: string;
  full_path: string;
  clone_url: string;
  default_branch?: string;
  description?: string;
  visibility?: string;
}

/** One ingested artifact node from `GET /studio-artifact-ingest/v1/nodes`.
 * `value` is the free-form GTS payload (issue/PR/repo fields). */
export interface ArtifactNode {
  type_id: string;
  instance_id: string;
  value: {
    repo?: string;
    external_id?: string;
    number?: number;
    title?: string;
    state?: string;
    author?: string | null;
    body?: string | null;
    url?: string | null;
    labels?: string[];
    source_branch?: string | null;
    target_branch?: string | null;
    merged?: boolean;
    provider?: string;
    full_path?: string;
    // File nodes:
    path?: string;
    sha?: string;
    is_dir?: boolean;
    size?: number | null;
    created_at?: string | null;
    updated_at?: string | null;
    // User nodes:
    login?: string;
    [key: string]: unknown;
  };
}

export interface ArtifactNodePage {
  nodes: ArtifactNode[];
  /** Total artifacts matching the type/scope filter across every page. */
  total: number;
  /** Opaque cursor for the next page, omitted when this is the last page. */
  next_cursor?: string;
}

/** One node from the gears catalog — a `gear` crate or a `crate_version`. The
 *  payload shape differs by type; read it loosely. */
/** One registered type, as the registry returns it. Only the fields a screen
 *  needs; the registry carries the whole schema document too. */
/** How many nodes of one type the graph holds.
 *
 *  Counted rather than asked for: graph-storage's contract has no count, so
 *  the server pages a projection and stops at a cap. `capped` says the number
 *  is a floor — a page that shows one as a total lies about the graph. */
export interface TypeCount {
  leaf_id: string;
  count: number;
  capped: boolean;
}

/** One GTS type the graph holds, and what this organization says about it.
 *
 *  The graph stores far more types than a catalogue of building blocks should
 *  list — files, chunks, commits, domain entities. Which of them are
 *  components is a judgement about the organization's model, not a fact about
 *  storage, so it is a mark somebody sets rather than a constant in a gear. */
export interface CatalogType {
  /** The id graph-storage stores it under, ancestry and all. Empty when
   *  nothing has written a node of this type into this tenant's graph yet. */
  type_id: string;
  /** The leaf of that id: how the type is named everywhere else, and the key a
   *  mark and a field schema are written against. */
  leaf_id: string;
  /** A family or base — derived from, never instantiated, so never a
   *  component. Reported rather than hidden so the page can say why. */
  is_abstract: boolean;
  component: boolean;
  /** Who authored the field schema it renders against. */
  schema: "builtin" | "tenant" | "none";
}

/** The presentation of one component type: which fields a component page shows
 *  for it, grouped, and where each one is read from.
 *
 *  Served by studio-components-catalog and stored in graph-storage beside the
 *  type it describes, so a workspace can change a page without a release. This
 *  used to be a JSON file compiled into this bundle. */
export interface FieldSchemaSource {
  class: "repo" | "api" | "manual" | "none";
  ref: string;
}

export interface FieldSchemaField {
  key: string;
  label: string;
  kind: "text" | "label" | "docstate" | "bool" | "metric" | "status";
  lamp: boolean;
  source: FieldSchemaSource;
  example?: string;
  domain?: Record<string, unknown>;
}

export interface FieldSchemaGroup {
  id: string;
  title: string;
  icon: string;
  fields: FieldSchemaField[];
}

export interface FieldSchema {
  /** The GTS type this schema is the presentation of. */
  describes: string;
  groups: FieldSchemaGroup[];
  composition: { key: string; label: string; color: string }[];
  statusLegend: Record<string, string>;
  docStateLegend: Record<string, string>;
  sourceClasses: Record<string, { label: string; hint: string }>;
  /** `builtin` — what the deployment ships — or `tenant`, a stored override. */
  owner: "builtin" | "tenant";
  /** Whether this organization treats the type as a component, and therefore
   *  whether the Components page lists its nodes. Set on the Objects page. */
  component: boolean;
}

export interface GtsEntity {
  gts_id: string;
  content?: { title?: string; description?: string };
}

export interface GtsEntityPage {
  entities: GtsEntity[];
}

export interface CatalogNode {
  type_id: string;
  instance_id: string;
  value: {
    // Gear nodes:
    name?: string;
    kind?: string;
    /** `draft` (a directory of documents, no crate under it) or `published`.
     *  Absent means the scan did not assess this component — a FrontX package
     *  has no crate count, and neither has anything nobody walked. */
    status?: string | null;
    description?: string | null;
    max_version?: string | null;
    newest_version?: string | null;
    max_stable_version?: string | null;
    num_versions?: number | null;
    downloads?: number | null;
    recent_downloads?: number | null;
    repository?: string | null;
    documentation?: string | null;
    homepage?: string | null;
    keywords?: string[];
    categories?: string[];
    // Crate-version nodes:
    crate?: string;
    num?: string;
    yanked?: boolean | null;
    yank_message?: string | null;
    license?: string | null;
    rust_version?: string | null;
    edition?: string | null;
    crate_size?: number | null;
    has_lib?: boolean | null;
    published_by?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    title?: string;
    [key: string]: unknown;
  };
}

// ── Constructor Insight: delivery metrics per component ──────────────────────

/** One component to measure. Either a path prefix or a directory name; with
 *  neither, the `key` is used as the directory name — which is what a caller
 *  that knows component names but not their paths wants. */
export interface ComponentSpecInput {
  key: string;
  path_prefix?: string;
  path_segment?: string;
}

export interface ComponentMetricsQuery {
  /** `owner/name`, or a bare `name` to match in any org. */
  repository: string;
  /** Inclusive `YYYY-MM-DD`; both default to the last 30 days. */
  from?: string;
  to?: string;
  /** Group by the first N path segments when `components` is empty (1–6). */
  depth?: number;
  components?: ComponentSpecInput[];
  /** Return the `other` remainder row. Default true. */
  include_other?: boolean;
  /** Ask for `series` as well — one point per component per bucket. */
  bucket?: "day" | "week" | "month";
  limit?: number;
}

export interface ComponentMetricsRow {
  component: string;
  commits: number;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  authors: number;
}

export interface ComponentTrendPoint {
  component: string;
  /** The bucket's first day, `YYYY-MM-DD`. */
  date: string;
  commits: number;
  lines_added: number;
  lines_removed: number;
}

export interface ComponentMetrics {
  repository: string;
  /** The window actually used, resolved server-side when the request defaulted it. */
  from: string;
  to: string;
  components: ComponentMetricsRow[];
  bucket?: string | null;
  /** Sparse: a bucket with no commits has no point, rather than a zero. */
  series: ComponentTrendPoint[];
  truncated: boolean;
}

export interface ComponentPullRequestsQuery {
  repository: string;
  /** Inclusive `YYYY-MM-DD` on when a PR was **opened**; defaults to 30 days. */
  from?: string;
  to?: string;
  depth?: number;
  components?: ComponentSpecInput[];
  include_other?: boolean;
  limit?: number;
}

export interface ComponentPullRequestsRow {
  component: string;
  open: number;
  merged: number;
  closed: number;
  /** Not a share of the repository's PRs: one touching three gears is in all three. */
  total: number;
  /** Absent when nothing merged in the window — not the same as zero hours. */
  merged_cycle_hours?: number | null;
  authors: number;
}

export interface ComponentPullRequests {
  repository: string;
  from: string;
  to: string;
  components: ComponentPullRequestsRow[];
  truncated: boolean;
}

/** A relation between two artifact nodes (endpoints by instance id). Types:
 *  `…rel.authored_by…`, `…rel.modifies…`, `…rel.artifact_of…`, `…rel.contains…`. */
export interface ArtifactEdge {
  type_id: string;
  from: string;
  to: string;
}

export interface WorkspaceSettings {
  automation_level?: "manual" | "recommendations" | "autonomous";
  approved_worker_categories?: string[];
  /** Existing Studio workspace folder (CLI-created) used as the root. */
  root_path?: string;
  /** Clone URL of the workspace repository itself (alternative to root_path). */
  root_repo_url?: string;
  root_branch?: string;
  /** credstore secret reference with the PAT for the workspace repository. */
  root_token_ref?: string;
  /** Workspace sources: multiple repositories/folders per workspace. */
  repos?: RepoEntry[];
}

/** A versioned capability bundle published in the Studio kit registry. */
export interface StudioKit {
  slug: string;
  name: string;
  description: string;
  publisher: string;
  visibility: string;
  source: string;
  repository_url: string;
  default_version: string;
  manifest_path: string;
}

/** One repository this kit has been materialized into. A kit is installed into
 * a PROJECT and materialized per repository, so this is a list: a project can
 * gain a repository after the kit was requested, and each target carries its
 * own version and outcome. */
export interface KitMaterialization {
  repository_id: string;
  repository_label?: string;
  version: string;
  status: "installed" | "failed";
  materialized_at: string;
  failure_reason?: string;
}

/** Project-scoped desired state. The trusted IDE runner advances `pending` to
 * `installed`; the browser never executes kit scripts itself. */
export interface KitInstallation {
  kit_slug: string;
  version: string;
  source: string;
  repository_url: string;
  install_mode: "copy" | "register";
  status: "pending" | "installing" | "installed" | "failed";
  requested_by: string;
  requested_at: string;
  installed_at?: string;
  /** Where this kit BELONGS: `project` (the project repository alone) or
   *  `all-repositories`. Intent, as opposed to `materializations`, which is
   *  where it actually is — reconciling is the difference between the two.
   *  Optional for the same rolling-deploy reason as `materializations`. */
  scope?: "project" | "all-repositories";
  /** The most recently materialized target, derived by the backend from
   *  `materializations`. */
  repository_id?: string;
  /** Optional on purpose: during a rolling deploy the portal can be newer than
   *  the backend answering it, and a missing list must degrade to "no detail"
   *  rather than throw in the render. */
  materializations?: KitMaterialization[];
  failure_reason?: string;
}

/** One repository the project's running IDE has mounted. Live state, not
 * stored: it exists only while a session runs, and the backend answers 503
 * when there is none. `project` marks the project's own repository -- where
 * `.cf-studio-kit.toml` lives and where a materialize call with no
 * `repository_id` lands. The backend lists it first. */
export interface ProjectRepository {
  repository_id: string;
  label: string;
  kind: "project" | "source";
  git_mode?: string | null;
}

/* ── studio-presence: who is in Studio now ── */

/** One person, as the presence gear reports them. */
export interface PresenceEntry {
  user_id: string;
  display_name?: string | null;
  tenant_id: string;
  place: string;
  detail?: string | null;
  since_ms: number;
  last_seen_ms: number;
}

/** A note somebody left for the caller. Handed over once and not stored. */
export interface PresenceMessage {
  id: string;
  from_user_id: string;
  from_display_name?: string | null;
  text: string;
  sent_ms: number;
}

/* ── mini-chat / conversions / file-storage shapes ── */

export interface Chat {
  id: string;
  model: string;
  title?: string;
  message_count: number;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  model?: string;
  created_at: string;
}

export interface Model {
  model_id: string;
  display_name: string;
  tier: string;
  context_window: number;
  description?: string;
}

export interface Conversion {
  request_id?: string;
  id?: string;
  tenant_id: string;
  child_tenant_name?: string;
  target_mode: string;
  status: string;
  expires_at?: string;
}

/** A project open in somebody's desktop Studio: a lease the app renews. */
export interface DesktopSession {
  id: string;
  workspace_id: string;
  /** Token subject of whoever has it open. */
  member_id: string;
  device_id: string;
  device_name?: string | null;
  started_at_epoch_secs: number;
  last_seen_epoch_secs: number;
  expires_at_epoch_secs: number;
  heartbeat_secs: number;
}

export interface StudioSession {
  id: string;
  workspace_id: string;
  state: "starting" | "running" | "stopped";
  url: string;
  created_at_epoch_secs: number;
  sources: string[];
  /** The `session.await_ready` run probing this session, on a launch answer.
   *  Absent where studio-tasks has no database — then the wait falls back to
   *  polling. */
  ready_run_id?: string;
}

interface SessionWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * How to follow the readiness run to its end.
   *
   * Injected rather than imported: `studio-events.ts` imports from this module,
   * and calling back into it from here would close the cycle. The caller has
   * the token anyway, which this module's session helpers do not.
   *
   * `signal` fires as soon as the wait is over by any route, so a follower that
   * holds a subscription can drop it instead of running out its own timeout.
   */
  follow?: (
    runId: string,
    signal: AbortSignal,
  ) => Promise<{ state: string; error?: string | null }>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Wait until a newly-created asynchronous IDE runtime is actually reachable.
 *
 * Kubernetes returns the session record before its Pod has been scheduled and
 * the gate has bound port 3003. Embedding the URL while it is still `starting`
 * makes the reverse proxy answer 502 and leaves Cloudflare's error document in
 * the iframe.
 *
 * The probe is the backend's now: a launch queues a `session.await_ready` run
 * whose reads are what promote `starting` to `running`, so a session comes up
 * whether or not this tab is still open. Given `ready_run_id` and a `follow`,
 * this waits on that run and asks for the record once at the end.
 *
 * Without them it polls, exactly as it used to — a GET is still what refreshes
 * the server-side probe, which is what a deployment with no task queue has.
 */
/** Thrown by the poll loop when the caller has stopped caring. Never surfaces:
 *  a cancelled poll is always the loser of a race that has already settled. */
const POLL_CANCELLED = "studio session poll cancelled";

export async function waitForStudioSessionReady(
  initial: StudioSession,
  refresh: () => Promise<StudioSession>,
  options: SessionWaitOptions = {},
): Promise<StudioSession> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;

  /** Ask the record until it stops saying `starting`, the deadline passes, or
   *  the caller gives up on it.
   *
   *  `signal` is not decoration. This loop is one half of a `Promise.race`, and
   *  a race only settles its winner — the loser keeps running. When the run
   *  stream reported a FAILED launch, this poll went on asking `refresh()` once
   *  a second for the rest of the 120-second deadline: two minutes of
   *  authenticated requests about a session everyone had already been told was
   *  dead, continuing long after the error was on screen. The signal is checked
   *  on both sides of the sleep so cancelling costs at most one tick and never
   *  an extra request. */
  const poll = async (from: StudioSession, signal?: AbortSignal): Promise<StudioSession> => {
    let session = from;
    while (session.state === "starting") {
      if (signal?.aborted) throw new Error(POLL_CANCELLED);
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new Error(
          `IDE session did not become ready within ${Math.ceil(timeoutMs / 1_000)} seconds`,
        );
      }
      await sleep(Math.min(pollIntervalMs, remaining));
      if (signal?.aborted) throw new Error(POLL_CANCELLED);
      session = await refresh();
    }
    return session;
  };

  let session = initial;

  if (session.state === "starting" && session.ready_run_id && options.follow) {
    /* The run stream is an ACCELERATOR and a failure reporter, not the source
       of truth. The subscription is opened after the session was created, so a
       run that finishes in between never delivers its terminal event to it, and
       waiting on the stream alone then sits out the follower's own timeout —
       minutes of a launch that was ready in seconds. Poll alongside it and take
       whichever answers first: the stream reports a FAILED run immediately, the
       poll guarantees a successful one is noticed. */
    const controller = new AbortController();
    const watched = options.follow(session.ready_run_id, controller.signal).then(async (end) => {
      if (end.state !== "succeeded") {
        throw new Error(end.error || `IDE session did not become ready (run ${end.state})`);
      }
      // The run's result deliberately carries no URL — it would contain the
      // one-shot gate token, and a run's result is broadcast to the whole
      // tenant. One authenticated read gets it.
      return refresh();
    });
    // The loser of the race still settles. Without this, an abort — or a run
    // that fails after the poll already succeeded — surfaces as an unhandled
    // rejection.
    watched.catch(() => undefined);
    const polled = poll(session, controller.signal);
    // Same reason as `watched` above: whichever of the two loses the race still
    // settles, and a cancelled poll rejects.
    polled.catch(() => undefined);
    try {
      session = await Promise.race([watched, polled]);
    } finally {
      controller.abort();
    }
    // The run can finish a moment before the record catches up; keep asking
    // rather than calling that a stopped session.
    if (session.state === "starting") {
      session = await poll(session);
    }
  } else {
    session = await poll(session);
  }

  if (session.state !== "running") {
    throw new Error(`IDE session stopped before it became ready (state: ${session.state})`);
  }
  return session;
}

/** Loopback names the session URL may carry — same machine, different "site". */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Rewrite a session URL to the host the portal itself is served from.
 *
 * The IDE runs in an iframe and its auth gate uses a `SameSite=Lax` cookie,
 * which the browser withholds from cross-site requests. `localhost` and
 * `127.0.0.1` are the same machine but NOT the same site, so a portal opened
 * on one and a session published on the other loses the cookie on every
 * request after the initial `?token=` redirect — the IDE then answers
 * "403 — session token required" from inside the frame. Ports are irrelevant
 * to that comparison; only the host is.
 *
 * `SameSite=None` would be the other way out, but it requires `Secure`, and
 * sessions are published over plain http on loopback.
 *
 * Only loopback hosts are rewritten: a real `public_host` (a deployment
 * reachable by name) is deliberate configuration and must survive untouched.
 */
export function alignSessionHost(url: string): string {
  const here = typeof window === "undefined" ? "" : window.location.hostname;
  try {
    const u = new URL(url);
    if (LOOPBACK.has(u.hostname) && LOOPBACK.has(here)) {
      u.hostname = here;
    }
    return u.toString();
  } catch {
    return url; // not a URL we understand — hand it back unchanged
  }
}

/**
 * Browser origin used by the portal ↔ embedded IDE postMessage bridge.
 *
 * Kubernetes session URLs are intentionally relative (`/studio/<id>/`) so
 * they stay on the portal host. `new URL(relative)` throws, which used to
 * leave the iframe without a target origin and silently prevented the portal
 * from sending its API token to Theia.
 */
export function sessionOrigin(url: string): string {
  if (typeof window === "undefined") return "";
  try {
    return new URL(url, window.location.href).origin;
  } catch {
    return "";
  }
}

/** The vocabulary's contracts as the composer takes them: capability key to
 *  contracts. A capability without any is left out, and is found by its terms. */
function contractsOf(vocabulary: readonly Capability[]): Record<string, string[]> {
  const contracts: Record<string, string[]> = {};
  for (const cap of vocabulary) if (cap.contracts?.length) contracts[cap.key] = cap.contracts;
  return contracts;
}

const withAlignedHost = (s: StudioSession): StudioSession => ({
  ...s,
  url: alignSessionHost(s.url),
});

export interface StoredFile {
  id: string;
  name?: string;
  file_name?: string;
  size_bytes?: number;
  created_at?: string;
}

export type ProjectArtifactOrigin = "manual" | "generated";

// File Storage expects a concrete classifier derived from its base file type.
// A single-segment `gts.cf.file_storage.file.v1~` looks plausible but is not a
// valid GTS type chain and is rejected before an upload ticket is created.
const PROJECT_ARTIFACT_GTS_FILE_TYPE =
  "gts.cf.fstorage.file.type.v1~cf.studio.artifact.file.v1~";

export interface ProjectArtifactScope {
  organization_id: string;
  workspace_id: string;
  project_id: string;
}

export interface ProjectArtifactObjectRef {
  storage: "file-storage";
  file_id: string;
  version_id: string;
  name: string;
  mime: string;
  size: number;
  checksum?: string;
}

interface FileUploadTicket {
  file_id: string;
  version_id: string;
  upload_url: string;
}

interface FileStorageVersion {
  version_id: string;
  mime_type: string;
  size: number;
  hash_algorithm: string;
  hash: string;
  status: string;
  is_current: boolean;
}

interface FileStorageFile {
  file_id: string;
  etag?: string;
}

export interface Group {
  id: string;
  type: string;
  name: string;
  hierarchy: { parent_id: string | null; tenant_id: string; depth: number };
  metadata?: { workspace_id?: string } & Record<string, unknown>;
}

export interface Membership {
  group_id: string;
  resource_type: string;
  resource_id: string;
}

export function shortTypeName(gtsType: string): string {
  return gtsType.split("~").filter(Boolean).at(-1)?.split(".").at(-2) ?? gtsType;
}

export class ApiError extends Error {
  /**
   * The body read as RFC 9457 problem+json, when it is one.
   *
   * Every failure this backend produces is a canonical problem
   * (`docs/errors-catalog.md`), so this is populated for anything that reached
   * the assembly. It is absent when the failure did not: a proxy answering HTML,
   * a gateway timeout, a body that never arrived. Screens read `problem.category`
   * rather than `status`, because the status does not identify the failure —
   * `400` is three different categories.
   */
  readonly problem?: Problem;

  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
    this.problem = parseProblem(body);
  }
}

export function apiUrl(path: string): string {
  return `/cf${path.startsWith("/") ? path : `/${path}`}`;
}

/** The organization on screen, as App resolves it. */
let currentOrganization: string | undefined;

/** Called by App whenever the organization on screen changes. */
export function setCurrentOrganization(id: string | undefined): void {
  currentOrganization = id;
}

/** Gears that keep their data per organization and take `?organization_id=`. */
const ORG_SCOPED = ["/studio-components-catalog/", "/studio-reports/"];

/**
 * `path` with the organization on screen named, for a gear that keeps its
 * data per organization. Without it the server takes the caller's home
 * tenant, and a platform administrator's home is the platform root -- their
 * catalogue and reports were the root's while the screen showed an
 * organization's connections. A path that already names one keeps it.
 */
export function orgScoped(path: string, org: string | undefined = currentOrganization): string {
  if (!org || !ORG_SCOPED.some((p) => path.startsWith(p)) || /[?&]organization_id=/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}organization_id=${encodeURIComponent(org)}`;
}

/** Fired on any 401 so the app can drop a dead session instead of looping. */
export const UNAUTHENTICATED_EVENT = "studio:unauthenticated";

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  if (!token) {
    // Defensive: an empty token would reach the gateway as a missing bearer
    // and read as a server-side auth failure. Fail here, clearly.
    window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
    throw new ApiError(401, { title: "Not signed in", detail: "No access token in this session" });
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  if (import.meta.env.DEV) {
    // Dev-only: makes "did we actually send the bearer?" answerable from the
    // console instead of guessing at a server-side 401.
    console.debug(
      `[api] ${init?.method ?? "GET"} ${path} · auth=${headers.Authorization ? "yes" : "NO"} · token=${token.length}ch ${token.slice(0, 6)}…`,
    );
  }
  const res = await fetch(apiUrl(orgScoped(path)), { ...init, headers });
  const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    // 401 = the session is over (SSO access tokens expire; we hold no refresh
    // token yet). Tell the app once; every caller still gets its error.
    if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
    throw new ApiError(res.status, body);
  }
  return body as T;
}

/**
 * Headers for a call that starts background work (`202` + `run_id`).
 *
 * `Idempotency-Key` makes a retry of that request answer the run it already
 * started instead of starting a second one (docs/api-conventions.md). One key per
 * user action: the default is fresh on every call, and a caller retrying the
 * same action passes the key it used the first time.
 */
export function idempotent(key: string = crypto.randomUUID()): Record<string, string> {
  return { "Idempotency-Key": key };
}

/** A file the server writes, as a blob: the same auth and errors as `request`. */
async function requestBlob(path: string, token: string): Promise<Blob> {
  if (!token) {
    window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
    throw new ApiError(401, { title: "Not signed in", detail: "No access token in this session" });
  }
  const res = await fetch(apiUrl(orgScoped(path)), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
    throw new ApiError(res.status, await res.json().catch(() => undefined));
  }
  return res.blob();
}

/** Server-side ceiling on `limit` (studio-backend `src/pagination.rs`). */
const MAX_PAGE = 200;

/**
 * Walk a paged list endpoint to completion and return every item.
 *
 * The backend list contract is `?offset=&limit=` -> `{ [key]: [...], total }`,
 * defaulting to 50 per page. Screens that filter or lay out a whole collection
 * client-side (the gear catalogue, the artifact graph) need all of it, and
 * asking once would silently render only the first page. `total` is the count
 * before paging, so the walk stops the moment it has that many.
 */
async function requestAllPages<T>(path: string, token: string, key: string): Promise<T[]> {
  const separator = path.includes("?") ? "&" : "?";
  const items: T[] = [];
  for (let offset = 0; ; offset += MAX_PAGE) {
    const body = await request<Record<string, unknown>>(
      `${path}${separator}offset=${offset}&limit=${MAX_PAGE}`,
      token,
    );
    const page = (body[key] as T[] | undefined) ?? [];
    items.push(...page);
    const total = typeof body.total === "number" ? body.total : items.length;
    // An empty page also terminates: a server that ignores the parameters, or a
    // collection shrinking under a concurrent write, must not spin forever.
    if (page.length === 0 || items.length >= total) return items;
  }
}

const artifactSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function sameOriginFileStorageUrl(signedUrl: string): string {
  if (typeof window === "undefined") return signedUrl;
  try {
    const url = new URL(signedUrl, window.location.href);
    if (url.pathname.startsWith("/api/file-storage-data/")) {
      url.protocol = window.location.protocol;
      url.host = window.location.host;
    }
    return url.toString();
  } catch {
    return signedUrl;
  }
}

/**
 * Upload one user-created or Studio-generated artifact through file-storage's
 * signed data plane. Repository-ingested files deliberately do not use this
 * path. The hierarchy is durable metadata today; the platform gear remains the
 * sole owner of the physical S3 object-key layout.
 */
export async function uploadProjectArtifact(
  token: string,
  file: File,
  scope: ProjectArtifactScope,
  origin: ProjectArtifactOrigin,
  existingFileId?: string,
): Promise<ProjectArtifactObjectRef> {
  let ticket: FileUploadTicket;
  let currentEtag: string | undefined;

  if (existingFileId) {
    const current = await request<FileStorageFile>(
      `/api/file-storage/v1/files/${encodeURIComponent(existingFileId)}`,
      token,
    );
    currentEtag = current.etag;
    ticket = await request<FileUploadTicket>(
      `/api/file-storage/v1/files/${encodeURIComponent(existingFileId)}/versions`,
      token,
      { method: "POST", body: "{}" },
    );
  } else {
    ticket = await request<FileUploadTicket>("/api/file-storage/v1/files", token, {
      method: "POST",
      body: JSON.stringify({
        owner_kind: "app",
        owner_id: scope.project_id,
        name: file.name,
        gts_file_type: PROJECT_ARTIFACT_GTS_FILE_TYPE,
        mime_type: file.type || "application/octet-stream",
        idempotency_key: crypto.randomUUID(),
        custom_metadata: [
          { key: "studio.organization_id", value: scope.organization_id },
          { key: "studio.workspace_id", value: scope.workspace_id },
          { key: "studio.project_id", value: scope.project_id },
          { key: "studio.artifact_origin", value: origin },
          { key: "studio.original_name", value: file.name },
        ],
      }),
    });
  }

  const upload = await fetch(sameOriginFileStorageUrl(ticket.upload_url), {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!upload.ok) {
    throw new ApiError(upload.status, { title: "Artifact upload failed" });
  }

  const deadline = Date.now() + 120_000;
  let stored: FileStorageVersion | undefined;
  while (Date.now() < deadline) {
    const versions = await request<FileStorageVersion[]>(
      `/api/file-storage/v1/files/${encodeURIComponent(ticket.file_id)}/versions`,
      token,
    );
    stored = versions.find((version) => version.version_id === ticket.version_id);
    if (stored?.status === "available") break;
    if (stored && !["pending", "uploading"].includes(stored.status)) {
      throw new Error(`Artifact upload ended in state '${stored.status}'`);
    }
    await artifactSleep(500);
  }
  if (!stored || stored.status !== "available") {
    throw new Error("Artifact upload did not finalize within 120 seconds");
  }

  await request<FileStorageFile>(
    `/api/file-storage/v1/files/${encodeURIComponent(ticket.file_id)}/bind`,
    token,
    {
      method: "POST",
      headers: currentEtag ? { "If-Match": currentEtag } : undefined,
      body: JSON.stringify({ version_id: ticket.version_id }),
    },
  );

  return {
    storage: "file-storage",
    file_id: ticket.file_id,
    version_id: ticket.version_id,
    name: file.name,
    mime: stored.mime_type,
    size: stored.size,
    checksum:
      stored.hash_algorithm && stored.hash
        ? `${stored.hash_algorithm}:${stored.hash}`
        : undefined,
  };
}

/* ── studio-documents gear shapes ── */

export interface DocSection {
  key: string;
  title: string;
  required: boolean;
  min_words?: number | null;
  description?: string | null;
  aliases?: string[] | null;
}
export interface DocRules {
  warn_unknown_sections: boolean;
  front_matter: string[];
  forbid_placeholders: boolean;
  min_title_words: number;
}
export type DocQuestionKind = "text" | "long_text" | "bool" | "single" | "multi";
export interface DocQuestion {
  id: string;
  prompt: string;
  kind: DocQuestionKind;
  options: string[];
  required: boolean;
  /** Capability tag this answer seeds for the Composer. */
  capability?: string | null;
  /** Section key the answer is written under when the document is generated. */
  section?: string | null;
  help?: string | null;
}
export interface DocType {
  key: string;
  name: string;
  description: string;
  gts_type_id: string;
  owner: "builtin" | "organization" | "workspace";
  owner_tenant_id?: string | null;
  body: string;
  sections: DocSection[];
  rules: DocRules;
  /** Intake questionnaire; empty for types without one. */
  questionnaire?: DocQuestion[];
}
/** One questionnaire answer on the wire. Exactly one value field is meaningful
 *  per question kind. */
export interface DocAnswer {
  question_id: string;
  /** `text`, `long_text` and `single`. */
  text?: string;
  /** `multi`. */
  choices?: string[];
  /** `bool`. */
  flag?: boolean;
}

export interface Doc {
  id: string;
  tenant_id: string;
  project_id?: string | null;
  inherited: boolean;
  type_key: string;
  title: string;
  content: string;
  status: "draft" | "review" | "approved";
  conforms: boolean;
  /** Capability keys the document declares. The server indexes these from the
   *  document's own front matter on every write — do not parse the body. */
  capabilities: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Where this document would go in a repository — `docs/<type>/<slug>.md`.
   *  A suggestion the publish form prefills and a person may edit. */
  suggested_path?: string;
}
export interface DocSectionStatus {
  key: string;
  title: string;
  present: boolean;
  word_count: number;
  required: boolean;
  ok: boolean;
}
export interface DocValidation {
  conforms: boolean;
  sections: DocSectionStatus[];
  issues: string[];
}

/** The gear repository connected to a project — where its gears live and where
 *  scaffolded gears are written. */
/** One file of a scaffolded gear, as the endpoint sends and returns it. */
export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface ProjectGearRepo {
  project_id?: string;
  tenant?: string;
  connection_id?: string | null;
  repo?: string;
  branch?: string;
}

/** Whether product previews run here (`components_catalog/gearbox.rs`), and
 *  the gear corpus they resolve against — which a product project's IDE
 *  session checks out beside the project under `source_id`. */
export interface GearboxStatus {
  enabled: boolean;
  engine_version?: string | null;
  corpus_url?: string | null;
  corpus_ref?: string | null;
  corpus_commit?: string | null;
  source_id: string;
  profiles: string[];
  problem?: string | null;
}

export interface GearboxDiagnostic {
  code: string;
  severity: "error" | "warning" | "info" | string;
  message: string;
  help?: string | null;
  /** `product.gdl`, or the corpus path of the gear.gdl it is about. */
  file?: string | null;
  /** One-based. */
  line?: number | null;
}

export interface GearboxApplication {
  name: string;
  kind: string;
  anchor?: string | null;
  gears: string[];
  replicas: number;
  listens: { name: string; gear: string; address: string }[];
}

/** One thing completion did to the picks, and why. */
export interface ProductChange {
  /** Crate name. */
  gear: string;
  added: boolean;
  reason: string;
}

/** The product a project is composing, as the server remembers it. */
/** How a product configures its gears: gear crate name -> field -> value.
 *  Written into product.gdl as the gear's or plugin's `config`. */
export type GearConfig = Record<string, Record<string, unknown>>;

export interface ProjectProduct {
  project_id?: string;
  /** The product's configuration of its gears (see GearConfig). */
  config?: GearConfig;
  product_id?: string;
  name?: string;
  /** Catalogue names (`cf-gears-api-gateway`), in the order they were picked. */
  gears?: string[];
  profile?: string;
  updated_at?: string;
  /** What the engine said the last time the product was previewed. */
  last_preview?: {
    profile: string;
    ok: boolean;
    errors: number;
    warnings: number;
    applications: string[];
    /** Every gear the resolution contains, picked or pulled in, by crate. */
    gears: string[];
    corpus_commit?: string | null;
  };
  /** Where `product.gdl` was last committed; `path` is relative to the repository root. */
  written?: { branch: string; commit_sha: string; pr_url?: string | null; path?: string };
}

/** What the Gearbox engine made of a set of picked gears. */
export interface ProductPreview {
  product_gdl: string;
  profile: string;
  ok: boolean;
  diagnostics: GearboxDiagnostic[];
  applications: GearboxApplication[];
  gears: { id: string; crate_name: string; reasons: string[] }[];
  added: { id: string; reason: string }[];
  not_described: string[];
  /** Picked hosts without the plugin their extension point needs, and the
   *  engine ids that could fill it. */
  plugin_options: { host: string; available: string[] }[];
  corpus_commit?: string | null;
  written?: { branch: string; commit_sha: string; pr_url?: string | null } | null;
}

/** What `importDomainModel` loaded. */
export interface DomainModelImport {
  entities: number;
  buckets: number;
  node_types: number;
  edge_types: number;
}

/** What `syncDomainModel` materialized. */
export interface DomainModelSync {
  object_types: number;
  inherits: number;
  declares: number;
  skipped_endpoints: number;
}

/** One row of the portfolio, as the server counts it.
 *
 *  Every count is nullable and the null is load-bearing: it means that source
 *  could not be asked, which is not the same fact as a count of zero. */
export interface RollupRow {
  id: string;
  name: string;
  kind: "workspace" | "project";
  /** The workspace a project belongs to; null on a workspace row. */
  parent_id?: string | null;
  projects?: number | null;
  documents?: number | null;
  findings?: number | null;
  repos?: number | null;
  /** Projects: `new_gears` | `product` | `existing`, and the project's brief. */
  project_kind?: string | null;
  brief?: string | null;
  /** Findings still to fix (`high`, `gate-failed`, `some`); `findings` counts every verdict. */
  open_findings?: number | null;
  /** Unresolved threads the repositories report. */
  open_comments?: number | null;
  /** Bound repository files plus documents written in Studio. */
  specs?: number | null;
  specs_authored?: number | null;
  specs_checked?: number | null;
  specs_failing?: number | null;
  /** Null when no pull request was ever synced. */
  pulls_open?: number | null;
  pulls_merged?: number | null;
  pull_days?: number[] | null;
  activity_days?: number | null;
  /**
   * People who may work in the project, from Studio memberships: every active
   * organization member under tenant access, the members granted a role on it
   * under role-based access. Null when that could not be read.
   */
  team?: number | null;
  /** The newest event the Activity feed lists. */
  last_event?: string | null;
  last_subject?: string | null;
  last_at?: string | null;
}

/** A verdict as the server read it. Fields follow the detector, so most are
 *  absent for any one answer; the nulls are load-bearing where present. */
export interface SpecQualityVerdict {
  detector: string;
  task_id: string;
  doc_type?: string | null;
  spec_share?: number | null;
  gate_passed?: boolean | null;
  passed?: boolean | null;
  leak_share?: number | null;
  foreign_roles?: string[] | null;
  by_path?: Record<string, string[]> | null;
  pairs?: string[][] | null;
  recognised?: boolean | null;
  /** What the detector found, each placed in the text. */
  findings?: SpecFindingItem[];
}

/** `?organization_id=` for a reports call, or nothing when no organization is known. */
export function orgQuery(org: string | undefined, sep: "?" | "&" = "?"): string {
  return org ? `${sep}organization_id=${encodeURIComponent(org)}` : "";
}

export const api = {
  /** Login = validate the token by asking the backend who we are. */
  me: (token: string) => request<Me>("/account-management/v1/me", token),

  /** One analysis, as the server read it.
   *
   *  The four detectors answer in shapes their service does not document, and
   *  turning those into a verdict is a judgement rather than a parse. That
   *  judgement moved to the backend so two portals cannot make it differently;
   *  this asks for the answer. `paths` is required by the set detectors
   *  (`bloat`, `traceability`): a document absent from it is absent from the
   *  reply, and absent reads as "not analysed" where an empty list reads as
   *  "analysed, nothing found". */
  specQualityVerdict: (
    token: string,
    taskId: string,
    detector: "purpose" | "leak" | "bloat" | "traceability",
    paths: string[] = [],
  ) => {
    const q = new URLSearchParams({ task_id: taskId, detector });
    for (const p of paths) q.append("path", p);
    return request<SpecQualityVerdict>(`/studio-spec-quality/v1/verdicts?${q.toString()}`, token);
  },

  /** What every workspace and project contains, in one request.
   *
   *  The portal used to compose this itself — three requests per row, one of
   *  them a listing that walks the whole artifact graph. The composition is on
   *  the server now; this asks for it. `projectId` narrows it to one project,
   *  `workspaceId` to one workspace and its projects. */
  rollups: (token: string, projectId?: string, workspaceId?: string) => {
    const q = projectId
      ? `?project_id=${encodeURIComponent(projectId)}`
      : workspaceId
        ? `?workspace_id=${encodeURIComponent(workspaceId)}`
        : "";
    return request<{ items: RollupRow[]; total: number }>(
      `/studio-organizations/v1/rollups${q}`,
      token,
    );
  },

  /* ── studio-documents gear (types + templates + validation) ── */

  /** Define, replace or hide a journey stage in this workspace.
   *
   *  `hidden: true` is a tombstone: it removes the inherited entry from the
   *  effective catalogue instead of replacing it. Reverting is `deleteStage`. */
  upsertStage: (
    token: string,
    workspaceId: string,
    body: {
      key: string;
      label: string;
      required?: boolean;
      position?: number;
      requires?: string[];
      gates?: string[];
      hidden?: boolean;
    },
  ) =>
    request<JourneyStage>(`/studio-documents/v1/workspaces/${workspaceId}/stages`, token, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Drop this workspace's own entry for `key`, so what it inherits shows
   *  through again. Idempotent. */
  deleteStage: (token: string, workspaceId: string, key: string) =>
    request<void>(
      `/studio-documents/v1/workspaces/${workspaceId}/stages/${encodeURIComponent(key)}`,
      token,
      { method: "DELETE" },
    ),

  upsertCapability: (
    token: string,
    workspaceId: string,
    body: { key: string; label: string; terms?: string[]; contracts?: string[]; hidden?: boolean },
  ) =>
    request<Capability>(`/studio-documents/v1/workspaces/${workspaceId}/capabilities`, token, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteCapability: (token: string, workspaceId: string, key: string) =>
    request<void>(
      `/studio-documents/v1/workspaces/${workspaceId}/capabilities/${encodeURIComponent(key)}`,
      token,
      { method: "DELETE" },
    ),

  /** Every spec a project has, in one list, with each queue counted.
   *
   *  The merge, the ordering and the queues live in `documents/spec_rows.rs`.
   *  This used to be `spec-rows.ts`, which meant the page first had to page
   *  the WHOLE artifact file graph to find the files nothing had classified
   *  yet — the projection cannot narrow by a payload field, so every one of
   *  those pages was a slice of the tenant's entire typed node set.
   *
   *  `sources.files_known` false means nobody could ask for those files, so
   *  `not-scanned` is empty for that reason rather than because there are none. */
  specRows: (token: string, projectId: string) =>
    request<{
      items: SpecRow[];
      total: number;
      sources: { files_known: boolean; counts: { queue: SpecFilter; count: number }[] };
    }>(`/studio-documents/v1/spec-rows?project_id=${encodeURIComponent(projectId)}`, token),

  /** How many specs came out of each repository.
   *
   *  Two sources with no join between them: the artifact graph holds the file
   *  and its repository, studio-documents holds the binding that says what the
   *  file is. This page used to hold both, by paging the entire file listing.
   *
   *  `files_known` false means every count is MISSING rather than zero. */
  specsPerSource: (token: string, scope: string) =>
    request<{
      items: { repo: string; specs: number }[];
      total: number;
      files_known: boolean;
    }>(`/studio-documents/v1/specs-per-source?scope=${encodeURIComponent(scope)}`, token),

  /** What a project has of each document type it declares.
   *
   *  The grouping and the coverage rule live in `documents/spec_rows.rs`: a
   *  repository file a person bound to a type is a document of that type, a
   *  file the scanner only proposed is shown but NOT counted, and a document
   *  nobody has checked has not passed anything. This used to be
   *  `spec-pipeline.ts`, which meant the screen had to fetch every binding to
   *  work it out. */
  specPipeline: (token: string, projectId: string) =>
    request<{ items: PipelineRow[]; total: number }>(
      `/studio-documents/v1/spec-pipeline?project_id=${encodeURIComponent(projectId)}`,
      token,
    ),

  /** A week of movement per repository, folded by studio-artifact-ingest.
   *
   *  This used to be `source-activity.ts` plus a paged walk of `pull_request`
   *  and `commit` nodes in the browser — commits outnumber everything else in
   *  a repository, and the projection cannot narrow by a payload field, so
   *  every page was a slice of the tenant's whole typed node set. */
  sourceActivity: (token: string, scope: string, days?: number) =>
    request<{ items: RepoActivity[]; total: number; days: number }>(
      `/studio-artifact-ingest/v1/source-activity?scope=${encodeURIComponent(scope)}` +
        (days ? `&days=${days}` : ""),
      token,
    ),

  /** What was checked and what was said, in one feed.
   *
   *  The ordering, the naming fallback and the two kinds live in
   *  `artifact_ingest/activity.rs`. The page used to walk `spec_finding` and
   *  `comment` to a cap and read every binding to name them. */
  activityFeed: (token: string, projectId: string) =>
    request<{ items: ActivityEvent[]; total: number }>(
      `/studio-artifact-ingest/v1/activity?project_id=${encodeURIComponent(projectId)}`,
      token,
    ),

  /** The effective capability vocabulary for a workspace (ADR-0014 s5). */
  capabilities: (token: string, workspaceId: string) =>
    request<{ items: Capability[] }>(
      `/studio-documents/v1/workspaces/${workspaceId}/capabilities`,
      token,
    ),

  /** The effective journey-stage catalogue for a workspace (ADR-0014 s7). */
  stages: (token: string, workspaceId: string) =>
    request<{ items: JourneyStage[] }>(
      `/studio-documents/v1/workspaces/${workspaceId}/stages`,
      token,
    ),

  docTypes: (token: string, workspaceId: string) =>
    request<{ items: DocType[] }>(
      `/studio-documents/v1/workspaces/${workspaceId}/types`,
      token,
    ),

  /** What an organization publishes to the workspaces under it.
   *
   *  Its own editing view, not what a workspace sees: a workspace may replace
   *  or hide any of it. The Components page is organization-scoped, so this is
   *  the level whose document types belong in its catalogue. */
  orgDocTypes: (token: string, organizationId: string) =>
    request<{ items: DocType[] }>(
      `/studio-documents/v1/organizations/${organizationId}/types`,
      token,
    ),

  upsertDocType: (
    token: string,
    workspaceId: string,
    body: {
      key: string;
      name: string;
      description?: string;
      body: string;
      sections: DocSection[];
      rules?: DocRules;
    },
  ) =>
    request<DocType>(`/studio-documents/v1/workspaces/${workspaceId}/types`, token, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // All pages: the documents screen keeps the list in state and reads the
  // selected document's body straight out of it. Real paging UI is the next
  // step — until then the walk is what keeps the screen showing everything.
  workspaceDocuments: async (token: string, workspaceId: string) => ({
    items: await requestAllPages<Doc>(
      `/studio-documents/v1/workspaces/${workspaceId}/documents`,
      token,
      "items",
    ),
  }),

  projectDocuments: async (token: string, workspaceId: string, projectId: string) => ({
    items: await requestAllPages<Doc>(
      `/studio-documents/v1/workspaces/${workspaceId}/projects/${projectId}/documents`,
      token,
      "items",
    ),
  }),

  createWorkspaceDocument: (
    token: string,
    workspaceId: string,
    body: { type_key: string; title: string; content?: string; answers?: DocAnswer[] },
  ) =>
    request<Doc>(`/studio-documents/v1/workspaces/${workspaceId}/documents`, token, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  createProjectDocument: (
    token: string,
    workspaceId: string,
    projectId: string,
    body: { type_key: string; title: string; content?: string; answers?: DocAnswer[] },
  ) =>
    request<Doc>(
      `/studio-documents/v1/workspaces/${workspaceId}/projects/${projectId}/documents`,
      token,
      { method: "POST", body: JSON.stringify(body) },
    ),

  updateDocument: (
    token: string,
    workspaceId: string,
    id: string,
    body: { title?: string; content?: string; status?: string },
  ) =>
    request<Doc>(`/studio-documents/v1/workspaces/${workspaceId}/documents/${id}`, token, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  validateDocument: (token: string, workspaceId: string, id: string) =>
    request<DocValidation>(
      `/studio-documents/v1/workspaces/${workspaceId}/documents/${id}/validate`,
      token,
      { method: "POST" },
    ),

  deleteDocument: (token: string, workspaceId: string, id: string) =>
    request<void>(`/studio-documents/v1/workspaces/${workspaceId}/documents/${id}`, token, {
      method: "DELETE",
    }),

  /* ── Studio kit registry (prototype only) ── */

  // All three walk their pages. The endpoints are `?offset=&limit=` now — the
  // server stopped answering with the whole collection — and these screens
  // filter and lay out the full list client-side, so asking once would render
  // the first fifty and look complete.
  kits: async (token: string) => ({
    items: await requestAllPages<StudioKit>("/studio-kits/v1/catalog", token, "items"),
  }),

  kitInstallations: async (token: string, projectId: string) => ({
    items: await requestAllPages<KitInstallation>(
      `/studio-kits/v1/projects/${encodeURIComponent(projectId)}/installations`,
      token,
      "items",
    ),
  }),

  projectRepositories: async (token: string, projectId: string) => ({
    items: await requestAllPages<ProjectRepository>(
      `/studio-kits/v1/projects/${encodeURIComponent(projectId)}/repositories`,
      token,
      "items",
    ),
  }),

  requestKitInstallation: (
    token: string,
    projectId: string,
    input: {
      kit_slug: string;
      version: string;
      install_mode: "copy" | "register";
      scope?: "project" | "all-repositories";
    },
  ) =>
    request<KitInstallation>(
      `/studio-kits/v1/projects/${encodeURIComponent(projectId)}/installations`,
      token,
      { method: "POST", body: JSON.stringify(input) },
    ),

  materializeKitInstallation: (
    token: string,
    projectId: string,
    kitSlug: string,
    repositoryId?: string,
  ) =>
    request<KitInstallation>(
      `/studio-kits/v1/projects/${encodeURIComponent(projectId)}/installations/${encodeURIComponent(kitSlug)}/materialize`,
      token,
      { method: "POST", body: JSON.stringify({ repository_id: repositoryId }) },
    ),

  /** Materialize the kit wherever its scope says it belongs. Idempotent: the
   *  backend skips repositories already carrying the requested version, so
   *  this is safe to call on load and is what picks up a repository that
   *  joined the project after the kit was installed. */
  reconcileKitInstallation: (token: string, projectId: string, kitSlug: string) =>
    request<KitInstallation>(
      `/studio-kits/v1/projects/${encodeURIComponent(projectId)}/installations/${encodeURIComponent(kitSlug)}/reconcile`,
      token,
      { method: "POST" },
    ),

  removeKitInstallation: (token: string, projectId: string, kitSlug: string) =>
    request<void>(
      `/studio-kits/v1/projects/${encodeURIComponent(projectId)}/installations/${encodeURIComponent(kitSlug)}`,
      token,
      { method: "DELETE" },
    ),

  tenant: (token: string, tenantId: string) =>
    request<Tenant>(`/account-management/v1/tenants/${tenantId}`, token),

  tenantChildren: (token: string, tenantId: string) =>
    request<Page<Tenant>>(`/account-management/v1/tenants/${tenantId}/children`, token),

  /** Every child, following `next_cursor`. The first page alone is how the
   *  portfolio used to list a workspace's projects: silently cut short. */
  tenantChildrenAll: (token: string, tenantId: string) =>
    allCursorPages<Tenant>(`/account-management/v1/tenants/${tenantId}/children`, token),

  deleteTenant: (token: string, tenantId: string) =>
    request<void>(`/account-management/v1/tenants/${tenantId}`, token, { method: "DELETE" }),

  deleteGroup: (token: string, groupId: string, force = false) =>
    request<void>(`/resource-group/v1/groups/${groupId}${force ? "?force=true" : ""}`, token, {
      method: "DELETE",
    }),

  createTenant: (
    token: string,
    input: { name: string; parent_id: string; tenant_type: string },
  ) =>
    request<Tenant>("/account-management/v1/tenants", token, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** Rename a tenant. AM exposes `name` as the only mutable field on
   *  `PATCH /tenants/{id}` (RFC 7396 merge patch); status transitions and the
   *  parent are immutable here. */
  updateTenant: (token: string, tenantId: string, input: { name: string }) =>
    request<Tenant>(`/account-management/v1/tenants/${tenantId}`, token, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  tenantUsers: (token: string, tenantId: string) =>
    request<Page<User>>(`/account-management/v1/tenants/${tenantId}/users`, token),

  /** Every user, following `next_cursor` (see `tenantChildrenAll`). */
  tenantUsersAll: (token: string, tenantId: string) =>
    allCursorPages<User>(`/account-management/v1/tenants/${tenantId}/users`, token),

  /** Platform-admin-only directory, including identities without a valid tenant. */
  platformIdentities: (token: string) =>
    request<{ items: PlatformIdentity[] }>("/studio-identity/v1/users", token),

  assignPlatformIdentity: (
    token: string,
    identityId: string,
    input: { tenant_id: string; role: MembershipRole },
  ) =>
    request<void>(`/studio-identity/v1/users/${encodeURIComponent(identityId)}/assignment`, token, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** An organization's members, from studio-user — the authority for who
   *  belongs to it (ADR-0011 §2). `people.view`: an owner or a platform admin. */
  orgMembers: (token: string, orgId: string) =>
    requestAllPages<OrgMember>(
      `/studio-user/v1/organizations/${encodeURIComponent(orgId)}/members`,
      token,
      "items",
    ),

  /** One member's sign-in methods and attributed accounts. `people.view`, and
   *  only for somebody in that organization (404 otherwise). */
  memberIdentities: (token: string, orgId: string, userId: string) =>
    request<MemberIdentities>(
      `/studio-user/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}/identities`,
      token,
    ),

  /** Add somebody, change their role, or suspend/resume them — one write. An
   *  active `owner` also gets the organization's owner grant; anyone else loses it. */
  putMembership: (
    token: string,
    userId: string,
    orgId: string,
    input: { role: MembershipRole; status?: "active" | "suspended"; source?: "assignment" | "manual" },
  ) =>
    request<OrgMember>(
      `/studio-user/v1/users/${encodeURIComponent(userId)}/memberships/${encodeURIComponent(orgId)}`,
      token,
      { method: "PUT", body: JSON.stringify(input) },
    ),

  removeMembership: (token: string, userId: string, orgId: string) =>
    request<void>(
      `/studio-user/v1/users/${encodeURIComponent(userId)}/memberships/${encodeURIComponent(orgId)}`,
      token,
      { method: "DELETE" },
    ),

  /** The canonical Studio person behind a sign-in, created on first sight
   *  (platform admin). The membership routes take this id, not the IdP's. */
  resolvePerson: (
    token: string,
    input: { provider: "keycloak"; subject: string; display_name?: string; email?: string },
  ) =>
    request<{ user_id: string }>("/studio-user/v1/resolve", token, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  orgInvitations: (token: string, orgId: string) =>
    request<{ items: OrgInvitation[] }>(
      `/studio-user/v1/organizations/${encodeURIComponent(orgId)}/invitations`,
      token,
    ),

  /** The person sees it when they sign in with this address proven, and
   *  accepts it themselves (ADR-0018 §2) — no token to hand over. */
  inviteToOrg: (token: string, orgId: string, input: { email: string; role: "member" | "admin" }) =>
    request<{ invitation: OrgInvitation }>(
      `/studio-user/v1/organizations/${encodeURIComponent(orgId)}/invitations`,
      token,
      { method: "POST", body: JSON.stringify(input) },
    ),

  revokeInvitation: (token: string, orgId: string, invitationId: string) =>
    request<void>(
      `/studio-user/v1/organizations/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`,
      token,
      { method: "DELETE" },
    ),

  inviteUser: (
    token: string,
    tenantId: string,
    input: { username: string; email?: string; display_name?: string },
  ) =>
    request<User>(`/account-management/v1/tenants/${tenantId}/users`, token, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* ── Projects (RG-backed, ADR-0002) ── */

  groups: (token: string) => request<Page<Group>>("/resource-group/v1/groups", token),

  createGroup: (
    token: string,
    input: { type: string; name: string; parent_id: string | null; metadata?: Record<string, unknown> },
  ) =>
    request<Group>("/resource-group/v1/groups", token, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  memberships: (token: string) => request<Page<Membership>>("/resource-group/v1/memberships", token),

  addMembership: (token: string, groupId: string, resourceType: string, resourceId: string) =>
    request<Membership>(
      `/resource-group/v1/memberships/${groupId}/${resourceType}/${resourceId}`,
      token,
      { method: "POST" },
    ),

  /** Relabel a connection, move it to another installation, or rotate its
   *  credential. Every field optional; the backend verifies the result against
   *  the provider before writing, with or without a new token. The connection
   *  id survives, which is why this exists — workspace sources reference it. */
  patchConnection: (
    token: string,
    id: string,
    input: { label?: string; base_url?: string; token?: string },
    tenantId?: string,
  ) =>
    request<ConnectionTest>(
      `/studio-connector/v1/connections/${id}${tenantId ? `?tenant=${tenantId}` : ""}`,
      token,
      { method: "PATCH", body: JSON.stringify(input) },
    ),

  /* ── Workspace settings (AM tenant metadata) ── */

  workspaceSettings: async (token: string, tenantId: string): Promise<WorkspaceSettings | null> => {
    try {
      const entry = await request<{ value: WorkspaceSettings }>(
        `/account-management/v1/tenants/${tenantId}/metadata/${WS_SETTINGS_TYPE}`,
        token,
      );
      return entry.value;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null; // not set yet
      throw e;
    }
  },

  /* ── studio-connector ── */

  connectorProviders: (token: string) =>
    request<{ items: ConnectorProvider[] }>("/studio-connector/v1/providers", token),

  /** Connections visible from `tenant` — its own, or inherited from an ancestor. */
  connections: (token: string, tenant: string) =>
    request<{ items: Connection[] }>(
      `/studio-connector/v1/connections?tenant=${encodeURIComponent(tenant)}`,
      token,
    ),

  /** Verify a credential without storing it ("Test connection"). */
  probeConnection: (token: string, body: { provider: string; base_url?: string; token: string }) =>
    request<ConnectorIdentity>("/studio-connector/v1/probe", token, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Verifies, then stores ("Test & save"). The token never comes back out. */
  createConnection: (
    token: string,
    body: {
      provider: string;
      label: string;
      base_url?: string;
      token: string;
      scope?: string;
      /** Organization (inherited by its workspaces) or a single workspace. */
      owner_tenant_id?: string;
    },
  ) =>
    request<ConnectionTest>("/studio-connector/v1/connections", token, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  testConnection: (token: string, id: string, tenant: string) =>
    request<ConnectionTest>(
      `/studio-connector/v1/connections/${id}/test?tenant=${encodeURIComponent(tenant)}`,
      token,
      { method: "POST" },
    ),

  /** Removes the row from the connection's OWNING tenant, so deleting an
   *  inherited connection edits the organization's catalogue — and is refused
   *  when the caller may not write there. */
  deleteConnection: (token: string, id: string, tenant: string) =>
    request<void>(
      `/studio-connector/v1/connections/${id}?tenant=${encodeURIComponent(tenant)}`,
      token,
      { method: "DELETE" },
    ),

  /* ── studio-connector: the notification half ── */

  /** Channels this connection can post to. Refused (400) for a webhook
   *  connection, whose channel is fixed in the URL it was created from. */
  notifyTargets: (token: string, id: string, tenant: string, search?: string) => {
    const q = new URLSearchParams({ tenant });
    if (search?.trim()) q.set("search", search.trim());
    return request<{ items: NotifyTarget[] }>(
      `/studio-connector/v1/connections/${encodeURIComponent(id)}/targets?${q.toString()}`,
      token,
    );
  },

  /** Post now and wait for the platform's answer. Delivered once, not retried —
   *  this is the "send a test message" path; use `queueNotification` for
   *  anything that must not be lost. */
  sendConnectorMessage: (
    token: string,
    id: string,
    tenant: string,
    body: { target?: string; title?: string; text: string; link?: string; topic?: string },
  ) =>
    request<SentMessage>(
      `/studio-connector/v1/connections/${encodeURIComponent(id)}/messages?tenant=${encodeURIComponent(tenant)}`,
      token,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /* ── studio-notify: the durable queue ── */

  /** Queue a notification and get the run that will deliver it. 202 — durably
   *  queued; whether Slack takes it is not yet known.
   *
   *  Two kinds of destination, exactly one per message: `connection_id` posts to
   *  a chat channel, `workspace_id` shows it in the Theia IDE of whoever has
   *  that workspace open. */
  queueNotification: (
    token: string,
    body: {
      connection_id?: string;
      target?: string;
      workspace_id?: string;
      level?: "info" | "warn" | "error";
      title?: string;
      text: string;
      link?: string;
      topic?: string;
      tenant_id?: string;
    },
    /** The `Idempotency-Key`: pass the first attempt's key when retrying it. */
    idempotencyKey?: string,
  ) =>
    request<{ run_id: string; poll: string }>("/studio-notify/v1/messages", token, {
      method: "POST",
      headers: idempotent(idempotencyKey),
      body: JSON.stringify(body),
    }),

  connectionRepositories: (token: string, id: string, tenant: string, search?: string) => {
    const q = new URLSearchParams({ tenant });
    if (search?.trim()) q.set("search", search.trim());
    return request<{ items: RemoteRepo[] }>(
      `/studio-connector/v1/connections/${id}/repositories?${q.toString()}`,
      token,
    );
  },



  /** Where a project stands against the stages of its workspace's journey.
   *
   *  Computed, never stored: a stage is complete when the documents it names
   *  are there, conform, and have passed whatever detectors it gates on. A
   *  stored flag would go stale the moment one of them is edited. */
  projectStageStatus: (token: string, workspaceId: string, projectId: string) =>
    request<{ items: StageStatus[] }>(
      `/studio-documents/v1/workspaces/${workspaceId}/projects/${projectId}/stage-status`,
      token,
    ),

  /* ── studio-documents: ingested files bound to types ── */

  /** Classify ingested files against the workspace's document types. Send a
   *  few dozen per call — the whole set in one request blows the body limit. */
  classifyDocFiles: (
    token: string,
    workspaceId: string,
    projectId: string | null,
    files: { node_id: string; path: string; content: string }[],
  ) =>
    request<{ items: DocBinding[]; not_documents: number; kept: number }>(
      projectId
        ? `/studio-documents/v1/workspaces/${workspaceId}/projects/${projectId}/document-bindings/classify`
        : `/studio-documents/v1/workspaces/${workspaceId}/document-bindings/classify`,
      token,
      { method: "POST", body: JSON.stringify({ files }) },
    ),

  /** Run a Spec Quality detector over a project's documents.
   *
   *  Carries binding ids, NOT text. The server reads the documents from the
   *  checkout a sync left on disk — which is where they already are — and
   *  enqueues one run. This replaces the portal reading every file out through
   *  `repo-files` and posting it back, which is what made a whole-set detector
   *  a request big enough for the gateway to refuse.
   *
   *  Which bindings deserve a detector stays here: that is policy, and only the
   *  reading of them moved. */
  analyzeProjectDocuments: (
    token: string,
    workspaceId: string,
    projectId: string,
    detector: "purpose" | "leak" | "bloat" | "traceability",
    bindingIds: string[],
    /** Documents written in Studio; each comes back as `studio-doc/<id>.md`. */
    documentIds: string[] = [],
  ) =>
    request<{ run_id: string; poll: string; documents: number }>(
      `/studio-documents/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(
        projectId,
      )}/quality/${encodeURIComponent(detector)}`,
      token,
      {
        method: "POST",
        headers: idempotent(),
        body: JSON.stringify({ binding_ids: bindingIds, document_ids: documentIds }),
      },
    ),

  /** Every capability the project's documents declare -- the ones Studio holds
   *  and the repository files bound to a type -- with what declares each. */
  declaredCapabilities: (token: string, projectId: string) =>
    request<{ items: DeclaredCapability[]; total: number }>(
      `/studio-documents/v1/declared-capabilities?project_id=${encodeURIComponent(projectId)}`,
      token,
    ),

  docBindings: (
    token: string,
    workspaceId: string,
    projectId: string | null,
    page?: { offset?: number; limit?: number },
  ) => {
    const q = new URLSearchParams();
    if (page?.offset != null) q.set("offset", String(page.offset));
    if (page?.limit != null) q.set("limit", String(page.limit));
    const suffix = q.toString() ? `?${q}` : "";
    return request<{ items: DocBinding[]; total: number }>(
      projectId
        ? `/studio-documents/v1/workspaces/${workspaceId}/projects/${projectId}/document-bindings${suffix}`
        : `/studio-documents/v1/workspaces/${workspaceId}/document-bindings${suffix}`,
      token,
    );
  },

  /** Every binding in the scope, read page by page to `total`. The route
   *  clamps a page to 200 rows, and a repository has thousands of files, so a
   *  single call is the first page and not the set: a caller matching rows
   *  against it would see every file past the first page as unscanned. */
  allDocBindings: async (token: string, workspaceId: string, projectId: string | null) => {
    const PAGE = 200;
    const items: DocBinding[] = [];
    for (;;) {
      const page = await api.docBindings(token, workspaceId, projectId, { offset: items.length, limit: PAGE });
      items.push(...page.items);
      if (page.items.length === 0 || items.length >= page.total) return { items, total: page.total };
    }
  },

  /** Rule on what an ingested file is. Pass `content` to re-check conformance
   *  against the new type in the same call. */
  decideDocBinding: (
    token: string,
    workspaceId: string,
    id: string,
    body: {
      action: "confirm" | "set" | "reject" | "reset";
      type_key?: string;
      source?: "manual" | "spec_quality";
      confidence?: number;
      content?: string;
    },
  ) =>
    request<DocBinding>(
      `/studio-documents/v1/workspaces/${workspaceId}/document-bindings/${id}`,
      token,
      { method: "PUT", body: JSON.stringify(body) },
    ),


  /** Record one detector's verdict against a bound repository file.
   *
   *  The full finding goes to the artifact graph; this is the index a stage
   *  gate reads, so a stage can depend on a detector having passed for a
   *  document that lives in the repository. */
  recordBindingAnalysis: (
    token: string,
    workspaceId: string,
    bindingId: string,
    detector: string,
    body: { state: "pending" | "passed" | "failed"; task_id?: string; summary?: string },
  ) =>
    request<unknown>(
      `/studio-documents/v1/workspaces/${workspaceId}/document-bindings/${bindingId}/analyses/${detector}`,
      token,
      { method: "PUT", body: JSON.stringify(body) },
    ),

  deleteDocBinding: (token: string, workspaceId: string, id: string) =>
    request<void>(
      `/studio-documents/v1/workspaces/${workspaceId}/document-bindings/${id}`,
      token,
      { method: "DELETE" },
    ),

  /** Publish one file into a repository through a connection: commit it, and
   *  optionally cut the branch first and open a pull request after. The
   *  connection's own credential does the writing, so a read-only token
   *  answers 400 with the provider's reason. */
  writeRepoFile: (
    token: string,
    connectionId: string,
    tenant: string,
    body: {
      repo: string;
      /** Branch to commit on; omitted commits to the repository default. A
       *  branch that does not exist yet is cut from `base`. */
      branch?: string;
      /** Where a new branch is cut from, and what a pull request targets.
       *  Omitted means the repository default. */
      base?: string;
      path: string;
      content: string;
      message: string;
      /** Opens (or reuses) a request from `branch` into the base. Needs `branch`. */
      pull_request?: { title: string; body?: string };
    },
  ) =>
    request<WrittenFile>(
      `/studio-connector/v1/connections/${connectionId}/files?tenant=${encodeURIComponent(tenant)}`,
      token,
      { method: "POST", body: JSON.stringify(body) },
    ),

  putWorkspaceSettings: (token: string, tenantId: string, value: WorkspaceSettings) =>
    request<unknown>(`/account-management/v1/tenants/${tenantId}/metadata/${WS_SETTINGS_TYPE}`, token, {
      method: "PUT",
      body: JSON.stringify(value), // transparent payload; GTS-validated server-side
    }),

  /* ── Project attributes (AM tenant metadata on the project tenant) ── */
  projectConfig: async (token: string, tenantId: string): Promise<ProjectConfig | null> => {
    try {
      const entry = await request<{ value: ProjectConfig }>(
        `/account-management/v1/tenants/${tenantId}/metadata/${PROJECT_CONFIG_TYPE}`,
        token,
      );
      return entry.value;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },

  putProjectConfig: (token: string, tenantId: string, value: ProjectConfig) =>
    request<unknown>(
      `/account-management/v1/tenants/${tenantId}/metadata/${PROJECT_CONFIG_TYPE}`,
      token,
      { method: "PUT", body: JSON.stringify(value) },
    ),

  /* ── Organization access config (AM tenant metadata) ── */

  /** The privilege catalogue and the seeded role ladder, from the side that
   *  evaluates them.
   *
   *  Both used to be a second copy in `access.ts` under a comment saying they
   *  "must match" `access_config.rs`, guarded by a test that parsed the Rust
   *  source. They match because the server is now asked.
   *
   *  Ids and the ladder only — what a privilege is CALLED is not served, and
   *  deliberately so (see `AccessCatalogueDto`): the strings belong to whoever
   *  draws the screen. `PRIVILEGE_LABELS` in `access.ts` is this portal's set. */
  accessCatalogue: (token: string) =>
    request<{ privileges: string[]; default_roles: import("./access").RoleDef[] }>(
      "/studio-organizations/v1/access-catalogue",
      token,
    ),

  /** The org's access model + role definitions. `null` = never set (defaults). */
  accessConfig: async (token: string, tenantId: string): Promise<import("./access").AccessConfig | null> => {
    try {
      const entry = await request<{ value: import("./access").AccessConfig }>(
        `/account-management/v1/tenants/${tenantId}/metadata/${ACCESS_TYPE}`,
        token,
      );
      return entry.value;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null; // not set yet
      throw e;
    }
  },

  putAccessConfig: (token: string, tenantId: string, value: import("./access").AccessConfig) =>
    request<unknown>(`/account-management/v1/tenants/${tenantId}/metadata/${ACCESS_TYPE}`, token, {
      method: "PUT",
      body: JSON.stringify(value),
    }),

  /* ── Presence (studio-presence gear) ──
   *
   * The heartbeat both reports and collects: one request, because a client
   * that has to be here anyway to say it is here should not need a second one
   * to find out it was written to. */

  presenceHeartbeat: (
    token: string,
    where: { display_name?: string; place?: string; detail?: string },
  ) =>
    request<{ me: PresenceEntry; messages: PresenceMessage[]; online: number }>(
      "/studio-presence/v1/me",
      token,
      { method: "POST", body: JSON.stringify(where) },
    ),

  /** A deliberate exit, so the list does not hold somebody for the whole
   *  timeout after they closed the tab. */
  presenceLeave: (token: string) =>
    request<void>("/studio-presence/v1/me", token, { method: "DELETE" }),

  presenceOnline: (token: string) =>
    request<{ items: PresenceEntry[]; total: number; online_ttl_ms: number; heartbeat_ms: number }>(
      "/studio-presence/v1/online",
      token,
    ),

  /** `delivered: false` means the recipient is not in Studio — nothing was
   *  queued, and the caller has to say so. */
  presenceSend: (
    token: string,
    message: { to_user_id: string; text: string; from_display_name?: string },
  ) =>
    request<{ delivered: boolean; waiting: number }>("/studio-presence/v1/messages", token, {
      method: "POST",
      body: JSON.stringify(message),
    }),

  /* ── Per-user preferences (studio-user gear) ──
   *
   * The one record of what a person chose about how Studio looks to them:
   * which lists read as a table and which as tiles, how many rows a page
   * shows, the theme and the language (`app.theme`, `app.language`). It used
   * to share the job with the platform's simple-user-settings gear, which
   * holds only those last two; one record means one writer and nothing to
   * reconcile. Bounded to 64 short entries so the map stays a preference
   * store. */

  uiPreferences: async (token: string): Promise<Record<string, string>> => {
    try {
      const r = await request<{ preferences?: Record<string, string> }>(
        "/studio-user/v1/me/ui-preferences",
        token,
      );
      return r.preferences ?? {};
    } catch (e) {
      // An older backend has no such route. Nothing remembered is a state the
      // caller already handles; a 404 here must not break the session.
      if (e instanceof ApiError && e.status === 404) return {};
      throw e;
    }
  },

  /** Replace the whole set. Whole rather than merged: an absent key has to be
   *  able to mean "forget this one". */
  saveUiPreferences: (token: string, preferences: Record<string, string>) =>
    request<{ preferences: Record<string, string> }>("/studio-user/v1/me/ui-preferences", token, {
      method: "PUT",
      body: JSON.stringify({ preferences }),
    }),

  /* ── Workspace AI chat (mini-chat gear) ── */

  createChat: (token: string, title: string) =>
    request<{ id: string }>("/mini-chat/v1/chats", token, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  chats: (token: string) => request<Page<Chat>>("/mini-chat/v1/chats", token),

  chatMessages: (token: string, chatId: string) =>
    request<Page<ChatMessage>>(`/mini-chat/v1/chats/${chatId}/messages`, token),

  deleteChat: (token: string, chatId: string) =>
    request<unknown>(`/mini-chat/v1/chats/${chatId}`, token, { method: "DELETE" }),

  models: (token: string) => request<Page<Model>>("/mini-chat/v1/models", token),

  /* ── AM dual-consent conversions ── */

  requestConversion: (token: string, tenantId: string, target: "managed" | "self_managed") =>
    request<Conversion>(`/account-management/v1/tenants/${tenantId}/conversions`, token, {
      method: "POST",
      body: JSON.stringify({ target_mode: target, comment: "Requested from the Studio portal" }),
    }),

  inboundConversions: (token: string, parentId: string) =>
    request<Page<Conversion>>(`/account-management/v1/tenants/${parentId}/child-conversions`, token),

  decideConversion: (
    token: string,
    parentId: string,
    requestId: string,
    status: "approved" | "rejected",
  ) =>
    request<Conversion>(
      `/account-management/v1/tenants/${parentId}/child-conversions/${requestId}`,
      token,
      { method: "PATCH", body: JSON.stringify({ status }) },
    ),

  /* ── System observability (orchestrator / oagw / types-registry / file-storage) ── */

  gears: (token: string) => request<unknown>("/gear-orchestrator/v1/gears", token),
  oagwUpstreams: (token: string) => request<unknown>("/oagw/v1/upstreams", token),
  gtsEntities: (token: string) => request<unknown>("/types-registry/v1/entities", token),

  /** The same registry, read for what a screen needs: the human name of a type.
   *
   *  ADR-0013 makes this the catalogue of MEANING — "titles and descriptions are
   *  read by consoles and by the generated frontend, so they are written for
   *  people". A screen that labels a type should therefore ask here rather than
   *  prettify an identifier, which is how `domain.skill` would end up displayed
   *  as "Skill" when the model calls it "Competency". */
  gtsTypeTitles: (token: string) =>
    request<GtsEntityPage>("/types-registry/v1/entities", token),

  /** The field schema each component type is rendered against.
   *
   *  Built-ins overlaid by whatever this tenant has stored, so what comes back
   *  is what the page should show — the client does not merge levels. */
  fieldSchemas: (token: string) =>
    request<{ schemas: FieldSchema[] }>(
      "/studio-components-catalog/v1/field-schemas",
      token,
    ),

  /** Replace this tenant's schema for one component type. */
  saveFieldSchema: (token: string, describes: string, schema: unknown) =>
    request<unknown>(
      `/studio-components-catalog/v1/field-schemas/${encodeURIComponent(describes)}`,
      token,
      { method: "PUT", body: JSON.stringify({ schema }) },
    ),

  /** Drop this tenant's schema for one component type, back to the built-in. */
  deleteFieldSchema: (token: string, describes: string) =>
    request<void>(
      `/studio-components-catalog/v1/field-schemas/${encodeURIComponent(describes)}`,
      token,
      { method: "DELETE" },
    ),

  /** Every node type the graph holds, and which of them this organization
   *  treats as components. The Objects page is a view of exactly this. */
  catalogTypes: (token: string) =>
    request<{ types: CatalogType[] }>("/studio-components-catalog/v1/types", token),

  /** How many nodes of each type the graph holds.
   *
   *  Its own read: a count is one projection per type, and the type list is
   *  hundreds of types. The Objects page draws its table first and fills these
   *  in, rather than waiting on arithmetic to show a row. */
  typeCounts: (token: string) =>
    request<{ counts: TypeCount[] }>("/studio-components-catalog/v1/types/counts", token),

  /** Mark a type as one of this organization's components, or unmark it. */
  setTypeComponent: (token: string, typeId: string, component: boolean) =>
    request<CatalogType>(
      `/studio-components-catalog/v1/types/${encodeURIComponent(typeId)}/component`,
      token,
      { method: "PUT", body: JSON.stringify({ component }) },
    ),

  // ── Domain model (studio-domain-model gear) ──
  /** Upload a domain-model document to make it the active ontology. */
  importDomainModel: (token: string, ontology: unknown) =>
    request<DomainModelImport>("/studio-domain-model/v1/model/import", token, {
      method: "POST",
      body: JSON.stringify({ ontology }),
    }),
  /** The stored ontology (frontend-regen source). */
  domainModelTypes: (token: string) =>
    request<{
      ontology: { entities: unknown[]; buckets?: unknown[] };
      /** Whether this caller may change the model (`domain.model`, ADR-0035). */
      can_edit_model: boolean;
    }>(
      "/studio-domain-model/v1/types",
      token,
    ),
  /** Materialize the model as a graph (object_type nodes + inherits/declares). */
  syncDomainModel: (token: string) =>
    request<DomainModelSync>("/studio-domain-model/v1/model/sync", token, { method: "POST" }),
  /** Read the model graph back out of Graph Storage. */
  domainModelGraph: (token: string) =>
    request<{ nodes: unknown[]; edges: unknown[] }>("/studio-domain-model/v1/model/graph", token),
  /** Experimental: one type's objects filtered, ordered, projected, with
   *  declared relations followed. Typed from the model (`domain-query.ts`), so
   *  a field or relation the model lacks is a compile error, not a 400. */
  queryDomain: <T extends DomainEntity>(token: string, query: DomainQuery<T>) =>
    request<DomainQueryResult<T>>("/studio-domain-model/v1/query", token, {
      method: "POST",
      body: JSON.stringify(query),
    }),
  /** Create or replace one domain object: the same `type` + `key` (+ project)
   *  is the same object, so saving again updates it. */
  saveDomainObject: (
    token: string,
    body: {
      type: string;
      key: string;
      project_id?: string;
      validate?: "off" | "warn" | "strict";
      value: Record<string, unknown>;
    },
  ) =>
    request<{
      type_id: string;
      instance_id: string;
      violations: { field: string; kind: string; detail: string }[];
      undeclared: string[];
    }>("/studio-domain-model/v1/objects", token, { method: "POST", body: JSON.stringify(body) }),
  /** Objects written with a free-form scope rather than a project: no project
   *  grant reaches them (ADR-0035). One bounded read; `complete` says whether
   *  it saw everything. */
  domainLegacyScopes: (token: string) =>
    request<{
      items: { instance_id: string; entity: string; name: string | null; scope: string }[];
      total: number;
      complete: boolean;
      scanned: number;
    }>("/studio-domain-model/v1/objects/legacy-scopes?limit=200", token),
  /** The instance graph: created objects and the relations between them. */
  domainObjectsGraph: (token: string) =>
    request<{ nodes: unknown[]; edges: unknown[] }>("/studio-domain-model/v1/objects/graph", token),
  files: (token: string) => request<Page<StoredFile>>("/api/file-storage/v1/files", token),
  storages: (token: string) => request<unknown>("/api/file-storage/v1/storages", token),

  /* ── studio-artifact-ingest gear: pull issues/PRs from a source into the graph ── */
  syncArtifacts: (
    token: string,
    body: {
      provider: string;
      secret_ref: string;
      repo_full_path: string;
      base_url?: string;
      since?: string;
      /** Parent workspace tenant — tagged onto every node so a workspace-level
       *  graph shows every project under it. */
      workspace_id?: string;
      /** Project tenant — tagged onto every node (project-level graph scope)
       *  and used to locate the IDE's checkout to read instead of cloning. */
      project_id?: string;
      repo_dir?: string;
    },
  ) =>
    request<{ run_id: string; status: string }>(
      "/studio-artifact-ingest/v1/sync",
      token,
      { method: "POST", headers: idempotent(), body: JSON.stringify(body) },
    ),

  /** Remove from the graph every repository synced into this scope that is
   *  not in `keep` — with its issues, PRs, files and their document bindings.
   *  `keep` is what the project has attached now. */
  pruneArtifacts: (
    token: string,
    body: {
      workspace_id?: string;
      project_id?: string;
      keep: { secret_ref: string; repo_full_path: string }[];
    },
  ) =>
    request<{ repos: number; nodes: number; bindings: number }>(
      "/studio-artifact-ingest/v1/reconcile",
      token,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** Poll a background sync. Terminal states are `succeeded` / `failed` /
   * `cancelled`. The task id is a studio-tasks run id, read through the one
   * route every background run has (`taskRun`); the counts are the run's
   * `result`, which the sync updates per phase. */
  artifactSyncTask: async (token: string, taskId: string) => {
    const run = await api.taskRun(token, taskId);
    const n = runCount(run);
    return {
      task_id: run.id,
      status: run.state as RunState,
      repo_full_path: String(run.payload?.repo_full_path ?? ""),
      message: runMessage(run),
      issues: n("issues"),
      pull_requests: n("pull_requests"),
      files: n("files"),
      /** Live per-phase counts + nodes already stored in the graph (mid-sync). */
      comments: n("comments"),
      commits: n("commits"),
      stored: n("stored"),
    };
  },

  /** Text files (path + content) from a repository's IDE checkout, for running
   * analysis over the actual repo. Empty until the IDE has cloned it. */
  repoFiles: (token: string, workspaceId: string, repoDir: string) =>
    request<{ files: { path: string; text: string }[] }>(
      `/studio-artifact-ingest/v1/repo-files?workspace_id=${encodeURIComponent(
        workspaceId,
      )}&repo_dir=${encodeURIComponent(repoDir)}`,
      token,
    ),

  /** Read back the ingested artifact nodes, optionally filtered by type leaf
   * and scoped to a tenant (`scope` matches a node's workspace_id OR
   * project_id).
   *
   * The leaf is matched EXACTLY, not by substring, against every artifact type
   * the gear knows (artifact_ingest/gts.rs `ALL_NODE_TYPES`): `repo`, `issue`,
   * `pull_request`, `file`, `user`, `spec_finding`, `comment`, `commit`. An
   * unknown value lists nothing rather than everything, so a typo is silent.
   *
   * Omitting the type lists only the four FIRST-CLASS types (repo, file, issue,
   * pull_request) — which is what this comment used to say was the whole set.
   * It is not: comments, commits and authors are ingested and listable, they
   * are simply not in the default projection. */
  listArtifactNodes: (
    token: string,
    type?: string,
    scope?: string,
    cursor?: string,
    limit?: number,
    opts?: { repo?: string; sort?: "updated"; offset?: number; q?: string },
  ) => {
    const qs = new URLSearchParams();
    if (type) qs.set("type", type);
    if (scope) qs.set("scope", scope);
    if (opts?.repo) qs.set("repo", opts.repo);
    if (opts?.sort) qs.set("sort", opts.sort);
    if (opts?.q) qs.set("q", opts.q);
    if (opts?.offset != null) qs.set("offset", String(opts.offset));
    else if (cursor) qs.set("cursor", cursor);
    if (limit) qs.set("limit", String(limit));
    const suffix = qs.toString();
    return request<ArtifactNodePage>(
      `/studio-artifact-ingest/v1/nodes${suffix ? `?${suffix}` : ""}`,
      token,
    );
  },

  /** Relations between ingested nodes (authored_by / modifies / …), optionally
   * scoped to a tenant (both endpoints must be in-scope). */
  artifactEdges: async (token: string, scope?: string) => ({
    // All pages: the caller draws a graph, and one page of relations would
    // render a fraction of the edges between nodes it is already showing.
    edges: await requestAllPages<ArtifactEdge>(
      `/studio-artifact-ingest/v1/edges${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`,
      token,
      "edges",
    ),
  }),


  /** Every detector verdict recorded for a scope, newest page first.
   *
   *  Findings are ordinary artifact nodes, so this is `listArtifactNodes` with
   *  the finding type — paged here because a project that has been analysed a
   *  few times has more findings than documents. */
  listSpecFindings: async (token: string, scope: string): Promise<SpecFinding[]> => {
    const out: SpecFinding[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.listArtifactNodes(token, "spec_finding", scope, cursor, 200);
      for (const n of page.nodes ?? []) {
        const v = n.value as Record<string, unknown>;
        if (typeof v.detector === "string" && typeof v.subject === "string") {
          out.push({
            detector: v.detector,
            subject: v.subject,
            path: typeof v.path === "string" ? v.path : null,
            severity: typeof v.severity === "string" ? v.severity : null,
            summary: typeof v.summary === "string" ? v.summary : null,
            score: typeof v.score === "number" ? v.score : null,
            details: v.details,
          });
        }
      }
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  },

  /** Register an already-uploaded manual/generated file in the artifact graph.
   * The graph stores metadata and the file-storage reference, never bytes. */
  addProjectArtifact: (
    token: string,
    body: {
      organization_id: string;
      workspace_id: string;
      project_id: string;
      origin: ProjectArtifactOrigin;
      path: string;
      size: number;
      object_ref: ProjectArtifactObjectRef;
    },
  ) =>
    request<{ instance_id: string }>("/studio-artifact-ingest/v1/files", token, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Persist spec-quality detector results into the artifact graph: per-document
   *  finding nodes plus derived document↔document relations (duplicates /
   *  traces_to). Endpoints are node instance ids. Idempotent. */
  saveQualityFindings: (
    token: string,
    body: {
      findings?: {
        detector: string;
        subject: string;
        path?: string;
        severity?: string;
        summary?: string;
        score?: number;
        details?: unknown;
      }[];
      duplicates?: { from: string; to: string }[];
      traces?: { from: string; to: string }[];
      /** Tenants to tag finding nodes with, so they survive the graph's scope
       *  filter (workspace = parent, project = this project). */
      workspace_id?: string;
      project_id?: string;
    },
  ) =>
    request<{ nodes: number; edges: number }>("/studio-artifact-ingest/v1/quality", token, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /* ── studio-components-catalog gear: crates.io → graph (our published gears) ── */
  /** Enqueue a background sync of the crates.io keyword into the graph. */
  syncComponents: (
    token: string,
    body?: {
      crates_io: string | null;
      repositories: {
        tenant: string;
        connection_id: string | null;
        repo: string;
        git_ref: string | null;
        mode: string;
      }[];
    },
  ) =>
    request<{ run_id: string; status: string }>("/studio-components-catalog/v1/sync", token, {
      method: "POST",
      headers: idempotent(),
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  /** Poll a background catalog sync. The task id is a studio-tasks run id,
   * read through `taskRun`; the counts are the run's `result`. */
  componentsCatalogTask: async (token: string, taskId: string) => {
    const run = await api.taskRun(token, taskId);
    const n = runCount(run);
    return {
      task_id: run.id,
      status: run.state as RunState,
      message: runMessage(run),
      gears: n("gears"),
      versions: n("versions"),
      stored: n("stored"),
    };
  },
  /** Match what a product needs against the components this system knows.
   *
   *  The rules — head-anchored term matching, built-first ordering, one
   *  component per candidate, the cut to a shortlist after the sort — live in
   *  `components_catalog/compose.rs`. They used to live in this portal, and a
   *  second portal would have grown its own copy and disagreed quietly.
   *
   *  A POST because the vocabulary travels with the question: a workspace's
   *  terms are a map, and a map does not belong in a query string. */
  /** Compare what the project's specs declare with what its code depends on:
   *  per capability, the components in the code that fill it; the components
   *  the specs do not account for; and what the Gearbox engine says about the
   *  code's own set of gears. */
  conformance: (token: string, projectId: string, capabilities: string[], vocabulary: readonly Capability[]) => {
    const terms: Record<string, string[]> = {};
    for (const cap of vocabulary) if (cap.terms?.length) terms[cap.key] = cap.terms;
    const contracts = contractsOf(vocabulary);
    return request<Conformance>("/studio-components-catalog/v1/conformance", token, {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, capabilities, terms, contracts }),
    });
  },
  composePlan: (token: string, capabilities: string[], vocabulary: readonly Capability[]) => {
    // A capability with no terms is matched against its own name, which is what
    // it meant before vocabularies existed — so it is left out of the map
    // rather than sent as an empty list.
    const terms: Record<string, string[]> = {};
    for (const cap of vocabulary) if (cap.terms?.length) terms[cap.key] = cap.terms;
    const contracts = contractsOf(vocabulary);
    return request<{ items: PlanRow[]; total: number }>(
      "/studio-components-catalog/v1/compose",
      token,
      { method: "POST", body: JSON.stringify({ capabilities, terms, contracts }) },
    );
  },
  /** What moved in each catalogued gear, over a window of days.
   *
   *  The catalogue is read by the server, and so are the rules that turn it
   *  into a question Insight can answer — grouping by repository, naming each
   *  crate's directory, resolving the collisions, joining the two answers back
   *  together. All of that used to live in `gear-activity.tsx`, which is why
   *  this screen used to pull the whole catalogue into the browser first. */
  gearActivity: (token: string, days: number, compare = false) =>
    request<{
      items: GearActivity[];
      total: number;
      /** Where the numbers came from, and what was left out getting them. */
      sources: {
        from: string | null;
        to: string | null;
        truncated: boolean;
        repositories: string[];
      };
    }>(`/studio-components-catalog/v1/activity?days=${days}${compare ? "&compare=previous" : ""}`, token),

  /** What each component's fields say, with its three sources reconciled.
   *
   *  The precedence — crates.io < repository scan < what a person set, with
   *  the old flat keys filling only what is still unanswered — lives in
   *  `components_catalog/values.rs`. It used to run in this portal, per row,
   *  on every render. */
  componentValues: (token: string) =>
    request<{ items: ComponentValues[]; total: number; truncated: boolean }>(
      "/studio-components-catalog/v1/component-values",
      token,
    ),

  /** What the fields said before: without `component`, each component's
   *  earliest snapshot in the last `days` days (the "before" a better/worse
   *  mark compares with); with it, that component's every snapshot, oldest
   *  first (`components_catalog/history.rs`). */
  componentHistory: (token: string, days: number, component?: string) =>
    request<{ items: ComponentSnapshot[]; total: number }>(
      `/studio-components-catalog/v1/component-history?days=${days}${
        component ? `&component=${encodeURIComponent(component)}` : ""
      }`,
      token,
    ),

  /** Read back the ingested gear crates. */
  listComponents: (token: string) =>
    request<{ nodes: CatalogNode[]; truncated?: boolean }>(
      "/studio-components-catalog/v1/components",
      token,
    ),
  /** Read Studio-managed delivery metadata for catalogued Gears. */
  listComponentProfiles: (token: string) =>
    request<{ nodes: CatalogNode[] }>("/studio-components-catalog/v1/profiles", token),
  /** Replace Studio-managed delivery metadata for one Gear. */
  saveComponentProfile: (token: string, name: string, profile: Record<string, unknown>) =>
    request<CatalogNode>(`/studio-components-catalog/v1/components/${encodeURIComponent(name)}/profile`, token, {
      method: "POST",
      body: JSON.stringify({ profile }),
    }),
  /** Read back crate versions, optionally filtered to one crate. */
  listComponentVersions: (token: string, crate?: string) =>
    request<{ nodes: CatalogNode[] }>(
      `/studio-components-catalog/v1/versions${crate ? `?crate=${encodeURIComponent(crate)}` : ""}`,
      token,
    ),

  /** Pull requests for one repository, sliced by component (studio-insight). */
  insightComponentPullRequests: (token: string, body: ComponentPullRequestsQuery) =>
    request<ComponentPullRequests>("/studio-insight/v1/components/pull-requests", token, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Delivery metrics for one repository, sliced by component (studio-insight). */
  insightComponentMetrics: (token: string, body: ComponentMetricsQuery) =>
    request<ComponentMetrics>("/studio-insight/v1/components/metrics", token, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** The gear repository connected to a project (0 or 1 node). */
  getProjectGearRepo: (token: string, projectId: string) =>
    request<{ nodes: { value: ProjectGearRepo }[] }>(
      `/studio-components-catalog/v1/projects/${encodeURIComponent(projectId)}/gear-repo`,
      token,
    ),
  /** Connect (or update) the gear repository for a project. */
  setProjectGearRepo: (
    token: string,
    projectId: string,
    body: { tenant: string; connection_id?: string | null; repo: string; branch?: string },
  ) =>
    request<CatalogNode>(
      `/studio-components-catalog/v1/projects/${encodeURIComponent(projectId)}/gear-repo`,
      token,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Write a scaffolded gear skeleton into the project's connected gear repo
   *  (branch off the connected base branch, one commit, optional PR). */
  /** Scaffold a starter gear into the project's connected gear repo.
   *
   *  The skeleton is generated SERVER-side (`components_catalog/skeleton.rs`).
   *  This used to send the files, which made the browser the only thing that
   *  knew what a gear looks like — so the same request could not be made
   *  without one, and any other caller had to reinvent the layout. `files` is
   *  still accepted for a caller that has already decided what to write.
   *
   *  `dry_run` returns what WOULD be written and touches nothing, which is how
   *  a preview stays honest without a second generator to keep in step. */
  scaffoldGearToRepo: (
    token: string,
    projectId: string,
    body: {
      slug: string;
      app_title?: string;
      problem?: string;
      origin?: string;
      parent_dir?: string;
      /** `service` (the default), `minimal`, or `plugin`. The gear's
       *  `gear.gdl` is the Gearbox engine's own scaffold of that kind. */
      gear_kind?: GearKind;
      /** For a plugin: the host crate whose extension point it fills. */
      plugin_host?: string;
      /** Which of the host's points, by GTS spec id. */
      plugin_spec?: string;
      files?: ScaffoldFile[];
      dry_run?: boolean;
      open_pr?: boolean;
    },
  ) =>
    request<{
      branch: string;
      commit_sha: string;
      pr_url?: string | null;
      files: ScaffoldFile[];
    }>(
      `/studio-components-catalog/v1/projects/${encodeURIComponent(projectId)}/scaffold`,
      token,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** The hosts a new plugin gear can fill, from the Gearbox engine. Hosts that
   *  can run in a product come first. */
  gearboxExtensionPoints: (token: string) =>
    request<{ items: GearboxExtensionPoint[]; total: number }>(
      `/studio-components-catalog/v1/gearbox/extension-points`,
      token,
    ),
  /** The product the project is composing, or null before anything is picked. */
  projectProduct: async (token: string, projectId: string): Promise<ProjectProduct | null> => {
    const r = await request<{ nodes: { value: ProjectProduct }[] }>(
      `/studio-components-catalog/v1/projects/${encodeURIComponent(projectId)}/product`,
      token,
    );
    return r.nodes?.[0]?.value ?? null;
  },
  /** Merge fields into the project's product; omitted fields keep their value. */
  saveProjectProduct: (
    token: string,
    projectId: string,
    body: { product_id?: string; name?: string; gears?: string[]; profile?: string; config?: GearConfig },
  ) =>
    request<{ value: ProjectProduct }>(
      `/studio-components-catalog/v1/projects/${encodeURIComponent(projectId)}/product`,
      token,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  /** Complete picks into a set the engine can resolve: what the catalogue
   *  proves cannot run is taken out, a missing plugin or REST host is put in,
   *  each with its reason. Writes nothing. */
  completeProduct: (token: string, gears: string[], config?: GearConfig) =>
    request<{ gears: string[]; changes: ProductChange[]; config: GearConfig }>(
      `/studio-components-catalog/v1/gearbox/complete`,
      token,
      { method: "POST", body: JSON.stringify({ gears, config: config ?? {} }) },
    ),
  /** Whether product previews can run, and against which gear corpus. */
  gearboxStatus: (token: string) =>
    request<GearboxStatus>(`/studio-components-catalog/v1/gearbox`, token),
  /** Compose a product.gdl from picked gears and resolve it with the Gearbox
   *  engine. `write` also commits it to the project's gear repo — onto the
   *  base branch, or onto a new branch with a pull request when `open_pr`. */
  previewProduct: (
    token: string,
    projectId: string,
    body: {
      product_id: string;
      name?: string;
      gears: string[];
      profile?: string;
      write?: boolean;
      open_pr?: boolean;
      /** Commit onto the base branch; only for a repository the product owns. */
      /** The product's configuration of its gears (see GearConfig). */
      config?: GearConfig;
      onto_base?: boolean;
    },
  ) =>
    request<ProductPreview>(
      `/studio-components-catalog/v1/projects/${encodeURIComponent(projectId)}/product/preview`,
      token,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Create a new repository via the connector and set it as the project's gear repo. */
  createProjectRepo: (
    token: string,
    projectId: string,
    body: {
      tenant: string;
      connection_id?: string | null;
      owner?: string;
      is_org?: boolean;
      name: string;
      private?: boolean;
    },
  ) =>
    request<{ full_name: string; html_url: string; default_branch: string }>(
      `/studio-components-catalog/v1/projects/${encodeURIComponent(projectId)}/create-repo`,
      token,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /* ── studio-session gear: per-workspace Theia IDE containers ── */
  createStudioSession: (
    token: string,
    workspaceId: string,
    repos: RepoEntry[],
    root?: { path?: string; repoUrl?: string; branch?: string; tokenRef?: string },
  ) =>
    request<StudioSession>("/studio-session/v1/sessions", token, {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        root_path: root?.path || undefined,
        root_repo_url: root?.repoUrl || undefined,
        root_branch: root?.branch || undefined,
        root_token_ref: root?.tokenRef || undefined,
        repos: repos.map((r) => ({
          name: r.name,
          kind: r.source === "local" ? "local" : "git",
          url: r.url || undefined,
          path: r.path || undefined,
          target: r.target || undefined,
          branch: r.branch || undefined,
          token_ref: r.token_ref || undefined,
        })),
      }),
    }).then(withAlignedHost),

  /**
   * credstore: create a secret (used for repo access tokens).
   *
   * `sharing` defaults to "tenant" — a repository credential belongs to the
   * workspace, so any member launching a session can use it. Pass "private"
   * for a per-user secret (e.g. a personal AI key): the credstore keeps it to
   * its owner and returns it ahead of any tenant secret with the same ref. The
   * `personal_token` secret type requires "private" — it rejects tenant sharing.
   */
  putSecret: async (
    token: string,
    reference: string,
    value: string,
    secretType?: string,
    sharing: "tenant" | "private" | "shared" = "tenant",
  ) => {
    const payload = {
      value,
      sharing,
      ...(secretType ? { type: secretType } : {}),
    };
    try {
      return await request<unknown>("/credstore/v1/secrets", token, {
        method: "POST",
        body: JSON.stringify({ reference, ...payload }),
      });
    } catch (e) {
      // 409: the reference exists (possibly from an earlier failed attempt,
      // whose GET fails closed). Rotate it instead — `If-Match: *` is the
      // gear's explicit unconditional overwrite.
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
      return await request<unknown>(`/credstore/v1/secrets/${encodeURIComponent(reference)}`, token, {
        method: "PUT",
        headers: { "If-Match": "*" },
        body: JSON.stringify(payload),
      });
    }
  },
  /**
   * Secret health probe: credstore has NO list endpoint, so surfaces build
   * from refs known to workspace settings and check each with a GET.
   * "ok" = readable; "broken" = exists but fails closed (fence-poisoned) or
   * missing — either way a rotate (putSecret) heals it.
   */
  checkSecret: async (token: string, reference: string): Promise<"ok" | "broken"> => {
    try {
      await request<unknown>(`/credstore/v1/secrets/${encodeURIComponent(reference)}`, token);
      return "ok";
    } catch {
      return "broken";
    }
  },

  deleteSecret: (token: string, reference: string) =>
    request<unknown>(`/credstore/v1/secrets/${encodeURIComponent(reference)}`, token, {
      method: "DELETE",
    }),

  studioSession: (token: string, id: string) =>
    request<StudioSession>(`/studio-session/v1/sessions/${id}`, token).then(withAlignedHost),
  studioSessions: (token: string) =>
    request<{ items: StudioSession[] }>("/studio-session/v1/sessions", token).then((p) => ({
      items: p.items.map(withAlignedHost),
    })),
  deleteStudioSession: (token: string, id: string) =>
    request<void>(`/studio-session/v1/sessions/${id}`, token, { method: "DELETE" }),
  /** The desktops this project is open on right now (ADR-0027 §4). */
  desktopSessions: (token: string, projectId: string) =>
    requestAllPages<DesktopSession>(
      `/studio-session/v1/desktop-sessions?project_id=${encodeURIComponent(projectId)}`,
      token,
      "items",
    ),

  /**
   * POST /mini-chat/v1/chats/{id}/messages:stream — SSE.
   * Calls onDelta with accumulated text; resolves when the stream ends.
   */
  streamMessage: async (
    token: string,
    chatId: string,
    content: string,
    onDelta: (full: string) => void,
  ): Promise<void> => {
    const res = await fetch(apiUrl(`/mini-chat/v1/chats/${chatId}/messages:stream`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ content }),
    });
    if (!res.ok || !res.body) {
      throw new ApiError(res.status, await res.json().catch(() => undefined));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Parse SSE frames: "event: X\ndata: {...}\n\n"
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
        const data = /^data:\s*(.+)$/m.exec(frame)?.[1];
        if (event === "delta" && data) {
          try {
            const d = JSON.parse(data) as { text?: string; content?: string; delta?: string };
            text += d.text ?? d.content ?? d.delta ?? "";
            onDelta(text);
          } catch {
            /* ignore malformed frame */
          }
        } else if (event === "error" && data) {
          throw new ApiError(502, JSON.parse(data));
        }
      }
    }
  },
  /* ── studio-tasks gear: durable background runs ── */

  /** Newest first. `state` and `taskType` narrow it server-side. */
  taskRuns: (
    token: string,
    opts?: { state?: string; taskType?: string; limit?: number; offset?: number },
  ) => {
    const q = new URLSearchParams();
    if (opts?.state) q.set("state", opts.state);
    if (opts?.taskType) q.set("task_type", opts.taskType);
    if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts?.offset) q.set("offset", String(opts.offset));
    const suffix = q.toString();
    return request<{ items: TaskRun[]; total?: number }>(
      `/studio-tasks/v1/runs${suffix ? `?${suffix}` : ""}`,
      token,
    );
  },

  /** One run. `tenant` names where it was queued when that is not the
   *  caller's home tenant (a report's runs live in its organization). */
  taskRun: (token: string, runId: string, tenant?: string) =>
    request<TaskRun>(
      `/studio-tasks/v1/runs/${encodeURIComponent(runId)}${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""}`,
      token,
    ),

  /** What kinds of work this deployment can run at all. */
  taskTypes: (token: string) =>
    request<{ items: string[] }>("/studio-tasks/v1/task-types", token),

  /** Cooperative: the flag is set, and a handler that never checks it will
      not stop. Answers 202 for exactly that reason. */
  cancelTaskRun: (token: string, runId: string) =>
    request<TaskRun>(`/studio-tasks/v1/runs/${encodeURIComponent(runId)}/cancel`, token, {
      method: "POST",
    }),

  retryTaskRun: (token: string, runId: string) =>
    request<TaskRun>(`/studio-tasks/v1/runs/${encodeURIComponent(runId)}/retry`, token, {
      method: "POST",
    }),

  /* ── studio-scheduler gear: cron/interval schedules ── */

  schedules: (token: string) =>
    request<{ items: TaskSchedule[] }>("/studio-scheduler/v1/schedules", token),

  runScheduleNow: (token: string, scheduleId: string) =>
    request<{ run_id: string }>(
      `/studio-scheduler/v1/schedules/${encodeURIComponent(scheduleId)}/run-now`,
      token,
      { method: "POST", headers: idempotent() },
    ),

  /* ── studio-reports gear: report definitions, sources and drawing ── */

  /* Every reports call names the organization on screen (`org`): a caller's
   * home tenant need not be it -- a platform administrator's is the platform
   * root, where the organization's connection does not exist. Absent, the
   * server takes the home tenant. */

  /** Every report this deployment draws, with this organization's source. */
  reports: (token: string, org?: string) =>
    request<{ items: Report[]; total: number }>(`/studio-reports/v1/reports${orgQuery(org)}`, token),

  /** A report's data as typed JSON (for `roadmap`: one row per planned gear). */
  reportSummary: (token: string, report: string, org?: string) =>
    request<RoadmapReport>(`/studio-reports/v1/reports/${encodeURIComponent(report)}/summary${orgQuery(org)}`, token),

  /** The report as of `date` (`YYYY-MM-DD`), as the `.xlsx` the server draws. */
  exportReport: (token: string, report: string, date: string, org?: string) =>
    requestBlob(
      `/studio-reports/v1/reports/${encodeURIComponent(report)}/workbook?date=${encodeURIComponent(date)}${orgQuery(org, "&")}`,
      token,
    ),

  updateReportSource: (token: string, report: string, body: ReportSourceInput, org?: string) =>
    request<ReportSource>(`/studio-reports/v1/reports/${encodeURIComponent(report)}/source${orgQuery(org)}`, token, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  /** Whether the report refreshes on its own. */
  reportSchedule: (token: string, report: string, org?: string) =>
    request<ReportSchedule>(`/studio-reports/v1/reports/${encodeURIComponent(report)}/schedule${orgQuery(org)}`, token),

  /** Switch the report's own (hourly) refresh on or off. The server writes the
   *  organization into the schedule's payload; the client never does. */
  updateReportSchedule: (token: string, report: string, enabled: boolean, org?: string) =>
    request<ReportSchedule>(`/studio-reports/v1/reports/${encodeURIComponent(report)}/schedule${orgQuery(org)}`, token, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

  /** Read the plan again and sync the board: a `reports.refresh` run. */
  syncReport: (token: string, report: string, org?: string) =>
    request<{ run_id: string; status: string }>(
      `/studio-reports/v1/reports/${encodeURIComponent(report)}/sync${orgQuery(org)}`,
      token,
      { method: "POST", headers: idempotent() },
    ),
};
