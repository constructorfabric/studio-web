import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { OperationJournal } from './operation-journal';
import { RepositoryOperationQueue, type FakeRepositoryExecutionResult } from './repository-operation-queue';
import { WorkspaceBoundary } from './workspace-boundary';
import { RepositoryRegistry } from './repository-registry';
import type { StudioRuntimeConfig } from './studio-runtime-config';

let repositoryId: string;
let repositoryFingerprint: string;
const COMMIT_SHA = 'a'.repeat(40);

describe('repository operation queue', () => {
    let tempDir: string;
    let repoRoot: string;
    let boundary: WorkspaceBoundary;
    let registry: RepositoryRegistry;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-queue-'));
        repoRoot = path.join(tempDir, 'repo');
        await fs.mkdir(repoRoot);
        boundary = new WorkspaceBoundary();
        await boundary.initialize(runtimeConfig(repoRoot, path.join(tempDir, 'data')));
        await Promise.all(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map(file =>
            fs.writeFile(path.join(repoRoot, file), file)
        ));
        registry = new RepositoryRegistry();
        await registry.initialize(repoRoot);
        const [descriptor] = await registry.replace([{ repositoryRoot: repoRoot }]);
        repositoryId = descriptor.repositoryId;
        repositoryFingerprint = descriptor.fingerprint;
    });

    afterEach(async () => {
        registry.dispose();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('enforces strict fifo ordering and duplicate reuse', async () => {
        const journal = createJournal();
        const executionOrder: string[] = [];
        const queue = new RepositoryOperationQueue(journal, boundary, {
            execute: async operation => {
                executionOrder.push(operation.operationId);
                return { outcome: 'pushed', commitSha: COMMIT_SHA };
            }
        }, registry);
        await queue.initialize();

        const first = await queue.enqueue(request('key-1', 'a.txt', 'hash-a'));
        const duplicate = await queue.enqueue(request('key-1', 'a.txt', 'hash-a'));
        const second = await queue.enqueue(request('key-2', 'b.txt', 'hash-b'));

        await queue.whenIdle();

        expect(duplicate.reusedExisting).toBe(true);
        expect(duplicate.operation.operationId).toBe(first.operation.operationId);
        expect(second.reusedExisting).toBe(false);
        expect(executionOrder).toEqual([first.operation.operationId, second.operation.operationId]);
    });

    it('drives no-changes, failed, push-pending, blocked, and pushed branches', async () => {
        const journal = createJournal();
        const outcomes = new Map<string, FakeRepositoryExecutionResult>([
            ['a.txt', { outcome: 'no-changes' }],
            ['b.txt', { outcome: 'failed', failureReason: 'validation failed' }],
            ['c.txt', { outcome: 'push-pending', failureReason: 'remote unavailable', commitSha: COMMIT_SHA }],
            ['d.txt', { outcome: 'blocked', failureReason: 'manual approval required' }],
            ['e.txt', { outcome: 'pushed', commitSha: COMMIT_SHA }]
        ]);
        const queue = new RepositoryOperationQueue(journal, boundary, {
            execute: async operation => outcomes.get(operation.relativePath) ?? { outcome: 'pushed', commitSha: COMMIT_SHA }
        }, registry);
        await queue.initialize();

        await queue.enqueue(request('k1', 'a.txt', 'h1'));
        await queue.enqueue(request('k2', 'b.txt', 'h2'));
        await queue.enqueue(request('k3', 'c.txt', 'h3'));
        await queue.enqueue(request('k4', 'd.txt', 'h4'));
        await queue.enqueue(request('k5', 'e.txt', 'h5'));

        await queue.whenIdle();

        expect(journal.getCurrentOperations().map(operation => operation.state)).toEqual([
            'no-changes',
            'failed',
            'push-pending',
            'blocked',
            'pushed'
        ]);
        expect(journal.getCurrentOperations().filter(operation => operation.commitSha).map(operation => operation.commitSha)).toEqual([
            COMMIT_SHA,
            COMMIT_SHA
        ]);
        const transitionsByPath = new Map<string, string[]>();
        for (const event of journal.getEventsAfter(0)) {
            const states = transitionsByPath.get(event.relativePath) ?? [];
            states.push(event.state);
            transitionsByPath.set(event.relativePath, states);
        }
        expect(journal.getEventsAfter(0).find(event => event.state === 'pushed')?.commitSha).toBe(COMMIT_SHA);
        expect(transitionsByPath.get('a.txt')).toEqual(['queued', 'validating', 'no-changes']);
        expect(transitionsByPath.get('b.txt')).toEqual(['queued', 'validating', 'failed']);
        expect(transitionsByPath.get('c.txt')).toEqual(['queued', 'validating', 'committing', 'committed', 'push-pending']);
        expect(transitionsByPath.get('d.txt')).toEqual(['queued', 'validating', 'blocked']);
        expect(transitionsByPath.get('e.txt')).toEqual(['queued', 'validating', 'committing', 'committed', 'pushing', 'pushed']);
    });

    it('records a local-only commit as terminal and does not replay it after restart', async () => {
        const journal = createJournal();
        let executions = 0;
        const executor = {
            execute: async () => {
                executions += 1;
                return { outcome: 'committed-local', commitSha: COMMIT_SHA } as const;
            }
        };
        const queue = new RepositoryOperationQueue(journal, boundary, executor, registry);
        await queue.initialize();

        await queue.enqueue(request('local-key', 'a.txt', 'hash-a'));
        await queue.whenIdle();

        expect(journal.getCurrentOperations()[0]?.state).toBe('committed-local');
        expect(journal.getEventsAfter(0).map(event => event.state)).toEqual([
            'queued',
            'validating',
            'committing',
            'committed-local'
        ]);

        const replayed = new RepositoryOperationQueue(createJournal(), boundary, executor, registry);
        await replayed.initialize();
        expect(executions).toBe(1);
    });

    it('re-resolves repository identity when retrying an identity-drift failure', async () => {
        const journal = createJournal();
        let executions = 0;
        const queue = new RepositoryOperationQueue(journal, boundary, {
            execute: async () => {
                executions += 1;
                return executions === 1
                    ? { outcome: 'failed', failureReason: 'Repository ownership changed since the operation was queued' }
                    : { outcome: 'no-changes' };
            }
        }, registry);
        await queue.initialize();
        const contentHash = createHash('sha256').update('a.txt').digest('hex');
        const first = await queue.enqueue(request('identity-drift', 'a.txt', contentHash));
        await queue.whenIdle();

        const [retried, concurrentRetry] = await Promise.all([
            queue.retry(first.operation.operationId),
            queue.retry(first.operation.operationId)
        ]);
        await queue.whenIdle();

        expect(retried.operationId).not.toBe(first.operation.operationId);
        expect(concurrentRetry.operationId).toBe(retried.operationId);
        expect(retried.repositoryId).toBe(repositoryId);
        expect(journal.getOperation(first.operation.operationId)?.state).toBe('failed');
        expect(journal.getOperation(retried.operationId)?.state).toBe('no-changes');
        expect(executions).toBe(2);
    });

    it('publishes persisted deltas and supports replay after restart', async () => {
        const journal = createJournal();
        const seen: number[] = [];
        const queue = new RepositoryOperationQueue(journal, boundary, {
            execute: async () => ({ outcome: 'pushed', commitSha: COMMIT_SHA })
        }, registry);
        await queue.initialize();
        queue.subscribe(event => {
            seen.push(event.sequence);
            expect(journal.getEventsAfter(event.sequence - 1)[0]?.sequence).toBe(event.sequence);
        });

        await queue.enqueue(request('key-1', 'a.txt', 'hash-a'));
        await queue.whenIdle();

        const afterFirst = queue.getEventsAfter(2);
        expect(afterFirst.events.map(event => event.sequence)).toEqual([3, 4, 5, 6]);
        expect(seen).toEqual([1, 2, 3, 4, 5, 6]);

        const replayedJournal = createJournal();
        const replayedQueue = new RepositoryOperationQueue(replayedJournal, boundary, {
            execute: async () => ({ outcome: 'pushed', commitSha: COMMIT_SHA })
        }, registry);
        await replayedQueue.initialize();

        expect(replayedQueue.getEventsAfter(4).events.map(event => event.sequence)).toEqual([5, 6]);
        expect(replayedJournal.getCurrentOperations()[0]?.state).toBe('pushed');
    });

    it('serializes concurrent duplicate enqueue and validates paths through the workspace boundary', async () => {
        const journal = createJournal();
        const queue = new RepositoryOperationQueue(journal, boundary, {
            execute: async () => ({ outcome: 'no-changes' })
        }, registry);
        await queue.initialize();

        const [first, duplicate] = await Promise.all([
            queue.enqueue(request('same-key', './nested/../a.txt', 'hash-a')),
            queue.enqueue(request('same-key', 'a.txt', 'hash-a'))
        ]);
        await queue.whenIdle();

        expect([first.reusedExisting, duplicate.reusedExisting].sort()).toEqual([false, true]);
        expect(first.operation.operationId).toBe(duplicate.operation.operationId);
        expect(journal.getEventsAfter(0).filter(event => event.state === 'queued')).toHaveLength(1);
        await expect(queue.enqueue(request('escape', '../outside.txt', 'hash'))).rejects.toThrow('Path traversal');
    });

    it('reuses an existing operation when only the incoming savedAt differs', async () => {
        const journal = createJournal();
        const queue = new RepositoryOperationQueue(journal, boundary, {
            execute: async () => ({ outcome: 'no-changes' })
        }, registry);
        await queue.initialize();

        const first = await queue.enqueue(request('same-key', 'a.txt', 'hash-a', '2026-07-27T00:00:00.000Z'));
        const duplicate = await queue.enqueue(request('same-key', 'a.txt', 'hash-a', '2026-07-27T00:00:10.000Z'));
        await queue.whenIdle();

        expect(duplicate.reusedExisting).toBe(true);
        expect(duplicate.operation.operationId).toBe(first.operation.operationId);
        expect(duplicate.operation.savedAt).toBe('2026-07-27T00:00:00.000Z');
    });

    it('preserves original enqueue order when replayed operations have interleaved transitions', async () => {
        const journal = createJournal();
        const firstScope = journalScope('key-1', 'a.txt', 'hash-a');
        const secondScope = journalScope('key-2', 'b.txt', 'hash-b');
        await journal.appendTransition(firstScope, 'op-1', 'queued', '2026-07-27T00:00:00.000Z');
        await journal.appendTransition(firstScope, 'op-1', 'validating', '2026-07-27T00:00:01.000Z');
        await journal.appendTransition(secondScope, 'op-2', 'queued', '2026-07-27T00:00:02.000Z');
        await journal.appendTransition(firstScope, 'op-1', 'committing', '2026-07-27T00:00:03.000Z');
        const executionOrder: string[] = [];
        const queue = new RepositoryOperationQueue(journal, boundary, {
            execute: async operation => {
                executionOrder.push(operation.operationId);
                return { outcome: 'no-changes' };
            }
        }, registry);

        await queue.initialize();

        expect(executionOrder).toEqual(['op-1', 'op-2']);
    });

    it('retries only recoverable terminal operations', async () => {
        const journal = createJournal();
        let attempts = 0;
        const queue = new RepositoryOperationQueue(journal, boundary, {
            execute: async () => {
                attempts += 1;
                return attempts === 1
                    ? { outcome: 'blocked', failureReason: 'temporary policy' }
                    : { outcome: 'no-changes' };
            }
        }, registry);
        await queue.initialize();

        const enqueued = await queue.enqueue(request('retry-key', 'a.txt', 'hash-a'));
        await queue.whenIdle();
        expect(journal.getOperation(enqueued.operation.operationId)?.state).toBe('blocked');

        await queue.retry(enqueued.operation.operationId);
        await queue.whenIdle();
        expect(journal.getOperation(enqueued.operation.operationId)?.state).toBe('no-changes');
        await expect(queue.retry(enqueued.operation.operationId)).rejects.toThrow('not retryable');
    });

    it('runs different repositories concurrently while preserving each repository queue', async () => {
        const nestedRoot = path.join(repoRoot, 'nested');
        await fs.mkdir(nestedRoot);
        await fs.writeFile(path.join(nestedRoot, 'nested.md'), 'nested');
        const descriptors = await registry.replace([
            { repositoryRoot: repoRoot },
            { repositoryRoot: nestedRoot }
        ]);
        const rootDescriptor = descriptors.find(descriptor => descriptor.workspaceRelativeRoot === '.')!;
        const nestedDescriptor = descriptors.find(descriptor => descriptor.workspaceRelativeRoot === 'nested')!;
        let releaseExecutions: () => void = () => undefined;
        const executionGate = new Promise<void>(resolve => {
            releaseExecutions = resolve;
        });
        const startedRepositories: string[] = [];
        const queue = new RepositoryOperationQueue(createJournal(), boundary, {
            execute: async operation => {
                startedRepositories.push(operation.repositoryId!);
                if (startedRepositories.length === 2) {
                    releaseExecutions();
                }
                await executionGate;
                return { outcome: 'no-changes' };
            }
        }, registry);
        await queue.initialize();

        await queue.enqueue(request('root-key', 'a.txt', 'root-hash', undefined, rootDescriptor.repositoryId));
        await queue.enqueue(request('nested-key', 'nested/nested.md', 'nested-hash', undefined, nestedDescriptor.repositoryId));
        await queue.whenIdle();

        expect(new Set(startedRepositories)).toEqual(new Set([
            rootDescriptor.repositoryId,
            nestedDescriptor.repositoryId
        ]));
    });

    it('blocks legacy nonterminal entries and creates a new v2 operation on explicit retry', async () => {
        const fileContents = 'a.txt';
        const contentHash = createHash('sha256').update(fileContents).digest('hex');
        const journal = createJournal();
        await journal.initialize();
        await fs.appendFile(journal.getJournalPath(), `${JSON.stringify({
            sequence: 1,
            operationId: 'legacy-op',
            state: 'queued',
            timestamp: '2026-07-27T00:00:00.000Z',
            workspaceId: 'workspace-1',
            relativePath: 'a.txt',
            repositoryRelativePath: 'a.txt',
            languageId: 'markdown',
            contentHash,
            idempotencyKey: 'legacy-key',
            savedAt: '2026-07-27T00:00:00.000Z'
        })}\n`);
        const replayedJournal = createJournal();
        let executions = 0;
        const queue = new RepositoryOperationQueue(replayedJournal, boundary, {
            execute: async () => {
                executions += 1;
                return { outcome: 'no-changes' };
            }
        }, registry);

        await queue.initialize();

        const legacy = replayedJournal.getOperation('legacy-op');
        expect(legacy).toMatchObject({
            journalSchemaVersion: 1,
            state: 'blocked',
            failureReason: expect.stringContaining('repository identity is missing')
        });
        expect(executions).toBe(0);

        const retried = await queue.retry('legacy-op');
        await queue.whenIdle();

        expect(retried.journalSchemaVersion).toBe(2);
        expect(retried.operationId).not.toBe('legacy-op');
        expect(retried.repositoryId).toBe(repositoryId);
        expect(executions).toBe(1);
        expect(replayedJournal.getOperation('legacy-op')?.state).toBe('blocked');
    });

    function createJournal(): OperationJournal {
        return new OperationJournal({
            dataDir: path.join(tempDir, 'data'),
            repositoryRoot: repoRoot
        });
    }
});

function runtimeConfig(repositoryRoot: string, dataDir: string): StudioRuntimeConfig {
    return {
        actorId: 'actor-1',
        workspaceId: 'workspace-1',
        workspaceRoot: repositoryRoot,
        repositoryRoot,
        dataDir,
        allowedOriginsMode: 'same-origin',
        allowedOrigins: [],
        git: { mode: 'disabled' },
        secrets: {}
    };
}

function request(
    idempotencyKey: string,
    relativePath: string,
    contentHash: string,
    savedAt = '2026-07-27T00:00:00.000Z',
    requestRepositoryId = repositoryId
) {
    return {
        workspaceId: 'workspace-1',
        repositoryId: requestRepositoryId,
        relativePath,
        languageId: 'markdown' as const,
        contentHash,
        idempotencyKey,
        savedAt
    };
}

function journalScope(idempotencyKey: string, relativePath: string, contentHash: string) {
    return {
        ...request(idempotencyKey, relativePath, contentHash),
        journalSchemaVersion: 2 as const,
        repositoryFingerprint,
        repositoryConfigRevision: 'unconfigured',
        repositoryRelativePath: relativePath
    };
}
