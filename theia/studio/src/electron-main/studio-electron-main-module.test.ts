/**
 * @jest-environment node
 */
import 'reflect-metadata';
import { DESKTOP_UPDATER_GLOBAL, describeUpdateCheck, type UpdateCheck } from '../common/desktop-updates-protocol';
import { DesktopUpdatesMain } from './studio-electron-main-module';

describe('Help → Check for Updates, in the main process', () => {
    afterEach(() => {
        delete (globalThis as Record<string, unknown>)[DESKTOP_UPDATER_GLOBAL];
    });

    it('says the app is not updated in place where the updater did not start', async () => {
        expect(await new DesktopUpdatesMain().check()).toEqual({ state: 'unavailable' });
    });

    it('asks the updater desktop-updater.js handed over', async () => {
        const found: UpdateCheck = { state: 'downloading', version: '0.3.0', current: '0.3.0-beta.2' };
        (globalThis as Record<string, unknown>)[DESKTOP_UPDATER_GLOBAL] = { checkNow: jest.fn(async () => found) };
        expect(await new DesktopUpdatesMain().check()).toEqual(found);
    });

    it('turns an updater that throws into a failed check, not a broken menu item', async () => {
        (globalThis as Record<string, unknown>)[DESKTOP_UPDATER_GLOBAL] = {
            checkNow: async () => {
                throw new Error('net::ERR_INTERNET_DISCONNECTED');
            }
        };
        expect(await new DesktopUpdatesMain().check()).toEqual({ state: 'failed', message: 'net::ERR_INTERNET_DISCONNECTED' });
    });
});

describe('the channel chosen in Settings, in the main process', () => {
    afterEach(() => {
        delete (globalThis as Record<string, unknown>)[DESKTOP_UPDATER_GLOBAL];
    });

    it('hands the choice to the updater', async () => {
        const setChannel = jest.fn();
        (globalThis as Record<string, unknown>)[DESKTOP_UPDATER_GLOBAL] = { checkNow: jest.fn(), setChannel };
        await new DesktopUpdatesMain().setChannel('beta');
        expect(setChannel).toHaveBeenCalledWith('beta');
    });

    it('is a no-op where no updater started, or one that predates the choice', async () => {
        await expect(new DesktopUpdatesMain().setChannel('stable')).resolves.toBeUndefined();
        (globalThis as Record<string, unknown>)[DESKTOP_UPDATER_GLOBAL] = { checkNow: jest.fn() };
        await expect(new DesktopUpdatesMain().setChannel('stable')).resolves.toBeUndefined();
    });
});

describe('what the member reads after a check', () => {
    it('says which version is current, and whether betas count', () => {
        expect(describeUpdateCheck({ state: 'current', version: '0.3.0', channel: 'stable' }).text)
            .toBe('Constructor Studio 0.3.0 is the latest.');
        expect(describeUpdateCheck({ state: 'current', version: '0.3.0-beta.2', channel: 'beta' }).text)
            .toBe('Constructor Studio 0.3.0-beta.2 is the latest, betas included.');
    });

    it('names the update found and what happens next', () => {
        expect(describeUpdateCheck({ state: 'downloading', version: '0.3.1', current: '0.3.0' }).text)
            .toMatch(/^Constructor Studio 0\.3\.1 is available \(you have 0\.3\.0\)\. It is downloading/);
        expect(describeUpdateCheck({ state: 'ready', version: '0.3.1' }).text).toMatch(/installs when you restart/);
    });

    it('sends a build that does not update itself to the release page', () => {
        expect(describeUpdateCheck({ state: 'manual', version: '0.3.1', current: '0.3.0' }).text)
            .toMatch(/^Constructor Studio 0\.3\.1 is available \(you have 0\.3\.0\)\. This copy does not update itself/);
    });

    it('warns when the check failed, with why', () => {
        expect(describeUpdateCheck({ state: 'failed', message: 'offline' })).toEqual({ level: 'warn', text: 'Could not check for updates: offline' });
    });
});
