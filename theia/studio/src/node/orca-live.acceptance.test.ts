// Live acceptance: the exact code the IDE backend runs, against a real Orca
// runtime on this machine. Same posture as `cfs-map-live.acceptance.test.ts` —
// it exercises the real tool when the tool is available and stands down
// otherwise, so CI without an Orca install stays green.
//
// What it proves that the unit tests cannot: the CLI is where we think it is,
// the flags we send are accepted, and the payloads we map are the payloads the
// runtime actually returns.

import 'reflect-metadata';
import { OrcaCli, OrcaCliMissingError } from './orca-cli';
import { OrcaServiceImpl } from './orca-service';

function build(): OrcaServiceImpl {
    const service = new OrcaServiceImpl();
    (service as unknown as { cli: OrcaCli }).cli = new OrcaCli();
    return service;
}

describe('live Orca runtime', () => {
    jest.setTimeout(120_000);

    it('reads status, worktrees and agent terminals when an Orca runtime is available', async () => {
        const service = build();

        // No install: the panel's own "not reachable" path, and nothing to assert.
        try {
            new OrcaCli().binary();
        } catch (error) {
            expect(error).toBeInstanceOf(OrcaCliMissingError);
            console.log('orca CLI not installed — live acceptance skipped');
            return;
        }

        const status = await service.status();
        if (!status.reachable) {
            // Installed but nothing serving: also a supported state.
            expect(status.state).toBe('unreachable');
            console.log(`orca runtime not reachable (${status.error ?? 'no reason given'}) — live acceptance skipped`);
            return;
        }

        // A reachable runtime reports a version and a state we can render.
        expect(status.state).toBeTruthy();
        expect(status.appVersion).toMatch(/^\d+\.\d+/);

        const worktrees = await service.listWorktrees();
        expect(Array.isArray(worktrees)).toBe(true);
        for (const worktree of worktrees) {
            // Whatever else changes upstream, these are the fields the panel
            // renders and the selector is built from.
            expect(worktree.id).toBeTruthy();
            expect(worktree.path).toBeTruthy();
            expect(worktree.branch).not.toMatch(/^refs\/heads\//);
        }

        const current = await service.currentWorktree();
        if (current) {
            // The test process runs inside a checkout, so if Orca manages it,
            // it must be one of the listed worktrees.
            expect(worktrees.some(w => w.path === current.path)).toBe(true);

            const terminals = await service.listTerminals(`path:${current.path}`);
            expect(Array.isArray(terminals)).toBe(true);
            for (const terminal of terminals) {
                expect(terminal.handle).toMatch(/^term_/);
            }
            console.log(
                `live: ${worktrees.length} worktree(s), ${terminals.length} terminal(s) in ${current.branch}` +
                    (terminals.length ? ` — agents: ${terminals.map(t => t.agent ?? '?').join(', ')}` : '')
            );
        } else {
            console.log(`live: ${worktrees.length} worktree(s); this checkout is not Orca-managed`);
        }
    });

    it('turns a refused command into a message an operator can act on', async () => {
        const service = build();
        try {
            new OrcaCli().binary();
        } catch {
            console.log('orca CLI not installed — live acceptance skipped');
            return;
        }
        if (!(await service.status()).reachable) {
            console.log('orca runtime not reachable — live acceptance skipped');
            return;
        }

        // A selector that cannot resolve: the runtime refuses, and the refusal
        // must arrive as a readable message rather than "exit code 1".
        await expect(service.listTerminals('path:/definitely/not/a/worktree')).rejects.toThrow(
            /worktree|selector|not found|no such/i
        );
    });
});
