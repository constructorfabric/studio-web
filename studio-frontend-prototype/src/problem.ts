/* The error contract, as the portal reads it.
 *
 * Every failing response from this backend is RFC 9457 `application/problem+json`
 * produced by `toolkit-canonical-errors` — one of sixteen categories, never a
 * body a gear invented. `docs/errors-catalog.md` is the normative description;
 * this file is the half a screen calls.
 *
 * The reason it exists: the HTTP status does not identify the failure. `400` is
 * `invalid_argument` or `failed_precondition` or `out_of_range`, `409` is
 * `already_exists` or `aborted`, and `500` is `internal` or `unknown` or
 * `data_loss`. A screen that branches on `status` cannot tell "your input is
 * malformed" from "the resource is in the wrong state", which are two different
 * things to tell a person. `type` is what identifies it, and `category` below is
 * that field parsed.
 */

/** The sixteen canonical categories. Fixed upstream; a gear picks, never invents. */
export type ProblemCategory =
  | "cancelled"
  | "unknown"
  | "invalid_argument"
  | "deadline_exceeded"
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "resource_exhausted"
  | "failed_precondition"
  | "aborted"
  | "out_of_range"
  | "unimplemented"
  | "internal"
  | "service_unavailable"
  | "data_loss"
  | "unauthenticated";

const CATEGORIES = new Set<string>([
  "cancelled",
  "unknown",
  "invalid_argument",
  "deadline_exceeded",
  "not_found",
  "already_exists",
  "permission_denied",
  "resource_exhausted",
  "failed_precondition",
  "aborted",
  "out_of_range",
  "unimplemented",
  "internal",
  "service_unavailable",
  "data_loss",
  "unauthenticated",
]);

/** Nothing the person did causes these, and nothing they do will fix them. */
const DEFECTS: ReadonlySet<string> = new Set([
  "internal",
  "unknown",
  "data_loss",
  "service_unavailable",
  "deadline_exceeded",
]);

/** One malformed member of the request. */
export interface FieldViolation {
  /** Path to the offending member. */
  field?: string;
  description?: string;
  /** Stable machine-readable token. Branch on this, never on `description`. */
  reason?: string;
}

/** One unmet precondition — the state that was wrong, not the input. */
export interface PreconditionViolation {
  type_?: string;
  subject?: string;
  description?: string;
}

/** One exceeded quota. */
export interface QuotaViolation {
  subject?: string;
  description?: string;
  retry_after_seconds?: number;
}

/**
 * The `context` member, as the union of every category's shape.
 *
 * Everything optional because which fields are present is decided by the
 * category: `not_found` carries `{}`, `invalid_argument` carries exactly one of
 * three shapes. `docs/errors-catalog.md` has the table.
 */
export interface ProblemContext {
  /** `invalid_argument`, `out_of_range`. */
  field_violations?: FieldViolation[];
  /** `invalid_argument`. */
  format?: string;
  /** `invalid_argument`. */
  constraint?: string;
  /** `failed_precondition`. */
  violations?: (PreconditionViolation & QuotaViolation)[];
  /** `permission_denied`, `aborted`, `unauthenticated`. */
  reason?: string;
  /** `internal`, `unknown`. */
  description?: string;
  /** `service_unavailable`. */
  retry_after_seconds?: number;
}

/** A parsed problem+json body. */
export interface Problem {
  /** The GTS URI. The stable identity of the failure. */
  type?: string;
  /** `type` reduced to its category, when it is one we know. */
  category?: ProblemCategory;
  /** The category's fixed English name. Not a sentence — do not show it alone. */
  title?: string;
  status?: number;
  /** The backend's own sentence about this occurrence. The thing to show. */
  detail?: string;
  instance?: string;
  /** Matches the `x-request-id` header. The handle for support. */
  trace_id?: string;
  context: ProblemContext;
}

/**
 * The category named by a `type` URI, or `undefined` if it names none.
 *
 * The URI is `gts://gts.cf.core.errors.err.v1~cf.core.err.<name>.v1~`; only the
 * `<name>` is load-bearing, and it is matched against the closed set rather than
 * returned raw, so an unexpected one reads as "no category" instead of leaking a
 * string a caller might branch on.
 */
export function categoryOf(type: string | undefined): ProblemCategory | undefined {
  const named = /cf\.core\.err\.([a-z_]+)\.v\d+/.exec(type ?? "");
  const name = named?.[1];
  return name && CATEGORIES.has(name) ? (name as ProblemCategory) : undefined;
}

/**
 * Read a response body as a problem, or `undefined` if it is not one.
 *
 * Deliberately tolerant: a proxy, a gateway timeout or a crash can answer with
 * HTML, an empty body, or a shape nobody designed, and none of those should
 * throw on the way to an error message.
 */
export function parseProblem(body: unknown): Problem | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = body as Record<string, unknown>;

  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const type = str(raw.type);
  const title = str(raw.title);
  const detail = str(raw.detail);

  // A body with none of these is somebody else's JSON, not a problem.
  if (type === undefined && title === undefined && detail === undefined) return undefined;

  const context =
    raw.context && typeof raw.context === "object" ? (raw.context as ProblemContext) : {};

  return {
    type,
    category: categoryOf(type),
    title,
    status: typeof raw.status === "number" ? raw.status : undefined,
    detail,
    instance: str(raw.instance),
    trace_id: str(raw.trace_id),
    context,
  };
}

/** The problem carried by an error, if it carries one. */
export function problemOf(e: unknown): Problem | undefined {
  const carrier = e as { problem?: Problem; body?: unknown } | null;
  return carrier?.problem ?? parseProblem(carrier?.body);
}

/**
 * Does this error name one of these categories?
 *
 * The readable way to ask, and the correct one: `status === 400` cannot tell an
 * `invalid_argument` from a `failed_precondition`.
 */
export function isProblem(e: unknown, ...categories: ProblemCategory[]): boolean {
  const category = problemOf(e)?.category;
  return category !== undefined && categories.includes(category);
}

/** The support handle, when the backend sent one. */
export function traceId(e: unknown): string | undefined {
  return problemOf(e)?.trace_id;
}

/**
 * Everything this problem says that is worth reading, in reading order.
 *
 * `detail` is the sentence for most categories, but several put the part worth
 * reading somewhere else and leave `detail` generic:
 *
 * - `failed_precondition` says "Operation precondition not met" and the reason
 *   is in `context.violations[].description`;
 * - `invalid_argument` carries one of three shapes — per-field violations, a
 *   format, or a constraint — and repeats the constraint in `detail`;
 * - `permission_denied` and `aborted` put theirs in `context.reason`;
 * - `internal` and `unknown` in `context.description`;
 * - `resource_exhausted` in `context.violations[].description`.
 *
 * Anything already said by `detail` is dropped rather than repeated, because a
 * category that stutters reads as a bug in the portal.
 */
function saidBeyondDetail(problem: Problem, detail: string | undefined): string[] {
  const { context } = problem;
  const said: string[] = [];

  for (const violation of context.violations ?? []) {
    if (violation.description) said.push(violation.description.trim());
  }
  for (const violation of context.field_violations ?? []) {
    // The field is worth naming: "name: must not be empty" beats "must not be
    // empty" on a form with nine inputs.
    const text = [violation.field, violation.description].filter(Boolean).join(": ").trim();
    if (text) said.push(text);
  }
  for (const value of [context.constraint, context.format, context.reason, context.description]) {
    if (value?.trim()) said.push(value.trim());
  }

  return said.filter((s) => s.length > 0 && s !== detail);
}

/**
 * A problem as one line of text for a person.
 *
 * Shows the backend's sentence, then whatever `context` adds that the sentence
 * did not already say. The trace id is appended only for the categories nothing
 * the reader does will fix — on those the id is the whole of what makes a report
 * actionable, and on the others it is noise in front of an answer.
 */
export function errText(e: unknown): string {
  const problem = problemOf(e);
  if (!problem) {
    const status = (e as { status?: number } | null)?.status;
    return status ? `HTTP ${status}` : String(e);
  }

  const detail = problem.detail?.trim();
  const said = saidBeyondDetail(problem, detail);
  const parts = [detail, ...said].filter((p): p is string => Boolean(p));

  const status = problem.status ?? (e as { status?: number } | null)?.status;
  const head = `HTTP ${status ?? "?"}${problem.title ? ` · ${problem.title}` : ""}`;
  const body = parts.length > 0 ? ` — ${parts.join(" — ")}` : "";
  const trace =
    problem.trace_id && problem.category && DEFECTS.has(problem.category)
      ? ` (trace ${problem.trace_id})`
      : "";

  return `${head}${body}${trace}`;
}
