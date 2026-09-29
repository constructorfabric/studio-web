import {
    ReferenceEntry,
    ReferenceSources,
    ReferenceReadiness,
    activityText,
    demandText,
    emptyMessage,
    filterEntries,
    kindCounts,
    loadComponentsReference,
    profilePercent,
    planWarning,
    releaseText,
    scheduleText,
    sourceText,
    stageTone,
} from './components-reference-model';

function answer(status: number, body: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function entry(over: Partial<ReferenceEntry>): ReferenceEntry {
    return {
        name: 'x',
        title: null,
        type_id: 'gts.cf.studio.catalog.gear.v1~',
        kind: 'gear',
        category: null,
        description: null,
        status: null,
        version: null,
        version_source: null,
        num_versions: null,
        downloads: null,
        recent_downloads: null,
        updated_at: null,
        repository: null,
        repo_path: null,
        synced_from: null,
        sources: [],
        profile_filled: null,
        profile_fields: null,
        activity: null,
        engine: [],
        related: [],
        ...over,
    };
}

const accountManagement = entry({
    name: 'cf-gears-account-management',
    title: 'Account Management',
    description: 'Reference multi-tenant account management',
    version: '0.10.0',
    version_source: 'crates.io',
    num_versions: 12,
    downloads: 792,
    profile_filled: 21,
    profile_fields: 62,
    repository: 'https://github.com/constructorfabric/gears-rust',
    repo_path: 'gears/system/account-management',
    synced_from: 'constructorfabric/gears-rust',
    engine: [{
        id: 'account-management', display_name: 'Account Management', role: 'service', category: 'oss',
        gdl_path: null, runtime_caps: ['db'], colocated_deps: [], extension_points: [], fills: null, hosts: [], plugins: [],
    }],
});
const sdk = entry({ name: 'cf-gears-account-management-sdk', kind: 'sdk', version: '0.7.5', version_source: 'crates.io' });
const uiKit = entry({ name: '@gears-frontx/ui-kit', kind: 'frontx', category: 'hai3', version: '0.4.0', version_source: 'declared' });
const draft = entry({ name: 'cf-gears-approval-service', status: 'draft' });

const measured: ReferenceSources = {
    gearbox_corpus: 'MikeFalcon77/gears-rust@feature/gearbox (a0a42ce)',
    gearbox_problem: null,
    activity_days: 90,
    activity_from: '2026-07-02',
    activity_to: '2026-09-29',
    activity_problem: null,
};
const unmeasured: ReferenceSources = { ...measured, activity_days: null, activity_problem: 'studio-insight is not configured' };

describe('components reference model', () => {
    const all = [accountManagement, sdk, uiKit, draft];

    it('counts kinds in the order the filter offers them', () => {
        expect(kindCounts(all)).toEqual([
            { kind: 'gear', count: 2 },
            { kind: 'sdk', count: 1 },
            { kind: 'frontx', count: 1 },
        ]);
    });

    it('finds a component by its engine id and filters by kind', () => {
        const none = new Set<string>();
        expect(filterEntries(all, { query: 'account-management', kinds: none, addableOnly: false }).map(e => e.name))
            .toEqual(['cf-gears-account-management', 'cf-gears-account-management-sdk']);
        expect(filterEntries(all, { query: '', kinds: new Set(['frontx']), addableOnly: false }).map(e => e.name))
            .toEqual(['@gears-frontx/ui-kit']);
        expect(filterEntries(all, { query: '', kinds: none, addableOnly: true }).map(e => e.name))
            .toEqual(['cf-gears-account-management']);
    });

    it('says where a version came from, and tells a draft from an unpublished crate', () => {
        expect(releaseText(accountManagement)).toBe('0.10.0 · 12 versions');
        expect(releaseText(uiKit)).toBe('0.4.0 (declared, not on a registry)');
        expect(releaseText(draft)).toBe('Draft — documents only, no crate');
        // Nothing to say is said by saying nothing.
        expect(releaseText(entry({}))).toBeNull();
    });

    it('tells not measured from nothing moved', () => {
        expect(activityText(accountManagement, unmeasured)).toBeNull();
        expect(activityText(accountManagement, measured)).toBe('No activity recorded in 90 days');
        expect(activityText({ ...accountManagement, activity: { commits: 3, files_changed: 4, lines_added: 10, lines_removed: 2, authors: 1 } }, measured))
            .toBe('3 commits · +10 −2 · 1 authors');
    });

    it('has no profile percentage without a schema, rather than zero', () => {
        expect(profilePercent(accountManagement)).toBe(34);
        expect(profilePercent(uiKit)).toBeNull();
    });

    it('names the source by repository and directory', () => {
        expect(sourceText(accountManagement)).toBe('constructorfabric/gears-rust/gears/system/account-management');
        expect(sourceText(entry({ repository: 'https://github.com/constructorfabric/gears-rust' }))).toBe('constructorfabric/gears-rust');
        expect(sourceText(entry({}))).toBeNull();
    });

    const ready: ReferenceReadiness = {
        stage: 'In Dev', stage_at: 3, stage_of: 6, lifecycle: 'in qa',
        milestone: '26.10', due: '2026-10-31', committed: false,
        plan: 'check', plan_lamp: 'watch', plan_reasons: ['P1 for Acronis, but the date is not a commitment'],
        demand: [{ consumer: 'Virtuozzo', priority: 3 }, { consumer: 'Acronis', priority: 1 }],
        progress: [{ label: 'Design', value: 'Done', pct: 100 }],
        last_release: 'v0.2.8', released_on: '2026-09-23', used_by: 3, roadmap_item: null,
    };

    it('places a stage in its pipeline', () => {
        expect(stageTone(ready)).toBe('early');
        expect(stageTone({ ...ready, stage_at: 5 })).toBe('late');
        expect(stageTone({ ...ready, stage_at: 6 })).toBe('done');
        expect(stageTone({ ...ready, stage_at: 1 })).toBe('idle');
        expect(stageTone(null)).toBe('idle');
    });

    it('says whether the date holds', () => {
        const sep = new Date('2026-09-29T00:00:00Z');
        expect(scheduleText(ready, sep)).toEqual({ text: 'Check', lamp: 'watch' });
        expect(scheduleText({ ...ready, plan_lamp: 'good', plan: 'on track' }, sep)).toEqual({ text: 'On target', lamp: 'good' });
        expect(scheduleText({ ...ready, due: '2026-07-31' }, sep)).toEqual({ text: '2 months late', lamp: 'bad' });
        expect(scheduleText({ ...ready, due: null }, sep)).toEqual({ text: 'No date', lamp: 'none' });
        expect(scheduleText({ ...ready, plan: 'delivered', due: '2026-01-31' }, sep)).toEqual({ text: 'Delivered', lamp: 'good' });
        expect(scheduleText({ ...ready, milestone: null, plan: null }, sep)).toBeNull();
    });

    it('lists demand most urgent first and warns only on amber or red', () => {
        expect(demandText(ready)).toBe('Acronis P1 · Virtuozzo P3');
        expect(demandText({ ...ready, demand: [] })).toBeNull();
        expect(planWarning(ready)).toEqual({ lamp: 'watch', text: 'P1 for Acronis, but the date is not a commitment' });
        expect(planWarning({ ...ready, plan_lamp: 'good' })).toBeNull();
    });

    it('explains an empty list by why it is empty', () => {
        expect(emptyMessage(0, 0)).toMatch(/no components yet/);
        expect(emptyMessage(5, 0)).toMatch(/No component matches/);
        expect(emptyMessage(5, 2)).toBeUndefined();
    });

    it('reads the reference in one request and turns a refusal into a sentence', async () => {
        const asked: string[] = [];
        const ok = await loadComponentsReference(async path => {
            asked.push(path);
            return answer(200, { items: [accountManagement], total: 1, truncated: false, sources: measured });
        });
        expect(asked).toEqual(['/studio-components-catalog/v1/reference?days=90']);
        expect(ok.kind === 'ok' && ok.reference.items.length).toBe(1);

        const refused = await loadComponentsReference(async () => answer(401, {}));
        expect(refused).toEqual({ kind: 'error', message: expect.stringMatching(/not signed in/) });

        const down = await loadComponentsReference(async () => { throw new Error('offline'); });
        expect(down).toEqual({ kind: 'error', message: expect.stringMatching(/could not be reached: offline/) });
    });
});
