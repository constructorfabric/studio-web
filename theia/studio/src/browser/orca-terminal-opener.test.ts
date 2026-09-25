// "Open" on an agent: a terminal tab in the middle, wired both ways to the
// agent's PTY. The terminal package itself is stood in for — its widget
// needs a real DOM and xterm, and what is under test is the wiring.

import 'reflect-metadata';
jest.mock('@theia/terminal/lib/browser/base/terminal-service', () => ({ TerminalService: Symbol('TerminalService') }));
jest.mock('@theia/terminal/lib/browser/base/terminal-widget', () => ({ TerminalLocation: { Panel: 1, Editor: 2 } }));

import { Container } from '@theia/core/shared/inversify';
import { Emitter } from '@theia/core/lib/common/event';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { OrcaTerminalService } from '../common/orca-terminal-protocol';
import type { OrcaTerminal } from '../common/orca-protocol';
import { OrcaTerminalFrontendClient, OrcaTerminalOpener, orcaTabTitle } from './orca-terminal-opener';

function fakeWidget() {
    const data = new Emitter<string>();
    const size = new Emitter<{ cols: number; rows: number }>();
    const disposed = new Emitter<void>();
    const widget = {
        written: [] as string[],
        isDisposed: false,
        dimensions: { cols: 132, rows: 40 },
        start: jest.fn(async () => 1),
        write: (text: string) => widget.written.push(text),
        writeLine: (text: string) => widget.written.push(`${text}\n`),
        onData: data.event,
        onSizeChanged: size.event,
        onDidDispose: disposed.event,
        type: (text: string) => data.fire(text),
        resize: (cols: number, rows: number) => size.fire({ cols, rows }),
        close: () => {
            widget.isDisposed = true;
            disposed.fire();
        }
    };
    return widget;
}

function setup(attach: (stream: string) => Promise<void> = async () => undefined) {
    const widgets: Array<ReturnType<typeof fakeWidget>> = [];
    const terminals = {
        newTerminal: jest.fn(async () => {
            const widget = fakeWidget();
            widgets.push(widget);
            return widget;
        }),
        open: jest.fn(async () => undefined)
    };
    const bridge = {
        attach: jest.fn((stream: string) => attach(stream)),
        write: jest.fn(async () => undefined),
        resize: jest.fn(async () => undefined),
        detach: jest.fn(async () => undefined)
    };
    const container = new Container();
    container.bind(TerminalService).toConstantValue(terminals as never);
    container.bind(OrcaTerminalService).toConstantValue(bridge as never);
    container.bind(OrcaTerminalFrontendClient).toSelf().inSingletonScope();
    container.bind(OrcaTerminalOpener).toSelf().inSingletonScope();
    return {
        opener: container.get(OrcaTerminalOpener),
        client: container.get(OrcaTerminalFrontendClient),
        terminals,
        bridge,
        widgets
    };
}

const agent: OrcaTerminal = {
    handle: 'term_1',
    title: 'Claude Code',
    agent: 'claude',
    connected: true,
    worktreePath: '/workspace/studio-web',
    preview: ''
};

describe('Open on an Orca agent', () => {
    it('opens a pseudo terminal tab in the middle, and attaches it at the size it has', async () => {
        const { opener, terminals, bridge } = setup();
        await opener.open(agent);

        expect(terminals.newTerminal).toHaveBeenCalledWith(expect.objectContaining({
            title: 'claude · Claude Code',
            isPseudoTerminal: true,
            useServerTitle: false,
            location: 2
        }));
        expect(terminals.open).toHaveBeenCalledWith(expect.anything(), { widgetOptions: { area: 'main' }, mode: 'activate' });
        expect(bridge.attach).toHaveBeenCalledWith(expect.any(String), 'term_1', 132, 40);
    });

    it('shows the PTY in the tab, and sends it what is typed and the size the tab takes', async () => {
        const { opener, client, bridge, widgets } = setup();
        await opener.open(agent);
        const stream = bridge.attach.mock.calls[0][0];
        client.onOutput(stream, '\x1b[1mworking\x1b[0m');
        client.onOutput('someone-else', 'not ours');
        widgets[0].type('y\r');
        widgets[0].resize(200, 50);

        expect(widgets[0].written).toEqual(['\x1b[1mworking\x1b[0m']);
        expect(bridge.write).toHaveBeenCalledWith(stream, 'y\r');
        expect(bridge.resize).toHaveBeenCalledWith(stream, 200, 50);
    });

    it('sends the size the tab fitted to while it attached', async () => {
        const { opener, bridge, widgets } = setup(async () => {
            widgets[0].dimensions = { cols: 150, rows: 45 };
        });
        await opener.open(agent);

        expect(bridge.resize).toHaveBeenCalledWith(bridge.attach.mock.calls[0][0], 150, 45);
    });

    it('brings the same tab forward on a second Open instead of attaching twice', async () => {
        const { opener, terminals, bridge } = setup();
        const first = await opener.open(agent);
        const second = await opener.open(agent);

        expect(second).toBe(first);
        expect(terminals.newTerminal).toHaveBeenCalledTimes(1);
        expect(bridge.attach).toHaveBeenCalledTimes(1);
        expect(terminals.open).toHaveBeenLastCalledWith(first, { mode: 'activate' });
    });

    it('lets go of the stream when the tab closes, and the next Open attaches afresh', async () => {
        const { opener, bridge, widgets } = setup();
        await opener.open(agent);
        const stream = bridge.attach.mock.calls[0][0];
        widgets[0].close();
        expect(bridge.detach).toHaveBeenCalledWith(stream);

        await opener.open(agent);
        expect(bridge.attach).toHaveBeenCalledTimes(2);
    });

    it('says in the tab why the stream ended, and re-attaches on the next Open', async () => {
        const { opener, client, bridge, widgets } = setup();
        await opener.open(agent);
        client.onClosed(bridge.attach.mock.calls[0][0], 'The terminal ended.');

        expect(widgets[0].written.join('')).toContain('[The terminal ended.]');
        await opener.open(agent);
        expect(widgets).toHaveLength(2);
    });

    it('says in the tab why it could not attach', async () => {
        const { opener, widgets } = setup(async () => {
            throw new Error('This IDE has no pairing with the Orca runtime');
        });
        await opener.open(agent);

        expect(widgets[0].written.join('')).toContain('This IDE has no pairing with the Orca runtime');
        await opener.open(agent);
        expect(widgets).toHaveLength(2);
    });
});

describe('the title of an agent tab', () => {
    it('names the agent and its terminal, once each', () => {
        expect(orcaTabTitle({ agent: 'codex', title: 'Fix login' })).toBe('codex · Fix login');
        expect(orcaTabTitle({ agent: 'claude', title: 'claude' })).toBe('claude');
        expect(orcaTabTitle({ title: '  ' })).toBe('terminal');
    });
});
