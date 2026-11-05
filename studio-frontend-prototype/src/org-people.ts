/* ── Who is in an organization, as studio-user answers it (ADR-0040) ────────
 *
 * One answer to "who belongs here": studio-user's memberships. The screens
 * that pick a person for a grant, list an organization's people or a
 * project's team read it from here — never from account-management's
 * `/tenants/{id}/users`, which lists the identity provider's single home
 * tenant per account and is not membership.
 *
 * A member is keyed by the canonical person id (`user_id`), which is also what
 * every grant names (ADR-0040 §5), so a grant and a row match by id.
 */

import { api, type Colleague, type OrgMember, type User } from "./api";
import { normalizeAccessConfig, type GrantDef } from "./access";

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

/** A member with what the colleague projection adds about them: photo, how
 *  the organization describes them, and when they were last seen. */
export interface PersonRow extends Member {
  avatarUrl?: string;
  directory?: Colleague["directory"];
  lastSeenMs?: number;
}

/** The members, each joined to their colleague row by person id, so one
 *  list carries both the address (administrative listing) and the photo and
 *  last-seen (colleague projection). A member with no colleague row keeps
 *  what it had. */
export function withColleagues(members: Member[], colleagues: Colleague[], orgId: string): PersonRow[] {
  const byId = new Map(colleagues.filter((c) => c.org_id === orgId).map((c) => [c.user_id, c]));
  return members.map((m) => {
    const c = byId.get(m.id);
    if (!c) return m;
    return {
      ...m,
      ...(c.avatar_url ? { avatarUrl: c.avatar_url } : {}),
      directory: c.directory,
      ...(c.last_seen_at_epoch_ms != null ? { lastSeenMs: c.last_seen_at_epoch_ms } : {}),
    };
  });
}

/** Who is on one project, as the Team section has it: under role access the
 *  members a grant reaches it (org-wide or scoped to it), under tenant access
 *  every member. Studio's memberships, not account management's users list:
 *  that one names each account's single home tenant and needs the identity
 *  provider, which a stand may not have. */
export async function projectTeam(token: string, orgId: string, projectId: string): Promise<User[]> {
  const [members, access] = await Promise.all([orgPeople(token, orgId), api.accessConfig(token, orgId).catch(() => null)]);
  const cfg = normalizeAccessConfig(access, []);
  const on =
    cfg.model === "roles"
      ? new Set(
          cfg.grants
            .filter((g) => g.subjectType === "member" && (g.scopeType === "org" || (g.scopeType === "project" && g.scopeId === projectId)))
            .map((g) => g.subjectId),
        )
      : null;
  return members
    .filter((m) => !on || on.has(m.id))
    .map((m) => ({ id: m.id, username: m.email?.split("@")[0] ?? m.name, email: m.email, display_name: m.name }));
}
