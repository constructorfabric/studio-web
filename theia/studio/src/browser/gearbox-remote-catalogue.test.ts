import {
    loadRemoteGearCatalogue,
    remoteGearCatalogueChanged,
    remoteGearCatalogueRefused,
    remoteGearCatalogueSignedIn,
} from './gearbox-remote-catalogue';

function answer(status: number, body: unknown): () => Promise<Response> {
    return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
}

describe('loadRemoteGearCatalogue', () => {
    it('passes every descriptor of the backend\'s corpus through, and names the corpus', async () => {
        const api = { id: 'api-gateway', source: 'gears-rust', gdl_path: 'gears/api-gateway/gear.gdl' };
        const authn = { id: 'authn', source: 'gears-rust', gdl_path: 'gears/authn/gear.gdl' };
        const fetchApi = jest.fn(answer(200, {
            source_id: 'gears-rust',
            corpus: 'constructorfabric/gears-rust@main',
            catalogue: { gears: { 'api-gateway': api, authn }, contracts: {}, sources: {} },
        }));

        const remote = await loadRemoteGearCatalogue(fetchApi);

        expect(fetchApi).toHaveBeenCalledWith('/studio-product/v1/gearbox/catalogue');
        expect(remote).toEqual({ corpus: 'constructorfabric/gears-rust@main', gears: [api, authn] });
    });

    it('says where a copy can be cloned from, at the commit the gears were read at', async () => {
        const remote = await loadRemoteGearCatalogue(answer(200, {
            source_id: 'gears-rust',
            corpus: 'o/gears-rust@main',
            corpus_url: 'https://github.com/o/gears-rust.git',
            corpus_ref: 'main',
            corpus_commit: 'a'.repeat(40),
            corpus_needs_token: true,
            catalogue: { gears: { g: { id: 'g' } } },
        }));

        expect(remote?.origin).toEqual({ sourceId: 'gears-rust', url: 'https://github.com/o/gears-rust.git', rev: 'a'.repeat(40), needsToken: true });
    });

    it('carries the path a private corpus is relayed from, so the desktop can clone it without its token', async () => {
        const remote = await loadRemoteGearCatalogue(answer(200, {
            source_id: 'gears-rust',
            corpus: 'o/gears-rust@main',
            corpus_url: 'https://github.com/o/gears-rust.git',
            corpus_commit: 'c'.repeat(40),
            corpus_needs_token: true,
            corpus_clone_path: '/studio-product/v1/gearbox/corpus',
            catalogue: { gears: { g: { id: 'g' } } },
        }));

        expect(remote?.origin?.clonePath).toBe('/studio-product/v1/gearbox/corpus');
    });

    it('asks a backend from before studio-product at the catalogue's path', async () => {
        const fetchApi = jest.fn(async (path: string) => path.startsWith('/studio-product/')
            ? answer(404, {})()
            : answer(200, { source_id: 'gears-rust', corpus: 'o/gears-rust@main', catalogue: { gears: { g: { id: 'g' } } } })());

        const remote = await loadRemoteGearCatalogue(fetchApi);

        expect(fetchApi).toHaveBeenLastCalledWith('/studio-components-catalog/v1/gearbox/catalogue');
        expect(remote?.gears).toEqual([{ id: 'g' }]);
    });

    it('offers nothing when the backend has no corpus, so the catalogue stays empty rather than failing', async () => {
        expect(await loadRemoteGearCatalogue(answer(404, {}))).toBeUndefined();
        expect(await loadRemoteGearCatalogue(answer(200, { corpus: 'x', catalogue: { gears: {} } }))).toBeUndefined();
    });

    it('fails, saying why, when the backend could not be asked: that is not "no corpus"', async () => {
        await expect(loadRemoteGearCatalogue(answer(503, {}))).rejects.toThrow('the Studio backend is not answering (HTTP 503)');
        await expect(loadRemoteGearCatalogue(answer(500, {}))).rejects.toThrow('HTTP 500');
        await expect(loadRemoteGearCatalogue(answer(401, {}))).rejects.toThrow('not signed in to Studio (HTTP 401)');
    });
});

describe('asking again once signed in', () => {
    const listed = { source_id: 'gears-rust', corpus: 'o/gears-rust@main', catalogue: { gears: { g: { id: 'g' } } } };

    it('asks again after a refusal signed out, once, however the sign-in was seen', async () => {
        const changed = jest.fn();
        const sub = remoteGearCatalogueChanged.event(changed);
        try {
            await loadRemoteGearCatalogue(answer(401, {})).catch(() => undefined);
            expect(remoteGearCatalogueRefused()).toBe(true);
            // The Studio view seeing the member signed in on its first look,
            // and the heartbeat's backstop, both call this.
            remoteGearCatalogueSignedIn();
            remoteGearCatalogueSignedIn();
            expect(changed).toHaveBeenCalledTimes(1);
        } finally {
            sub.dispose();
        }
    });

    it('treats "no Studio behind the proxy yet" as a refusal too, and a missing Gearbox as an answer', async () => {
        await loadRemoteGearCatalogue(answer(503, {})).catch(() => undefined);
        expect(remoteGearCatalogueRefused()).toBe(true);
        await loadRemoteGearCatalogue(answer(404, {}));
        expect(remoteGearCatalogueRefused()).toBe(false);
    });

    it('does not load a catalogue twice that was listed at start', async () => {
        const changed = jest.fn();
        const sub = remoteGearCatalogueChanged.event(changed);
        try {
            await loadRemoteGearCatalogue(answer(200, listed));
            remoteGearCatalogueSignedIn();
            expect(changed).not.toHaveBeenCalled();
        } finally {
            sub.dispose();
        }
    });
});
