/**
 * @jest-environment node
 */
import {
    chooseEnvironment, desktopConfigFrom, environmentsFrom, folderFor, helperCommand, openedTenant, rememberOpened
} from './desktop-studio-contribution';
import { customEnvironment, parseEnvironments } from '../common/desktop-environments';

const OFFERED = JSON.stringify([
    { id: 'dev', label: 'Dev', studioUrl: 'https://dev.example.com', issuer: 'https://dev.example.com/auth/realms/studio' },
    { id: 'test', label: 'Test', studioUrl: 'https://test.example.com/' },
    { id: 'local', label: 'Local', studioUrl: 'http://127.0.0.1:8090', issuer: 'http://127.0.0.1:8088/realms/studio' },
]);

describe('which Studio a desktop connects to', () => {
    const { list, pinned, defaultId } = environmentsFrom({ STUDIO_DESKTOP_ENVIRONMENTS: OFFERED, STUDIO_DESKTOP_DEFAULT: 'test' });

    it('reads the list the build carries, deriving a missing realm', () => {
        expect(list.map(e => e.id)).toEqual(['dev', 'test', 'local']);
        expect(list[1]).toEqual({ id: 'test', label: 'Test', studioUrl: 'https://test.example.com', issuer: 'https://test.example.com/auth/realms/studio' });
        expect(pinned).toBeUndefined();
    });

    it('starts on the build default when the member chose nothing', () => {
        expect(chooseEnvironment(list, pinned, {}, defaultId)?.id).toBe('test');
    });

    it('keeps the member\'s choice over the default', () => {
        expect(chooseEnvironment(list, pinned, { environment: 'local' }, defaultId)?.studioUrl).toBe('http://127.0.0.1:8090');
    });

    it('takes an address the member typed', () => {
        expect(chooseEnvironment(list, pinned, { custom: { studioUrl: 'https://mine.example.com/' } }, defaultId))
            .toEqual(customEnvironment('https://mine.example.com'));
        expect(customEnvironment('https://mine.example.com').issuer).toBe('https://mine.example.com/auth/realms/studio');
    });

    it('falls back to the default when a saved choice is no longer offered', () => {
        expect(chooseEnvironment(list, pinned, { environment: 'gone' }, defaultId)?.id).toBe('test');
    });

    it('lets STUDIO_DESKTOP_URL pin one Studio over any choice', () => {
        const env = environmentsFrom({ STUDIO_DESKTOP_ENVIRONMENTS: OFFERED, STUDIO_DESKTOP_URL: 'http://127.0.0.1:8090' });
        expect(chooseEnvironment(env.list, env.pinned, { environment: 'dev' })?.id).toBe('pinned');
    });

    it('drops entries it cannot use', () => {
        expect(parseEnvironments([{ id: 'x' }, { id: 'y', studioUrl: 'ftp://nope' }, 'junk', { studioUrl: 'https://a' }])).toEqual([]);
        expect(parseEnvironments('not a list')).toEqual([]);
        expect(environmentsFrom({ STUDIO_DESKTOP_ENVIRONMENTS: '{broken' }).list).toEqual([]);
    });

    it('builds a config from the chosen Studio', () => {
        const config = desktopConfigFrom({ STUDIO_DESKTOP_ENVIRONMENTS: OFFERED }, '/here', { environment: 'local' })!;
        expect(config.studioUrl).toBe('http://127.0.0.1:8090');
        expect(config.issuer).toBe('http://127.0.0.1:8088/realms/studio');
    });
});

describe('desktop studio contribution', () => {
    it('stays off unless a Studio is named', () => {
        expect(desktopConfigFrom({}, '/here')).toBeUndefined();
    });

    it('derives the realm and the gateway prefix from the Studio address', () => {
        const config = desktopConfigFrom({ STUDIO_DESKTOP_URL: 'https://studio.example.com/' }, '/here')!;
        expect(config.studioUrl).toBe('https://studio.example.com');
        expect(config.issuer).toBe('https://studio.example.com/realms/studio');
        expect(config.gatewayPrefix).toBe('/cf');
        expect(config.clientId).toBe('studio-desktop');
    });

    it('names a workspace folder after the workspace, minus what a file system refuses', () => {
        expect(folderFor('Test Worksoace', 'id-1')).toBe('Test Worksoace');
        expect(folderFor('a/b: c?', 'id-1')).toBe('a-b- c');
        expect(folderFor('  ..  ', 'id-1')).toBe('id-1');
        expect(folderFor(undefined, 'id-1')).toBe('id-1');
    });

    it('remembers which tenant a folder was opened for, on the Studio it came from', () => {
        const config = desktopConfigFrom({ STUDIO_DESKTOP_URL: 'https://studio.example.com' }, '/here')!;
        const settings = rememberOpened({ updates: 'beta' }, '/home/me/ConstructorStudio/workspaces/Web', config.studioUrl, 'project-1');
        expect(settings.updates).toBe('beta');
        expect(openedTenant(settings, config, '/home/me/ConstructorStudio/workspaces/Web/')).toBe('project-1');
        expect(openedTenant(settings, config, '/home/me/elsewhere')).toBeUndefined();
        // The same folder means nothing to another Studio: its ids are not ours.
        const other = desktopConfigFrom({ STUDIO_DESKTOP_URL: 'https://other.example.com' }, '/here')!;
        expect(openedTenant(settings, other, '/home/me/ConstructorStudio/workspaces/Web')).toBeUndefined();
    });

    it('answers for the workspace a deployment pinned at its root', () => {
        const config = desktopConfigFrom({
            STUDIO_DESKTOP_URL: 'https://studio.example.com',
            STUDIO_DESKTOP_WORKSPACE_ID: 'ws-1',
            STUDIO_WORKSPACE_ROOT: '/srv/checkout',
        }, '/here')!;
        expect(openedTenant({}, config, '/srv/checkout')).toBe('ws-1');
        expect(openedTenant({}, config, '/srv')).toBeUndefined();
    });

    it('runs the credential helper with the app itself, not a Node on PATH', () => {
        expect(helperCommand('C:\\Program Files\\Studio\\Studio.exe', 'C:\\app\\helper.mjs'))
            .toBe('!ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Studio/Studio.exe" "C:/app/helper.mjs"');
    });
});
