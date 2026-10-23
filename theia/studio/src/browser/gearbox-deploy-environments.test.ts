import { DeployEnvironments, foldersAbove } from './gearbox-deploy-environments';

const json = (status: number, body: unknown): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('the organization\'s environments, for the desktop\'s Deploy', () => {
    it('look for the opened folder among those above the product', () => {
        expect(foldersAbove('C:\\Users\\a\\ConstructorStudio\\p\\products\\shop\\product.gdl').slice(0, 3)).toEqual([
            'C:\\Users\\a\\ConstructorStudio\\p\\products\\shop',
            'C:\\Users\\a\\ConstructorStudio\\p\\products',
            'C:\\Users\\a\\ConstructorStudio\\p',
        ]);
        expect(foldersAbove('/home/a/p/product.gdl')).toEqual(['/home/a/p', '/home/a', '/home']);
    });

    it('are read for the project the folder was opened for', async () => {
        const asked: string[] = [];
        const source = new DeployEnvironments(
            async () => ({ kind: 'project', workspaceId: 'w', projectId: 'p-1' }),
            async path => {
                asked.push(path);
                return json(200, {
                    environments: [{ environment: { id: 'e1', name: 'prod', registry: 'ghcr.io/acme', protected: true }, namespace: 'shop-prod' }],
                    bindings: [{ profile: 'prod', environment_id: 'e1' }],
                });
            },
        );
        await expect(source.targets('/p/product.gdl')).resolves.toEqual({
            projectId: 'p-1',
            environments: [{ id: 'e1', name: 'prod', namespace: 'shop-prod', registry: 'ghcr.io/acme', protected: true, registryLogin: false }],
            bound: { prod: 'e1' },
        });
        expect(asked).toEqual(['/studio-environments/v1/targets?project_id=p-1']);
    });

    it('are none outside a Studio project, or from a Studio without them', async () => {
        const outside = new DeployEnvironments(async () => undefined, async () => json(200, {}));
        await expect(outside.targets('/x/product.gdl')).resolves.toBeUndefined();
        const old = new DeployEnvironments(async () => ({ kind: 'project', workspaceId: 'w', projectId: 'p' }), async () => json(404, {}));
        await expect(old.targets('/x/product.gdl')).resolves.toBeUndefined();
    });

    it('take a deploy, and pass on the server\'s refusal in its words', async () => {
        let sent: RequestInit | undefined;
        const ok = new DeployEnvironments(async () => undefined, async (_path, init) => {
            sent = init;
            return json(202, { state: 'awaiting_approval', environment_name: 'prod', namespace: 'shop-prod' });
        });
        await expect(ok.requestDeploy('p-1', { environment_id: 'e1' })).resolves.toMatchObject({ state: 'awaiting_approval' });
        expect(sent?.method).toBe('POST');
        const refused = new DeployEnvironments(async () => undefined, async () => json(400, { detail: 'the chart is not a packaged .tgz' }));
        await expect(refused.requestDeploy('p-1', {})).rejects.toThrow('the chart is not a packaged .tgz');
    });

    it('say which have a registry login, and get a push token for one (ADR-0048)', async () => {
        const asked: { path: string; init?: RequestInit }[] = [];
        const source = new DeployEnvironments(
            async () => ({ kind: 'project', workspaceId: 'w', projectId: 'p-1' }),
            async (path, init) => {
                asked.push({ path, init });
                if (path.includes('/push-tokens')) {
                    return json(201, { registry: 'ghcr.io', prefix: 'ghcr.io/acme', token: 't0k', expires_in: 300 });
                }
                return json(200, {
                    environments: [{ environment: { id: 'e1', name: 'prod', registry: 'ghcr.io/acme', registry_connection_id: 'r1' }, namespace: 'shop-prod' }],
                });
            },
        );
        const targets = await source.targets('/p/product.gdl');
        expect(targets?.environments[0]?.registryLogin).toBe(true);
        await expect(source.pushToken('p-1', 'e1', ['gbx-api', 'charts/shop'])).resolves.toMatchObject({ token: 't0k', registry: 'ghcr.io' });
        expect(asked[1]?.path).toBe('/studio-environments/v1/environments/e1/push-tokens?project_id=p-1');
        expect(JSON.parse(String(asked[1]?.init?.body))).toEqual({ repositories: ['gbx-api', 'charts/shop'] });
        const refused = new DeployEnvironments(async () => undefined, async () => json(400, { detail: 'ghcr.io has no token service' }));
        await expect(refused.pushToken('p', 'e', ['x'])).rejects.toThrow('no token service');
    });

    it('start a build in Studio for the project (ADR-0048 §9)', async () => {
        let asked: { path: string; init?: RequestInit } | undefined;
        const source = new DeployEnvironments(async () => undefined, async (path, init) => {
            asked = { path, init };
            return json(202, { build_id: 'studio-0123456789ab', run_id: 'r', namespace: 'shop-dev' });
        });
        await expect(source.startBuild('p-1', { environment_id: 'e1', profile: 'prod', product_file: 'products/shop/product.gdl', ref: 'main' }))
            .resolves.toMatchObject({ build_id: 'studio-0123456789ab' });
        expect(asked?.path).toBe('/studio-environments/v1/builds?project_id=p-1');
        expect(JSON.parse(String(asked?.init?.body))).toMatchObject({ product_file: 'products/shop/product.gdl', ref: 'main' });
    });
});
