// Review requests on a project's documents and the verdicts given on them
// (studio-documents `/review-requests`, docs/design/studio-documents.md).
//
// A request names one version of one document, whom it asks, who of them is
// required, and when it is due. A verdict is a record and is never edited;
// the latest one per reviewer counts. What is here is the wording and the
// small decisions a screen makes about them, so they can be tested.
//
// A reviewer may speak for a stakeholder (an organization: Acronis,
// Constructor, Virtuozzo); one approval answers for it. A request may name
// the stakeholders that must approve, and keeps the rules it is judged by as
// they were when it was asked for.

export interface ReviewerInput {
  person: string;
  name?: string | null;
  required: boolean;
  /** The stakeholder they speak for. */
  stakeholder?: string | null;
}

export interface Reviewer {
  person: string;
  name?: string | null;
  required: boolean;
  verdict?: "approved" | "changes_requested" | null;
  /** That verdict asks for changes over a security concern. */
  security?: boolean;
  stakeholder?: string | null;
}

/** Where one stakeholder stands on a request. */
export interface Stakeholder {
  name: string;
  /** The request names it as one that must approve. */
  required: boolean;
  approved: boolean;
  approved_by: string[];
  /** Everyone asked on its behalf; empty when nobody was asked yet. */
  asked: string[];
}

export interface ReviewVerdict {
  id: string;
  request_id: string;
  version: string;
  approver: string;
  approver_name?: string | null;
  verdict: "approved" | "changes_requested";
  security?: boolean;
  note?: string | null;
  checks: string[];
  decided_at: string;
}

export interface ReviewRequest {
  id: string;
  project_id: string;
  subject_kind: "document" | "binding";
  subject_id: string;
  type_key?: string | null;
  title: string;
  version: string;
  requested_by: string;
  requested_by_name?: string | null;
  reviewers: Reviewer[];
  due_at?: string | null;
  state: "open" | "approved" | "superseded" | "withdrawn";
  overdue: boolean;
  outstanding: string[];
  /** The maturity the version asked about declares (gears-rust #5275). */
  maturity?: string | null;
  /** Below `stable`: the review is advice, and only a security concern
   *  holds the stage. */
  advisory?: boolean;
  created_at: string;
  verdicts: ReviewVerdict[];
  /** Absent from a server older than stakeholders. */
  stakeholders?: Stakeholder[];
  /** The type's template and review guide changed since the review was
   *  asked for; it is still judged by the ones it started with. */
  rules_changed?: boolean;
}

/** The document a review is about. */
export interface ReviewSubject {
  kind: "document" | "binding";
  id: string;
  title: string;
  typeKey?: string | null;
  /** What is being reviewed: a binding's content sha, a document's revision. */
  version: string;
}

/** The body of `POST /review-requests`. A due date is a day; it is due at its
 *  end, in UTC. */
export function reviewRequestBody(
  projectId: string,
  subject: ReviewSubject,
  reviewers: ReviewerInput[],
  dueDay: string | null,
  stakeholders: string[] = [],
) {
  return {
    project_id: projectId,
    subject_kind: subject.kind,
    subject_id: subject.id,
    type_key: subject.typeKey ?? null,
    title: subject.title,
    version: subject.version,
    reviewers: reviewers.map((r) => ({
      person: r.person,
      name: r.name ?? null,
      required: r.required,
      stakeholder: r.stakeholder?.trim() || null,
    })),
    due_at: dueDay ? `${dueDay}T23:59:59Z` : null,
    stakeholders: parseStakeholders(stakeholders.join(",")),
  };
}

/** "Acronis, constructor ,acronis" -> ["Acronis", "constructor"]: trimmed,
 *  empty ones dropped, the first spelling of each kept. */
export function parseStakeholders(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
}

/** The required stakeholders nobody of theirs has approved for. */
export function silentStakeholders(r: ReviewRequest): string[] {
  return (r.stakeholders ?? []).filter((s) => s.required && !s.approved).map((s) => s.name);
}

/** One line per stakeholder: who approved for it, or who it still waits on. */
export function stakeholderLines(r: ReviewRequest): string[] {
  return (r.stakeholders ?? []).map((s) =>
    s.approved
      ? `${s.name}: ✓ ${s.approved_by.join(", ")}`
      : s.asked.length > 0
        ? `${s.name}: waiting for ${s.asked.join(" or ")}`
        : `${s.name}: nobody asked yet${s.required ? " — it must approve" : ""}`,
  );
}

/** How a request reads in one line. */
export function reviewState(r: ReviewRequest): { label: string; tone: "ok" | "wait" | "late" | "muted" } {
  switch (r.state) {
    case "approved":
      return { label: "Approved", tone: "ok" };
    case "superseded":
      return { label: "Superseded by a later request", tone: "muted" };
    case "withdrawn":
      return { label: "Withdrawn", tone: "muted" };
    default: {
      const waiting = [...r.outstanding, ...silentStakeholders(r)];
      if (waiting.length === 0) return { label: "Waiting for a first approval", tone: r.overdue ? "late" : "wait" };
      return {
        label: `${r.overdue ? "Overdue — waiting" : "Waiting"} for ${waiting.join(", ")}`,
        tone: r.overdue ? "late" : "wait",
      };
    }
  }
}

/** Why the request does or does not hold the document's stage, in one line,
 *  when that is not simply "until the required reviewers approve": a
 *  maturity below stable makes the review advice, and a security concern
 *  holds the stage at any level. `null` for the plain case. */
export function gateNote(r: ReviewRequest): string | null {
  if (r.state !== "open") return null;
  const concerns = r.reviewers.filter((x) => x.verdict === "changes_requested" && x.security).map((x) => x.name ?? x.person);
  if (concerns.length > 0) {
    return `${concerns.join(", ")} raised a security concern: it holds the stage at any maturity until they answer again.`;
  }
  if (r.advisory) {
    return `The document is ${r.maturity ?? "below stable"}: this review is advice and does not hold the stage; only a security concern would.`;
  }
  return null;
}

/** When the type's rules moved under a running review: it keeps the ones it
 *  started with, and the reviewer should know which. `null` otherwise. */
export function rulesNote(r: ReviewRequest): string | null {
  if (r.state !== "open" || !r.rules_changed) return null;
  return "The document type's template or review criteria changed since this review was asked for. It is judged by the ones it started with; ask again to review against the new ones.";
}

/** Whether the caller can give a verdict: an open request that names them. */
export function canDecide(r: ReviewRequest, me: string | null): boolean {
  return !!me && r.state === "open" && r.reviewers.some((x) => x.person === me);
}

/** The request the document stands on: the newest that is not superseded or
 *  withdrawn, else the newest at all. Requests arrive newest first. */
export function currentRequest(requests: ReviewRequest[]): ReviewRequest | null {
  return requests.find((r) => r.state === "open" || r.state === "approved") ?? requests[0] ?? null;
}

/** Whether a request is about an older version than the one on screen. */
export function isStale(r: ReviewRequest, version: string): boolean {
  return r.version !== version;
}

/** Add a person to the reviewers being picked, once; the first pick is required. */
export function addReviewer(list: ReviewerInput[], person: ReviewerInput): ReviewerInput[] {
  if (list.some((r) => r.person === person.person)) return list;
  return [...list, person];
}
