/* ── Who a user id is ─────────────────────────────────────────────────────────
 *
 * Records name people by id (`requested_by`, `decided_by`, `pushed_by`) and,
 * mostly, by the name the server knew then (`requested_by_name`). Where it
 * knew none, a screen showed the raw UUID. It now asks the tenants' user
 * lists (`api.tenantUsersAll`, the one the Projects page reads) once per
 * tenant and page load, and says "unknown user (abcd…)" when they do not
 * have the person either -- never the whole UUID. */

import { useEffect, useState } from "react";

import { api, type User } from "./api";

/** Names by user id, as one tenant's user list gave them. */
export type PeopleNames = ReadonlyMap<string, string>;

/** No names known: [`personLabel`] then says only what the record says. */
export const NO_PEOPLE: PeopleNames = new Map();

/** How a person is called when nobody knows their name: a short, stable
 *  label, not the UUID. */
export function unknownUserLabel(id: string): string {
  const head = id.replace(/-/g, "").slice(0, 4);
  return head ? `unknown user (${head}…)` : "unknown user";
}

/** A user's name as people read it: the name the record carries, else the
 *  one the tenants' lists give, else [`unknownUserLabel`]. A value that is
 *  not an id (a login, an e-mail) is shown as it is. */
export function personLabel(
  id: string | null | undefined,
  name: string | null | undefined,
  known: PeopleNames,
): string {
  if (name?.trim()) return name.trim();
  const who = id?.trim() ?? "";
  if (!who) return "unknown user";
  const found = known.get(who.toLowerCase());
  if (found) return found;
  return looksLikeId(who) ? unknownUserLabel(who) : who;
}

const ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** A UUID, with or without dashes. */
export function looksLikeId(s: string): boolean {
  return ID.test(s.trim());
}

/** A user as their name: display name, else login, else e-mail. */
export function nameOf(u: User): string | null {
  return u.display_name?.trim() || u.username?.trim() || u.email?.trim() || null;
}

/** Each tenant's names, asked once per page load and sign-in: a failed ask
 *  (the caller may not list that tenant's users) is no names, not an error.
 *  Another token is asked afresh: who signed in may since have changed, and
 *  may see other names. */
const byTenant = new Map<string, Promise<Map<string, string>>>();
let askedWith: string | null = null;

export function peopleOf(
  token: string,
  tenantId: string,
  list: (token: string, tenantId: string) => Promise<{ items?: User[] }> = api.tenantUsersAll,
): Promise<Map<string, string>> {
  if (token !== askedWith) {
    byTenant.clear();
    askedWith = token;
  }
  let found = byTenant.get(tenantId);
  if (!found) {
    found = list(token, tenantId).then(
      (p) => {
        const names = new Map<string, string>();
        for (const u of p.items ?? []) {
          const n = nameOf(u);
          if (n) names.set(u.id.toLowerCase(), n);
        }
        return names;
      },
      () => new Map<string, string>(),
    );
    byTenant.set(tenantId, found);
  }
  return found;
}

/** Forget every tenant's names (tests). */
export function forgetPeople(): void {
  byTenant.clear();
  askedWith = null;
}

/** The names the tenants' user lists give, merged; read once per tenant. */
export function usePeople(token: string | null | undefined, tenantIds: readonly (string | null | undefined)[]): PeopleNames {
  const key = [...new Set(tenantIds.filter((t): t is string => !!t))].sort().join(",");
  const [names, setNames] = useState<PeopleNames>(new Map());
  useEffect(() => {
    if (!token || !key) return;
    let live = true;
    void Promise.all(key.split(",").map((t) => peopleOf(token, t))).then((lists) => {
      if (!live) return;
      const merged = new Map<string, string>();
      for (const l of lists) for (const [id, n] of l) merged.set(id, n);
      setNames(merged);
    });
    return () => {
      live = false;
    };
  }, [token, key]);
  return names;
}
