import 'reflect-metadata';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { adaptCfsMap, CfsMapAdapterError } from './cfs-map-adapter';
import type { CfsMapRunRequest, CfsMapRunResult, CfsMapRunnerImpl } from './cfs-map-runner';
import type { GitExecutor } from './git-executor';
import type { RepositoryRegistry } from './repository-registry';
import { WorkspaceGraphServiceImpl } from './workspace-graph-service';
import type { StudioRuntimeConfig } from './studio-runtime-config';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

describe('workspace graph service with canonical cfs map', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-graph-'));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('normalizes canonical map positions, category bands, and safe file ownership', async () => {
        const harness = await createHarness(tempDir);
        const response = await harness.service.getSnapshot({
            repositoryId: 'repo-1'
        });

        expect(response.snapshot).toMatchObject({
            schemaVersion: 2,
            mapVersion: '1.0',
            primarySource: 'local',
            repositories: [{ repositoryId: 'repo-1', commitSha: HEAD_A }],
            stale: false
        });
        expect(response.snapshot?.nodes[0]).toMatchObject({
            id: 'local:docs/spec.md',
            relPath: 'docs/spec.md',
            position: { x: 25, y: 50 },
            location: {
                workspaceId: 'workspace',
                repositoryId: 'repo-1',
                repositoryRelativePath: 'docs/spec.md'
            }
        });
        expect(response.snapshot?.categoryBands.docs).toEqual({
            x: 0,
            y: 0,
            w: 300,
            h: 180,
            label: 'Docs',
            fill: '#fff'
        });
    });

    it('uses the selected repository server-side HEAD revision', async () => {
        const harness = await createHarness(tempDir);
        const response = await harness.service.getSnapshot({
            repositoryId: 'repo-1'
        });

        expect(response.snapshot?.repositories).toEqual([
            { repositoryId: 'repo-1', commitSha: HEAD_A }
        ]);
        expect(harness.git.revParseHead).toHaveBeenCalledWith(harness.repoRoot);
        expect(harness.git.revParseHead.mock.calls.length).toBeGreaterThanOrEqual(7);
        expect(harness.runner.run).toHaveBeenCalledWith({
            workspaceRoot: harness.config.workspaceRoot,
            repositoryRoot: harness.repoRoot,
            dataDir: harness.config.dataDir
        });
    });

    it('rejects an unknown repository scope before invoking git or cfs', async () => {
        const harness = await createHarness(tempDir);

        await expect(harness.service.getSnapshot({ repositoryId: 'missing' }))
            .rejects.toThrow('Unknown repository: missing');
        expect(harness.git.revParseHead).not.toHaveBeenCalled();
        expect(harness.runner.run).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent refreshes only when their server-owned fingerprint matches', async () => {
        let release: (() => void) | undefined;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const harness = await createHarness(tempDir);
        harness.runner.run.mockImplementationOnce(async () => {
            await gate;
            return mapResult(harness.repoRoot);
        });

        const first = harness.service.refresh({ repositoryId: 'repo-1' });
        const second = harness.service.refresh({ repositoryId: 'repo-1' });
        release?.();
        await Promise.all([first, second]);

        expect(harness.runner.run).toHaveBeenCalledTimes(1);
    });

    it('keeps repository status and refresh concurrency independent', async () => {
        let release: (() => void) | undefined;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let activeRuns = 0;
        let maximumActiveRuns = 0;
        const harness = await createMultiRepositoryHarness(tempDir, async request => {
            activeRuns += 1;
            maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
            await gate;
            activeRuns -= 1;
            return mapResult(request.repositoryRoot);
        });

        const first = harness.service.refresh({ repositoryId: 'repo-1' });
        const second = harness.service.refresh({ repositoryId: 'repo-2' });
        for (let attempt = 0; attempt < 20 && harness.runner.run.mock.calls.length < 2; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        expect(maximumActiveRuns).toBe(2);
        expect(await harness.service.getStatus({ repositoryId: 'repo-1' })).toMatchObject({
            repositoryId: 'repo-1',
            state: 'indexing'
        });
        expect(await harness.service.getStatus({ repositoryId: 'repo-2' })).toMatchObject({
            repositoryId: 'repo-2',
            state: 'indexing'
        });

        release?.();
        await Promise.all([first, second]);
        const repoOne = await harness.service.getSnapshot({ repositoryId: 'repo-1' });
        const repoTwo = await harness.service.getSnapshot({ repositoryId: 'repo-2' });
        expect(repoOne.snapshot?.repositories).toEqual([{ repositoryId: 'repo-1', commitSha: HEAD_A }]);
        expect(repoTwo.snapshot?.repositories).toEqual([{ repositoryId: 'repo-2', commitSha: HEAD_B }]);
        expect(repoOne.snapshot?.revision).not.toBe(repoTwo.snapshot?.revision);
    });

    it('reports dirty files only for the requested repository', async () => {
        const harness = await createMultiRepositoryHarness(tempDir);
        harness.git.statusPorcelain.mockImplementation(async (repositoryRoot: string) =>
            repositoryRoot === harness.repoRoots[0] ? [' M docs/one.md'] : ['?? docs/two.md']
        );

        const overlay = await harness.service.getDirtyOverlay({ repositoryId: 'repo-2' });

        expect(harness.git.statusPorcelain).toHaveBeenCalledTimes(1);
        expect(harness.git.statusPorcelain).toHaveBeenCalledWith(harness.repoRoots[1]);
        expect(overlay.files).toEqual([{
            repositoryId: 'repo-2',
            repositoryRelativePath: 'docs/two.md',
            state: 'untracked'
        }]);
    });

    it('parses porcelain -z rename records as one destination-path overlay entry', async () => {
        const harness = await createHarness(tempDir);
        harness.git.statusPorcelain.mockResolvedValue([
            'R  docs/new name.md',
            'docs/old name.md',
            '?? docs/untracked.md'
        ]);

        const overlay = await harness.service.getDirtyOverlay({ repositoryId: 'repo-1' });

        expect(overlay.files).toEqual([
            {
                repositoryId: 'repo-1',
                repositoryRelativePath: 'docs/new name.md',
                state: 'renamed'
            },
            {
                repositoryId: 'repo-1',
                repositoryRelativePath: 'docs/untracked.md',
                state: 'untracked'
            }
        ]);
    });

    it('retries the actual current HEAD when it changes during indexing', async () => {
        const harness = await createHarness(tempDir);
        harness.git.revParseHead
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValue(HEAD_B);

        const response = await harness.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(response.status).toMatchObject({
            state: 'ready',
            stale: false,
            serviceInstanceId: expect.any(String)
        });
        expect(response.snapshot?.repositories).toEqual([{ repositoryId: 'repo-1', commitSha: HEAD_B }]);
        expect(harness.runner.run).toHaveBeenCalledTimes(2);
    });

    it('rolls back stale cache publication when HEAD changes during cache commit', async () => {
        const harness = await createHarness(tempDir);
        harness.git.revParseHead
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValue(HEAD_B);

        const response = await harness.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(response.status.state).toBe('ready');
        expect(response.snapshot?.repositories).toEqual([{ repositoryId: 'repo-1', commitSha: HEAD_B }]);
        const cacheDirectory = path.join(harness.config.dataDir, 'workspace-graph-cache');
        const snapshotEntries = (await fs.readdir(cacheDirectory))
            .filter(entry => entry.endsWith('.json') && !entry.endsWith('.index.json'));
        expect(snapshotEntries).toHaveLength(1);
        for (const entry of snapshotEntries) {
            const envelope = JSON.parse(await fs.readFile(path.join(cacheDirectory, entry), 'utf8')) as {
                snapshot: { repositories: Array<{ commitSha: string }> };
            };
            expect(envelope.snapshot.repositories).toEqual([{ repositoryId: 'repo-1', commitSha: HEAD_B }]);
        }
    });

    it('preserves HEAD-drift retry and isolates rollback when index restore and temp cleanup fail', async () => {
        const harness = await createHarness(tempDir);
        await harness.service.getSnapshot({ repositoryId: 'repo-1' });
        const cacheDirectory = path.join(harness.config.dataDir, 'workspace-graph-cache');
        const oldIndexEntry = (await fs.readdir(cacheDirectory)).find(entry => entry.endsWith('.index.json'));
        expect(oldIndexEntry).toBeDefined();
        const oldIndexPath = path.join(cacheDirectory, oldIndexEntry!);

        harness.runner.run.mockResolvedValue(mapResult(harness.repoRoot, '2.0.0'));
        harness.git.revParseHead.mockClear();
        harness.git.revParseHead
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValueOnce(HEAD_A)
            .mockResolvedValue(HEAD_B);

        const originalRename = fs.rename.bind(fs);
        const originalRm = fs.rm.bind(fs);
        let restoreRenameFailed = false;
        let restoreTempCleanupFailed = false;
        const renameSpy = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (String(from).includes('.restore.tmp')) {
                restoreRenameFailed = true;
                throw new Error('injected index restore rename failure');
            }
            return originalRename(from, to);
        });
        const rmSpy = jest.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
            if (String(target).includes('.restore.tmp')) {
                restoreTempCleanupFailed = true;
                throw new Error('injected restore temp cleanup failure');
            }
            return originalRm(target, options);
        });

        try {
            const status = await harness.service.refresh({ repositoryId: 'repo-1' });

            expect(status).toMatchObject({ state: 'ready', stale: false });
            expect(restoreRenameFailed).toBe(true);
            expect(restoreTempCleanupFailed).toBe(true);
            await expect(fs.lstat(oldIndexPath)).rejects.toMatchObject({ code: 'ENOENT' });
            const snapshotEntries = (await fs.readdir(cacheDirectory))
                .filter(entry => entry.endsWith('.json') && !entry.endsWith('.index.json'));
            const envelopes = await Promise.all(snapshotEntries.map(async entry =>
                JSON.parse(await fs.readFile(path.join(cacheDirectory, entry), 'utf8')) as {
                    engine: { version: string };
                    snapshot: { repositories: Array<{ repositoryId: string; commitSha: string }> };
                }
            ));
            expect(envelopes).not.toContainEqual(expect.objectContaining({
                engine: expect.objectContaining({ version: '2.0.0' }),
                snapshot: expect.objectContaining({
                    repositories: [{ repositoryId: 'repo-1', commitSha: HEAD_A }]
                })
            }));
            expect(envelopes).toContainEqual(expect.objectContaining({
                engine: expect.objectContaining({ version: '2.0.0' }),
                snapshot: expect.objectContaining({
                    repositories: [{ repositoryId: 'repo-1', commitSha: HEAD_B }]
                })
            }));
        } finally {
            renameSpy.mockRestore();
            rmSpy.mockRestore();
        }
    });

    it('returns an explicitly stale last-good snapshot after a failed refresh', async () => {
        const harness = await createHarness(tempDir);
        const first = await harness.service.getSnapshot({ repositoryId: 'repo-1' });
        expect(first.snapshot?.stale).toBe(false);

        harness.git.revParseHead.mockResolvedValue(HEAD_B);
        harness.runner.run.mockRejectedValueOnce(new Error('cfs map timed out after 60000ms'));
        const failed = await harness.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(failed.status).toMatchObject({
            state: 'failed',
            stale: true,
            errorMessage: 'cfs map timed out after 60000ms'
        });
        expect(failed.snapshot).toMatchObject({
            revision: first.snapshot?.revision,
            stale: true,
            diagnostics: [{
                id: 'workspace-graph-refresh-failed',
                code: 'map-failed',
                severity: 'warning',
                message: 'Workspace graph refresh failed; showing the last successfully indexed graph.'
            }]
        });
    });

    it('loads a persisted last-good snapshot before a fresh service runner failure', async () => {
        const seeded = await createHarness(tempDir);
        const first = await seeded.service.getSnapshot({ repositoryId: 'repo-1' });

        const restarted = await createHarness(tempDir, async () => {
            throw new Error('cfs map unavailable after restart');
        });
        const failed = await restarted.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(restarted.runner.run).toHaveBeenCalledTimes(1);
        expect(failed.status).toMatchObject({
            state: 'failed',
            stale: true,
            revision: first.snapshot?.revision,
            errorMessage: 'cfs map unavailable after restart'
        });
        expect(failed.snapshot).toMatchObject({
            revision: first.snapshot?.revision,
            repositories: [{ repositoryId: 'repo-1', commitSha: HEAD_A }],
            stale: true
        });
    });

    it('retries a failed same-HEAD refresh and recovers on the next snapshot request', async () => {
        const harness = await createHarness(tempDir);
        const first = await harness.service.getSnapshot({ repositoryId: 'repo-1' });
        harness.runner.run.mockRejectedValueOnce(new Error('transient cfs map failure'));

        const failed = await harness.service.refresh({ repositoryId: 'repo-1' });
        expect(failed).toMatchObject({ state: 'failed', stale: true });

        const recovered = await harness.service.getSnapshot({
            repositoryId: 'repo-1',
            knownRevision: first.snapshot?.revision
        });

        expect(harness.runner.run).toHaveBeenCalledTimes(3);
        expect(recovered.status).toMatchObject({ state: 'ready', stale: false });
        expect(recovered.notModified).toBe(true);
    });

    it('serializes distinct HEAD refreshes and leaves the latest snapshot current', async () => {
        let releaseFirst: (() => void) | undefined;
        const firstGate = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        let activeRuns = 0;
        let maximumActiveRuns = 0;
        const harness = await createHarness(tempDir);
        harness.runner.run.mockImplementation(async () => {
            activeRuns += 1;
            maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
            try {
                if (harness.runner.run.mock.calls.length === 1) {
                    await firstGate;
                }
                return mapResult(harness.repoRoot);
            } finally {
                activeRuns -= 1;
            }
        });

        const first = harness.service.refresh({ repositoryId: 'repo-1' });
        await Promise.resolve();
        harness.git.revParseHead.mockResolvedValue(HEAD_B);
        const second = harness.service.refresh({ repositoryId: 'repo-1' });
        releaseFirst?.();
        const [staleRefresh, currentRefresh] = await Promise.all([first, second]);
        const latest = await harness.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(maximumActiveRuns).toBe(1);
        expect(harness.runner.run).toHaveBeenCalledTimes(1);
        expect(staleRefresh).toMatchObject({ state: 'failed' });
        expect(currentRefresh).toMatchObject({ state: 'ready' });
        expect(latest.snapshot?.repositories).toEqual([
            { repositoryId: 'repo-1', commitSha: HEAD_B }
        ]);
    });

    it('does not let obsolete queued B overwrite current A after an A to B to A transition', async () => {
        let releaseFirst: (() => void) | undefined;
        const firstGate = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        const harness = await createHarness(tempDir);
        harness.runner.run.mockImplementation(async () => {
            if (harness.runner.run.mock.calls.length === 1) {
                await firstGate;
            }
            return mapResult(harness.repoRoot);
        });

        const first = harness.service.refresh({ repositoryId: 'repo-1' });
        for (let attempt = 0; attempt < 20 && harness.runner.run.mock.calls.length < 1; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        harness.git.revParseHead.mockResolvedValueOnce(HEAD_B);
        const obsoleteB = harness.service.refresh({ repositoryId: 'repo-1' });
        for (let attempt = 0; attempt < 20 && harness.git.revParseHead.mock.calls.length < 3; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        harness.git.revParseHead.mockResolvedValue(HEAD_A);
        releaseFirst?.();

        const [firstStatus, obsoleteStatus] = await Promise.all([first, obsoleteB]);
        const finalStatus = await harness.service.getStatus({ repositoryId: 'repo-1' });
        expect(firstStatus).toMatchObject({ state: 'ready', stale: false });
        expect(obsoleteStatus).toMatchObject({ state: 'ready', stale: false });
        expect(finalStatus).toMatchObject({ state: 'ready', stale: false });
        expect(harness.runner.run).toHaveBeenCalledTimes(1);
        const finalSnapshot = await harness.service.getSnapshot({ repositoryId: 'repo-1' });
        expect(finalSnapshot.snapshot?.repositories).toEqual([{ repositoryId: 'repo-1', commitSha: HEAD_A }]);
    });

    it('uses one status service instance id per backend lifetime', async () => {
        const first = await createHarness(tempDir);
        const idle = await first.service.getStatus({ repositoryId: 'repo-1' });
        const ready = (await first.service.getSnapshot({ repositoryId: 'repo-1' })).status;
        const restarted = await createHarness(tempDir);
        const restartedIdle = await restarted.service.getStatus({ repositoryId: 'repo-1' });

        expect(idle.serviceInstanceId).toMatch(/^[0-9a-f-]{36}$/u);
        expect(ready.serviceInstanceId).toBe(idle.serviceInstanceId);
        expect(restartedIdle.serviceInstanceId).not.toBe(idle.serviceInstanceId);
    });

    it('includes engine version in cache identity and rejects legacy parser cache shapes', async () => {
        const harness = await createHarness(tempDir);
        await fs.mkdir(path.join(harness.config.dataDir, 'workspace-graph-cache'), { recursive: true });
        await fs.writeFile(
            path.join(harness.config.dataDir, 'workspace-graph-cache', 'legacy.json'),
            JSON.stringify({ schemaVersion: 1, revision: 'legacy' }),
            'utf8'
        );

        const first = await harness.service.refresh({ repositoryId: 'repo-1' });
        harness.runner.run.mockResolvedValueOnce(mapResult(harness.repoRoot, '2.0.0'));
        const second = await harness.service.refresh({ repositoryId: 'repo-1' });

        expect(first.revision).not.toBe(second.revision);
        const cacheEntries = await fs.readdir(path.join(harness.config.dataDir, 'workspace-graph-cache'));
        expect(cacheEntries.filter(entry => entry.endsWith('.json'))).toHaveLength(4);
    });

    it('rejects an incompatible persisted envelope during pre-run recovery', async () => {
        const seeded = await createHarness(tempDir);
        await seeded.service.getSnapshot({ repositoryId: 'repo-1' });
        const cacheDirectory = path.join(seeded.config.dataDir, 'workspace-graph-cache');
        const entries = await fs.readdir(cacheDirectory);
        const snapshotEntry = entries.find(entry => entry.endsWith('.json') && !entry.endsWith('.index.json'));
        expect(snapshotEntry).toBeDefined();
        const envelopePath = path.join(cacheDirectory, snapshotEntry!);
        const envelope = JSON.parse(await fs.readFile(envelopePath, 'utf8')) as Record<string, unknown>;
        envelope.cacheEngineId = 'legacy-adapter';
        await fs.writeFile(envelopePath, JSON.stringify(envelope), 'utf8');

        const restarted = await createHarness(tempDir, async () => {
            throw new Error('runner also failed');
        });
        const failed = await restarted.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(failed.status).toMatchObject({ state: 'failed', stale: false });
        expect(failed.snapshot).toBeUndefined();
    });

    it('rejects a cache envelope with a malformed nested snapshot shape', async () => {
        const seeded = await createHarness(tempDir);
        await seeded.service.getSnapshot({ repositoryId: 'repo-1' });
        const cacheDirectory = path.join(seeded.config.dataDir, 'workspace-graph-cache');
        const entries = await fs.readdir(cacheDirectory);
        const snapshotEntry = entries.find(entry => entry.endsWith('.json') && !entry.endsWith('.index.json'));
        expect(snapshotEntry).toBeDefined();
        const envelopePath = path.join(cacheDirectory, snapshotEntry!);
        const envelope = JSON.parse(await fs.readFile(envelopePath, 'utf8')) as {
            snapshot: Record<string, unknown>;
        };
        delete envelope.snapshot.nodes;
        await fs.writeFile(envelopePath, JSON.stringify(envelope), 'utf8');

        const restarted = await createHarness(tempDir, async () => {
            throw new Error('runner failed after malformed cache');
        });
        const failed = await restarted.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(failed.status).toMatchObject({ state: 'failed', stale: false });
        expect(failed.snapshot).toBeUndefined();
    });

    it('rejects an oversized persisted cache envelope before reading it', async () => {
        const seeded = await createHarness(tempDir);
        await seeded.service.getSnapshot({ repositoryId: 'repo-1' });
        const cacheDirectory = path.join(seeded.config.dataDir, 'workspace-graph-cache');
        const entries = await fs.readdir(cacheDirectory);
        const snapshotEntry = entries.find(entry => entry.endsWith('.json') && !entry.endsWith('.index.json'));
        expect(snapshotEntry).toBeDefined();
        await fs.truncate(path.join(cacheDirectory, snapshotEntry!), (64 * 1024 * 1024) + 1);

        const restarted = await createHarness(tempDir, async () => {
            throw new Error('runner failed after oversized cache');
        });
        const failed = await restarted.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(failed.status).toMatchObject({ state: 'failed', stale: false });
        expect(failed.snapshot).toBeUndefined();
    });

    it('bounds an oversized scope index and recovers through the validated cache scan', async () => {
        const seeded = await createHarness(tempDir);
        const first = await seeded.service.getSnapshot({ repositoryId: 'repo-1' });
        const cacheDirectory = path.join(seeded.config.dataDir, 'workspace-graph-cache');
        const entries = await fs.readdir(cacheDirectory);
        const indexEntry = entries.find(entry => entry.endsWith('.index.json'));
        expect(indexEntry).toBeDefined();
        await fs.truncate(path.join(cacheDirectory, indexEntry!), (64 * 1024) + 1);

        const restarted = await createHarness(tempDir, async () => {
            throw new Error('runner unavailable after oversized index');
        });
        const failed = await restarted.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(failed.status).toMatchObject({ state: 'failed', stale: true });
        expect(failed.snapshot).toMatchObject({ revision: first.snapshot?.revision, stale: true });
    });

    it.each([
        ['duplicate edge ids', (snapshot: Record<string, unknown>) => {
            snapshot.edges = [
                canonicalEdge('duplicate', 'local:docs/spec.md', 'local:docs/spec.md'),
                canonicalEdge('duplicate', 'local:docs/spec.md', 'local:docs/spec.md')
            ];
        }],
        ['orphan edge endpoints', (snapshot: Record<string, unknown>) => {
            snapshot.edges = [canonicalEdge('orphan', 'local:docs/spec.md', 'local:missing.md')];
        }],
        ['orphan dangling-use nodes', (snapshot: Record<string, unknown>) => {
            snapshot.danglingCptUses = [{
                cptId: 'CPT-404',
                nodeId: 'local:missing.md',
                line: 1,
                snippet: 'CPT-404'
            }];
        }],
        ['duplicate diagnostic ids', (snapshot: Record<string, unknown>) => {
            snapshot.diagnostics = [
                canonicalDiagnostic('duplicate'),
                canonicalDiagnostic('duplicate')
            ];
        }],
        ['orphan diagnostic related nodes', (snapshot: Record<string, unknown>) => {
            snapshot.diagnostics = [canonicalDiagnostic('orphan', 'local:missing.md')];
        }],
        ['missing node category', (snapshot: Record<string, unknown>) => {
            snapshot.categories = {};
        }],
        ['inconsistent category counts', (snapshot: Record<string, unknown>) => {
            const categories = snapshot.categories as Record<string, { nodeCount: number }>;
            categories.docs.nodeCount += 1;
        }],
        ['bucket key and id mismatch', (snapshot: Record<string, unknown>) => {
            snapshot.bucketRects = {
                docs: { id: 'other', x: 0, y: 0, w: 100, h: 100, label: 'Docs' }
            };
        }]
    ])('rejects a cache envelope with %s', async (_case, mutateSnapshot) => {
        const seeded = await createHarness(tempDir);
        await seeded.service.getSnapshot({ repositoryId: 'repo-1' });
        const cacheDirectory = path.join(seeded.config.dataDir, 'workspace-graph-cache');
        const entries = await fs.readdir(cacheDirectory);
        const snapshotEntry = entries.find(entry => entry.endsWith('.json') && !entry.endsWith('.index.json'));
        expect(snapshotEntry).toBeDefined();
        const envelopePath = path.join(cacheDirectory, snapshotEntry!);
        const envelope = JSON.parse(await fs.readFile(envelopePath, 'utf8')) as {
            snapshot: Record<string, unknown>;
        };
        mutateSnapshot(envelope.snapshot);
        await fs.writeFile(envelopePath, JSON.stringify(envelope), 'utf8');

        const restarted = await createHarness(tempDir, async () => {
            throw new Error('runner failed after relationally invalid cache');
        });
        const failed = await restarted.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(failed.status).toMatchObject({ state: 'failed', stale: false });
        expect(failed.snapshot).toBeUndefined();
    });

    it('recovers the newest valid revision cache and atomically repairs a corrupt scope index', async () => {
        const seeded = await createHarness(tempDir);
        const first = await seeded.service.getSnapshot({ repositoryId: 'repo-1' });
        const cacheDirectory = path.join(seeded.config.dataDir, 'workspace-graph-cache');
        const indexEntry = (await fs.readdir(cacheDirectory)).find(entry => entry.endsWith('.index.json'));
        expect(indexEntry).toBeDefined();
        const indexPath = path.join(cacheDirectory, indexEntry!);
        await fs.writeFile(indexPath, JSON.stringify({
            cacheVersion: 3,
            cacheEngineId: 'cfs-map-v1-adapter-v2-repository-local-only',
            scopeFingerprint: 'not-the-server-owned-scope'
        }), 'utf8');

        const restarted = await createHarness(tempDir, async () => {
            throw new Error('runner unavailable during cache recovery');
        });
        const failed = await restarted.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(failed.status).toMatchObject({
            state: 'failed',
            stale: true,
            revision: first.snapshot?.revision
        });
        expect(failed.snapshot).toMatchObject({
            revision: first.snapshot?.revision,
            stale: true
        });
        const repairedIndex = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
            revision: string;
        };
        expect(repairedIndex.revision).toBe(first.snapshot?.revision);
    });

    it('advances indexedAt on a successful same-HEAD reindex without changing graph revision', async () => {
        const harness = await createHarness(tempDir);
        const first = await harness.service.getSnapshot({ repositoryId: 'repo-1' });
        await new Promise(resolve => setTimeout(resolve, 10));

        const reindexed = await harness.service.refresh({ repositoryId: 'repo-1' });
        const second = await harness.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(reindexed).toMatchObject({
            state: 'ready',
            revision: first.snapshot?.revision,
            lastIndexedAt: second.snapshot?.indexedAt
        });
        expect(second.snapshot?.revision).toBe(first.snapshot?.revision);
        expect(Date.parse(second.snapshot!.indexedAt)).toBeGreaterThan(Date.parse(first.snapshot!.indexedAt));
    });

    it('returns a safe graph-level stale diagnostic even when the graph revision is known', async () => {
        const harness = await createHarness(tempDir);
        const first = await harness.service.getSnapshot({ repositoryId: 'repo-1' });
        harness.git.revParseHead.mockResolvedValue(HEAD_B);
        harness.runner.run.mockRejectedValueOnce(new Error('token=super-secret runner failure'));

        const failed = await harness.service.getSnapshot({
            repositoryId: 'repo-1',
            knownRevision: first.snapshot?.revision
        });

        expect(failed.notModified).toBe(false);
        expect(failed.snapshot?.diagnostics).toContainEqual({
            id: 'workspace-graph-refresh-failed',
            code: 'map-failed',
            severity: 'warning',
            message: 'Workspace graph refresh failed; showing the last successfully indexed graph.'
        });
        expect(JSON.stringify(failed.snapshot?.diagnostics)).not.toContain('super-secret');
    });

    it('fails closed on reachable map sources outside RepositoryRegistry', async () => {
        const harness = await createHarness(tempDir);
        const externalRoot = path.join(tempDir, 'external');
        await fs.mkdir(externalRoot, { recursive: true });
        const payload = canonicalPayload(harness.repoRoot);
        const sources = (payload.workspace as { sources: Array<Record<string, unknown>> }).sources;
        sources.push({ name: 'unknown', path: externalRoot, reachable: true, role: 'full' });
        (payload.nodes as Array<Record<string, unknown>>).push(canonicalNode('unknown:secret.md', 'secret.md', 'unknown'));
        harness.runner.run.mockResolvedValueOnce({ ...mapResult(harness.repoRoot), payload });

        const response = await harness.service.getSnapshot({ repositoryId: 'repo-1' });

        expect(response.status).toMatchObject({
            state: 'failed',
            stale: false
        });
        expect(response.status.errorMessage).toContain('does not resolve inside a server-registered repository');
        expect(response.snapshot).toBeUndefined();
    });

    it('fails closed on malformed canonical output', async () => {
        const repoRoot = path.join(tempDir, 'repo');
        await fs.mkdir(repoRoot, { recursive: true });
        await expect(adaptCfsMap(
            { version: '0.9' },
            {
                workspaceId: 'workspace',
                revision: 'revision',
                repositories: [],
                engine: { command: 'cfs', version: '1.0.0' }
            }
        )).rejects.toBeInstanceOf(CfsMapAdapterError);
    });
});

async function createHarness(
    root: string,
    runImplementation?: () => Promise<CfsMapRunResult>
) {
    let repoRoot = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    await fs.mkdir(path.join(repoRoot, 'docs'), { recursive: true });
    repoRoot = await fs.realpath(repoRoot);
    const config: StudioRuntimeConfig = {
        actorId: 'actor',
        workspaceId: 'workspace',
        workspaceRoot: repoRoot,
        repositoryRoot: repoRoot,
        dataDir,
        allowedOriginsMode: 'same-origin',
        allowedOrigins: [],
        git: { mode: 'disabled' },
        secrets: {}
    };
    const repository = {
        canonicalRoot: repoRoot,
        descriptor: {
            repositoryId: 'repo-1',
            label: 'repo'
        }
    };
    const registry = {
        repositories: [repository],
        descriptors: [repository.descriptor],
        requireRepository: jest.fn((repositoryId: string) => {
            if (repositoryId !== repository.descriptor.repositoryId) {
                throw new Error(`Unknown repository: ${repositoryId}`);
            }
            return repository;
        })
    } as unknown as RepositoryRegistry;
    const git = {
        revParseHead: jest.fn().mockResolvedValue(HEAD_A),
        statusPorcelain: jest.fn().mockResolvedValue([])
    };
    const runner = {
        run: jest.fn(runImplementation ?? (async () => mapResult(repoRoot)))
    };
    const service = new WorkspaceGraphServiceImpl(
        { getConfig: () => config } as never,
        registry,
        git as unknown as GitExecutor,
        runner as unknown as CfsMapRunnerImpl
    );
    await service.onStart();
    return { repoRoot, config, registry, git, runner, service };
}

async function createMultiRepositoryHarness(
    root: string,
    runImplementation?: (request: CfsMapRunRequest) => Promise<CfsMapRunResult>
) {
    const repoRoots = await Promise.all(['repo-one', 'repo-two'].map(async name => {
        const repositoryRoot = path.join(root, name);
        await fs.mkdir(path.join(repositoryRoot, 'docs'), { recursive: true });
        return fs.realpath(repositoryRoot);
    }));
    const dataDir = path.join(root, 'multi-data');
    const config: StudioRuntimeConfig = {
        actorId: 'actor',
        workspaceId: 'workspace',
        workspaceRoot: root,
        repositoryRoot: repoRoots[0],
        dataDir,
        allowedOriginsMode: 'same-origin',
        allowedOrigins: [],
        git: { mode: 'disabled' },
        secrets: {}
    };
    const repositories = repoRoots.map((canonicalRoot, index) => ({
        canonicalRoot,
        descriptor: {
            repositoryId: `repo-${index + 1}`,
            label: `repo-${index + 1}`
        }
    }));
    const registry = {
        repositories,
        descriptors: repositories.map(repository => repository.descriptor),
        requireRepository: jest.fn((repositoryId: string) => {
            const repository = repositories.find(candidate => candidate.descriptor.repositoryId === repositoryId);
            if (!repository) {
                throw new Error(`Unknown repository: ${repositoryId}`);
            }
            return repository;
        })
    } as unknown as RepositoryRegistry;
    const git = {
        revParseHead: jest.fn(async (repositoryRoot: string) =>
            repositoryRoot === repoRoots[0] ? HEAD_A : HEAD_B
        ),
        statusPorcelain: jest.fn().mockResolvedValue([])
    };
    const runner = {
        run: jest.fn(runImplementation ?? (async (request: CfsMapRunRequest) => mapResult(request.repositoryRoot)))
    };
    const service = new WorkspaceGraphServiceImpl(
        { getConfig: () => config } as never,
        registry,
        git as unknown as GitExecutor,
        runner as unknown as CfsMapRunnerImpl
    );
    await service.onStart();
    return { repoRoots, config, registry, git, runner, service };
}

function mapResult(repoRoot: string, version = '1.0.0'): CfsMapRunResult {
    return {
        payload: canonicalPayload(repoRoot),
        engine: { command: 'cfs', version },
        stderr: ''
    };
}

function canonicalPayload(repoRoot: string): Record<string, unknown> {
    return {
        version: '1.0',
        generated_at: '2026-07-30T00:00:00Z',
        workspace: {
            primary: 'local',
            sources: [{ name: 'local', path: repoRoot, reachable: true, role: 'full' }]
        },
        scan: {
            artifacts_toml: null,
            systems_scanned: 0,
            systems_docs_only: 0,
            skip_dirs: []
        },
        nodes: [canonicalNode('local:docs/spec.md', 'docs/spec.md', 'local')],
        edges: [],
        dangling_cpt_uses: [],
        categories: {
            docs: {
                node_count: 1,
                origin_counts: { 'parent-dir': 1 },
                style: { color: '#111', background: '#eee' }
            }
        },
        layout: {
            vis_nodes: [{ id: 'local:docs/spec.md', x: 25, y: 50 }],
            bucket_rects: {},
            category_bands: {
                docs: { x: 0, y: 0, w: 300, h: 180, label: 'Docs', fill: '#fff' }
            }
        }
    };
}

function canonicalNode(id: string, relPath: string, source: string): Record<string, unknown> {
    return {
        id,
        rel_path: relPath,
        source,
        kind: 'markdown',
        language: 'markdown',
        category: 'docs',
        category_origin: 'parent-dir',
        content: '# Spec',
        loc: 1,
        cpt_defs: [],
        cpt_uses: []
    };
}

function canonicalEdge(id: string, from: string, to: string): Record<string, unknown> {
    return {
        id,
        from,
        to,
        type: 'file-link',
        refs: [],
        crossRepo: false,
        dangling: false
    };
}

function canonicalDiagnostic(id: string, relatedNodeId?: string): Record<string, unknown> {
    return {
        id,
        code: 'unresolved-link',
        severity: 'warning',
        message: 'Unresolved link',
        ...(relatedNodeId === undefined ? {} : { relatedNodeId })
    };
}
