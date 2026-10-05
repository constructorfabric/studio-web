// The right flank never opens on an assistant by itself.
//
// Claude Code, Codex and Theia's AI Chat each put a view in the right flank,
// and the plugins' views arrive after the layout is built. Whatever a mode
// meant to show there — Agents, the Inspector, nothing at all — the tab bar's
// selection then moves to the newcomer, and a person opening a document is met
// by a sign-in page for a tool they did not ask for. Reported from use: "I don't
// like that Claude Code opens by default."
//
// The rule is about intent, and the intent has to be for the ASSISTANT: a
// click on the right flank's own tabs, or a command that opens an assistant
// ("Claude Code: Open", the Agents button, a seeded question). Anything else —
// startup, the plugins registering their views, switching modes with a click
// or a key — is not a request for one, and the change it made is undone: the
// tab the flank showed before comes back, or the flank folds if there was none.

import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { ApplicationShell, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { CommandRegistry, Disposable, DisposableCollection } from '@theia/core';
import type { Title, Widget, TabBar } from '@theia/core/shared/@lumino/widgets';

/** How recent a request for an assistant must be to account for what happened. */
export const INTENT_WINDOW_MS = 1500;

/**
 * How many unasked-for reveals one page load undoes. Startup and a few mode
 * switches account for them; past this the guard stands aside rather than
 * risk fighting a plugin that keeps selecting its own view.
 */
export const MAX_INTERVENTIONS = 8;

/** The views an assistant puts in the right flank. */
export function isAssistantView(id: string): boolean {
    return id === 'chat-view-widget'
        || /^plugin-view-container:workbench\.view\.extension\.(claude|codex)/i.test(id);
}

/**
 * Commands that ask for an assistant. Not every command: during startup the
 * shell and the plugins run dozens (setContext, view registrations), and
 * counting those as intent let the very reveal this guards against through.
 */
export function isAssistantCommand(id: string): boolean {
    return /^(claude-vscode\.|chatgpt\.|codex\.|studio\.assistants?\.|studio\.orca\.|ai-chat|aiChat|chat:)/.test(id);
}

/** What to do about the right flank's selection, given when an assistant was last asked for. */
export function decideReveal(
    current: string | undefined,
    previous: string | undefined,
    lastAssistantIntentAt: number,
    now: number,
): 'keep' | 'restore-previous' | 'collapse' {
    if (!current || !isAssistantView(current)) {
        return 'keep';
    }
    if (now - lastAssistantIntentAt <= INTENT_WINDOW_MS) {
        return 'keep';
    }
    return previous && !isAssistantView(previous) ? 'restore-previous' : 'collapse';
}

@injectable()
export class AssistantRevealGuard implements FrontendApplicationContribution {
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(CommandRegistry)
    protected readonly commands: CommandRegistry;

    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    protected readonly toDispose = new DisposableCollection();
    protected lastAssistantIntentAt = Number.NEGATIVE_INFINITY;
    /** The last view the flank showed that was not an assistant: what to give back. */
    protected lastOwnView: Title<Widget> | undefined;
    protected interventions = 0;
    protected readonly restored = new Set<string>();

    onStart(): void {
        const intent = (): void => {
            this.lastAssistantIntentAt = Date.now();
        };
        // A click on the right flank's tabs (or inside an open assistant) is a
        // request for what is there. Capture, so a widget that stops the
        // event still counts.
        const onPointer = (event: PointerEvent): void => {
            const target = event.target as Element | null;
            if (target?.closest?.('#theia-right-side-panel, #theia-right-content-panel')) {
                intent();
            }
        };
        window.addEventListener('pointerdown', onPointer, true);
        this.toDispose.push(Disposable.create(() => window.removeEventListener('pointerdown', onPointer, true)));
        this.toDispose.push(this.commands.onWillExecuteCommand(event => {
            if (isAssistantCommand(event.commandId)) {
                intent();
            }
        }));
    }

    onDidInitializeLayout(): void {
        const tabBar = this.shell.rightPanelHandler.tabBar as TabBar<Widget>;
        const onChanged = (_: TabBar<Widget>, change: TabBar.ICurrentChangedArgs<Widget>): void => {
            this.check(tabBar, change.currentTitle, change.previousTitle);
        };
        tabBar.currentChanged.connect(onChanged);
        this.toDispose.push(Disposable.create(() => tabBar.currentChanged.disconnect(onChanged)));
        if (this.perspectives) {
            // A mode switch lays the flank out anew; look again once it has.
            this.toDispose.push(this.perspectives.onDidChangePerspective(() => {
                setTimeout(() => this.check(tabBar, tabBar.currentTitle, this.lastOwnView ?? null), 0);
            }));
        }
        // The layout itself may already have landed on one.
        this.check(tabBar, tabBar.currentTitle, null);
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    protected check(tabBar: TabBar<Widget>, current: Title<Widget> | null, previous: Title<Widget> | null): void {
        if (current && !isAssistantView(current.owner.id)) {
            this.lastOwnView = current;
        }
        const fallback = previous && !isAssistantView(previous.owner.id) ? previous : this.lastOwnView;
        let decision = decideReveal(current?.owner.id, fallback?.owner.id, this.lastAssistantIntentAt, Date.now());
        if (decision === 'keep' || this.interventions >= MAX_INTERVENTIONS) {
            return;
        }
        // Giving the previous tab back is tried once per assistant: if the
        // assistant takes the selection again (a plugin re-selecting its own
        // view), handing it back again would only start a tug of war. After
        // that the flank just folds.
        const id = current!.owner.id;
        if (decision === 'restore-previous' && this.restored.has(id)) {
            decision = 'collapse';
        }
        this.interventions++;
        // After this turn: the shell is still handling the change that got us here.
        setTimeout(() => {
            if (tabBar.currentTitle !== current) {
                return;
            }
            if (decision === 'restore-previous' && fallback && tabBar.titles.includes(fallback)) {
                this.restored.add(id);
                tabBar.currentTitle = fallback;
            } else if (this.shell.isExpanded('right')) {
                void this.shell.collapsePanel('right');
            }
        }, 0);
    }
}
