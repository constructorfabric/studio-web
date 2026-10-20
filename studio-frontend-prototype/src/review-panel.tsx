// The review of one document: ask people to review the version on screen,
// see where the current request stands, and — when you are asked — give your
// verdict. Every verdict stays on record; the stage the document belongs to
// waits until its required reviewers approve -- unless the document's
// maturity is below stable, when only a security concern holds it.

import { useCallback, useEffect, useState } from "react";
import { api, type Colleague } from "./api";
import {
  addReviewer,
  canDecide,
  currentRequest,
  gateNote,
  isStale,
  parseStakeholders,
  reviewRequestBody,
  reviewState,
  rulesNote,
  stakeholderLines,
  type ReviewerInput,
  type ReviewRequest,
  type ReviewSubject,
} from "./review-requests";

const TONE: Record<string, { bg: string; fg: string }> = {
  ok: { bg: "var(--success-soft)", fg: "var(--success)" },
  wait: { bg: "var(--info-soft)", fg: "var(--info)" },
  late: { bg: "var(--warning-soft)", fg: "var(--warning)" },
  muted: { bg: "var(--muted)", fg: "var(--muted-foreground)" },
};

export function ReviewPanel({
  token,
  projectId,
  subject,
  onChanged,
}: {
  token: string;
  projectId: string;
  subject: ReviewSubject;
  /** After a request or a verdict: the stage status may have moved. */
  onChanged?: () => void;
}) {
  const [requests, setRequests] = useState<ReviewRequest[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [people, setPeople] = useState<Colleague[]>([]);
  const [asking, setAsking] = useState(false);
  const [picked, setPicked] = useState<ReviewerInput[]>([]);
  const [due, setDue] = useState("");
  const [mustApprove, setMustApprove] = useState("");
  const [note, setNote] = useState("");
  const [security, setSecurity] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRequests((await api.reviewRequests(token, projectId, subject.id)).items);
      setErr(null);
    } catch (e) {
      // A backend from before reviews: say so once, and show nothing else.
      setRequests([]);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [token, projectId, subject.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .myProfile(token)
      .then((p) => setMe(p.id))
      .catch(() => setMe(null));
  }, [token]);

  const startAsking = async () => {
    setAsking(true);
    try {
      const [colleagues, suggested] = await Promise.all([
        api.myColleagues(token).catch(() => [] as Colleague[]),
        api.reviewerSuggestions(token, projectId, subject.id, subject.typeKey).catch(() => ({ items: [], total: 0 })),
      ]);
      const seen = new Set<string>();
      setPeople(colleagues.filter((c) => c.user_id !== me && !seen.has(c.user_id) && seen.add(c.user_id)));
      setPicked(suggested.items.map((s) => ({ person: s.person, name: s.name ?? null, required: s.required })));
    } catch {
      // The form still works by picking people by hand.
    }
  };

  const send = async () => {
    setBusy(true);
    try {
      await api.createReviewRequest(
        token,
        reviewRequestBody(projectId, subject, picked, due || null, parseStakeholders(mustApprove)),
      );
      setAsking(false);
      setPicked([]);
      setDue("");
      setMustApprove("");
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (r: ReviewRequest, verdict: "approved" | "changes_requested") => {
    setBusy(true);
    try {
      await api.createReviewApproval(token, projectId, r.id, verdict, note.trim() || null, verdict === "changes_requested" && security);
      setNote("");
      setSecurity(false);
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (r: ReviewRequest) => {
    setBusy(true);
    try {
      await api.cancelReviewRequest(token, projectId, r.id);
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (requests === null) return null;
  const current = currentRequest(requests);
  const state = current ? reviewState(current) : null;
  const gate = current ? gateNote(current) : null;
  const rules = current ? rulesNote(current) : null;
  const holders = current ? stakeholderLines(current) : [];
  const nameOf = (person: string) =>
    people.find((p) => p.user_id === person)?.display_name ?? picked.find((p) => p.person === person)?.name ?? person;

  return (
    <div className="rv-panel">
      <div className="rv-head">
        <span className="rv-title">Review</span>
        {current && state && (
          <span className="ing-state" style={{ background: TONE[state.tone].bg, color: TONE[state.tone].fg }}>
            {state.label}
          </span>
        )}
        {current && isStale(current, subject.version) && current.state !== "withdrawn" && (
          <span className="rv-muted" title={`Asked about ${current.version}`}>
            about an earlier version
          </span>
        )}
      </div>
      {err && <div className="rv-err">{err}</div>}
      {gate && <div className="rv-muted">{gate}</div>}
      {rules && (
        <div className="rv-muted" data-rules-changed>
          {rules}
        </div>
      )}

      {current && (
        <>
          <ul className="rv-reviewers">
            {current.reviewers.map((r) => (
              <li key={r.person}>
                {r.name ?? r.person}
                {r.stakeholder ? ` for ${r.stakeholder}` : ""}
                {r.required ? "" : " (optional)"}:{" "}
                <b>
                  {r.verdict === "approved"
                    ? "✓ approved"
                    : r.verdict === "changes_requested"
                      ? r.security
                        ? "✗ changes (security)"
                        : "✗ changes"
                      : "—"}
                </b>
              </li>
            ))}
          </ul>
          {holders.length > 0 && (
            <ul className="rv-reviewers" aria-label="Stakeholders">
              {holders.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {current.due_at && <div className="rv-muted">Due {current.due_at.slice(0, 10)}</div>}
          {canDecide(current, me) && (
            <div className="rv-decide">
              <input
                placeholder="A note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label="Note with your verdict"
              />
              <button disabled={busy} onClick={() => void decide(current, "approved")}>
                ✓ Approve
              </button>
              <button disabled={busy} onClick={() => void decide(current, "changes_requested")}>
                ✗ Request changes
              </button>
              <label title="A security concern holds the stage at any maturity">
                <input type="checkbox" checked={security} onChange={(e) => setSecurity(e.target.checked)} /> a
                security concern
              </label>
            </div>
          )}
          {current.state === "open" && current.requested_by === me && (
            <button className="rv-link" disabled={busy} onClick={() => void withdraw(current)}>
              Withdraw the request
            </button>
          )}
          {current.verdicts.length > 0 && (
            <details className="rv-history">
              <summary>{current.verdicts.length} verdict{current.verdicts.length === 1 ? "" : "s"} on record</summary>
              <ul>
                {current.verdicts.map((v) => (
                  <li key={v.id}>
                    {v.decided_at.slice(0, 16).replace("T", " ")} · {v.approver_name ?? v.approver} ·{" "}
                    {v.verdict === "approved" ? "approved" : v.security ? "requested changes (security)" : "requested changes"}
                    {v.note && <> · “{v.note}”</>}
                    {v.checks.length > 0 && <span className="rv-muted"> · passed: {v.checks.join(", ")}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {!asking ? (
        <button className="rv-link" onClick={() => void startAsking()}>
          {current && current.state !== "withdrawn" ? "Ask again for this version…" : "Request a review…"}
        </button>
      ) : (
        <div className="rv-ask">
          <div className="rv-picked">
            {picked.length === 0 && <span className="rv-muted">Nobody picked yet.</span>}
            {picked.map((p) => (
              <span key={p.person} className="chip on">
                {p.name ?? nameOf(p.person)}
                <label title="The request is not approved until a required reviewer approves">
                  <input
                    type="checkbox"
                    checked={p.required}
                    onChange={(e) =>
                      setPicked(picked.map((x) => (x.person === p.person ? { ...x, required: e.target.checked } : x)))
                    }
                  />{" "}
                  required
                </label>
                <input
                  className="rv-for"
                  placeholder="for (org)"
                  title="The stakeholder they speak for: one approval answers for it"
                  aria-label={`Whom ${p.name ?? p.person} speaks for`}
                  value={p.stakeholder ?? ""}
                  onChange={(e) =>
                    setPicked(picked.map((x) => (x.person === p.person ? { ...x, stakeholder: e.target.value } : x)))
                  }
                  style={{ width: 90, fontSize: 11 }}
                />
                <button
                  className="rv-x"
                  aria-label={`Remove ${p.name ?? p.person}`}
                  onClick={() => setPicked(picked.filter((x) => x.person !== p.person))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <select
            aria-label="Add a reviewer"
            value=""
            onChange={(e) => {
              const c = people.find((p) => p.user_id === e.target.value);
              if (c) setPicked(addReviewer(picked, { person: c.user_id, name: c.display_name ?? null, required: true }));
            }}
          >
            <option value="">Add a reviewer…</option>
            {people
              .filter((p) => !picked.some((x) => x.person === p.user_id))
              .map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.display_name ?? p.user_id}
                </option>
              ))}
          </select>
          <label className="rv-due">
            Due <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <label className="rv-due" title="Each must approve through somebody speaking for it">
            Must be approved by{" "}
            <input
              placeholder="Acronis, Constructor, Virtuozzo"
              value={mustApprove}
              onChange={(e) => setMustApprove(e.target.value)}
            />
          </label>
          <div className="rv-actions">
            <button className="primary" disabled={busy || picked.length === 0} onClick={() => void send()}>
              Ask {picked.length || ""} to review
            </button>
            <button onClick={() => setAsking(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
