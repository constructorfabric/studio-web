// The desktop update channel as a Theia preference: its schema, the move of the
// Studio view's old choice into it, and the updater following it.

import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Emitter } from '@theia/core/lib/common/event';
import { PreferenceScope } from '@theia/core/lib/common/preferences/preference-scope';
import type { DesktopUpdates, UpdateChannelChoice } from '../common/desktop-updates-protocol';
import {
    CHECK_FOR_UPDATES_COMMAND_ID, DESKTOP_UPDATE_CHANNEL_PREFERENCE, DESKTOP_UPDATE_CHANNEL_PREFERENCE_SCHEMA,
    DesktopUpdateChannelContribution, migrateLegacyChannel, readUpdateChannel,
} from './desktop-update-channel';

describe('the update channel preference', () => {
    const property = DESKTOP_UPDATE_CHANNEL_PREFERENCE_SCHEMA.properties[DESKTOP_UPDATE_CHANNEL_PREFERENCE];

    it('is Settings → Extensions → Studio → Desktop: Update Channel, one of auto, stable or beta, auto by default', () => {
        expect(DESKTOP_UPDATE_CHANNEL_PREFERENCE).toBe('studio.desktop.updateChannel');
        expect(property.type).toBe('string');
        expect(property.enum).toEqual(['auto', 'stable', 'beta']);
        expect(property.enumDescriptions).toHaveLength(3);
        expect(property.default).toBe('auto');
    });

    it('is the member\'s, not a project\'s: no workspace or folder value', () => {
        expect(property.scope).toBe(PreferenceScope.User);
    });

    it('names Help → Check for Updates, and links to it from Settings', () => {
        expect(property.description).toContain('Help → Check for Updates');
        expect(property.markdownDescription).toContain('Help → Check for Updates');
        expect(property.markdownDescription).toContain(`(command:${CHECK_FOR_UPDATES_COMMAND_ID})`);
        expect(CHECK_FOR_UPDATES_COMMAND_ID).toBe('studio.desktop.checkForUpdates');
    });

    it('reads anything else in the settings file as auto', () => {
        expect(readUpdateChannel('beta')).toBe('beta');
        expect(readUpdateChannel('stable')).toBe('stable');
        expect(readUpdateChannel('nightly')).toBe('auto');
        expect(readUpdateChannel(undefined)).toBe('auto');
    });

    it('is registered by the desktop app\'s electron module only, never a session\'s', () => {
        const source = (file: string) => fs.readFileSync(path.join(__dirname, file), 'utf8');
        expect(source('studio-electron-frontend-module.ts')).toContain('DESKTOP_UPDATE_CHANNEL_PREFERENCE_SCHEMA');
        expect(source('../browser/studio-frontend-module.ts')).not.toMatch(/desktop-update-channel|updateChannel/);
    });
});

describe('moving the Studio view\'s choice into Settings', () => {
    it('copies the old choice when the member has not set the preference', () => {
        expect(migrateLegacyChannel('beta', undefined)).toEqual({ set: 'beta', clear: true });
        expect(migrateLegacyChannel('stable', undefined)).toEqual({ set: 'stable', clear: true });
    });

    it('keeps a preference the member set, and still clears the old file', () => {
        expect(migrateLegacyChannel('beta', 'stable')).toEqual({ clear: true });
        expect(migrateLegacyChannel('stable', 'auto')).toEqual({ clear: true });
    });

    it('does nothing when there was no old choice', () => {
        expect(migrateLegacyChannel(null, undefined)).toEqual({ clear: false });
        expect(migrateLegacyChannel(undefined, 'beta')).toEqual({ clear: false });
    });
});

describe('the updater follows the preference', () => {
    interface Harness {
        contribution: DesktopUpdateChannelContribution;
        reported: UpdateChannelChoice[];
        requests: Array<{ method: string; url: string }>;
        user: Map<string, unknown>;
        change(value: unknown): Promise<void>;
    }

    function harness(legacy: 'stable' | 'beta' | null | 404, user: Record<string, unknown> = {}): Harness {
        const values = new Map<string, unknown>(Object.entries(user));
        const changed = new Emitter<{ preferenceName: string }>();
        const preferences = {
            ready: Promise.resolve(),
            get: (name: string) => values.get(name) ?? 'auto',
            inspect: (name: string) => ({ preferenceName: name, defaultValue: 'auto', globalValue: values.get(name) }),
            set: jest.fn(async (name: string, value: unknown, scope: PreferenceScope) => {
                expect(scope).toBe(PreferenceScope.User);
                values.set(name, value);
                changed.fire({ preferenceName: name });
            }),
            onPreferenceChanged: changed.event,
        };
        const reported: UpdateChannelChoice[] = [];
        const updates: DesktopUpdates = {
            check: async () => ({ state: 'unavailable' }),
            setChannel: async choice => { reported.push(choice); },
        };
        const requests: Array<{ method: string; url: string }> = [];
        (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            requests.push({ method, url: new URL(String(url), 'http://localhost').pathname });
            if (legacy === 404) {
                return { ok: false, status: 404, json: async () => ({}) } as Response;
            }
            return { ok: true, status: method === 'DELETE' ? 204 : 200, json: async () => ({ channel: legacy }) } as Response;
        });
        const contribution = new DesktopUpdateChannelContribution();
        Object.assign(contribution, { preferences, updates });
        return {
            contribution, reported, requests, user: values,
            async change(value: unknown) {
                values.set(DESKTOP_UPDATE_CHANNEL_PREFERENCE, value);
                changed.fire({ preferenceName: DESKTOP_UPDATE_CHANNEL_PREFERENCE });
                await new Promise(resolve => setTimeout(resolve, 0));
            },
        };
    }

    async function started(h: Harness): Promise<Harness> {
        await (h.contribution as unknown as { start(): Promise<void> }).start();
        return h;
    }

    afterEach(() => {
        delete (globalThis as { fetch?: unknown }).fetch;
    });

    it('moves a beta chosen in the Studio view into Settings, then the updater follows beta', async () => {
        const h = await started(harness('beta'));
        expect(h.user.get(DESKTOP_UPDATE_CHANNEL_PREFERENCE)).toBe('beta');
        expect(h.requests).toEqual([
            { method: 'GET', url: '/studio-desktop/updates' },
            { method: 'DELETE', url: '/studio-desktop/updates' },
        ]);
        expect(h.reported[h.reported.length - 1]).toBe('beta');
        h.contribution.onStop();
    });

    it('keeps the member\'s preference over the old file', async () => {
        const h = await started(harness('beta', { [DESKTOP_UPDATE_CHANNEL_PREFERENCE]: 'stable' }));
        expect(h.user.get(DESKTOP_UPDATE_CHANNEL_PREFERENCE)).toBe('stable');
        expect(h.requests.map(r => r.method)).toEqual(['GET', 'DELETE']);
        expect(h.reported).toEqual(['stable']);
        h.contribution.onStop();
    });

    it('reports auto where nothing was ever chosen, and removes nothing', async () => {
        const h = await started(harness(null));
        expect(h.requests.map(r => r.method)).toEqual(['GET']);
        expect(h.reported).toEqual(['auto']);
        h.contribution.onStop();
    });

    it('still reports the channel where no Studio is configured to ask', async () => {
        const h = await started(harness(404));
        expect(h.reported).toEqual(['auto']);
        h.contribution.onStop();
    });

    it('tells the updater each change made in Settings, until it stops', async () => {
        const h = await started(harness(null));
        await h.change('beta');
        await h.change('stable');
        expect(h.reported).toEqual(['auto', 'beta', 'stable']);
        h.contribution.onStop();
        await h.change('beta');
        expect(h.reported).toEqual(['auto', 'beta', 'stable']);
    });
});
