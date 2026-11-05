import { afterEach, describe, expect, it } from "vitest";

import { GLYPHS } from "./tenant-glyphs";
import {
  defaultIcon,
  forgetIcons,
  ICON_COLORS,
  ICON_GLYPHS,
  iconOf,
  knownIcon,
  parseIcon,
  rememberIcon,
  sameIcon,
} from "./tenant-icon";

afterEach(() => forgetIcons());

describe("the icons one may choose", () => {
  it("offers 24 glyphs, each drawn, and 8 colours", () => {
    expect(ICON_GLYPHS).toHaveLength(24);
    expect(new Set(ICON_GLYPHS).size).toBe(24);
    for (const g of ICON_GLYPHS) expect(GLYPHS[g]).toBeTypeOf("function");
    expect(ICON_COLORS).toHaveLength(8);
  });
});

describe("parseIcon", () => {
  it("reads a glyph and a colour this portal draws", () => {
    expect(parseIcon({ glyph: "rocket", color: "teal" })).toEqual({ glyph: "rocket", color: "teal" });
  });

  it("drops anything else in the value", () => {
    expect(parseIcon({ glyph: "rocket", color: "teal", data: "AAAA" })).toEqual({ glyph: "rocket", color: "teal" });
  });

  it("reads a name nobody defines, half an icon or no object as no choice", () => {
    expect(parseIcon({ glyph: "unicorn", color: "teal" })).toBeNull();
    expect(parseIcon({ glyph: "rocket", color: "#ff0000" })).toBeNull();
    expect(parseIcon({ glyph: "rocket" })).toBeNull();
    expect(parseIcon("rocket")).toBeNull();
    expect(parseIcon(null)).toBeNull();
    expect(parseIcon(undefined)).toBeNull();
  });
});

describe("defaultIcon", () => {
  it("is a folder for a workspace", () => {
    expect(defaultIcon("workspace")).toEqual({ glyph: "folder", color: "blue" });
    expect(defaultIcon("workspace", "product")).toEqual({ glyph: "folder", color: "blue" });
  });

  it("follows a project's kind", () => {
    expect(defaultIcon("project", "new_gears")).toEqual({ glyph: "gear", color: "violet" });
    expect(defaultIcon("project", "product")).toEqual({ glyph: "box", color: "green" });
    expect(defaultIcon("project", "existing")).toEqual({ glyph: "code", color: "amber" });
  });

  it("is a grid for a project of no known kind", () => {
    expect(defaultIcon("project")).toEqual({ glyph: "grid", color: "violet" });
    expect(defaultIcon("project", null)).toEqual({ glyph: "grid", color: "violet" });
    expect(defaultIcon("project", "something")).toEqual({ glyph: "grid", color: "violet" });
  });

  it("only ever names glyphs and colours one may choose", () => {
    for (const kind of [undefined, "new_gears", "product", "existing"]) {
      for (const level of ["workspace", "project"] as const) {
        expect(parseIcon(defaultIcon(level, kind))).not.toBeNull();
      }
    }
  });
});

describe("iconOf", () => {
  it("is the chosen icon when there is one", () => {
    expect(iconOf("project", { glyph: "star", color: "pink" }, "product")).toEqual({ glyph: "star", color: "pink" });
  });

  it("is the kind's when none was chosen or the choice is not readable", () => {
    expect(iconOf("project", undefined, "product")).toEqual({ glyph: "box", color: "green" });
    expect(iconOf("project", { glyph: "nope", color: "pink" }, "existing")).toEqual({ glyph: "code", color: "amber" });
  });
});

describe("what is known of each tenant", () => {
  it("keeps the choice and the kind a list said", () => {
    rememberIcon("p1", { glyph: "star", color: "red" }, "product");
    expect(knownIcon("p1")).toEqual({ chosen: { glyph: "star", color: "red" }, kind: "product" });
  });

  it("keeps the kind from before when a later word does not give one", () => {
    rememberIcon("p1", null, "existing");
    rememberIcon("p1", { glyph: "bolt", color: "amber" });
    expect(knownIcon("p1")).toEqual({ chosen: { glyph: "bolt", color: "amber" }, kind: "existing" });
  });

  it("knows nothing of a tenant nobody spoke of", () => {
    expect(knownIcon("p2")).toBeUndefined();
  });

  it("compares icons by both halves", () => {
    expect(sameIcon({ glyph: "a", color: "b" }, { glyph: "a", color: "b" })).toBe(true);
    expect(sameIcon({ glyph: "a", color: "b" }, { glyph: "a", color: "c" })).toBe(false);
    expect(sameIcon(null, { glyph: "a", color: "b" })).toBe(false);
  });
});
