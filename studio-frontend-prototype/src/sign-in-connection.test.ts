import { describe, expect, it } from "vitest";

import { callbackParams } from "./sign-in-connection";

describe("callbackParams", () => {
  it("reads the state and the code the identity provider sent back", () => {
    expect(callbackParams("?code=abc&state=0123&session_state=x")).toEqual({
      kind: "code",
      state: "0123",
      code: "abc",
    });
  });

  it("says plainly that a cancelled sign-in was cancelled", () => {
    expect(callbackParams("?error=access_denied&state=0123")).toEqual({
      kind: "refused",
      reason: "The sign-in was cancelled.",
    });
  });

  it("passes on what the provider said about any other refusal", () => {
    expect(callbackParams("?error=invalid_scope&error_description=Unknown+scope")).toEqual({
      kind: "refused",
      reason: "Unknown scope",
    });
  });

  it("has nothing to finish without both a state and a code", () => {
    expect(callbackParams("?code=abc")).toEqual({ kind: "empty" });
    expect(callbackParams("")).toEqual({ kind: "empty" });
  });
});
