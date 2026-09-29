// The projects a desktop member can open, found the way the main portal finds them.
//
// Every level is an account-management tenant, listed as a tenant's children
// and told apart by `tenant_type`: organization → workspace (the portal's
// "root project") → project (a nested one, with sources of its own in its own
// workspace settings).
//
// Which organizations: the member's `studio-user` memberships, as the main
// portal takes them (studio-frontend `appContextEffects.ts`). Membership is the
// authority (ADR-0011 §2); the home tenant a token names is not, even where a
// listing under it answers — authorization is still allow-all (ADR-0004), and
// what it lets through is not what a member was given. The platform
// administrator walks the root, by role.

export const TENANT_TYPES = {
    organization: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~',
    workspace: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~',
    project: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~',
} as const;

/** The platform root: its caller reaches every organization by role, not membership. */
export const PLATFORM_ROOT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

/** account-management's own listing ceiling. */
const PAGE_LIMIT = 200;

export interface Tenant {
    id: string;
    name: string;
    tenant_type?: string;
}

/** A workspace (a root project) and the projects nested in it. */
export interface Workspace extends Tenant {
    nested: Tenant[];
}

/** An organization the member may switch to; `role` is theirs in it, from the membership. */
export interface MemberOrganization extends Tenant {
    role?: string;
}

export interface Organization extends MemberOrganization {
    projects: Workspace[];
}

/** GET a gear path (`/account-management/v1/...`) and answer its JSON, or throw. */
export type GetJson = (path: string) => Promise<unknown>;

const items = (page: unknown): Tenant[] => ((page as { items?: Tenant[] } | undefined)?.items ?? []);

function childrenPath(tenantId: string, tenantType?: string): string {
    const query = new URLSearchParams();
    if (tenantType) {
        query.set('$filter', `tenant_type eq '${tenantType}'`);
    }
    query.set('limit', String(PAGE_LIMIT));
    return `/account-management/v1/tenants/${tenantId}/children?${query}`;
}

/** A tenant's children of one type; none where the member cannot list them. */
async function childrenOf(get: GetJson, tenantId: string, tenantType: string): Promise<Tenant[]> {
    try {
        // Filtered twice: a backend that ignores `$filter` still answers right.
        return items(await get(childrenPath(tenantId, tenantType))).filter(t => t.tenant_type === tenantType);
    } catch {
        return [];
    }
}

async function tenantOf(get: GetJson, id: string): Promise<Tenant | undefined> {
    try {
        return await get(`/account-management/v1/tenants/${id}`) as Tenant;
    } catch {
        // From outside a self-managed organization the answer is 404 by
        // design: isolation working, so it is dropped rather than shown nameless.
        return undefined;
    }
}

/** The organizations this person may switch between, as the main portal lists them. */
export async function organizationsOf(get: GetJson): Promise<MemberOrganization[]> {
    const me = await get('/account-management/v1/me') as { subject_tenant_id?: string } | undefined;
    if (me?.subject_tenant_id === PLATFORM_ROOT_TENANT_ID) {
        return childrenOf(get, PLATFORM_ROOT_TENANT_ID, TENANT_TYPES.organization);
    }
    const memberships = ((await get('/studio-user/v1/me/memberships')) as { items?: { org_id: string; role?: string }[] } | undefined)?.items ?? [];
    const resolved = await Promise.all(memberships.map(async m => {
        const tenant = await tenantOf(get, m.org_id);
        return tenant && typeof m.role === 'string' && m.role ? { ...tenant, role: m.role } : tenant;
    }));
    return resolved.filter((t): t is MemberOrganization => !!t && t.tenant_type === TENANT_TYPES.organization);
}

/** Every organization with its workspaces, and each workspace with its nested projects. */
export async function projectsOf(get: GetJson): Promise<Organization[]> {
    const organizations = await organizationsOf(get);
    return Promise.all(organizations.map(async org => ({
        ...org,
        projects: await Promise.all((await childrenOf(get, org.id, TENANT_TYPES.workspace)).map(async ws => ({
            ...ws,
            nested: await childrenOf(get, ws.id, TENANT_TYPES.project),
        }))),
    })));
}
