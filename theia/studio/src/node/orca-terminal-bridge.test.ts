import * as path from 'path';
import {
    OrcaTerminalBridge,
    SEND_CHUNK,
    chunkText,
    clampViewport,
    orcaClientDir,
    pairingOffer,
    streamEvent,
    type OrcaRemoteClient,
    type OrcaRpcResponse,
    type OrcaSubscriptionCallbacks
} from './orca-terminal-bridge';
import type { OrcaTerminalClient } from '../common/orca-terminal-protocol';

const PAIRING = { endpoint: 'ws://127.0.0.1:6768', deviceToken: 'token', publicKeyB64: 'key' };

/** A runtime that hands the test the stream's callbacks and records requests. */
function fakeRuntime() {
    const requests: Array<{ method: string; params: any }> = [];
    const subscribes: Array<{ params: any; callbacks: OrcaSubscriptionCallbacks }> = [];
    const closed = jest.fn();
    const remote: OrcaRemoteClient = {
        parsePairing: offer => (offer === 'orca://pair?code=ok' ? PAIRING : null),
        subscribe: async (_pairing, method, params, _timeout, callbacks) => {
            expect(method).toBe('terminal.subscribe');
            subscribes.push({ params, callbacks });
            return {
                close: closed,
                sendRequest: async (m, p) => {
                    requests.push({ method: m, params: p });
                    return { ok: true, result: {} };
                }
            };
        }
    };
    return { remote, requests, subscribes, closed };
}

class TestBridge extends OrcaTerminalBridge {
    constructor(readonly fake: OrcaRemoteClient, readonly offer: string | undefined = 'orca://pair?code=ok') {
        super();
    }
    protected override remoteClient(): OrcaRemoteClient {
        return this.fake;
    }
    protected override pairingOffer(): string | undefined {
        return this.offer;
    }
}

function client(): OrcaTerminalClient & { output: string[]; closed: string[] } {
    const output: string[] = [];
    const closed: string[] = [];
    return {
        output,
        closed,
        onOutput: (_stream, data) => output.push(data),
        onClosed: (_stream, reason) => closed.push(reason)
    };
}

const frame = (result: unknown): OrcaRpcResponse => ({ ok: true, result });

describe('the stream of an Orca terminal', () => {
    it('starts with the screen Orca serialized, then carries every chunk as it comes', () => {
        expect(streamEvent(frame({ type: 'scrollback', serialized: '\x1b[32mhi\x1b[0m', lines: ['hi'] })))
            .toEqual({ output: '\x1b[32mhi\x1b[0m' });
        expect(streamEvent(frame({ type: 'scrollback', lines: ['one', 'two'] }))).toEqual({ output: 'one\r\ntwo' });
        expect(streamEvent(frame({ type: 'data', chunk: 'live-42\r\n' }))).toEqual({ output: 'live-42\r\n' });
    });

    it('ends where Orca ends it, and says why when it refuses', () => {
        expect(streamEvent(frame({ type: 'end' }))).toEqual({ closed: 'The terminal ended.' });
        expect(streamEvent({ ok: false, error: { code: 'not_found', message: 'Unknown terminal handle' } }))
            .toEqual({ closed: 'Orca refused the stream: Unknown terminal handle' });
    });

    it('shows the last output of a terminal whose process is gone', () => {
        const event = streamEvent(frame({ type: 'subscribed', streamId: null, lines: ['bye'] }));
        expect(event.output).toBe('bye');
        expect(event.closed).toMatch(/no running process/);
    });

    it('ignores what it has nothing to show for', () => {
        expect(streamEvent(frame({ type: 'fit-override-changed', cols: 120, rows: 40 }))).toEqual({});
    });
});

describe('the bridge between a tab and an Orca terminal', () => {
    it('subscribes as a desktop viewer sized like the tab, and streams into the tab', async () => {
        const runtime = fakeRuntime();
        const tab = client();
        const bridge = new TestBridge(runtime.remote);
        bridge.setClient(tab);
        await bridge.attach('s1', 'term_1', 100, 30);

        expect(runtime.subscribes[0].params).toEqual({
            terminal: 'term_1',
            client: { id: 'studio-s1', type: 'desktop' },
            viewport: { cols: 100, rows: 30 }
        });
        runtime.subscribes[0].callbacks.onResponse(frame({ type: 'scrollback', serialized: 'screen' }));
        runtime.subscribes[0].callbacks.onResponse(frame({ type: 'data', chunk: 'more' }));
        expect(tab.output).toEqual(['screen', 'more']);
    });

    it('writes what is typed unchanged and in order, a long paste in pieces', async () => {
        const runtime = fakeRuntime();
        const bridge = new TestBridge(runtime.remote);
        await bridge.attach('s1', 'term_1', 80, 24);
        const paste = 'x'.repeat(SEND_CHUNK + 10);
        void bridge.write('s1', '\x1b[A');
        void bridge.write('s1', paste);
        await bridge.write('s1', '\x03');

        expect(runtime.requests.map(r => r.method)).toEqual(['terminal.send', 'terminal.send', 'terminal.send', 'terminal.send']);
        expect(runtime.requests.map(r => r.params.text)).toEqual(['\x1b[A', 'x'.repeat(SEND_CHUNK), 'x'.repeat(10), '\x03']);
        expect(runtime.requests.every(r => r.params.terminal === 'term_1')).toBe(true);
    });

    it('resizes the PTY within what Orca accepts', async () => {
        const runtime = fakeRuntime();
        const bridge = new TestBridge(runtime.remote);
        await bridge.attach('s1', 'term_1', 80, 24);
        await bridge.resize('s1', 300, 4);

        expect(runtime.requests).toEqual([{
            method: 'terminal.updateViewport',
            params: { terminal: 'term_1', client: { id: 'studio-s1', type: 'desktop' }, viewport: { cols: 240, rows: 8 } }
        }]);
    });

    it('keeps a resize made while the socket opens, and sends it once Orca answers', async () => {
        const runtime = fakeRuntime();
        let open: () => void = () => undefined;
        const slow: OrcaRemoteClient = {
            ...runtime.remote,
            subscribe: async (...args) => {
                await new Promise<void>(resolve => (open = resolve));
                return runtime.remote.subscribe(...args);
            }
        };
        const bridge = new TestBridge(slow);
        const attached = bridge.attach('s1', 'term_1', 80, 24);
        const resized = bridge.resize('s1', 120, 40);
        await Promise.resolve();
        expect(runtime.requests).toEqual([]);
        open();
        await attached;
        await resized;

        expect(runtime.requests.map(r => r.params.viewport)).toEqual([{ cols: 120, rows: 40 }]);
    });

    it('tells the tab once when the stream ends, and sends nothing after', async () => {
        const runtime = fakeRuntime();
        const tab = client();
        const bridge = new TestBridge(runtime.remote);
        bridge.setClient(tab);
        await bridge.attach('s1', 'term_1', 80, 24);
        runtime.subscribes[0].callbacks.onResponse(frame({ type: 'end' }));
        runtime.subscribes[0].callbacks.onClose?.();
        await bridge.write('s1', 'ignored');

        expect(tab.closed).toEqual(['The terminal ended.']);
        expect(runtime.closed).toHaveBeenCalled();
        expect(runtime.requests).toEqual([]);
    });

    it('lets go quietly when the tab closes, and when the window does', async () => {
        const runtime = fakeRuntime();
        const tab = client();
        const bridge = new TestBridge(runtime.remote);
        bridge.setClient(tab);
        await bridge.attach('s1', 'term_1', 80, 24);
        await bridge.attach('s2', 'term_2', 80, 24);
        await bridge.detach('s1');
        expect(runtime.closed).toHaveBeenCalledTimes(1);
        bridge.dispose();
        expect(runtime.closed).toHaveBeenCalledTimes(2);
        runtime.subscribes[1].callbacks.onResponse(frame({ type: 'data', chunk: 'late' }));
        expect(tab.output).toEqual([]);
        expect(tab.closed).toEqual([]);
    });

    it('explains a missing pairing instead of trying to connect', async () => {
        const runtime = fakeRuntime();
        const bridge = new TestBridge(runtime.remote, '');
        await expect(bridge.attach('s1', 'term_1', 80, 24)).rejects.toThrow(/no pairing with the Orca runtime/);
        expect(runtime.subscribes).toEqual([]);
    });

    it('names the failure when the runtime will not stream', async () => {
        const bridge = new TestBridge({
            parsePairing: () => PAIRING,
            subscribe: async () => {
                throw new Error('Remote Orca runtime rejected the device token.');
            }
        });
        await expect(bridge.attach('s1', 'term_1', 80, 24))
            .rejects.toThrow('Could not attach to the Orca terminal: Remote Orca runtime rejected the device token.');
        await bridge.write('s1', 'x');
    });
});

describe('where the bridge finds Orca and its pairing', () => {
    it('looks for the client next to the CLI, as every Orca package lays it out', () => {
        expect(orcaClientDir(path.join('/opt', 'Orca', 'resources', 'bin', 'orca-ide')))
            .toBe(path.join('/opt', 'Orca', 'resources', 'app.asar.unpacked', 'out', 'shared'));
    });

    it('takes an offer from the environment first, then the file the session writes', () => {
        const read = (file: string) => {
            if (file !== '/data/orca-pairing') {
                throw new Error('ENOENT');
            }
            return 'orca://pair?code=file\n';
        };
        expect(pairingOffer({ STUDIO_ORCA_PAIRING_URL: 'orca://pair?code=env' }, read)).toBe('orca://pair?code=env');
        expect(pairingOffer({ STUDIO_ORCA_PAIRING_FILE: '/data/orca-pairing' }, read)).toBe('orca://pair?code=file');
        expect(pairingOffer({ STUDIO_ORCA_PAIRING_FILE: '/elsewhere' }, read)).toBeUndefined();
        expect(pairingOffer({}, read)).toBeUndefined();
    });
});

describe('the pieces a paste is sent in', () => {
    it('never splits a surrogate pair', () => {
        const text = 'ab\u{1F600}cd';
        const chunks = chunkText(text, 3);
        expect(chunks.join('')).toBe(text);
        expect(chunks).toEqual(['ab', '\u{1F600}c', 'd']);
    });

    it('clamps a viewport that is not a number to the smallest Orca takes', () => {
        expect(clampViewport(Number.NaN, 30.4)).toEqual({ cols: 20, rows: 30 });
    });
});
