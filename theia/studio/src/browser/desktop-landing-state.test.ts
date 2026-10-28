// Which view the desktop landing page shows, and when it shows at all.

import {
    LandingStatus, creationOf, landingView, landingWanted, modeCards, noOrganizationHint, onboardingDismissed, recentFolders,
    sameFolder, unreachable,
} from './desktop-landing-state';
import { MODES } from './studio-mode-bar';
import type { Organization } from './desktop-projects';

const START = 'C:\\Users\\me\\ConstructorStudio\\workspace';
const status = (state: LandingStatus['state'], extra: Partial<LandingStatus> = {}): LandingStatus =>
    ({ enabled: true, studioUrl: 'https://studio-dev.cfabric.org', state, startFolder: START, ...extra });
const ORG: Organization = { id: 'o', name: 'Constructor Fabric', projects: [{ id: 'w', name: 'Gears', nested: [] }] };

describe('when the landing takes the main area', () => {
    it('takes it in the placeholder folder, whoever is signed in', () => {
        expect(landingWanted(status('signed-out'), START)).toBe(true);
        expect(landingWanted(status('signed-in'), START)).toBe(true);
        // The path as the IDE hands it back: forward slashes, a lower-case drive, a trailing slash.
        expect(landingWanted(status('signed-in'), 'c:/Users/me/ConstructorStudio/workspace/')).toBe(true);
    });

    it('takes it when the window has no folder at all, even with no Studio', () => {
        expect(landingWanted(status('signed-out'), undefined)).toBe(true);
        expect(landingWanted(undefined, undefined)).toBe(true);
    });

    it('leaves a real project or folder to the product start page', () => {
        expect(landingWanted(status('signed-in'), 'C:\\Users\\me\\ConstructorStudio\\workspaces\\Gears')).toBe(false);
        expect(landingWanted(status('signed-out'), 'D:\\code\\my-app')).toBe(false);
    });

    it('cannot tell the placeholder without a Studio, or from a backend that does not name it', () => {
        expect(landingWanted(undefined, START)).toBe(false);
        expect(landingWanted({ ...status('signed-out'), enabled: false }, START)).toBe(false);
        expect(landingWanted(status('signed-out', { startFolder: undefined }), START)).toBe(false);
    });

    it('compares folders the way the file system does', () => {
        expect(sameFolder('/home/me/ConstructorStudio/workspace', '/home/me/ConstructorStudio/workspace/')).toBe(true);
        expect(sameFolder('/home/me/Workspace', '/home/me/workspace')).toBe(false);
        expect(sameFolder('/c:/Users/Me/x', 'C:\\users\\me\\X')).toBe(true);
        expect(sameFolder(undefined, '/a')).toBe(false);
    });
});

describe('which view the landing shows', () => {
    it('checks first, and says when there is no Studio to sign in to', () => {
        expect(landingView(undefined, false)).toEqual({ kind: 'checking' });
        expect(landingView(undefined, true)).toEqual({ kind: 'no-studio' });
        expect(landingView({ ...status('signed-out'), enabled: false }, true)).toEqual({ kind: 'no-studio' });
    });

    it('offers the sign-in while signed out, and says why the last one failed', () => {
        expect(landingView(status('signed-out'), true)).toEqual({ kind: 'connect', unreachable: false });
        expect(landingView(status('failed', { error: 'the sign-in was refused' }), true))
            .toEqual({ kind: 'connect', error: 'the sign-in was refused', unreachable: false });
    });

    it('tells an unreachable Studio from a refusal, so offline is offered', () => {
        expect(landingView(status('failed', { error: 'fetch failed' }), true))
            .toEqual({ kind: 'connect', error: 'fetch failed', unreachable: true });
        expect(unreachable('getaddrinfo ENOTFOUND studio-dev.cfabric.org')).toBe(true);
        expect(unreachable('HTTP 502')).toBe(true);
        expect(unreachable('HTTP 403')).toBe(false);
        expect(unreachable(undefined)).toBe(false);
    });

    it('waits for the browser while signing in', () => {
        expect(landingView(status('signing-in'), true)).toEqual({ kind: 'signing-in' });
    });

    it('signed in: loading, then the projects, or no organizations, or why they could not load', () => {
        const signedIn = status('signed-in');
        expect(landingView(signedIn, true)).toEqual({ kind: 'projects-loading' });
        expect(landingView(signedIn, true, { loading: true })).toEqual({ kind: 'projects-loading' });
        expect(landingView(signedIn, true, { organizations: [ORG] })).toEqual({ kind: 'projects', organizations: [ORG] });
        expect(landingView(signedIn, true, { organizations: [] })).toEqual({ kind: 'no-organizations' });
        expect(landingView(signedIn, true, { error: 'HTTP 503' })).toEqual({ kind: 'projects-error', error: 'HTTP 503', unreachable: true });
        expect(landingView(signedIn, true, { error: 'HTTP 403' })).toEqual({ kind: 'projects-error', error: 'HTTP 403', unreachable: false });
        // A reload that failed keeps the list it had.
        expect(landingView(signedIn, true, { organizations: [ORG], error: 'HTTP 503' }).kind).toBe('projects');
    });
});

describe('the recent folders', () => {
    it('lists local folders, newest first, without the placeholder or duplicates', () => {
        const folders = recentFolders([
            'file:///c%3A/Users/me/ConstructorStudio/workspace',
            'file:///d%3A/code/my-app',
            'file:///home/me/notes',
            'file:///d%3A/code/my-app',
            'vscode-remote://ssh/somewhere',
        ], START);
        expect(folders).toEqual([
            { uri: 'file:///d%3A/code/my-app', name: 'my-app', path: 'd:\\code\\my-app' },
            { uri: 'file:///home/me/notes', name: 'notes', path: '/home/me/notes' },
        ]);
    });

    it('stops at the limit', () => {
        const many = Array.from({ length: 10 }, (_, i) => `file:///home/me/p${i}`);
        expect(recentFolders(many, undefined, 3).map(f => f.name)).toEqual(['p0', 'p1', 'p2']);
    });
});

describe('the onboarding cards', () => {
    it('are the modes of the mode picker, in its order, in its own words', () => {
        const cards = modeCards(MODES, undefined, 'default');
        expect(cards.map(c => c.label)).toEqual(['Doc editing', 'Building', 'Development', 'Agent development', 'Full functionality']);
        for (const [i, mode] of MODES.entries()) {
            expect(cards[i]).toMatchObject({ label: mode.label, icon: mode.icon, line: mode.title, perspective: mode.perspective });
        }
        expect(cards.filter(c => c.current).map(c => c.label)).toEqual(['Development']);
    });

    it('leave out a mode whose perspective this build lacks', () => {
        const registered = MODES.map(m => m.perspective).filter(p => p !== 'gearbox.product');
        expect(modeCards(MODES, registered, undefined).map(c => c.label)).not.toContain('Building');
    });

    it('stay away only after "Got it"', () => {
        expect(onboardingDismissed(undefined)).toBe(false);
        expect(onboardingDismissed(false)).toBe(false);
        expect(onboardingDismissed(true)).toBe(true);
    });
});

describe('what a member with no organization is told (ADR-0051 §5)', () => {
    it('reads the setting, and an older backend\'s self_service as open or off', () => {
        expect(creationOf({ self_service: false, organization_creation: 'request' })).toBe('request');
        expect(creationOf({ self_service: true, organization_creation: 'open' })).toBe('open');
        expect(creationOf({ self_service: true })).toBe('open');
        expect(creationOf({ self_service: false })).toBe('off');
        expect(creationOf({ organization_creation: 'everything' })).toBe('off');
        expect(creationOf(undefined)).toBe('off');
    });

    it('names the way the Studio allows: creating, asking, or an invitation', () => {
        expect(noOrganizationHint({ creation: 'open' })).toEqual({ kind: 'create' });
        expect(noOrganizationHint({ creation: 'request' })).toEqual({ kind: 'ask' });
        expect(noOrganizationHint({ creation: 'off' })).toEqual({ kind: 'invitation' });
        // Not read, or unreadable: invitations, which every setting allows.
        expect(noOrganizationHint(undefined)).toEqual({ kind: 'invitation' });
    });

    it('shows their own request: pending, rejected with the reason, or none worth naming', () => {
        const request = { name: 'Acme', created_at_ms: 1_767_225_600_000 };
        expect(noOrganizationHint({ creation: 'request', request: { ...request, status: 'pending' } }))
            .toEqual({ kind: 'pending', name: 'Acme', askedAt: 1_767_225_600_000 });
        expect(noOrganizationHint({ creation: 'request', request: { ...request, status: 'rejected', reason: 'Use your work email.' } }))
            .toEqual({ kind: 'rejected', name: 'Acme', reason: 'Use your work email.' });
        expect(noOrganizationHint({ creation: 'request', request: { ...request, status: 'rejected', reason: null } }))
            .toEqual({ kind: 'rejected', name: 'Acme' });
        expect(noOrganizationHint({ creation: 'request', request: { ...request, status: 'withdrawn' } })).toEqual({ kind: 'ask' });
    });
});
