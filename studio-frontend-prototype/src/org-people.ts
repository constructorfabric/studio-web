/* ── Who is in an organization, as studio-user answers it (ADR-0037) ────────
 *
 * One answer to "who belongs here": studio-user's memberships. The screens
 * that pick a person for a grant, list an organization's people or a
 * project's team read it from here — never from account-management's
 * `/tenants/{id}/users`, which lists the identity provider's single home
 * tenant per account and is not membership.
 *
 * A member is keyed by the canonical person id (`user_id`), which is also what
 * every grant names (ADR-0037 §5), so a grant and a row match by id.
 */

import { api, type Colleague, type OrgMember } from "./api";
import type { GrantDef } from "./access";

export interface Member {
  /** The canonical person id — the key a grant names. */
  id: string;
  name: string;
  email?: string;
  /** The membership's role: owner, admin or member. */
  role: string;
}

const shortId = (id: string) => id.slice(0, 8);

/** From the administrative listing (`people.view`), active members only. */
export function fromMembers(members: OrgMember[]): Member[] {
  return members
    .filter((m) => m.status === "active")
    .map((m) => ({
      id: m.user_id,
      name: m.display_name?.trim() || m.email?.trim() || `Person ${shortId(m.user_id)}`,
      email: m.email ?? undefined,
      role: m.role,
    }));
}

/** From the colleague projection any member may read (ADR-0036), for one
 *  organization. Carries no address, by design. */
export function fromColleagues(colleagues: Colleague[], orgId: string): Member[] {
  return colleagues
    .filter((c) => c.org_id === orgId)
    .map((c) => ({
      id: c.user_id,
      name: c.display_name?.trim() || `Person ${shortId(c.user_id)}`,
      role: c.role,
    }));
}

/** Sorted by name, one row per person. */
export function byName(members: Member[]): Member[] {
  const seen = new Map<string, Member>();
  for (const m of members) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** An organization's members: the administrative listing when the caller may
 *  read it, otherwise the colleague projection — which every member may read.
 *  Throws only when neither can be read. */
export async function orgPeople(token: string, orgId: string): Promise<Member[]> {
  try {
    return byName(fromMembers(await api.orgMembers(token, orgId)));
  } catch {
    return byName(fromColleagues(await api.myColleagues(token), orgId));
  }
}

/** The name to show for a grant's holder: the member it names, else the name
 *  the grant was written with. A grant written before the rekey names a
 *  sign-in subject no member row carries, and shows its stored name. */
export function holderName(grant: GrantDef, members: Member[]): string {
  return members.find((m) => m.id === grant.subjectId)?.name ?? grant.subjectName;
}

/** The projects a member holds a project-scoped grant on. */
export function projectGrantsOf(memberId: string, grants: GrantDef[]): GrantDef[] {
  return grants.filter(
    (g) => g.subjectType === "member" && g.subjectId === memberId && g.scopeType === "project",
  );
}
