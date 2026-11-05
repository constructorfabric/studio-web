import { describe, expect, it } from "vitest";

import { stateLabel, stateTone } from "./documents";

/**
 * A binding state this build has never heard of.
 *
 * `DocBindingState` is transcribed by hand from a sentence in the backend's
 * OpenAPI `description` — the field is typed `string` there — so a sixth state
 * added on the backend compiles fine here and arrives at runtime. These two
 * readers are what stands between that and a blank screen.
 */
describe("an unrecognised binding state", () => {
  it("renders neutral rather than throwing", () => {
    // The defect this replaces: `STATE_TONE[state]` read straight on an unknown state
    // threw "Cannot read properties of undefined" and took the Specs side
    // panel down with it.
    expect(() => stateTone("superseded")).not.toThrow();
    expect(stateTone("superseded")).toBe("neutral");
  });

  it("shows its own wire value rather than nothing", () => {
    // A reader can then say what the screen could not — "it says superseded
    // and this build does not know that word" is a report; a blank chip is not.
    expect(stateLabel("superseded")).toBe("superseded");
  });

  it("still answers for every state this build does know", () => {
    expect(stateLabel("detected")).toBe("proposed");
    expect(stateLabel("not_a_document")).toBe("not a document");
    expect(stateTone("confirmed")).toBe("ok");
  });
});
