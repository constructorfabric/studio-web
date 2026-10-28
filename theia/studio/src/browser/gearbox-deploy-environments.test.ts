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
            secrets: [],
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

    it('list the project\'s builds as the portal does, with what each published, and leave Runs out', async () => {
        let asked = '';
        const source = new DeployEnvironments(async () => undefined, async path => {
            asked = path;
            return json(200, {
                nodes: [
                    { instance_id: 'n1', value: { build_id: 'b-old', status: 'failed', failure: 'no protoc', failure_step: 'build', started_at: '2026-10-27T10:00:00Z' } },
                    { instance_id: 'n2', value: { action: 'run', status: 'passed', started_at: '2026-10-28T11:00:00Z' } },
                    {
                        instance_id: 'n3',
                        value: {
                            build_id: 'studio-1', where: 'studio', status: 'passed', commit: 'abcdef0123', started_at: '2026-10-28T10:00:00Z',
                            chart: { reference: 'oci://ghcr.io/acme/charts/shop', version: '0.0.0-studio.1' },
                            images: [{ app: 'api', image: 'ghcr.io/acme/gbx-api:studio-1' }, { app: '' }],
                        },
                    },
                ],
            });
        });
        const builds = await source.builds('p-1');
        expect(asked).toBe('/studio-artifact-ingest/v1/nodes?type=build&scope=p-1&sort=updated&limit=20');
        expect(builds.map(b => b.buildId)).toEqual(['studio-1', 'b-old']);
        expect(builds[0]).toMatchObject({
            where: 'studio', shortSha: 'abcdef0', chartRef: 'oci://ghcr.io/acme/charts/shop', chartVersion: '0.0.0-studio.1',
            images: [{ app: 'api', image: 'ghcr.io/acme/gbx-api:studio-1' }],
        });
        expect(builds[1]).toMatchObject({ status: 'failed', failure: 'no protoc', failureStep: 'build' });
        const refused = new DeployEnvironments(async () => undefined, async () => json(403, { detail: 'not a member' }));
        await expect(refused.builds('p')).rejects.toThrow('not a member');
    });

    it('list the project\'s deploys, newest first', async () => {
        const source = new DeployEnvironments(async () => undefined, async () => json(200, {
            items: [
                { id: 'd1', environment_id: 'e1', environment_name: 'dev', namespace: 'shop-dev', profile: 'prod', product: 'shop', action: 'install', state: 'succeeded', requested_at: '2026-10-27T10:00:00Z' },
                { id: 'd2', environment_id: 'e1', environment_name: 'dev', namespace: 'shop-dev', profile: 'prod', product: 'shop', build: 'studio-1', chart_version: '0.1', state: 'failed', reason: 'ImagePullBackOff', requested_at: '2026-10-28T10:00:00Z' },
            ],
        }));
        const deployments = await source.deployments('p-1');
        expect(deployments.map(d => d.id)).toEqual(['d2', 'd1']);
        expect(deployments[0]).toMatchObject({ environmentName: 'dev', build: 'studio-1', chartVersion: '0.1', reason: 'ImagePullBackOff', action: 'install' });
    });

    it('bind a profile without dropping another profile\'s binding or anyone\'s chart values', async () => {
        const asked: { path: string; init?: RequestInit }[] = [];
        const source = new DeployEnvironments(async () => undefined, async (path, init) => {
            asked.push({ path, init });
            if (init?.method === 'PUT') {
                return json(200, { items: [], total: 0 });
            }
            return json(200, {
                environments: [],
                bindings: [
                    { profile: 'dev', environment_id: 'e-dev', values: { replicas: 1 } },
                    { profile: 'prod', environment_id: 'e-old', values: { replicas: 3 } },
                ],
            });
        });
        await source.bind('p-1', 'prod', 'e-prod');
        expect(asked[0]?.path).toBe('/studio-environments/v1/targets?project_id=p-1');
        expect(asked[1]?.path).toBe('/studio-environments/v1/bindings?project_id=p-1');
        expect(JSON.parse(String(asked[1]?.init?.body))).toEqual({
            items: [
                { profile: 'dev', environment_id: 'e-dev', values: { replicas: 1 } },
                { profile: 'prod', environment_id: 'e-prod', values: { replicas: 3 } },
            ],
        });
    });

    it("carry the project's organization and its secret keys, never values", async () => {
        const source = new DeployEnvironments(
            async () => ({ kind: 'project', workspaceId: 'w', projectId: 'p-1' }),
            async () => json(200, { organization_id: 'org-1', environments: [], bindings: [], secrets: [{ environment_id: 'e1', key: 'STRIPE_KEY' }] }),
        );
        await expect(source.targets('/p/product.gdl')).resolves.toMatchObject({
            organizationId: 'org-1',
            secrets: [{ environmentId: 'e1', key: 'STRIPE_KEY' }],
        });
    });

    it("read a release's live status in the project's organization", async () => {
        let asked = '';
        const source = new DeployEnvironments(async () => undefined, async path => {
            asked = path;
            return json(200, { deployment: {}, workloads: [{ name: 'shop-api', ready: 1, desired: 2, images: ['r/shop-api:1'] }], hosts: ['shop.example.com'] });
        });
        await expect(source.status('org-1', 'd-1')).resolves.toEqual({
            workloads: [{ name: 'shop-api', ready: 1, desired: 2, images: ['r/shop-api:1'] }],
            hosts: ['shop.example.com'],
        });
        expect(asked).toBe('/studio-environments/v1/deployments/d-1/status?organization_id=org-1');
    });

    it('propose the CI build workflow as a pull request', async () => {
        let asked: { path: string; init?: RequestInit } | undefined;
        const source = new DeployEnvironments(async () => undefined, async (path, init) => {
            asked = { path, init };
            return json(200, { path: '.github/workflows/studio-build-shop.yml', branch: 'studio/build-shop', pr_url: 'https://github.com/a/b/pull/7' });
        });
        await expect(source.proposeBuildWorkflow('p-1', { environment_id: 'e1', profile: 'prod', product_file: 'product.gdl' })).resolves.toEqual({
            path: '.github/workflows/studio-build-shop.yml', branch: 'studio/build-shop', prUrl: 'https://github.com/a/b/pull/7',
        });
        expect(asked?.path).toBe('/studio-environments/v1/build-workflows?project_id=p-1');
        expect(JSON.parse(String(asked?.init?.body))).toEqual({ environment_id: 'e1', profile: 'prod', product_file: 'product.gdl' });
    });

    it('set a configuration secret, and remove one', async () => {
        const asked: { path: string; init?: RequestInit }[] = [];
        const source = new DeployEnvironments(async () => undefined, async (path, init) => {
            asked.push({ path, init });
            return json(init?.method === 'DELETE' ? 204 : 200, {});
        });
        await source.configSecret('p-1', 'e1', 'STRIPE_KEY', 's3cret');
        await source.configSecret('p-1', 'e1', 'STRIPE_KEY', undefined);
        expect(asked.map(a => `${a.init?.method} ${a.path}`)).toEqual([
            'PUT /studio-environments/v1/config-secrets/STRIPE_KEY?project_id=p-1&environment_id=e1',
            'DELETE /studio-environments/v1/config-secrets/STRIPE_KEY?project_id=p-1&environment_id=e1',
        ]);
        expect(JSON.parse(String(asked[0]?.init?.body))).toEqual({ value: 's3cret' });
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
