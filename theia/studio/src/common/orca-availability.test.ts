// Every state the Agents panel can find the Orca runtime in, and what it says
// and offers for each, on a member's machine and in a session.

import { compareVersions, missingAgentsNote, orcaAvailability } from './orca-availability';
import type { OrcaRuntimeStatus } from './orca-protocol';

const status = (over: Partial<OrcaRuntimeStatus>): OrcaRuntimeStatus => ({
    reachable: false,
    state: 'unreachable',
    desktopRunning: false,
    ...over
});

describe('what the panel says about the Orca runtime', () => {

    it('says it is checking before the first answer', () => {
        expect(orcaAvailability(undefined).kind).toBe('checking');
    });

    it('on a member\'s machine without Orca: install it, with a link', () => {
        const a = orcaAvailability(status({ host: 'local', cliMissing: true }));
        expect(a.kind).toBe('not-installed');
        expect(a.actions).toEqual(['install', 'retry']);
        expect(a.advice).toContain('Install Orca');
        expect(a.advice).toContain('ORCA_CLI');
        // A member has no image to rebuild.
        expect(a.advice).not.toContain('STUDIO_ORCA_DEB_URL');
        expect(a.advice).not.toContain('image');
    });

    it('in a session without Orca: the image, not a download', () => {
        const a = orcaAvailability(status({ host: 'session', cliMissing: true }));
        expect(a.advice).toContain('STUDIO_ORCA_DEB_URL');
        expect(a.actions).not.toContain('install');
        expect(a.advice).not.toContain('orca serve');
    });

    it('treats an older backend that names no host as a session', () => {
        expect(orcaAvailability(status({ cliMissing: true })).advice).toContain('built without the Orca runtime');
    });

    it('installed but closed: offers to start it', () => {
        for (const state of ['not_running', 'stale_bootstrap']) {
            const a = orcaAvailability(status({ host: 'local', state }));
            expect(a.kind).toBe('not-running');
            expect(a.actions[0]).toBe('start');
        }
    });

    it('in a session whose runtime is down: restart it, nothing to start by hand', () => {
        const a = orcaAvailability(status({ host: 'session', state: 'not_running' }));
        expect(a.actions).toEqual(['retry']);
        expect(a.advice).toContain('restart the session');
    });

    it('starting: wait and refresh', () => {
        expect(orcaAvailability(status({ host: 'local', state: 'starting' })).kind).toBe('starting');
        expect(orcaAvailability(status({ host: 'local', state: 'graph_not_ready' })).kind).toBe('starting');
    });

    it('any other failure carries its reason and still offers a way on', () => {
        const a = orcaAvailability(status({ host: 'local', error: 'orca status was killed before it answered (timeout)' }));
        expect(a.kind).toBe('unreachable');
        expect(a.advice).toContain('timeout');
        expect(a.actions).toEqual(['start', 'retry']);
    });

    it('ready: the status line the desktop showed', () => {
        const a = orcaAvailability(status({
            host: 'local', reachable: true, state: 'ready', appVersion: '1.4.211', desktopRunning: true, paired: true
        }));
        expect(a.kind).toBe('ready');
        expect(a.headline).toBe('ready · 1.4.211 · desktop');
        expect(a.notes).toEqual([]);
        expect(a.actions).toEqual(['retry']);
    });

    it('ready but unpaired on a member\'s machine: says terminals need a pairing, and offers it', () => {
        const a = orcaAvailability(status({ host: 'local', reachable: true, state: 'ready', paired: false }));
        expect(a.actions).toContain('pair');
        expect(a.notes.join(' ')).toMatch(/paired/);
    });

    it('a session never offers to pair: it pairs itself', () => {
        const a = orcaAvailability(status({ host: 'session', reachable: true, state: 'ready', paired: false }));
        expect(a.actions).not.toContain('pair');
    });

    it('names an Orca older than the one Studio is tested with', () => {
        const a = orcaAvailability(status({ host: 'local', reachable: true, state: 'ready', appVersion: '1.3.9', paired: true }));
        expect(a.notes.join(' ')).toContain('1.3.9 is older');
    });
});

describe('versions', () => {
    it('compares numerically, not as text', () => {
        expect(compareVersions('1.4.211', '1.4.197')).toBe(1);
        expect(compareVersions('1.4.97', '1.4.197')).toBe(-1);
        expect(compareVersions('v1.4.197', '1.4.197')).toBe(0);
        expect(compareVersions('1.5', '1.4.300')).toBe(1);
    });
});

describe('the agents Studio did not find', () => {
    it('are "not in this image" only in a session', () => {
        expect(missingAgentsNote('session', ['codex'])).toBe('Not in this image: codex');
        expect(missingAgentsNote(undefined, ['codex'])).toBe('Not in this image: codex');
    });

    it('are a hint on a member\'s machine, where there is no image', () => {
        const note = missingAgentsNote('local', ['codex', 'opencode']);
        expect(note).not.toContain('image');
        expect(note).toContain('codex, opencode');
    });

    it('say nothing when none is missing', () => {
        expect(missingAgentsNote('local', [])).toBe('');
    });
});
