import type { Organization } from './desktop-projects';
import {
    collapsedStorageKey, filteredOutEverything, locate, openableIds, organizationHints, parseCollapsed, portalUrl,
    pruneCollapsed, sourcesStateOf, studioLabel, toggleCollapsed, treeKey, treeRows,
} from './desktop-studio-tree';

const org = (id: string, name: string, projects: Organization['projects'] = [], role?: string): Organization =>
    ({ id, name, role, projects });
const ws = (id: string, name: string, nested: { id: string; name: string }[] = []) => ({ id, name, nested });

// Three organizations called the same, as on Dev, and one that is not.
const FABRIC_A = org('0b6f2c1e-1111-4000-8000-000000000001', 'Constructor Fabric', [
    ws('ws-gears', 'Gears workspace', [{ id: 'p-web', name: 'Studio-web' }, { id: 'p-rust', name: 'Gears-Rust' }]),
], 'owner');
const FABRIC_B = org('7d41aa90-2222-4000-8000-000000000002', 'Constructor Fabric', [ws('ws-docs', 'Docs')], 'member');
const FABRIC_C = org('c31da936-3333-4000-8000-000000000003', 'constructor fabric ', [], 'member');
const ACME = org('a-1', 'Acme', [ws('ws-pay', 'Payments', [{ id: 'p-api', name: 'api' }])], 'member');
const ALL = [FABRIC_A, FABRIC_B, FABRIC_C, ACME];

describe('organizations with one name', () => {
    it('are told apart by the start of their tenant id, and by the role where the roles differ', () => {
        const hints = organizationHints(ALL);
        expect(hints.get(FABRIC_A.id)).toBe('0b6f2c1e · owner');
        expect(hints.get(FABRIC_B.id)).toBe('7d41aa90 · member');
        expect(hints.get(FABRIC_C.id)).toBe('c31da936 · member');
    });

    it('leave a unique name alone', () => {
        expect(organizationHints(ALL).has(ACME.id)).toBe(false);
        expect(organizationHints([FABRIC_A, ACME]).size).toBe(0);
    });

    it('show no role when every one of them has the same', () => {
        const hints = organizationHints([FABRIC_B, FABRIC_C]);
        expect(hints.get(FABRIC_B.id)).toBe('7d41aa90');
    });

    it('take more of the id when the start is shared', () => {
        const a = org('abcdef12-0000-4000-8000-00000000000a', 'Twin');
        const b = org('abcdef12-9999-4000-8000-00000000000b', 'Twin');
        const hints = organizationHints([a, b]);
        expect(hints.get(a.id)).toBe('abcdef120000');
        expect(hints.get(b.id)).toBe('abcdef129999');
    });
});

describe('the tree', () => {
    it('lists organizations, then their workspaces, then the nested projects, with levels and folders', () => {
        const rows = treeRows([FABRIC_A, ACME]);
        expect(rows.map(r => [r.kind, r.name, r.level])).toEqual([
            ['organization', 'Constructor Fabric', 1],
            ['workspace', 'Gears workspace', 2],
            ['project', 'Studio-web', 3],
            ['project', 'Gears-Rust', 3],
            ['organization', 'Acme', 1],
            ['workspace', 'Payments', 2],
            ['project', 'api', 3],
        ]);
        expect(rows.find(r => r.id === 'p-web')).toMatchObject({ folder: 'Gears workspace - Studio-web', parentId: 'ws-gears', workspaceId: 'ws-gears' });
        expect(rows.find(r => r.id === 'ws-gears')).toMatchObject({ folder: 'Gears workspace', parentId: FABRIC_A.id });
    });

    it('does not name the organization when there is only one, as the portal hides it', () => {
        const rows = treeRows([ACME]);
        expect(rows.map(r => [r.kind, r.level, r.parentId])).toEqual([['workspace', 1, undefined], ['project', 2, 'ws-pay']]);
    });

    it('marks an organization with no projects as not expandable', () => {
        expect(treeRows(ALL).find(r => r.id === FABRIC_C.id)).toMatchObject({ expandable: false, expanded: false, hint: 'c31da936 · member' });
    });

    it('hides what is under a collapsed row', () => {
        const rows = treeRows([FABRIC_A, ACME], { collapsed: new Set([FABRIC_A.id, 'ws-pay']) });
        expect(rows.map(r => r.name)).toEqual(['Constructor Fabric', 'Acme', 'Payments']);
        expect(rows[0].expanded).toBe(false);
        expect(rows[2].expanded).toBe(false);
    });

    it('keeps a matching project with the rows above it, expanded whatever was closed', () => {
        const rows = treeRows(ALL, { filter: 'WEB', collapsed: new Set([FABRIC_A.id, 'ws-gears']) });
        expect(rows.map(r => r.name)).toEqual(['Constructor Fabric', 'Gears workspace', 'Studio-web']);
        expect(rows.every(r => !r.expandable || r.expanded)).toBe(true);
    });

    it('keeps everything under a matching workspace or organization', () => {
        expect(treeRows(ALL, { filter: 'payments' }).map(r => r.name)).toEqual(['Acme', 'Payments', 'api']);
        expect(treeRows(ALL, { filter: 'acme' }).map(r => r.name)).toEqual(['Acme', 'Payments', 'api']);
    });

    it('tells a filter that matched nothing from an empty list', () => {
        expect(filteredOutEverything(ALL, 'zzz')).toBe(true);
        expect(filteredOutEverything(ALL, '  ')).toBe(false);
        expect(filteredOutEverything([], '')).toBe(false);
    });
});

describe('the collapse state', () => {
    it('is kept per Studio', () => {
        expect(collapsedStorageKey('https://studio-dev.cfabric.org/')).toBe(collapsedStorageKey('https://studio-dev.cfabric.org'));
        expect(collapsedStorageKey('https://studio-dev.cfabric.org')).not.toBe(collapsedStorageKey('https://studio-test.cfabric.org'));
    });

    it('reads back what was stored, and nothing from anything else', () => {
        expect([...parseCollapsed(['a', 3, 'b'])]).toEqual(['a', 'b']);
        expect(parseCollapsed(undefined).size).toBe(0);
        expect(parseCollapsed({ a: 1 }).size).toBe(0);
    });

    it('toggles, or sets one way', () => {
        const closed = toggleCollapsed(new Set(), 'x');
        expect(closed.has('x')).toBe(true);
        expect(toggleCollapsed(closed, 'x').has('x')).toBe(false);
        expect(toggleCollapsed(closed, 'x', false).has('x')).toBe(true);
        expect(toggleCollapsed(closed, 'x', true).has('x')).toBe(false);
    });

    it('forgets rows that are gone', () => {
        expect([...pruneCollapsed(new Set([ACME.id, 'ws-pay', 'gone']), ALL)].sort()).toEqual([ACME.id, 'ws-pay'].sort());
    });
});

describe('the keyboard', () => {
    const rows = treeRows([FABRIC_A, ACME]);

    it('moves up and down, to the ends, and stops at them', () => {
        expect(treeKey(rows, FABRIC_A.id, 'ArrowDown')).toEqual({ type: 'focus', id: 'ws-gears' });
        expect(treeKey(rows, FABRIC_A.id, 'ArrowUp')).toEqual({ type: 'focus', id: FABRIC_A.id });
        expect(treeKey(rows, 'p-api', 'ArrowDown')).toEqual({ type: 'focus', id: 'p-api' });
        expect(treeKey(rows, 'ws-gears', 'End')).toEqual({ type: 'focus', id: 'p-api' });
        expect(treeKey(rows, 'ws-gears', 'Home')).toEqual({ type: 'focus', id: FABRIC_A.id });
        expect(treeKey(rows, undefined, 'ArrowDown')).toEqual({ type: 'focus', id: FABRIC_A.id });
    });

    it('closes an open row on Left, and goes to the parent from a closed one or a leaf', () => {
        expect(treeKey(rows, 'ws-gears', 'ArrowLeft')).toEqual({ type: 'collapse', id: 'ws-gears' });
        expect(treeKey(rows, 'p-web', 'ArrowLeft')).toEqual({ type: 'focus', id: 'ws-gears' });
        expect(treeKey(rows, FABRIC_A.id, 'ArrowLeft')).toEqual({ type: 'collapse', id: FABRIC_A.id });
        const closed = treeRows([FABRIC_A, ACME], { collapsed: new Set([FABRIC_A.id]) });
        expect(treeKey(closed, FABRIC_A.id, 'ArrowLeft')).toBeUndefined();
    });

    it('opens a closed row on Right, and goes into an open one', () => {
        const closed = treeRows([FABRIC_A, ACME], { collapsed: new Set(['ws-gears']) });
        expect(treeKey(closed, 'ws-gears', 'ArrowRight')).toEqual({ type: 'expand', id: 'ws-gears' });
        expect(treeKey(rows, 'ws-gears', 'ArrowRight')).toEqual({ type: 'focus', id: 'p-web' });
        expect(treeKey(rows, 'p-web', 'ArrowRight')).toBeUndefined();
    });

    it('activates on Enter and Space, and ignores other keys', () => {
        expect(treeKey(rows, 'p-web', 'Enter')).toEqual({ type: 'activate', id: 'p-web' });
        expect(treeKey(rows, 'p-web', ' ')).toEqual({ type: 'activate', id: 'p-web' });
        expect(treeKey(rows, 'p-web', 'a')).toBeUndefined();
        expect(treeKey([], 'p-web', 'ArrowDown')).toBeUndefined();
    });
});

describe('where a project is', () => {
    it('is found with its organization and workspace', () => {
        expect(locate(ALL, 'p-web')).toMatchObject({ organization: { id: FABRIC_A.id }, workspace: { id: 'ws-gears' }, project: { id: 'p-web' } });
        expect(locate(ALL, 'ws-docs')).toMatchObject({ organization: { id: FABRIC_B.id }, workspace: { id: 'ws-docs' } });
        expect(locate(ALL, 'ws-docs')!.project).toBeUndefined();
        expect(locate(ALL, 'nope')).toBeUndefined();
        expect(locate(undefined, 'p-web')).toBeUndefined();
    });

    it('lists every workspace and nested project to ask the sources of', () => {
        expect(openableIds(ALL)).toEqual(['ws-gears', 'p-web', 'p-rust', 'ws-docs', 'ws-pay', 'p-api']);
    });

    it('has an address in the portal', () => {
        expect(portalUrl('https://studio.example.com/', { organization: 'o', workspace: 'w' }))
            .toBe('https://studio.example.com/?screen=projects;org=o;workspace=w');
        expect(portalUrl('https://studio.example.com', { organization: 'o', workspace: 'w', project: 'p' }))
            .toBe('https://studio.example.com/?screen=projects;org=o;workspace=w;project=p');
    });
});

describe('what a sources listing says', () => {
    it('counts the repositories a desktop can clone', () => {
        expect(sourcesStateOf(200, { items: [{}, {}], total: 2 })).toEqual({ state: 'ready', repositories: 2 });
        expect(sourcesStateOf(200, { items: [{}] })).toEqual({ state: 'ready', repositories: 1 });
    });

    it('is "none yet" for an empty list, and for studio-git naming the project in its 404', () => {
        expect(sourcesStateOf(200, { items: [], total: 0 })).toEqual({ state: 'empty' });
        expect(sourcesStateOf(404, { status: 404, context: { resource_name: 'p-web' } })).toEqual({ state: 'empty' });
    });

    it('does not guess when the answer says nothing about the project', () => {
        // The gateway's own 404: this Studio runs no studio-git.
        expect(sourcesStateOf(404, undefined)).toEqual({ state: 'unknown' });
        expect(sourcesStateOf(500, { items: [] })).toEqual({ state: 'unknown' });
        expect(sourcesStateOf(403, {})).toEqual({ state: 'unknown' });
        expect(sourcesStateOf(200, 'not json')).toEqual({ state: 'unknown' });
    });
});

describe('the Studio the header names', () => {
    it('is the environment and its host', () => {
        expect(studioLabel('https://studio-dev.cfabric.org', { id: 'dev', label: 'Dev' })).toEqual({ name: 'Dev', host: 'studio-dev.cfabric.org' });
    });

    it('is the host alone for an address typed in or pinned', () => {
        expect(studioLabel('http://127.0.0.1:8090/', { id: 'custom', label: '127.0.0.1:8090' })).toEqual({ name: undefined, host: '127.0.0.1:8090' });
        expect(studioLabel('http://127.0.0.1:8090', undefined)).toEqual({ name: undefined, host: '127.0.0.1:8090' });
    });
});
