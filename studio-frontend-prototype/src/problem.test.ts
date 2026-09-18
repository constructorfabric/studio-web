import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { categoryOf, errText, isProblem, parseProblem, traceId } from "./problem";

/** A real 401, copied from the running backend rather than invented. */
const UNAUTHENTICATED = {
  type: "gts://gts.cf.core.errors.err.v1~cf.core.err.unauthenticated.v1~",
  title: "Unauthenticated",
  status: 401,
  detail: "Authentication required",
  instance: "/studio-tasks/v1/runs",
  trace_id: "74TP-bn2lkDhrMcp_7Qj9",
  context: { reason: "MISSING_BEARER" },
};

describe("categoryOf", () => {
  it("reads the category out of the GTS type", () => {
    expect(categoryOf(UNAUTHENTICATED.type)).toBe("unauthenticated");
    expect(
      categoryOf("gts://gts.cf.core.errors.err.v1~cf.core.err.failed_precondition.v1~"),
    ).toBe("failed_precondition");
  });

  it("refuses a name that is not one of the sixteen", () => {
    // Otherwise an unexpected name leaks out as a string a screen might branch
    // on, and the branch would be dead code nobody notices.
    expect(categoryOf("gts://gts.cf.core.errors.err.v1~cf.core.err.teapot.v1~")).toBeUndefined();
    expect(categoryOf(undefined)).toBeUndefined();
    expect(categoryOf("nonsense")).toBeUndefined();
  });
});

describe("parseProblem", () => {
  it("reads the fields the contract promises", () => {
    const problem = parseProblem(UNAUTHENTICATED);
    expect(problem?.category).toBe("unauthenticated");
    expect(problem?.status).toBe(401);
    expect(problem?.detail).toBe("Authentication required");
    expect(problem?.trace_id).toBe("74TP-bn2lkDhrMcp_7Qj9");
    expect(problem?.context.reason).toBe("MISSING_BEARER");
  });

  it("is not fooled by a body that is somebody else's JSON", () => {
    // A proxy or a crash can answer with anything; none of it should read as a
    // problem, and none of it should throw on the way to a message.
    expect(parseProblem({ items: [], total: 0 })).toBeUndefined();
    expect(parseProblem(undefined)).toBeUndefined();
    expect(parseProblem("<html>502</html>")).toBeUndefined();
    expect(parseProblem(null)).toBeUndefined();
  });

  it("survives a problem whose context is missing or the wrong type", () => {
    expect(parseProblem({ title: "Not Found" })?.context).toEqual({});
    expect(parseProblem({ title: "Not Found", context: "nope" })?.context).toEqual({});
  });
});

describe("isProblem", () => {
  it("distinguishes two categories that share an HTTP status", () => {
    // The whole reason this module exists: 400 is three different failures and
    // `status` cannot tell them apart.
    const malformed = new ApiError(400, {
      type: "gts://gts.cf.core.errors.err.v1~cf.core.err.invalid_argument.v1~",
      title: "Invalid Argument",
      detail: "name must not be empty",
      context: {},
    });
    const wrongState = new ApiError(400, {
      type: "gts://gts.cf.core.errors.err.v1~cf.core.err.failed_precondition.v1~",
      title: "Failed Precondition",
      detail: "Operation precondition not met",
      context: {},
    });

    expect(malformed.status).toBe(wrongState.status);
    expect(isProblem(malformed, "invalid_argument")).toBe(true);
    expect(isProblem(malformed, "failed_precondition")).toBe(false);
    expect(isProblem(wrongState, "failed_precondition")).toBe(true);
    expect(isProblem(wrongState, "invalid_argument")).toBe(false);
  });

  it("accepts several categories at once and says no to a non-problem", () => {
    const gone = new ApiError(404, {
      type: "gts://gts.cf.core.errors.err.v1~cf.core.err.not_found.v1~",
      title: "Not Found",
      detail: "no such run",
      context: {},
    });
    expect(isProblem(gone, "not_found", "permission_denied")).toBe(true);
    expect(isProblem(new Error("network down"), "not_found")).toBe(false);
    expect(isProblem(undefined, "not_found")).toBe(false);
  });
});

describe("ApiError", () => {
  it("parses the body once, so screens do not each re-read it", () => {
    const e = new ApiError(401, UNAUTHENTICATED);
    expect(e.problem?.category).toBe("unauthenticated");
    expect(traceId(e)).toBe("74TP-bn2lkDhrMcp_7Qj9");
  });

  it("has no problem when the failure never reached the assembly", () => {
    const e = new ApiError(502, "<html>bad gateway</html>");
    expect(e.problem).toBeUndefined();
    expect(errText(e)).toBe("HTTP 502");
  });
});

describe("errText", () => {
  it("names the field an invalid_argument is about", () => {
    // `field_violations` is the most common shape of the most common 400, and
    // it went unread until this module existed.
    const text = errText(
      new ApiError(400, {
        title: "Invalid Argument",
        detail: "Request validation failed",
        context: {
          field_violations: [
            { field: "name", description: "must not be empty", reason: "REQUIRED" },
          ],
        },
      }),
    );
    expect(text).toContain("name: must not be empty");
  });

  it("shows the trace id for a defect, because nothing the reader does will help", () => {
    const text = errText(
      new ApiError(500, {
        type: "gts://gts.cf.core.errors.err.v1~cf.core.err.internal.v1~",
        title: "Internal",
        detail: "Internal error",
        trace_id: "abc123",
        context: { description: "sqlx: connection closed" },
      }),
    );
    expect(text).toContain("sqlx: connection closed");
    expect(text).toContain("trace abc123");
  });

  it("leaves the trace id off a failure the reader can act on", () => {
    // On a 404 the id is noise in front of the answer.
    const text = errText(
      new ApiError(404, {
        type: "gts://gts.cf.core.errors.err.v1~cf.core.err.not_found.v1~",
        title: "Not Found",
        detail: "no such document",
        trace_id: "abc123",
        context: {},
      }),
    );
    expect(text).toBe("HTTP 404 · Not Found — no such document");
  });

  it("surfaces a permission_denied reason, which sits outside detail", () => {
    const text = errText(
      new ApiError(403, {
        type: "gts://gts.cf.core.errors.err.v1~cf.core.err.permission_denied.v1~",
        title: "Permission Denied",
        detail: "Permission denied",
        context: { reason: "privilege `access.manage` is required" },
      }),
    );
    expect(text).toContain("access.manage");
  });
});
