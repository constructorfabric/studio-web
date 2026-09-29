import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { WorkspaceBoundary } from './workspace-boundary';
import { GitCommandError, GitExecutor } from './git-executor';
import { GitPublishService } from './git-publish-service';
import type { StudioRuntimeConfig } from './studio-runtime-config';
import { StudioRuntimeConfigService } from './studio-runtime-config';
import { OperationJournal } from './operation-journal';
import { RepositoryOperationQueue } from './repository-operation-queue';
import { RepositoryRegistry } from './repository-registry';
import type { RepositoryDiscoveryService } from './repository-discovery-service';
import type { StudioOperationSnapshot } from '../common/studio-protocol';

const execFileAsync = promisify(execFile);

describe('git publish service', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-git-publish-'));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('fails closed in disabled mode', async () => {
        const harness = await createHarness({ mode: 'disabled' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'hello');

        const result = await harness.service.execute(operation('tracked.md', 'hello'));
        expect(result).toEqual({ outcome: 'blocked', failureReason: 'Git publish is disabled' });
    });

    it('blocks a repository-aware operation when Git configuration changed after enqueue', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'updated');
        const queueRuntime = await createQueueRuntime(harness);
        const descriptor = queueRuntime.registry.descriptors[0];
        const changedDiscovery = {
            refreshRepository: async () => ({
                ...descriptor.git,
                configRevision: 'changed-config-revision'
            })
        } as unknown as RepositoryDiscoveryService;
        const service = new GitPublishService(
            new GitExecutor({ allowLocalTransport: true }),
            configService(harness.config),
            harness.boundary,
            queueRuntime.registry,
            changedDiscovery
        );
        const legacyOperation = operation('tracked.md', 'updated');
        const repositoryOperation: StudioOperationSnapshot = {
            ...legacyOperation,
            journalSchemaVersion: 2,
            repositoryId: descriptor.repositoryId,
            repositoryFingerprint: descriptor.fingerprint,
            repositoryConfigRevision: descriptor.git.configRevision
        };

        const result = await service.execute(repositoryOperation);

        expect(result).toEqual({
            outcome: 'blocked',
            failureReason: 'Repository Git configuration changed since the operation was queued'
        });
        expect(await revListCount(harness.repoPath)).toBe(1);
    });

    it('rejects resolved remote URLs that cannot form a Git rewrite key', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'updated');
        const config: StudioRuntimeConfig = {
            ...harness.config,
            git: harness.config.git.mode === 'disabled'
                ? harness.config.git
                : {
                    ...harness.config.git,
                    fetchUrl: `${harness.remotePath}=invalid`
                }
        };
        const service = new GitPublishService(new GitExecutor({ allowLocalTransport: true }), configService(config), harness.boundary);

        const result = await service.execute(operation('tracked.md', 'updated'));

        expect(result).toEqual({ outcome: 'blocked', failureReason: 'Resolved Git remote URL is invalid' });
        expect(await revListCount(harness.repoPath)).toBe(1);
    });

    it('returns no-changes without commit or push when the target is unchanged', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });

        const result = await harness.service.execute(operation('tracked.md', 'initial'));
        expect(result).toEqual({ outcome: 'no-changes' });
        expect(await revListCount(harness.repoPath)).toBe(1);
    });

    it('rejects pre-staged content before mutation', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'updated');
        await runGit(harness.repoPath, ['add', '--', 'tracked.md']);

        const result = await harness.service.execute(operation('tracked.md', 'updated'));
        expect(result).toEqual({ outcome: 'blocked', failureReason: 'Pre-staged content is not allowed' });
    });

    it('rejects unsafe repository-local Git execution configuration', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'updated');
        await runGit(harness.repoPath, ['config', '--local', 'core.sshCommand', 'unsafe-command']);

        const result = await harness.service.execute(operation('tracked.md', 'updated'));

        expect(result.outcome).toBe('blocked');
        expect('failureReason' in result ? result.failureReason : '').toContain('core.sshcommand');
        expect(await revListCount(harness.repoPath)).toBe(1);
    });

    it('rejects pushInsteadOf repository config before commit or push mutation', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'updated');
        await runGit(harness.repoPath, [
            'config', '--local', 'url.ssh://attacker.invalid/.pushInsteadOf', harness.remotePath
        ]);

        const result = await harness.service.execute(operation('tracked.md', 'updated'));

        expect(result.outcome).toBe('blocked');
        expect('failureReason' in result ? result.failureReason : '').toContain('pushinsteadof');
        expect(await revListCount(harness.repoPath)).toBe(1);
        expect(await remoteRevParse(harness.remotePath, 'main')).toBe(await runGit(harness.repoPath, ['rev-parse', 'HEAD']));
    });

    it('blocks unsupported publish transports during preflight before mutation', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'updated');
        const config: StudioRuntimeConfig = {
            ...harness.config,
            git: harness.config.git.mode === 'disabled' ? harness.config.git : {
                ...harness.config.git,
                fetchSourceUrl: 'git://example.test/repo.git',
                pushSourceUrl: 'git://example.test/repo.git',
                fetchUrl: 'git://example.test/repo.git',
                pushUrl: 'git://example.test/repo.git'
            }
        };

        const result = await new GitPublishService(
            new GitExecutor({ allowLocalTransport: true }),
            configService(config),
            harness.boundary
        ).execute(operation('tracked.md', 'updated'));

        expect(result).toEqual({ outcome: 'blocked', failureReason: 'Resolved Git remote URL is invalid' });
        expect(await revListCount(harness.repoPath)).toBe(1);
    });

    it('creates a local commit in commit mode and does not push', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'updated');

        const result = await harness.service.execute(operation('tracked.md', 'updated'));

        expect(result.outcome).toBe('committed-local');
        expect(await revListCount(harness.repoPath)).toBe(2);
        expect(await headSubject(harness.repoPath)).toBe('chore(studio): save tracked.md (+1 -1)');
        expect(await runGit(harness.repoPath, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'HEAD']))
            .toBe('Studio Bot <studio@example.com>|Studio Bot <studio@example.com>');
        expect(await runGit(harness.repoPath, ['show', '--format=', '--name-only', 'HEAD'])).toBe('tracked.md');
        expect(await remoteRevParse(harness.remotePath, 'main')).toHaveLength(40);
        expect(await runGit(harness.repoPath, ['rev-parse', 'HEAD'])).not.toBe(await remoteRevParse(harness.remotePath, 'main'));
    });

    it('commits a newly saved untracked file and only that path', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'new file.md', 'new contents');

        const result = await harness.service.execute(operation('new file.md', 'new contents'));

        expect(result.outcome).toBe('committed-local');
        expect(await runGit(harness.repoPath, ['show', '--format=', '--name-only', 'HEAD'])).toBe('new file.md');
    });

    it('commits only the saved path while preserving unrelated unstaged and untracked changes', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'unrelated tracked update');
        await writeTrackedFile(harness.repoPath, 'saved.md', 'saved contents');
        await writeTrackedFile(harness.repoPath, 'unrelated.md', 'unrelated untracked contents');

        const result = await harness.service.execute(operation('saved.md', 'saved contents'));

        expect(result.outcome).toBe('committed-local');
        expect(await runGit(harness.repoPath, ['show', '--format=', '--name-only', 'HEAD'])).toBe('saved.md');
        expect(await runGit(harness.repoPath, ['status', '--short', '--untracked-files=all'])).toBe([
            'M tracked.md',
            '?? unrelated.md'
        ].join('\n'));
    });

    it('rebases and pushes after the remote advances on a different markdown file', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'first update');
        await advanceRemoteWithoutLocalFetch(harness.remotePath, 'main');

        const result = await harness.service.execute(operation('tracked.md', 'first update'));

        expect(result).toMatchObject({ outcome: 'pushed', commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
        expect(await revListCount(harness.repoPath)).toBe(3);
        expect(await remoteRevParse(harness.remotePath, 'main')).toBe(await runGit(harness.repoPath, ['rev-parse', 'HEAD']));
    });

    it('pulls before staging, committing, and pushing a fresh save in push mode', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'ordered update');
        const calls: string[] = [];
        const orderedGit = new class extends GitExecutor {
            override async pullRebaseAutostash(...args: Parameters<GitExecutor['pullRebaseAutostash']>): Promise<void> {
                calls.push('pull');
                await super.pullRebaseAutostash(...args);
            }
            override async addPath(...args: Parameters<GitExecutor['addPath']>): Promise<void> {
                calls.push('add');
                await super.addPath(...args);
            }
            override async commitPath(...args: Parameters<GitExecutor['commitPath']>): Promise<void> {
                calls.push('commit');
                await super.commitPath(...args);
            }
            override async pushBranch(...args: Parameters<GitExecutor['pushBranch']>): Promise<void> {
                calls.push('push');
                await super.pushBranch(...args);
            }
        }({ allowLocalTransport: true });
        const service = new GitPublishService(orderedGit, configService(harness.config), harness.boundary);

        const result = await service.execute(operation('tracked.md', 'ordered update'));

        expect(result).toMatchObject({ outcome: 'pushed', commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
        expect(calls).toEqual(['pull', 'add', 'commit', 'push']);
        expect(await remoteRevParse(harness.remotePath, 'main')).toBe(await runGit(harness.repoPath, ['rev-parse', 'HEAD']));
    });

    it('does not stage or commit when the initial pull fails before a fresh push commit', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'pull blocked update');
        const calls: string[] = [];
        const failingPullGit = new class extends GitExecutor {
            override async pullRebaseAutostash(..._args: Parameters<GitExecutor['pullRebaseAutostash']>): Promise<void> {
                calls.push('pull');
                throw new GitCommandError('pull failed', ['pull', '--rebase'], 1, '', 'fatal: remote unavailable');
            }
            override async addPath(...args: Parameters<GitExecutor['addPath']>): Promise<void> {
                calls.push('add');
                await super.addPath(...args);
            }
            override async commitPath(...args: Parameters<GitExecutor['commitPath']>): Promise<void> {
                calls.push('commit');
                await super.commitPath(...args);
            }
        }({ allowLocalTransport: true });
        const service = new GitPublishService(failingPullGit, configService(harness.config), harness.boundary);

        const result = await service.execute(operation('tracked.md', 'pull blocked update'));

        expect(result).toEqual({
            outcome: 'push-pending',
            failureReason: 'fatal: remote unavailable',
            commitSha: await runGit(harness.repoPath, ['rev-parse', 'HEAD'])
        });
        expect(calls).toEqual(['pull']);
        expect(await revListCount(harness.repoPath)).toBe(1);
        expect(await runGit(harness.repoPath, ['diff', '--cached', '--name-only'])).toBe('');
        expect(await runGit(harness.repoPath, ['log', '-1', '--format=%s', 'HEAD'])).toBe('initial');
    });

    it('rewrites the repository-owned remote URL while preserving named-origin semantics', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        const sourceUrl = 'https://studio.invalid/owner/repo.git';
        await runGit(harness.repoPath, ['remote', 'set-url', 'origin', sourceUrl]);
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'rewritten remote update');
        const config: StudioRuntimeConfig = {
            ...harness.config,
            git: {
                mode: 'push',
                branch: 'main',
                remote: 'origin',
                fetchSourceUrl: sourceUrl,
                pushSourceUrl: sourceUrl,
                fetchUrl: harness.remotePath,
                pushUrl: harness.remotePath,
                authorName: 'Studio Bot',
                authorEmail: 'studio@example.com'
            }
        };
        const service = new GitPublishService(new GitExecutor({ allowLocalTransport: true }), configService(config), harness.boundary);

        const result = await service.execute(operation('tracked.md', 'rewritten remote update'));

        expect(result).toMatchObject({ outcome: 'pushed', commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
        expect(await remoteRevParse(harness.remotePath, 'main')).toBe(await runGit(harness.repoPath, ['rev-parse', 'HEAD']));
        expect(await runGit(harness.repoPath, ['config', '--local', '--get', 'remote.origin.url'])).toBe(sourceUrl);
    });

    it('retries only the push step on restart after a transient push failure', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'first update');
        await installRejectPushHook(harness.remotePath);

        const firstResult = await harness.service.execute(operation('tracked.md', 'first update'));
        expect(firstResult.outcome).toBe('push-pending');
        const localHeadAfterFailure = await runGit(harness.repoPath, ['rev-parse', 'HEAD']);
        expect(await revListCount(harness.repoPath)).toBe(2);

        await removeRejectPushHook(harness.remotePath);

        const restarted = await createHarness({ mode: 'push' }, { existing: harness, tempDir });
        const secondResult = await restarted.service.execute(operation('tracked.md', 'first update'));

        expect(secondResult).toMatchObject({ outcome: 'pushed', commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
        expect(await revListCount(harness.repoPath)).toBe(2);
        expect(await remoteRevParse(harness.remotePath, 'main')).toBe(localHeadAfterFailure);
    });

    it('finds a reachable save commit after HEAD moves and pushes current HEAD on retry', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'first update');
        await installRejectPushHook(harness.remotePath);

        const savedOperation = operation('tracked.md', 'first update');
        const firstResult = await harness.service.execute(savedOperation);
        expect(firstResult.outcome).toBe('push-pending');
        const saveCommit = await runGit(harness.repoPath, ['rev-parse', 'HEAD']);

        await removeRejectPushHook(harness.remotePath);
        await writeTrackedFile(harness.repoPath, 'local-only.md', 'local follow-up');
        await runGit(harness.repoPath, ['add', '--', 'local-only.md']);
        await runGit(harness.repoPath, ['commit', '-m', 'local follow-up']);
        const movedHead = await runGit(harness.repoPath, ['rev-parse', 'HEAD']);

        const restarted = await createHarness({ mode: 'push' }, { existing: harness, tempDir });
        const secondResult = await restarted.service.execute(savedOperation);

        expect(secondResult).toMatchObject({ outcome: 'pushed', commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
        expect(await runGit(harness.repoPath, ['merge-base', '--is-ancestor', saveCommit, movedHead]).then(() => 'yes')).toBe('yes');
        expect(await remoteRevParse(harness.remotePath, 'main')).toBe(movedHead);
        const saveSubjects = (await runGit(harness.repoPath, ['log', '--format=%s']))
            .split('\n')
            .filter(subject => subject === 'chore(studio): save tracked.md (+1 -1)');
        expect(saveSubjects).toHaveLength(1);
    });

    it('blocks a pending push when a later commit changes the saved file at HEAD', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'first update');
        await installRejectPushHook(harness.remotePath);
        const savedOperation = operation('tracked.md', 'first update');

        expect((await harness.service.execute(savedOperation)).outcome).toBe('push-pending');
        await removeRejectPushHook(harness.remotePath);
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'later update');
        await runGit(harness.repoPath, ['add', '--', 'tracked.md']);
        await runGit(harness.repoPath, ['commit', '-m', 'later update']);
        const remoteHeadBeforeRetry = await remoteRevParse(harness.remotePath, 'main');

        const result = await harness.service.execute(savedOperation, { resumingPush: true });

        expect(result).toEqual({
            outcome: 'blocked',
            failureReason: 'Previously committed saved content no longer matches HEAD'
        });
        expect(await remoteRevParse(harness.remotePath, 'main')).toBe(remoteHeadBeforeRetry);
    });

    it('pushes rewritten local history when the saved blob is still present at HEAD', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'first update');
        await installRejectPushHook(harness.remotePath);

        const savedOperation = operation('tracked.md', 'first update');
        expect((await harness.service.execute(savedOperation)).outcome).toBe('push-pending');
        await removeRejectPushHook(harness.remotePath);
        await runGit(harness.repoPath, ['commit', '--amend', '-m', 'rewritten local save']);
        const rewrittenHead = await runGit(harness.repoPath, ['rev-parse', 'HEAD']);

        const result = await harness.service.execute(savedOperation, { resumingPush: true });

        expect(result).toMatchObject({ outcome: 'pushed', commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
        expect(await remoteRevParse(harness.remotePath, 'main')).toBe(rewrittenHead);
        expect(await revListCount(harness.repoPath)).toBe(2);
    });

    it('keeps transient pull failures retryable across restart', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'pull unavailable update');
        const offlineRemotePath = `${harness.remotePath}.offline`;
        await fs.rename(harness.remotePath, offlineRemotePath);

        const dataDir = path.join(tempDir, 'pull-retry-data');
        const journal = new OperationJournal({
            dataDir,
            repositoryRoot: harness.repoPath
        });
        const firstRuntime = await createQueueRuntime(harness);
        const firstQueue = new RepositoryOperationQueue(journal, harness.boundary, firstRuntime.service, firstRuntime.registry);
        await firstQueue.initialize();
        await firstQueue.enqueue(scope('pull-retry-key', 'tracked.md', 'pull unavailable update', firstRuntime.registry.descriptors[0].repositoryId));
        await firstQueue.whenIdle();

        expect(journal.getCurrentOperations()[0]?.state).toBe('push-pending');
        expect(journal.getCurrentOperations()[0]?.failureReason).toContain('does not appear to be a git repository');

        await fs.rename(offlineRemotePath, harness.remotePath);
        const restartedJournal = new OperationJournal({
            dataDir,
            repositoryRoot: harness.repoPath
        });
        const restarted = await createHarness({ mode: 'push' }, { existing: harness, tempDir });
        const restartedRuntime = await createQueueRuntime(restarted);
        const restartedQueue = new RepositoryOperationQueue(restartedJournal, restarted.boundary, restartedRuntime.service, restartedRuntime.registry);
        await restartedQueue.initialize();

        expect(restartedJournal.getCurrentOperations()[0]?.state).toBe('pushed');
        expect(await remoteRevParse(harness.remotePath, 'main')).toBe(await runGit(harness.repoPath, ['rev-parse', 'HEAD']));
    });

    it('does not create duplicate commits for duplicate-key queue submissions', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'dup update');

        const journal = new OperationJournal({
            dataDir: path.join(tempDir, 'data'),
            repositoryRoot: harness.repoPath
        });
        const queueRuntime = await createQueueRuntime(harness);
        const queue = new RepositoryOperationQueue(journal, harness.boundary, queueRuntime.service, queueRuntime.registry);
        await queue.initialize();

        const first = await queue.enqueue(scope('dup-key', 'tracked.md', 'dup update', queueRuntime.registry.descriptors[0].repositoryId));
        const duplicate = await queue.enqueue(scope('dup-key', 'tracked.md', 'dup update', queueRuntime.registry.descriptors[0].repositoryId));
        await queue.whenIdle();

        expect(duplicate.reusedExisting).toBe(true);
        expect(duplicate.operation.operationId).toBe(first.operation.operationId);
        expect(await revListCount(harness.repoPath)).toBe(2);
    });

    it('replays a push-pending queue operation and retries only the push', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'restart update');
        await installRejectPushHook(harness.remotePath);

        const dataDir = path.join(tempDir, 'replay-data');
        const journal = new OperationJournal({
            dataDir,
            repositoryRoot: harness.repoPath
        });
        const firstRuntime = await createQueueRuntime(harness);
        const firstQueue = new RepositoryOperationQueue(journal, harness.boundary, firstRuntime.service, firstRuntime.registry);
        await firstQueue.initialize();
        await firstQueue.enqueue(scope('replay-key', 'tracked.md', 'restart update', firstRuntime.registry.descriptors[0].repositoryId));
        await firstQueue.whenIdle();
        const localHead = await runGit(harness.repoPath, ['rev-parse', 'HEAD']);
        expect(journal.getCurrentOperations()[0]?.state).toBe('push-pending');
        expect(await revListCount(harness.repoPath)).toBe(2);

        await removeRejectPushHook(harness.remotePath);
        const replayedJournal = new OperationJournal({
            dataDir,
            repositoryRoot: harness.repoPath
        });
        const restartedRuntime = await createQueueRuntime(harness);
        const restartedQueue = new RepositoryOperationQueue(replayedJournal, harness.boundary, restartedRuntime.service, restartedRuntime.registry);
        await restartedQueue.initialize();

        expect(await revListCount(harness.repoPath)).toBe(2);
        expect(await remoteRevParse(harness.remotePath, 'main')).toBe(localHead);
        const replayStates = replayedJournal.getEventsAfter(0).map(event => event.state);
        expect(replayStates.slice(-3)).toEqual(['validating', 'pushing', 'pushed']);
    });

    it('records deterministic markdown commit metadata and staged counts', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });
        const savedAt = '2026-07-28T12:34:56.789Z';
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'alpha\nbeta\n');

        const result = await harness.service.execute(operation('tracked.md', 'alpha\nbeta\n', { timestamp: savedAt }));

        expect(result.outcome).toBe('committed-local');
        expect(await headSubject(harness.repoPath)).toBe('chore(studio): save tracked.md (+2 -1)');
        expect(await runGit(harness.repoPath, ['log', '-1', '--format=%B', 'HEAD'])).toBe([
            'chore(studio): save tracked.md (+2 -1)',
            '',
            `Saved-At: ${savedAt}`,
            'Saved-File: tracked.md',
            'Saved-Path: tracked.md',
            'Staged-Lines-Added: 2',
            'Staged-Lines-Deleted: 1',
            '',
            `Studio-Idempotency-Key: key-${hash('alpha\nbeta\n').slice(0, 8)}`,
            `Studio-Content-Hash: ${hash('alpha\nbeta\n')}`,
            'Studio-Workspace-Id: workspace-1',
            'Studio-Workspace-Path: tracked.md',
            'Studio-Repository-Path: tracked.md',
            'Studio-Language-Id: markdown'
        ].join('\n'));
    });

    it('commits the nested workspace file when the repository has same-named root and nested markdown', async () => {
        const harness = await createHarness({ mode: 'commit', workspaceRelativePath: 'nested-workspace' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'README.md', 'root initial');
        await writeTrackedFile(harness.repoPath, 'nested-workspace/README.md', 'nested initial');
        await runGit(harness.repoPath, ['add', '--', 'README.md', 'nested-workspace/README.md']);
        await runGit(harness.repoPath, ['commit', '-m', 'same-name baseline']);
        await writeTrackedFile(harness.repoPath, 'README.md', 'root update');
        await writeTrackedFile(harness.repoPath, 'nested-workspace/README.md', 'nested update');

        const result = await harness.service.execute(operation('README.md', 'nested update', {
            repositoryRelativePath: 'nested-workspace/README.md'
        }));

        expect(result.outcome).toBe('committed-local');
        expect(await runGit(harness.repoPath, ['show', '--format=', '--name-only', 'HEAD'])).toBe('nested-workspace/README.md');
        expect(await runGit(harness.repoPath, ['status', '--short', '--untracked-files=all'])).toBe('M README.md');
    });

    it('blocks direct non-markdown operations before Git mutation', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'updated');

        const result = await harness.service.execute({
            ...operation('tracked.md', 'updated'),
            languageId: 'plaintext' as never
        });

        expect(result).toEqual({ outcome: 'blocked', failureReason: 'Only Theia-detected Markdown saves can be published' });
        expect(await revListCount(harness.repoPath)).toBe(1);
    });

    it('blocks when the saved file changes between hash validation and git add', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'saved contents');
        const mutatingGit = new class extends GitExecutor {
            override async addPath(cwd: string, relativePath: string): Promise<void> {
                await fs.writeFile(path.join(cwd, relativePath), 'later contents', 'utf8');
                await super.addPath(cwd, relativePath);
            }
        }({ allowLocalTransport: true });
        const service = new GitPublishService(mutatingGit, configService(harness.config), harness.boundary);

        const result = await service.execute(operation('tracked.md', 'saved contents'));

        expect(result).toEqual({ outcome: 'blocked', failureReason: 'Staged content hash mismatch' });
        expect(await revListCount(harness.repoPath)).toBe(1);
    });

    it('finds all matching operation commits beyond the normal command output limit', async () => {
        const harness = await createHarness({ mode: 'commit' }, { tempDir });
        const trailer = 'Studio-Idempotency-Key: repeated-key';
        for (let index = 0; index < 220; index += 1) {
            await runGit(harness.repoPath, ['commit', '--allow-empty', '-m', `empty ${index}\n\n${trailer}`]);
        }

        const commits = await new GitExecutor({ allowLocalTransport: true }).findReachableCommitsByMessage(harness.repoPath, trailer);

        expect(commits).toHaveLength(220);
    }, 30000);

    it('returns blocked and does not push when pull --rebase hits a conflict', async () => {
        const harness = await createHarness({ mode: 'push' }, { tempDir });
        await writeTrackedFile(harness.repoPath, 'tracked.md', 'local change\n');
        await advanceRemoteWithConflictingChange(harness.remotePath, 'main', 'tracked.md', 'remote change\n');

        const result = await harness.service.execute(operation('tracked.md', 'local change\n'));

        expect(result.outcome).toBe('blocked');
        expect('failureReason' in result ? result.failureReason : '').toBe('Saved content hash mismatch');
        expect(await revListCount(harness.repoPath)).toBe(2);
        expect(await runGit(harness.remotePath, ['log', '-1', '--format=%s', 'main'])).toBe('remote conflict');
    });

    it('keeps force, reset, checkout, and interactive rebase outside the publish path', async () => {
        const executorSource = await fs.readFile(path.join(__dirname, 'git-executor.ts'), 'utf8');
        const publishSource = await fs.readFile(path.join(__dirname, 'git-publish-service.ts'), 'utf8');
        expect(publishSource).not.toContain('forceCheckoutBranch');
        expect(publishSource).not.toContain(' reset');
        expect(publishSource).not.toContain('checkout');
        expect(publishSource).not.toContain('--interactive');
        expect(publishSource).not.toContain('--abort');
        expect(publishSource).not.toContain('--continue');
        expect(executorSource).toContain('pull');
        expect(executorSource).toContain('--rebase');
        expect(executorSource).toContain('--autostash');
        expect(executorSource).toContain('execFile');
    });
});

async function createHarness(
    gitMode: { mode: 'disabled' | 'commit' | 'push'; workspaceRelativePath?: string },
    options: { existing?: Harness; tempDir: string }
): Promise<Harness> {
    if (options.existing) {
        const config = runtimeConfig(options.existing.repoPath, options.existing.remotePath, gitMode.mode, options.tempDir, gitMode.workspaceRelativePath);
        const boundary = new WorkspaceBoundary();
        await boundary.initialize(config);
        return {
            repoPath: options.existing.repoPath,
            remotePath: options.existing.remotePath,
            config,
            boundary,
            service: new GitPublishService(new GitExecutor({ allowLocalTransport: true }), configService(config), boundary)
        };
    }

    const repoPath = path.join(options.tempDir, `repo-${gitMode.mode}-${Math.random().toString(16).slice(2)}`);
    const remotePath = path.join(options.tempDir, `remote-${gitMode.mode}-${Math.random().toString(16).slice(2)}.git`);
    await gitInit(repoPath, ['init', '-b', 'main']);
    await gitInit(remotePath, ['init', '--bare']);
    await fs.writeFile(path.join(repoPath, 'tracked.md'), 'initial', 'utf8');
    await runGit(repoPath, ['add', '--', 'tracked.md']);
    await runGit(repoPath, ['commit', '-m', 'initial']);
    await runGit(repoPath, ['remote', 'add', 'origin', remotePath]);
    await runGit(repoPath, ['push', 'origin', 'refs/heads/main:refs/heads/main']);

    if (gitMode.workspaceRelativePath) {
        await fs.mkdir(path.join(repoPath, gitMode.workspaceRelativePath), { recursive: true });
    }
    const config = runtimeConfig(repoPath, remotePath, gitMode.mode, options.tempDir, gitMode.workspaceRelativePath);
    const boundary = new WorkspaceBoundary();
    await boundary.initialize(config);
    return {
        repoPath,
        remotePath,
        config,
        boundary,
        service: new GitPublishService(new GitExecutor({ allowLocalTransport: true }), configService(config), boundary)
    };
}

type Harness = {
    repoPath: string;
    remotePath: string;
    config: StudioRuntimeConfig;
    boundary: WorkspaceBoundary;
    service: GitPublishService;
};

function runtimeConfig(
    repositoryRoot: string,
    remotePath: string,
    mode: 'disabled' | 'commit' | 'push',
    tempDir: string,
    workspaceRelativePath?: string
): StudioRuntimeConfig {
    return {
        actorId: 'actor-1',
        workspaceId: 'workspace-1',
        workspaceRoot: workspaceRelativePath ? path.join(repositoryRoot, workspaceRelativePath) : repositoryRoot,
        repositoryRoot,
        dataDir: path.join(tempDir, 'runtime-data'),
        allowedOriginsMode: 'same-origin',
        allowedOrigins: [],
        git: mode === 'disabled'
            ? { mode }
            : {
                mode,
                branch: 'main',
                remote: 'origin',
                fetchSourceUrl: remotePath,
                pushSourceUrl: remotePath,
                fetchUrl: remotePath,
                pushUrl: remotePath,
                authorName: 'Studio Bot',
                authorEmail: 'studio@example.com'
            },
        secrets: {}
    };
}

function configService(config: StudioRuntimeConfig) {
    return {
        getConfig: () => config
    } as unknown as StudioRuntimeConfigService;
}

function operation(relativePath: string, contents: string, options?: { timestamp?: string; repositoryRelativePath?: string }): StudioOperationSnapshot {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const repositoryRelativePath = options?.repositoryRelativePath ?? relativePath;
    return {
        journalSchemaVersion: 1,
        operationId: 'op-1',
        workspaceId: 'workspace-1',
        relativePath,
        repositoryRelativePath,
        languageId: 'markdown',
        contentHash: hash(contents),
        idempotencyKey: `key-${hash(contents).slice(0, 8)}`,
        savedAt: timestamp,
        state: 'queued',
        createdAt: timestamp,
        updatedAt: timestamp,
        createdSequence: 1,
        lastSequence: 1
    };
}

function scope(idempotencyKey: string, relativePath: string, contents: string, repositoryId: string) {
    return {
        workspaceId: 'workspace-1',
        repositoryId,
        relativePath,
        repositoryRelativePath: relativePath,
        languageId: 'markdown' as const,
        contentHash: hash(contents),
        idempotencyKey,
        savedAt: '2026-07-27T00:00:00.000Z'
    };
}

async function createQueueRuntime(harness: Harness): Promise<{
    readonly registry: RepositoryRegistry;
    readonly service: GitPublishService;
}> {
    const registry = new RepositoryRegistry();
    await registry.initialize(harness.config.workspaceRoot);
    if (harness.config.git.mode === 'disabled') {
        throw new Error('Queue runtime requires enabled Git');
    }
    const git = {
        configRevision: 'test-config-revision',
        ...harness.config.git,
        publishEnabled: true
    } as const;
    await registry.replace([{ repositoryRoot: harness.repoPath, git }]);
    const discovery = {
        refreshRepository: async () => git
    } as unknown as RepositoryDiscoveryService;
    return {
        registry,
        service: new GitPublishService(
            new GitExecutor({ allowLocalTransport: true }),
            configService(harness.config),
            harness.boundary,
            registry,
            discovery
        )
    };
}

async function gitInit(cwd: string, args: string[]): Promise<void> {
    await fs.mkdir(cwd, { recursive: true });
    await runGit(cwd, args);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync('git', args, {
        cwd,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test User',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'Test User',
            GIT_COMMITTER_EMAIL: 'test@example.com',
            GIT_TERMINAL_PROMPT: '0'
        }
    });
    return String(result.stdout ?? '').trim();
}

async function writeTrackedFile(repoPath: string, relativePath: string, contents: string): Promise<void> {
    await fs.mkdir(path.dirname(path.join(repoPath, relativePath)), { recursive: true });
    await fs.writeFile(path.join(repoPath, relativePath), contents, 'utf8');
}

async function revListCount(repoPath: string): Promise<number> {
    return Number(await runGit(repoPath, ['rev-list', '--count', 'HEAD']));
}

async function headSubject(repoPath: string): Promise<string> {
    return runGit(repoPath, ['log', '-1', '--format=%s', 'HEAD']);
}

async function remoteRevParse(remotePath: string, branch: string): Promise<string> {
    return runGit(remotePath, ['rev-parse', branch]);
}

async function advanceRemoteWithoutLocalFetch(remotePath: string, branch: string): Promise<void> {
    const clonePath = path.join(path.dirname(remotePath), `clone-${Math.random().toString(16).slice(2)}`);
    await runGit(path.dirname(clonePath), ['clone', '--branch', branch, remotePath, clonePath]);
    await fs.writeFile(path.join(clonePath, 'remote-only.md'), 'remote update', 'utf8');
    await runGit(clonePath, ['add', '--', 'remote-only.md']);
    await runGit(clonePath, ['commit', '-m', 'remote advance']);
    await runGit(clonePath, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
}

async function advanceRemoteWithConflictingChange(
    remotePath: string,
    branch: string,
    relativePath: string,
    contents: string
): Promise<void> {
    const clonePath = path.join(path.dirname(remotePath), `clone-conflict-${Math.random().toString(16).slice(2)}`);
    await runGit(path.dirname(clonePath), ['clone', '--branch', branch, remotePath, clonePath]);
    await fs.writeFile(path.join(clonePath, relativePath), contents, 'utf8');
    await runGit(clonePath, ['add', '--', relativePath]);
    await runGit(clonePath, ['commit', '-m', 'remote conflict']);
    await runGit(clonePath, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
}

async function installRejectPushHook(remotePath: string): Promise<void> {
    const hookPath = path.join(remotePath, 'hooks', 'pre-receive');
    await fs.writeFile(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
}

async function removeRejectPushHook(remotePath: string): Promise<void> {
    await fs.rm(path.join(remotePath, 'hooks', 'pre-receive'), { force: true });
}

function hash(contents: string): string {
    const crypto = require('crypto') as typeof import('crypto');
    return crypto.createHash('sha256').update(contents).digest('hex');
}
