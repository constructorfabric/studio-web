import { PLATFORM_ROOT_TENANT_ID, TENANT_TYPES, projectsOf } from './desktop-projects';

const org = (id: string, name: string) => ({ id, name, tenant_type: TENANT_TYPES.organization });
const workspace = (id: string, name: string) => ({ id, name, tenant_type: TENANT_TYPES.workspace });
const project = (id: string, name: string) => ({ id, name, tenant_type: TENANT_TYPES.project });

const ACME = org('org-1', 'Acme');
const FABRIC = org('org-2', 'Constructor Fabric');
const PAYMENTS = workspace('ws-1', 'Payments');
const GEARS = workspace('ws-2', 'Gears workspace');
const RUST = project('p-1', 'Gears-Rust');
const WEB = project('p-2', 'Studio-web');

/**
 * A Studio answering the paths the desktop asks, and remembering which. A
 * children listing answers with every child, whatever `$filter` says, so the
 * desktop's own filter is what is tested.
 */
function studio(routes: Record<string, unknown>) {
    const asked: string[] = [];
    const get = async (path: string): Promise<unknown> => {
        asked.push(path);
        const key = Object.keys(routes).find(route => path === route || path.startsWith(`${route}?`));
        if (!key) {
            throw new Error('HTTP 404');
        }
        return routes[key];
    };
    return { get, asked };
}

const children = (id: string) => `/account-management/v1/tenants/${id}/children`;
const tenant = (id: string) => `/account-management/v1/tenants/${id}`;

describe('the projects a desktop member sees', () => {
    it('come from the organizations they are a member of, with each workspace\'s nested projects', async () => {
        const { get } = studio({
            '/account-management/v1/me': { subject_tenant_id: 'home-tenant' },
            '/studio-user/v1/me/memberships': { items: [{ org_id: ACME.id, role: 'member' }] },
            [tenant(ACME.id)]: ACME,
            [children(ACME.id)]: { items: [PAYMENTS, project('stray', 'not a workspace')] },
            [children(PAYMENTS.id)]: { items: [RUST, WEB] },
        });
        expect(await projectsOf(get)).toEqual([{ ...ACME, role: 'member', projects: [{ ...PAYMENTS, nested: [RUST, WEB] }] }]);
    });

    it('never come from the home tenant the token names, only from membership (ADR-0011)', async () => {
        const { get, asked } = studio({
            '/account-management/v1/me': { subject_tenant_id: FABRIC.id },
            '/studio-user/v1/me/memberships': { items: [{ org_id: ACME.id }] },
            [tenant(ACME.id)]: ACME,
            [tenant(FABRIC.id)]: FABRIC,
            [children(ACME.id)]: { items: [PAYMENTS] },
            [children(PAYMENTS.id)]: { items: [] },
            [children(FABRIC.id)]: { items: [GEARS] },
        });
        expect((await projectsOf(get)).map(o => o.name)).toEqual(['Acme']);
        expect(asked.some(path => path.includes(FABRIC.id))).toBe(false);
    });

    it('leave out an organization whose tenant cannot be read, and a listing that is refused', async () => {
        const { get } = studio({
            '/account-management/v1/me': {},
            '/studio-user/v1/me/memberships': { items: [{ org_id: 'org-hidden' }, { org_id: ACME.id }] },
            [tenant(ACME.id)]: ACME,
        });
        expect(await projectsOf(get)).toEqual([{ ...ACME, projects: [] }]);
    });

    it('are every organization\'s for the platform administrator', async () => {
        const { get, asked } = studio({
            '/account-management/v1/me': { subject_tenant_id: PLATFORM_ROOT_TENANT_ID },
            [children(PLATFORM_ROOT_TENANT_ID)]: { items: [ACME, { id: 'x', name: 'x', tenant_type: 'other' }] },
            [children(ACME.id)]: { items: [PAYMENTS] },
            [children(PAYMENTS.id)]: { items: [] },
        });
        expect(await projectsOf(get)).toEqual([{ ...ACME, projects: [{ ...PAYMENTS, nested: [] }] }]);
        expect(asked).not.toContain('/studio-user/v1/me/memberships');
    });

    it('are none, not an error, for a person with no organization', async () => {
        const { get } = studio({
            '/account-management/v1/me': {},
            '/studio-user/v1/me/memberships': { items: [] },
        });
        expect(await projectsOf(get)).toEqual([]);
    });

    it('filter each listing by type on the server too', async () => {
        const { get, asked } = studio({
            '/account-management/v1/me': {},
            '/studio-user/v1/me/memberships': { items: [{ org_id: ACME.id }] },
            [tenant(ACME.id)]: ACME,
            [children(ACME.id)]: { items: [PAYMENTS] },
            [children(PAYMENTS.id)]: { items: [] },
        });
        await projectsOf(get);
        const filter = (id: string) => new URL(asked.find(p => p.includes(`${id}/children`))!, 'http://studio').searchParams.get('$filter');
        expect(filter(ACME.id)).toBe(`tenant_type eq '${TENANT_TYPES.workspace}'`);
        expect(filter(PAYMENTS.id)).toBe(`tenant_type eq '${TENANT_TYPES.project}'`);
    });
});
