import { describe, expect, it } from "vitest";

import {
  anyFieldSet,
  attributeFields,
  choiceLabel,
  factsOf,
  fieldOptions,
  initialAttributes,
  matchField,
  matchesFields,
  projectFields,
  reposField,
  scalarAttributes,
  templateField,
  words,
} from "./project-filters";
import { BUILTIN_PHASES, lifecycleField } from "./project-lifecycle";

const phase = lifecycleField(BUILTIN_PHASES);
const template = templateField([
  { key: "product", title: "Product" },
  { key: "new_gears", title: "New gears" },
]);
const rows = [
  factsOf({ attributes: { status: "testing", type: "product", mode: "greenfield" }, repos: 2 }),
  factsOf({ attributes: { status: "draft", type: "new_gears", mode: "modernize" }, repos: 0 }),
  factsOf({ attributes: { status: "pilot", type: "gone", mode: "greenfield" }, repos: 1 }),
  factsOf({ attributes: {}, repos: null }),
];

describe("one field", () => {
  it("reads the lifecycle's status as a phase, a status from before phases included", () => {
    expect(matchField(phase, rows[0], "testing")).toBe(true);
    expect(matchField(phase, rows[1], "discovery")).toBe(true);
    expect(matchField(phase, rows[2], "pilot")).toBe(true);
    expect(matchField(phase, rows[3], "none")).toBe(true);
    expect(matchField(phase, rows[2], "none")).toBe(false);
  });

  it("matches a template by key or none", () => {
    expect(matchField(template, rows[0], "product")).toBe(true);
    expect(matchField(template, rows[3], "none")).toBe(true);
    expect(matchField(template, rows[0], "none")).toBe(false);
  });

  it("does not guess repositories it could not count", () => {
    expect(matchField(reposField, rows[0], "with")).toBe(true);
    expect(matchField(reposField, rows[1], "without")).toBe(true);
    expect(matchField(reposField, rows[3], "without")).toBe(false);
  });

  it("does not match a project whose row was not read", () => {
    expect(matchField(template, undefined, "none")).toBe(false);
  });
});

describe("all of them", () => {
  it("needs every set field and ignores a list's own filters", () => {
    const fields = [phase, template, reposField];
    expect(matchesFields(fields, rows[0], { phase: "testing", repos: "with", review: "x" })).toBe(true);
    expect(matchesFields(fields, rows[0], { phase: "testing", template: "new_gears" })).toBe(false);
    expect(matchesFields(fields, rows[0], {})).toBe(true);
    expect(anyFieldSet(fields, { review: "x" })).toBe(false);
    expect(anyFieldSet(fields, { template: "product" })).toBe(true);
  });
});

describe("the choices", () => {
  it("lists a field's own in order, a value it does not list, and none, counted", () => {
    expect(fieldOptions(phase, rows).map((o) => [o.value, o.count])).toEqual([
      ["discovery", 1],
      ["development", 0],
      ["testing", 1],
      ["production", 0],
      ["archived", 0],
      ["pilot", 1],
      ["none", 1],
    ]);
    expect(fieldOptions(template, rows).map((o) => o.label)).toEqual(["Product", "New gears", "gone", "No template"]);
  });

  it("names a choice in the field's words, else as stored", () => {
    expect(choiceLabel(template, "product")).toBe("Product");
    expect(choiceLabel(template, "gone")).toBe("gone");
    expect(choiceLabel(template, null)).toBeNull();
  });
});

describe("fields nobody registered", () => {
  it("offers every unclaimed attribute with a few values, in plain words", () => {
    const generic = attributeFields([phase, template], rows);
    expect(generic.map((f) => [f.id, f.label])).toEqual([["mode", "Mode"]]);
    expect(fieldOptions(generic[0], rows).map((o) => [o.value, o.count])).toEqual([
      ["greenfield", 2],
      ["modernize", 1],
      ["none", 1],
    ]);
  });

  it("leaves out free text and identifiers", () => {
    const many = Array.from({ length: 20 }, (_, i) => factsOf({ attributes: { brief: "b", id_like: `x${i}` } }));
    expect(attributeFields([], many)).toEqual([]);
  });

  it("puts the registered fields first", () => {
    expect(projectFields([phase], rows).map((f) => f.id)).toEqual(["phase", "mode", "type"]);
  });

  it("words a key", () => {
    expect(words("product_kind")).toBe("Product kind");
  });
});

describe("a project's config", () => {
  it("carries its short values, as the rollups row does", () => {
    expect(scalarAttributes({ status: "x", n: 1, ok: true, list: [], o: {}, long: "y".repeat(121) })).toEqual({
      status: "x",
      n: 1,
      ok: true,
    });
    expect(scalarAttributes(null)).toBeNull();
  });

  it("starts with what the fields start it with", () => {
    expect(initialAttributes([phase, template, reposField])).toEqual({ status: "discovery" });
  });
});
