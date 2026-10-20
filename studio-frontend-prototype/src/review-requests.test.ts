import { describe, expect, it } from "vitest";
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
  type ReviewRequest,
} from "./review-requests";

const request = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "r1",
  project_id: "p",
  subject_kind: "binding",
  subject_id: "b1",
  type_key: "prd",
  title: "prd.md",
  version: "sha-1",
  requested_by: "me",
  reviewers: [
    { person: "ann", name: "Ann", required: true },
    { person: "bob", name: "Bob", required: false },
  ],
  state: "open",
  overdue: false,
  outstanding: ["Ann"],
  created_at: "2026-10-13T10:00:00Z",
  verdicts: [],
  ...over,
});

describe("review requests", () => {
  it("builds the request body with the due day at its end", () => {
    const body = reviewRequestBody(
      "p",
      { kind: "binding", id: "b1", title: "prd.md", typeKey: "prd", version: "sha-1" },
      [{ person: "ann", name: "Ann", required: true }],
      "2026-10-20",
    );
    expect(body.due_at).toBe("2026-10-20T23:59:59Z");
    expect(body.reviewers).toEqual([{ person: "ann", name: "Ann", required: true, stakeholder: null }]);
    expect(body.stakeholders).toEqual([]);
    expect(reviewRequestBody("p", { kind: "document", id: "d", title: "t", version: "v" }, [], null).due_at).toBeNull();
  });

  it("says whom it waits for, and when it is late", () => {
    expect(reviewState(request()).label).toBe("Waiting for Ann");
    expect(reviewState(request({ overdue: true })).tone).toBe("late");
    expect(reviewState(request({ state: "approved", outstanding: [] })).label).toBe("Approved");
  });

  it("lets only a named reviewer decide an open request", () => {
    expect(canDecide(request(), "bob")).toBe(true);
    expect(canDecide(request(), "eve")).toBe(false);
    expect(canDecide(request({ state: "withdrawn" }), "ann")).toBe(false);
    expect(canDecide(request(), null)).toBe(false);
  });

  it("finds the request the document stands on and whether it is about an older version", () => {
    const list = [request({ id: "new", state: "withdrawn" }), request({ id: "old", state: "approved" })];
    expect(currentRequest(list)?.id).toBe("old");
    expect(currentRequest([request({ id: "x", state: "superseded" })])?.id).toBe("x");
    expect(currentRequest([])).toBeNull();
    expect(isStale(request(), "sha-2")).toBe(true);
  });

  it("adds a reviewer once", () => {
    const one = addReviewer([], { person: "ann", required: true });
    expect(addReviewer(one, { person: "ann", required: false })).toBe(one);
    expect(addReviewer(one, { person: "bob", required: false })).toHaveLength(2);
  });

  it("says when a review is advice and when a security concern holds the stage", () => {
    expect(gateNote(request())).toBeNull();
    expect(gateNote(request({ maturity: "experimental", advisory: true }))).toMatch(
      /experimental: this review is advice and does not hold the stage/,
    );
    const concern = request({
      maturity: "preview",
      advisory: true,
      reviewers: [{ person: "bob", name: "Bob", required: false, verdict: "changes_requested", security: true }],
    });
    expect(gateNote(concern)).toMatch(/^Bob raised a security concern/);
    expect(gateNote(request({ ...concern, maturity: "stable", advisory: false }))).toMatch(/security concern/);
    expect(gateNote(request({ advisory: true, state: "approved" }))).toBeNull();
  });
});

describe("stakeholders", () => {
  it("are parsed once each, first spelling kept", () => {
    expect(parseStakeholders(" Acronis, constructor ,acronis;;")).toEqual(["Acronis", "constructor"]);
  });

  it("a silent required stakeholder is waited for, and each says where it stands", () => {
    const r = request({
      outstanding: [],
      stakeholders: [
        { name: "Acronis", required: true, approved: true, approved_by: ["Ann"], asked: ["Ann"] },
        { name: "Virtuozzo", required: true, approved: false, approved_by: [], asked: [] },
      ],
    });
    expect(reviewState(r).label).toBe("Waiting for Virtuozzo");
    expect(stakeholderLines(r)).toEqual(["Acronis: ✓ Ann", "Virtuozzo: nobody asked yet — it must approve"]);
  });

  it("go into the request body with each reviewer's", () => {
    const body = reviewRequestBody(
      "p",
      { kind: "binding", id: "b1", title: "prd.md", version: "sha-1" },
      [{ person: "ann", required: true, stakeholder: " Acronis " }],
      null,
      ["Acronis", "acronis"],
    );
    expect(body.stakeholders).toEqual(["Acronis"]);
    expect(body.reviewers[0].stakeholder).toBe("Acronis");
  });
});

describe("rules changed mid-review", () => {
  it("is said on an open request only", () => {
    expect(rulesNote(request({ rules_changed: true }))).toMatch(/judged by the ones it started with/);
    expect(rulesNote(request({ rules_changed: true, state: "approved" }))).toBeNull();
    expect(rulesNote(request())).toBeNull();
  });
});
