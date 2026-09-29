// "Open" on an agent: its Orca terminal as a real Theia terminal tab, in the
// middle of the workbench, the way Orca itself shows it.
//
// The tab is a pseudo terminal — Theia's full xterm (theme, search, copy and
// paste, resize) with no shell of its own, the same kind of terminal an
// extension's `createTerminal({ pty })` gets. Its output is the agent's PTY,
// streamed by the backend (../node/orca-terminal-bridge.ts); what is typed in
// it goes to that PTY unchanged; its size is the PTY's size while it is open.
// Closing the tab lets go of the stream and nothing else: the agent keeps
// running in Orca, and Open attaches to it again.
//
// Off a session there is no pairing until the person makes one: the tab asks
// for the link the Orca desktop app generates for this computer, and attaches
// once it has it (../node/orca-terminal-bridge.ts keeps it for later starts).

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, type Command } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickInputService } from '@theia/core/lib/common/quick-pick-service';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { Emitter } from '@theia/core/lib/common/event';
import { generateUuid } from '@theia/core/lib/common/uuid';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalLocation, type TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import type { OrcaTerminal } from '../common/orca-protocol';
import {
    needsPairing,
    OrcaTerminalService,
    type OrcaTerminalClient
} from '../common/orca-terminal-protocol';

export const OrcaPairCommand: Command = {
    id: 'studio.orca.pair',
    category: 'Orca',
    label: 'Pair with Orca on This Computer'
};

/** The backend's pushes, as events. Bound as the RPC proxy's client. */
@injectable()
export class OrcaTerminalFrontendClient implements OrcaTerminalClient {
    protected readonly outputEmitter = new Emitter<{ stream: string; data: string }>();
    protected readonly closedEmitter = new Emitter<{ stream: string; reason: string }>();
    readonly onDidOutput = this.outputEmitter.event;
    readonly onDidClose = this.closedEmitter.event;

    onOutput(stream: string, data: string): void {
        this.outputEmitter.fire({ stream, data });
    }

    onClosed(stream: string, reason: string): void {
        this.closedEmitter.fire({ stream, reason });
    }
}

/** The title an agent's tab carries: which agent, and which terminal of it. */
export function orcaTabTitle(terminal: Pick<OrcaTerminal, 'agent' | 'title'>): string {
    const title = terminal.title?.trim() || 'terminal';
    return terminal.agent && terminal.agent !== title ? `${terminal.agent} · ${title}` : title;
}

@injectable()
export class OrcaTerminalOpener {

    @inject(TerminalService)
    protected readonly terminals!: TerminalService;

    @inject(OrcaTerminalService)
    protected readonly bridge!: OrcaTerminalService;

    @inject(OrcaTerminalFrontendClient)
    protected readonly client!: OrcaTerminalFrontendClient;

    @inject(QuickInputService)
    protected readonly quickInput!: QuickInputService;

    /** Open tabs, by Orca terminal handle — so Open twice shows the same tab. */
    protected readonly byHandle = new Map<string, TerminalWidget>();
    protected readonly byStream = new Map<string, { widget: TerminalWidget; handle: string }>();

    @postConstruct()
    protected init(): void {
        this.client.onDidOutput(({ stream, data }) => this.byStream.get(stream)?.widget.write(data));
        this.client.onDidClose(({ stream, reason }) => {
            const open = this.byStream.get(stream);
            if (!open) {
                return;
            }
            // The tab keeps what it showed; the next Open attaches afresh.
            this.forget(stream, open.handle, open.widget);
            open.widget.writeLine(`\r\n\x1b[2m[${reason}]\x1b[0m`);
        });
    }

    /** Show the terminal's tab, attaching to its PTY unless a tab already has. */
    async open(terminal: OrcaTerminal): Promise<TerminalWidget> {
        const existing = this.byHandle.get(terminal.handle);
        if (existing && !existing.isDisposed) {
            await this.terminals.open(existing, { mode: 'activate' });
            return existing;
        }
        const widget = await this.terminals.newTerminal({
            id: `studio-orca-terminal-${generateUuid()}`,
            title: orcaTabTitle(terminal),
            kind: 'orca',
            isPseudoTerminal: true,
            useServerTitle: false,
            destroyTermOnClose: true,
            location: TerminalLocation.Editor
        });
        await widget.start();
        await this.terminals.open(widget, { widgetOptions: { area: 'main' }, mode: 'activate' });

        const stream = generateUuid();
        this.byHandle.set(terminal.handle, widget);
        this.byStream.set(stream, { widget, handle: terminal.handle });
        const toDispose = new DisposableCollection(
            widget.onData(data => void this.bridge.write(stream, data)),
            widget.onSizeChanged(({ cols, rows }) => void this.bridge.resize(stream, cols, rows))
        );
        widget.onDidDispose(() => {
            toDispose.dispose();
            this.forget(stream, terminal.handle, widget);
            void this.bridge.detach(stream);
        });

        const { cols, rows } = widget.dimensions;
        try {
            await this.attachOrPair(stream, terminal.handle, cols, rows);
            // The tab has fitted itself to the editor area by now; the size it
            // was created with is xterm's default, not what is on screen.
            const fitted = widget.dimensions;
            if (fitted.cols !== cols || fitted.rows !== rows) {
                void this.bridge.resize(stream, fitted.cols, fitted.rows);
            }
        } catch (error) {
            // The tab stays, saying why; the next Open tries afresh.
            this.forget(stream, terminal.handle, widget);
            widget.writeLine(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
        }
        return widget;
    }

    /** Attach; when that fails for want of a pairing this IDE may make, ask for one and attach again. */
    protected async attachOrPair(stream: string, handle: string, cols: number, rows: number): Promise<void> {
        try {
            await this.bridge.attach(stream, handle, cols, rows);
        } catch (error) {
            // Missing, or no longer accepted: both are fixed by pairing (again).
            const unpaired = error instanceof Error && needsPairing(error.message);
            if (!unpaired || !(await this.bridge.canPair()) || !(await this.askToPair())) {
                throw error;
            }
            await this.bridge.attach(stream, handle, cols, rows);
        }
    }

    /**
     * Ask for the pairing link and hand it to the backend. Answers whether a
     * pairing was made; a link the backend refuses is asked for again, with why.
     */
    async askToPair(): Promise<boolean> {
        let problem: string | undefined;
        for (;;) {
            const link = await this.quickInput.input({
                title: 'Pair with Orca on this computer',
                prompt: problem ?? 'In Orca: Settings → Pair another Orca client → This computer → generate an access link, and paste it here.',
                placeHolder: 'orca://pair?code=…',
                password: true,
                ignoreFocusLost: true
            });
            if (!link?.trim()) {
                return false;
            }
            try {
                await this.bridge.pair(link);
                return true;
            } catch (error) {
                problem = error instanceof Error ? error.message : String(error);
            }
        }
    }

    protected forget(stream: string, handle: string, widget: TerminalWidget): void {
        this.byStream.delete(stream);
        if (this.byHandle.get(handle) === widget) {
            this.byHandle.delete(handle);
        }
    }
}

/** "Orca: Pair with Orca on This Computer" — to pair, or pair again, before any tab asks. Off a session only. */
@injectable()
export class OrcaPairingCommands implements CommandContribution {

    @inject(OrcaTerminalOpener)
    protected readonly opener!: OrcaTerminalOpener;

    @inject(OrcaTerminalService)
    protected readonly bridge!: OrcaTerminalService;

    @inject(MessageService)
    protected readonly messages!: MessageService;

    protected pairable = false;

    registerCommands(commands: CommandRegistry): void {
        // A session pairs itself; the command is not offered there at all.
        void this.bridge.canPair().then(can => (this.pairable = can), () => undefined);
        commands.registerCommand(OrcaPairCommand, {
            isEnabled: () => this.pairable,
            isVisible: () => this.pairable,
            execute: async () => {
                if (await this.opener.askToPair()) {
                    this.messages.info('Paired with Orca on this computer. Open an agent to see its terminal.');
                }
            }
        });
    }
}
