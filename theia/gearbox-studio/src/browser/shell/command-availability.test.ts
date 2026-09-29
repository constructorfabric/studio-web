import {
  ENGINE_DOWN,
  NO_PRODUCT,
  STILL_OPENING,
  addGearEntrance,
  productCommandRefusal,
} from "./command-availability";

const state = (productOpen: boolean, opening = false, engineConnected = true) => ({ productOpen, opening, engineConnected });

describe("Add gear", () => {
  it("adds to the open product", () => {
    expect(addGearEntrance(state(true))).toEqual({ kind: "add" });
  });

  it("creates a product when none is open, instead of doing nothing", () => {
    expect(addGearEntrance(state(false))).toEqual({ kind: "create-product" });
  });

  it("waits for a product that is still opening", () => {
    expect(addGearEntrance(state(false, true))).toEqual({ kind: "unavailable", reason: STILL_OPENING });
  });

  it("needs the engine either way", () => {
    expect(addGearEntrance(state(true, false, false))).toEqual({ kind: "unavailable", reason: ENGINE_DOWN });
    expect(addGearEntrance(state(false, false, false))).toEqual({ kind: "unavailable", reason: ENGINE_DOWN });
  });
});

describe("a command about the open product", () => {
  it("says to open or create one first", () => {
    expect(productCommandRefusal(state(false))).toBe(NO_PRODUCT);
    expect(productCommandRefusal(state(false, true))).toBe(STILL_OPENING);
  });

  it("runs once one is open, and says when it needs the engine", () => {
    expect(productCommandRefusal(state(true))).toBeUndefined();
    expect(productCommandRefusal(state(true, false, false))).toBeUndefined();
    expect(productCommandRefusal(state(true, false, false), true)).toBe(ENGINE_DOWN);
  });
});
