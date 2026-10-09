/* ── Access models, privileges and roles (concept → P1) ───────────────────────
 *
 * Two access models an organization can choose between (Admin → Access):
 *
 *   "tenant"  — access follows tenant membership: whoever is in the scope can
 *               act in it. This is today's behaviour (the platform's tenant
 *               model + static-authz plugin). No roles.
 *   "roles"   — role-based access: privileges are granted through named roles
 *               (a role IS a set of privileges), assigned to members/teams.
 *               Enforced by the Studio PDP plugin LAYERED OVER the
 *               tenant model (ADR-0009): tenant isolation is always the outer
 *               bound, roles only narrow access within the tenant — a member
 *               with no matching grant is denied, and no grant can reach across
 *               tenants.
 *
 * The choice and the org's role definitions are stored as AM tenant metadata
 * (same mechanism as the automation "trust ramp"), so this is backend-backed
 * without a new gear. A privilege here mirrors a platform Permission
 * ({resource_type, action}); the catalogue below is the Studio set we will
 * later register as GTS permission instances in types-registry.
 */

export type AccessModel = "tenant" | "roles";

export const ACCESS_MODELS: { id: AccessModel; label: string; blurb: string }[] = [
  {
    id: "tenant",
    label: "Tenant access",
    blurb:
      "Access follows membership: anyone in an organization or project can act within it. Simple, no roles to manage.",
  },
  {
    id: "roles",
    label: "Role-based access",
    blurb:
      "Access is granted through roles — each role is a set of privileges — assigned to members and teams. Fine-grained, but you manage roles.",
  },
];

/** One privilege = a Studio resource + a concrete action (a platform Permission). */
export interface Privilege {
  id: string;
  /** UI grouping (the resource family). */
  group: string;
  label: string;
}

/** What this portal CALLS each privilege.
 *
 *  The ids are the server's (`GET /studio-organizations/v1/access-catalogue`),
 *  and they are the half that must not drift: a privilege named on the writing
 *  side and not on the evaluating side is written into a role and then carries
 *  nothing. That list used to be copied here, with a test that parsed
 *  `access_config.rs` to prove the copy still matched.
 *
 *  The names are not served and should not be. A backend shipping English here
 *  would be handing a portal with i18n a second set of strings to ignore. So
 *  this map is presentation, keyed by id, and an id it does not know still
 *  renders — under its own name, in a group of its own.
 *
 *  The order of the groups is the order they are declared in. */
const PRIVILEGE_LABELS: Record<string, { group: string; label: string }> = {
  "people.view": { group: "People & Team", label: "View people" },
  "people.invite": { group: "People & Team", label: "Invite to the organization" },
  "people.manage": { group: "People & Team", label: "Manage memberships and roles" },

  "access.manage": { group: "Administration", label: "Manage roles and grants" },

  "connector.view": { group: "Connections", label: "View connections" },
  "connector.manage": { group: "Connections", label: "Manage connections" },

  "secret.view": { group: "Secrets", label: "View secrets" },
  "secret.manage": { group: "Secrets", label: "Manage secrets" },

  "document.view": { group: "Documents", label: "View documents" },
  "document.edit": { group: "Documents", label: "Edit documents" },

  "session.open": { group: "Sessions", label: "Open a workspace in the IDE" },

  "domain.view": { group: "Domain model", label: "View domain objects" },
  "domain.edit": { group: "Domain model", label: "Create and edit domain objects" },
  "domain.model": { group: "Domain model", label: "Change the domain model" },

  "component.registry": { group: "Components", label: "Decide about the component registry" },
};

/** Name one privilege id for the screen.
 *
 *  An id this portal has no string for is shown rather than hidden: the server
 *  is the authority on what exists, and a privilege the PDP understands but
 *  this build has never heard of is exactly what somebody needs to see. */
export function describePrivilege(id: string): Privilege {
  const known = PRIVILEGE_LABELS[id];
  return { id, group: known?.group ?? "Other", label: known?.label ?? id };
}

/** The catalogue grouped for the editor, in the server's order. */
export function privilegesByGroup(ids: readonly string[]): { group: string; items: Privilege[] }[] {
  const out: { group: string; items: Privilege[] }[] = [];
  for (const id of ids) {
    const p = describePrivilege(id);
    let bucket = out.find((b) => b.group === p.group);
    if (!bucket) {
      bucket = { group: p.group, items: [] };
      out.push(bucket);
    }
    bucket.items.push(p);
  }
  return out;
}

/** A role is a named set of privileges. `system` roles are seeded, non-deletable. */
export interface RoleDef {
  key: string;
  name: string;
  privileges: string[];
  system?: boolean;
}

/** A grant binds a subject (member or team) to a role within a scope
 *  (the whole organization, or one project). This is the (member/team × role ×
 *  scope) tuple the PDP will read. */
export interface GrantDef {
  id: string;
  subjectType: "member" | "team";
  subjectId: string;
  subjectName: string;
  roleKey: string;
  scopeType: "org" | "project";
  /** Tenant id (org) or project id; empty string means the whole organization. */
  scopeId: string;
  scopeName: string;
}

export interface AccessConfig {
  model: AccessModel;
  roles: RoleDef[];
  grants: GrantDef[];
}

/** Fill in any missing pieces so an older/partial stored config still renders.
 *
 *  `seeded` is the ladder the server seeds a fresh organization with, read from
 *  the access catalogue. It used to be built here, which meant a screen that
 *  saves could overwrite the stored ladder with the browser's idea of it —
 *  and a grant naming a role the document does not contain carries nothing. */
export function normalizeAccessConfig(
  v: Partial<AccessConfig> | null | undefined,
  seeded: readonly RoleDef[],
): AccessConfig {
  const model: AccessModel = v?.model === "roles" ? "roles" : "tenant";
  const roles = v?.roles && v.roles.length ? v.roles : [...seeded];
  const grants = Array.isArray(v?.grants) ? (v!.grants as GrantDef[]) : [];
  return { model, roles, grants };
}
