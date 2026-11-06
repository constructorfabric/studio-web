import { afterEach, describe, expect, it, vi } from "vitest";

import type { User } from "./api";
import { forgetPeople, looksLikeId, NO_PEOPLE, peopleOf, personLabel, unknownUserLabel } from "./user-names";

const ID = "3f2a9c1e-0b7d-4e1a-9c2f-5d6e7f8a9b0c";

afterEach(() => forgetPeople());

describe("personLabel", () => {
  it("prefers the name the record carries", () => {
    expect(personLabel(ID, "Alice", NO_PEOPLE)).toBe("Alice");
  });

  it("asks the tenants' names when the record has none", () => {
    expect(personLabel(ID, "", new Map([[ID, "Bob"]]))).toBe("Bob");
    expect(personLabel(ID.toUpperCase(), null, new Map([[ID, "Bob"]]))).toBe("Bob");
  });

  it("never shows a whole UUID", () => {
    const label = personLabel(ID, null, NO_PEOPLE);
    expect(label).toBe("unknown user (3f2a…)");
    expect(label).not.toContain(ID);
    expect(unknownUserLabel("")).toBe("unknown user");
    expect(personLabel(null, null, NO_PEOPLE)).toBe("unknown user");
  });

  it("shows a value that is not an id as it is", () => {
    expect(looksLikeId("ci-bot")).toBe(false);
    expect(personLabel("ci-bot", null, NO_PEOPLE)).toBe("ci-bot");
  });
});

describe("peopleOf", () => {
  it("asks each tenant once, and a refused ask is no names", async () => {
    const list = vi.fn(async (_t: string, tenant: string) => {
      if (tenant === "denied") throw new Error("404");
      return { items: [{ id: ID, username: "bob", display_name: "Bob B." } as User] };
    });
    const first = await peopleOf("t", "org", list);
    await peopleOf("t", "org", list);
    expect(first.get(ID)).toBe("Bob B.");
    expect(list).toHaveBeenCalledTimes(1);
    expect((await peopleOf("t", "denied", list)).size).toBe(0);
  });

  it("asks again under another token: who signed in may have changed", async () => {
    const list = vi.fn(async (token: string) => ({
      items: [{ id: ID, username: token === "a" ? "alice-view" : "bob-view" } as User],
    }));
    expect((await peopleOf("a", "org", list)).get(ID)).toBe("alice-view");
    expect((await peopleOf("b", "org", list)).get(ID)).toBe("bob-view");
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith("b", "org");
  });
});
