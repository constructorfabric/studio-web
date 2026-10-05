import { decideReveal, INTENT_WINDOW_MS, isAssistantCommand, isAssistantView } from './assistant-reveal-guard';

const CLAUDE = 'plugin-view-container:workbench.view.extension.claude-sidebar-secondary';
const CODEX = 'plugin-view-container:workbench.view.extension.codexSecondaryViewContainer';

describe('assistant reveal guard', () => {
    it('knows the assistants by their views', () => {
        expect([CLAUDE, CODEX, 'chat-view-widget'].every(isAssistantView)).toBe(true);
        expect(['studio.orca', 'outline-view', 'gearbox.inspector', 'plugin-view-container:workbench.view.extension.gitlens'].some(isAssistantView)).toBe(false);
    });

    it('undoes an assistant becoming current with nobody asking: back to the previous tab', () => {
        expect(decideReveal(CLAUDE, 'studio.orca', 0, 10_000)).toBe('restore-previous');
    });

    it('folds the flank when there was nothing else to go back to', () => {
        expect(decideReveal(CLAUDE, undefined, 0, 10_000)).toBe('collapse');
        expect(decideReveal(CLAUDE, CODEX, 0, 10_000)).toBe('collapse');
    });

    it('keeps an assistant someone just asked for', () => {
        const now = 10_000;
        expect(decideReveal(CLAUDE, 'studio.orca', now - INTENT_WINDOW_MS + 1, now)).toBe('keep');
    });

    it('never touches a view that is not an assistant', () => {
        expect(decideReveal('studio.orca', CLAUDE, 0, 10_000)).toBe('keep');
        expect(decideReveal(undefined, CLAUDE, 0, 10_000)).toBe('keep');
    });

    it('takes only the commands that open an assistant for a request', () => {
        for (const id of ['claude-vscode.sidebar.open', 'claude-vscode.editor.open', 'chatgpt.openSidebar', 'studio.assistants.pick', 'studio.assistant.reveal', 'studio.orca.toggle']) {
            expect(isAssistantCommand(id)).toBe(true);
        }
        for (const id of ['perspective.switch', 'setContext', 'workbench.action.reloadWindow', 'studio.markdownDiff.compare']) {
            expect(isAssistantCommand(id)).toBe(false);
        }
    });
});
