// The window's side of #497: ask once, remember the answer, add or leave the
// project, and do nothing at all in a portal session.

import 'reflect-metadata';
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class {}
}));
import { Container } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { OrcaService } from '../common/orca-protocol';
import { NO_PROJECT_SYNC, type OrcaProjectSync } from '../common/desktop-orca-projects';
import { DesktopOrcaProjectSync } from './desktop-orca-project-sync';

describe('DesktopOrcaProjectSync', () => {

    function mount(opts: { sync: OrcaProjectSync; answer?: string; preference?: string; root?: string }) {
        const prefs: Record<string, unknown> = { 'studio.orca.addOpenedProjects': opts.preference };
        const orca = {
            trackProject: jest.fn(async () => opts.sync),
            registerWorkspace: jest.fn(async () => ['/p/web'])
        };
        const messages = { info: jest.fn(async () => opts.answer), error: jest.fn() };
        const container = new Container();
        container.bind(OrcaService).toConstantValue(orca as never);
        container.bind(MessageService).toConstantValue(messages as never);
        container.bind(PreferenceService).toConstantValue({
            ready: Promise.resolve(),
            get: (key: string) => prefs[key],
            set: jest.fn(async (key: string, value: unknown) => {
                prefs[key] = value;
            })
        } as never);
        const root = opts.root ?? '/p';
        container.bind(WorkspaceService).toConstantValue({
            roots: Promise.resolve([{ resource: { path: { fsPath: () => root } } }]),
            onWorkspaceChanged: () => ({ dispose: () => undefined })
        } as never);
        container.bind(DesktopOrcaProjectSync).toSelf();
        const sync = container.get(DesktopOrcaProjectSync);
        return { sync, orca, messages, prefs };
    }

    const unknown: OrcaProjectSync = { enabled: true, unknown: ['/p/web'], removed: [], kept: [] };

    it('does nothing in a session: no question, nothing added', async () => {
        const m = mount({ sync: NO_PROJECT_SYNC });
        await m.sync.check();
        expect(m.messages.info).not.toHaveBeenCalled();
        expect(m.orca.registerWorkspace).not.toHaveBeenCalled();
        expect(m.sync.enabled).toBe(false);
    });

    it('asks once with the three answers, and "always" adds and is remembered', async () => {
        const m = mount({ sync: unknown, answer: 'Always add' });
        await m.sync.check();
        expect(m.messages.info).toHaveBeenCalledWith(expect.stringContaining('web'), 'Always add', 'Not now', 'Never');
        expect(m.orca.registerWorkspace).toHaveBeenCalledWith('/p');
        expect(m.prefs['studio.orca.addOpenedProjects']).toBe('always');

        m.messages.info.mockClear();
        await m.sync.check();
        expect(m.messages.info).not.toHaveBeenCalled();
        expect(m.orca.registerWorkspace).toHaveBeenCalledTimes(2);
    });

    it('"not now" adds nothing, is not remembered, and does not ask again for this project', async () => {
        const m = mount({ sync: unknown, answer: 'Not now' });
        await m.sync.check();
        await m.sync.check();
        expect(m.messages.info).toHaveBeenCalledTimes(1);
        expect(m.orca.registerWorkspace).not.toHaveBeenCalled();
        expect(m.prefs['studio.orca.addOpenedProjects']).toBeUndefined();
    });

    it('"never" is remembered and nothing is asked afterwards', async () => {
        const m = mount({ sync: unknown, answer: 'Never' });
        await m.sync.check();
        expect(m.prefs['studio.orca.addOpenedProjects']).toBe('never');
        expect(m.orca.registerWorkspace).not.toHaveBeenCalled();
    });

    it('with "always" already set, adds without asking', async () => {
        const m = mount({ sync: unknown, preference: 'always' });
        await m.sync.check();
        expect(m.messages.info).not.toHaveBeenCalled();
        expect(m.orca.registerWorkspace).toHaveBeenCalledWith('/p');
    });

    it('says what it removed, and keeps what it left for the panel', async () => {
        const m = mount({
            sync: { enabled: true, unknown: [], removed: ['/old/web'], kept: [{ path: '/old/api', reason: 'main has 1 uncommitted change' }] }
        });
        const changed = jest.fn();
        m.sync.onDidChange(changed);
        await m.sync.check();
        expect(m.messages.info).toHaveBeenCalledWith(expect.stringContaining('Removed from Orca: web'));
        expect(m.sync.kept).toEqual([{ path: '/old/api', reason: 'main has 1 uncommitted change' }]);
        expect(changed).toHaveBeenCalled();
    });

    it('tells the backend when the window goes away', async () => {
        const m = mount({ sync: { ...unknown, unknown: [] } });
        await m.sync.check();
        m.sync.onStop();
        expect(m.orca.trackProject).toHaveBeenLastCalledWith(expect.any(String), undefined);
    });
});
