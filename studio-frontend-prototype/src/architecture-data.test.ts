import { describe, expect, it } from "vitest";

import { dataSummary } from "./architecture";

describe("dataSummary", () => {
  it("counts what the model keeps and names what is still elsewhere", () => {
    const s = dataSummary([
      { gear: "studio-documents", stores: [{ kind: "documents", store: "model" }, { kind: "reviews", store: "tables" }], types: ["document", "review"] },
      { gear: "studio-environments", stores: [{ kind: "metadata", store: "model" }], types: ["deployment-environment", "review"] },
    ]);
    expect(s.gears).toBe(2);
    expect(s.inModel).toBe(2);
    expect(s.elsewhere).toEqual([{ gear: "studio-documents", kind: "reviews", store: "tables" }]);
    expect(s.types).toBe(3);
  });

  it("is empty for a backend that reports nothing", () => {
    expect(dataSummary([])).toEqual({ gears: 0, inModel: 0, elsewhere: [], types: 0 });
  });
});
