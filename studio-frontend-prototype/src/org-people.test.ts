import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type Colleague, type OrgMember } from "./api";
import type { GrantDef } from "./access";
import { byName, fromColleagues, fromMembers, holderName, orgPeople, projectGrantsOf } from "./org-people";

const member = (user_id: string, over: Partial<OrgMember> = {}): OrgMember => ({
  user_id,
  role: "member",
  status: "active",
  source: "manual",
  created_at_epoch_ms: 1,
  updated_at_epoch_ms: 1,
  ...over,
});

const colleague = (user_id: string, org_id: string, display_name?: string): Colleague => ({
  user_id,
  org_id,
  display_name,
  role: "member",
  directory: {},
});

const grant = (subjectId: string, over: Partial<GrantDef> = {}): GrantDef => ({
  id: `g-${subjectId}`,
  subjectType: "member",
  subjectId,
  subjectName: "as written",
  roleKey: "editor",
  scopeType: "project",
  scopeId: "p1",
  scopeName: "P1",
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("an organization's people come from its memberships", () => {
  it("keys each member by the person id a grant names", () => {
    const people = fromMembers([member("u-ada", { display_name: "Ada", role: "owner" })]);
    expect(people).toEqual([{ id: "u-ada", name: "Ada", email: undefined, role: "owner" }]);
  });

  it("leaves a suspended member out: they may not work here while it stands", () => {
    expect(fromMembers([member("u-1", { status: "suspended" })])).toEqual([]);
  });

  it("names a person with no name by an address, then by a short id", () => {
    expect(fromMembers([member("u-2", { email: "bo@x.example" })])[0].name).toBe("bo@x.example");
    expect(fromMembers([member("0123456789")])[0].name).toBe("Person 01234567");
  });

  it("reads the colleague projection for one organization only", () => {
    const people = fromColleagues(
      [colleague("u-a", "org-1", "Ann"), colleague("u-b", "org-2", "Ben")],
      "org-1",
    );
    expect(people.map((p) => p.id)).toEqual(["u-a"]);
  });

  it("lists a person once, by name", () => {
    const people = byName([
      { id: "b", name: "Zed", role: "member" },
      { id: "a", name: "Ann", role: "member" },
      { id: "b", name: "Zed", role: "member" },
    ]);
    expect(people.map((p) => p.name)).toEqual(["Ann", "Zed"]);
  });
});

describe("who may read which list", () => {
  it("uses the administrative listing when the caller may read it", async () => {
    vi.spyOn(api, "orgMembers").mockResolvedValue([member("u-1", { display_name: "One" })]);
    const colleagues = vi.spyOn(api, "myColleagues");
    expect((await orgPeople("t", "org-1")).map((p) => p.id)).toEqual(["u-1"]);
    expect(colleagues).not.toHaveBeenCalled();
  });

  it("falls back to colleagues for a member without people.view", async () => {
    vi.spyOn(api, "orgMembers").mockRejectedValue(new Error("403"));
    vi.spyOn(api, "myColleagues").mockResolvedValue([colleague("u-2", "org-1", "Two")]);
    expect((await orgPeople("t", "org-1")).map((p) => p.name)).toEqual(["Two"]);
  });
});

describe("a grant and a member match by person", () => {
  const people = [{ id: "u-ada", name: "Ada", role: "member" }];

  it("names the holder from the member it names", () => {
    expect(holderName(grant("u-ada"), people)).toBe("Ada");
  });

  it("keeps the stored name for a grant on a login nobody has rekeyed yet", () => {
    expect(holderName(grant("some-login-subject"), people)).toBe("as written");
  });

  it("finds a member's projects among project-scoped member grants only", () => {
    const grants = [
      grant("u-ada"),
      grant("u-ada", { id: "org", scopeType: "org", scopeId: "" }),
      grant("u-ada", { id: "team", subjectType: "team" }),
      grant("u-bob", { id: "bob" }),
    ];
    expect(projectGrantsOf("u-ada", grants).map((g) => g.id)).toEqual(["g-u-ada"]);
  });
});
