import 'reflect-metadata';
import { StudioChromeMode, modeTabsCss } from './studio-chrome-mode';

function chrome(activeId: string) {
    const listeners: (() => void)[] = [];
    const perspectives = {
        activeId,
        getActivePerspectiveId(): string { return this.activeId; },
        onDidChangePerspective: (fn: () => void) => {
            listeners.push(fn);
            return { dispose: () => undefined };
        },
    };
    const preferences = { set: jest.fn(async () => undefined) };
    const contribution = new StudioChromeMode();
    Object.defineProperty(contribution, 'perspectives', { value: perspectives });
    Object.defineProperty(contribution, 'preferences', { value: preferences });
    return { contribution, perspectives, preferences, listeners };
}

afterEach(() => {
    document.getElementById('studio-chrome-mode')?.remove();
    delete document.body.dataset.studioMode;
    delete document.body.dataset.studioPerspective;
});

describe('the chrome a mode implies', () => {
    it('keeps Theia’s own menu bar in the workbench', async () => {
        const { contribution, preferences } = chrome('default');
        contribution.onDidInitializeLayout();
        await Promise.resolve();

        // Both levers, because two systems decide: the preference is the only
        // thing that puts the panel in the LAYOUT, and the attribute is what
        // overrides the product's blanket paint rule.
        expect(preferences.set).toHaveBeenCalledWith('window.menuBarVisibility', 'classic', expect.anything());
        expect(document.body.dataset.studioMode).toBe('workbench');
    });

    it('keeps the menu while writing too, and drops only the second app icon', async () => {
        const { contribution, preferences } = chrome('studio.documents');
        contribution.onDidInitializeLayout();
        await Promise.resolve();
        const css = document.getElementById('studio-chrome-mode')?.textContent ?? '';

        expect(preferences.set).toHaveBeenCalledWith('window.menuBarVisibility', 'classic', expect.anything());
        expect(document.body.dataset.studioMode).toBe('documents');
        // The portal's branding sits directly above this row; Theia's own icon
        // would be the second one.
        expect(css).toContain('body[data-studio-mode="documents"] #theia-top-panel > .theia-icon');
        // And the menu itself is NOT hidden any more — the row is paid for
        // either way, so taking File and Terminal out of it buys nothing back.
        expect(css).not.toContain('.lm-MenuBar');
    });

    /* The collaboration strip has no test of its own here because it is not
       this file's widget — but it is this file's two levers, and it was shipped
       invisible because nothing asserted them together. It mounts into the top
       panel (`area: 'top'`), so it needs that panel IN the layout, which only
       `window.menuBarVisibility` decides, and PAINTED, which only this
       stylesheet decides against the product's blanket `display: none`. Either
       one alone leaves a strip that polls a roster every four seconds and shows
       nobody anything. */
    it.each(['default', 'studio.documents'])(
        'keeps the top panel in the layout and painted, for the strip that lives there (%s)',
        async activeId => {
            const { contribution, preferences } = chrome(activeId);
            contribution.onDidInitializeLayout();
            await Promise.resolve();
            const css = document.getElementById('studio-chrome-mode')?.textContent ?? '';
            const mode = document.body.dataset.studioMode;

            expect(preferences.set).toHaveBeenCalledWith(
                'window.menuBarVisibility',
                'classic',
                expect.anything(),
            );
            expect(css).toContain(`body[data-studio-mode="${mode}"] #theia-top-panel`);
            expect(css).toContain('display: flex !important');
            // Nothing may hide the panel itself — only what sits inside it.
            expect(css).not.toMatch(/#theia-top-panel\s*\{\s*display:\s*none/);
        },
    );

    it('follows a switch', async () => {
        const { contribution, perspectives, preferences, listeners } = chrome('default');
        contribution.onDidInitializeLayout();
        await Promise.resolve();

        perspectives.activeId = 'studio.documents';
        listeners.forEach(fn => fn());
        await Promise.resolve();

        expect(document.body.dataset.studioMode).toBe('documents');
        expect(preferences.set).toHaveBeenLastCalledWith('window.menuBarVisibility', 'classic', expect.anything());
    });

    it('gives Source Control back to the workbench and not to writing', () => {
        const { contribution } = chrome('default');
        contribution.onDidInitializeLayout();
        const css = document.getElementById('studio-chrome-mode')?.textContent ?? '';
        // The product hides the SCM tab along with Debug, Test, Search and
        // Explorer. Right for a document, wrong for someone who just edited
        // code and wants to commit it.
        expect(css).toContain('body[data-studio-mode="workbench"] #shell-tab-scm-view-container');
        // Explorer comes back per mode (MODE_TABS), never for every workbench
        // mode at once: Building and Agent development do not ask for it.
        expect(css).not.toContain('body[data-studio-mode="workbench"] #shell-tab-explorer-view-container');
        expect(css).not.toContain('body[data-studio-perspective="gearbox.product"]');
        expect(css).not.toContain('shell-tab-debug');
    });

    it('beats the product’s paint rule on specificity, not on order', () => {
        const { contribution } = chrome('default');
        contribution.onDidInitializeLayout();
        const css = document.getElementById('studio-chrome-mode')?.textContent ?? '';
        // (0,2,1) against #theia-top-panel's (0,1,0): whichever stylesheet is
        // injected first, this one decides.
        expect(css).toContain('body[data-studio-mode="workbench"] #theia-top-panel');
        expect(css).toContain('display: flex !important');
    });

    it('does nothing in an application without perspectives', () => {
        const contribution = new StudioChromeMode();
        Object.defineProperty(contribution, 'perspectives', { value: undefined });
        contribution.onDidInitializeLayout();
        expect(document.getElementById('studio-chrome-mode')).toBeNull();
    });
});

describe('the rail tabs a mode brings back', () => {
    it('gives writing a file tree, and leaves search to the product', () => {
        const { contribution } = chrome('studio.documents');
        contribution.onDidInitializeLayout();
        const css = document.getElementById('studio-chrome-mode')?.textContent ?? '';

        expect(document.body.dataset.studioPerspective).toBe('studio.documents');
        expect(css).toContain('body[data-studio-perspective="studio.documents"] #shell-tab-explorer-view-container');
        // One search: the product's, not Theia's file search beside it.
        expect(css).not.toContain('body[data-studio-perspective="studio.documents"] #shell-tab-search-view-container');
    });

    it('gives the code modes their file tree and their search across files', () => {
        for (const mode of ['default', 'studio.full']) {
            const { contribution } = chrome(mode);
            contribution.onDidInitializeLayout();
            const css = document.getElementById('studio-chrome-mode')?.textContent ?? '';
            expect(css).toContain(`body[data-studio-perspective="${mode}"] #shell-tab-explorer-view-container`);
            expect(css).toContain(`body[data-studio-perspective="${mode}"] #shell-tab-search-view-container`);
            // ...and not the product's Search beside it: one magnifier per mode.
            expect(css).toContain(`body[data-studio-perspective="${mode}"] #studio-search-rail`);
            contribution.onStop();
        }
    });

    it('keeps writing to one search and its bottom panel to Analyze', () => {
        const { contribution } = chrome('studio.documents');
        contribution.onDidInitializeLayout();
        const css = document.getElementById('studio-chrome-mode')?.textContent ?? '';
        expect(css).not.toContain('body[data-studio-perspective="studio.documents"] #shell-tab-search-view-container');
        expect(css).not.toContain('body[data-studio-perspective="studio.documents"] #studio-search-rail');
        expect(css).toContain('body[data-studio-perspective="studio.documents"] #theia-bottom-content-panel .lm-TabBar-tab:not(.lm-mod-current):not([id="shell-tab-studio:analyze"])');
    });

    it('names the mode it is in, and follows a switch', async () => {
        const { contribution, perspectives, listeners } = chrome('default');
        contribution.onDidInitializeLayout();
        await Promise.resolve();
        expect(document.body.dataset.studioPerspective).toBe('default');

        perspectives.activeId = 'studio.documents';
        listeners.forEach(fn => fn());
        await Promise.resolve();
        expect(document.body.dataset.studioPerspective).toBe('studio.documents');
    });

    it('writes nothing for a mode that names no tabs', () => {
        expect(modeTabsCss({ quiet: [] })).toBe('');
        expect(modeTabsCss({ m: ['a', 'b'] })).toBe(
            'body[data-studio-perspective="m"] #shell-tab-a,\nbody[data-studio-perspective="m"] #shell-tab-b { display: grid !important; }',
        );
    });
});
