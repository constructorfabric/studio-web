/* ── Access models, privileges and roles (concept → P1) ───────────────────────
 *
 * Two access models an organization can choose between (Admin → Access):
 *
 *   "tenant"  — access follows tenant membership: whoever is in the scope can
 *               act in it. This is today's behaviour (the platform's tenant
 *               model + static-authz plugin). No roles.
 *   "roles"   — role-based access: privileges are granted through named roles
 *               (a role IS a set of privileges), assigned to members/teams.
 *               Enforced by the Studio PDP plugin (ADR-0006) LAYERED OVER the
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

/** The Studio privilege catalogue. Ordered by resource family, then action. */
export const PRIVILEGES: Privilege[] = [
  { id: "project.view", group: "Projects", label: "View projects" },
  { id: "project.create", group: "Projects", label: "Create projects" },
  { id: "project.edit", group: "Projects", label: "Edit a project" },
  { id: "project.delete", group: "Projects", label: "Delete a project" },
  { id: "project.studio", group: "Projects", label: "Open Studio" },

  { id: "work.view", group: "Works", label: "View works" },
  { id: "work.create", group: "Works", label: "Create works" },
  { id: "work.edit", group: "Works", label: "Edit a work" },
  { id: "work.archive", group: "Works", label: "Archive a work" },

  { id: "artifact.view", group: "Artifacts", label: "View artifacts" },
  { id: "artifact.add", group: "Artifacts", label: "Add artifacts" },
  { id: "artifact.remove", group: "Artifacts", label: "Remove artifacts" },

  { id: "connector.view", group: "Connections", label: "View connections" },
  { id: "connector.manage", group: "Connections", label: "Manage connections" },

  { id: "secret.view", group: "Secrets", label: "View secrets" },
  { id: "secret.manage", group: "Secrets", label: "Manage secrets" },

  { id: "people.view", group: "People & Team", label: "View people" },
  { id: "people.invite", group: "People & Team", label: "Invite to the organization" },
  { id: "team.assign", group: "People & Team", label: "Assign people to a project team" },

  { id: "access.manage", group: "Administration", label: "Manage access, roles and grants" },
];

/** Catalogue grouped for the editor, preserving the order above. */
export function privilegesByGroup(): { group: string; items: Privilege[] }[] {
  const out: { group: string; items: Privilege[] }[] = [];
  for (const p of PRIVILEGES) {
    let bucket = out.find((b) => b.group === p.group);
    if (!bucket) {
      bucket = { group: p.group, items: [] };
      out.push(bucket);
    }
    bucket.items.push(p);
  }
  return out;
}

const ALL = PRIVILEGES.map((p) => p.id);

/** A role is a named set of privileges. `system` roles are seeded, non-deletable. */
export interface RoleDef {
  key: string;
  name: string;
  privileges: string[];
  system?: boolean;
}

/** The seeded roles for a fresh org (a sensible owner → viewer ladder). */
export function defaultRoles(): RoleDef[] {
  return [
    { key: "owner", name: "Owner", system: true, privileges: [...ALL] },
    {
      key: "admin",
      name: "Admin",
      system: true,
      // Everything except deleting a project.
      privileges: ALL.filter((id) => id !== "project.delete"),
    },
    {
      key: "editor",
      name: "Editor",
      system: true,
      privileges: [
        "project.view",
        "project.edit",
        "project.studio",
        "work.view",
        "work.create",
        "work.edit",
        "work.archive",
        "artifact.view",
        "artifact.add",
        "artifact.remove",
        "connector.view",
        "secret.view",
        "people.view",
      ],
    },
    {
      key: "viewer",
      name: "Viewer",
      system: true,
      privileges: PRIVILEGES.filter((p) => p.id.endsWith(".view")).map((p) => p.id),
    },
  ];
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

export function defaultAccessConfig(): AccessConfig {
  return { model: "tenant", roles: defaultRoles(), grants: [] };
}

/** Fill in any missing pieces so an older/partial stored config still renders. */
export function normalizeAccessConfig(v: Partial<AccessConfig> | null | undefined): AccessConfig {
  const model: AccessModel = v?.model === "roles" ? "roles" : "tenant";
  const roles = v?.roles && v.roles.length ? v.roles : defaultRoles();
  const grants = Array.isArray(v?.grants) ? (v!.grants as GrantDef[]) : [];
  return { model, roles, grants };
}
