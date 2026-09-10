import 'reflect-metadata';
jest.mock('./git-operations-contribution', () => ({
    GitOperationsFrontendController: class {}
}));
jest.mock('./workspace-sources-controller', () => ({
    WorkspaceSourcesFrontendController: class {}
}));
import type {
    StudioAuditEntry,
    StudioOperationEvent,
    StudioRepositoryDescriptor
} from '../common/studio-protocol';
import { AuditFrontendController } from './audit-controller';
import { StudioRuntimeFrontendClient } from './studio-runtime-client';

describe('Studio Audit frontend delivery', () => {
    const entry: StudioAuditEntry = {
        sequence: 7,
        relativePath: 'docs/spec.md',
        contentHash: 'a'.repeat(64),
        sha: 'b'.repeat(40),
        time: '2026-07-29T08:00:00.000Z',
        outcome: 'pushed'
    };

    it('delivers live audit notifications through the single Studio runtime client', () => {
        const gitOperations = {
            onOperationEvent: jest.fn(),
            onRepositoriesChanged: jest.fn()
        };
        const audit = { onAuditEvent: jest.fn() };
        const client = new StudioRuntimeFrontendClient(
            gitOperations as never,
            audit as never,
            {} as never,
            {} as never, // OpenInEditorFrontendController (unused in this test)
            {} as never // NotifyEditorFrontendController (unused in this test)
        );

        client.onAuditEvent(entry);
        client.onOperationEvent({ sequence: 8 } as StudioOperationEvent);
        client.onRepositoriesChanged([] as readonly StudioRepositoryDescriptor[]);

        expect(audit.onAuditEvent).toHaveBeenCalledWith(entry);
        expect(gitOperations.onOperationEvent).toHaveBeenCalledWith({ sequence: 8 });
        expect(gitOperations.onRepositoriesChanged).toHaveBeenCalledWith([]);
    });

    it('merges reconnect deltas and later live entries without duplicates', async () => {
        const controller = new AuditFrontendController();
        const runtime = {
            getAuditDeltas: jest.fn(async () => ({
                lastSequence: 7,
                entries: [entry]
            })),
            onDidOpenConnection: jest.fn(() => ({ dispose: jest.fn() })),
            onDidCloseConnection: jest.fn(() => ({ dispose: jest.fn() }))
        };

        controller.bindRuntime(runtime);
        await controller.onStart();
        controller.onAuditEvent(entry);
        controller.onAuditEvent({ ...entry, sequence: 8, outcome: 'pending' });

        expect(controller.getEntries()).toEqual([
            { ...entry, sequence: 8, outcome: 'pending' },
            entry
        ]);
        expect(runtime.getAuditDeltas).toHaveBeenCalledWith({ afterSequence: 0 });

        controller.onStop();
    });
});
