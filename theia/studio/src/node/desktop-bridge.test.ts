/**
 * @jest-environment node
 */
import {
    COMMANDS_KEPT,
    COMMAND_TTL_MS,
    CommandInbox,
    CommandListener,
    DesktopCommand,
    commandActivity,
    commandIn,
    eventEnvelope,
    postDesktopEvent,
    reconnectDelay,
    sseFrames,
} from './desktop-bridge';

const sent = (subjectId: string, payload: Record<string, unknown>) => ({
    seq: 1,
    kind: 'desktop_session.command_sent',
    subject_type: 'desktop_session',
    subject_id: subjectId,
    payload,
});

const leases: Record<string, string> = { 'lease-1': 'ws-1' };
const workspaceOf = (id: string) => leases[id];

const command = (id: string, heardAt = 0, workspaceId = 'ws-1'): DesktopCommand =>
    ({ commandId: id, workspaceId, command: 'open_in_editor', params: {}, heardAt });

describe('the desktop bridge', () => {
    it('reads whole SSE frames, keeping the unfinished one and skipping keep-alives and noise', () => {
        const { frames, rest } = sseFrames(': keep-alive\n\ndata: {"a":1}\r\n\r\ndata: not json\n\ndata: {"b"');
        expect(frames).toEqual([{ a: 1 }]);
        expect(rest).toBe('data: {"b"');
        expect(sseFrames(`${rest}:2}\n\n`).frames).toEqual([{ b: 2 }]);
    });

    it('hears only commands sent to a lease it holds, about that lease\'s workspace', () => {
        const ok = commandIn(sent('lease-1', { command_id: 'c1', command: 'open_in_editor', params: { relativePath: 'a' }, workspace_id: 'ws-1' }), workspaceOf, 5);
        expect(ok).toEqual({ commandId: 'c1', workspaceId: 'ws-1', command: 'open_in_editor', params: { relativePath: 'a' }, heardAt: 5 });
        expect(commandIn(sent('lease-2', { command_id: 'c1', command: 'x' }), workspaceOf, 0)).toBeUndefined();
        expect(commandIn(sent('lease-1', { command_id: 'c1', command: 'x', workspace_id: 'ws-9' }), workspaceOf, 0)).toBeUndefined();
        expect(commandIn(sent('lease-1', { command: 'x' }), workspaceOf, 0)).toBeUndefined();
        expect(commandIn({ ...sent('lease-1', { command_id: 'c', command: 'x' }), kind: 'task.running' }, workspaceOf, 0)).toBeUndefined();
        expect(commandIn('nonsense', workspaceOf, 0)).toBeUndefined();
        expect(commandIn(sent('lease-1', { command_id: 'c', command: 'x', params: [1] }), workspaceOf, 0)?.params).toEqual({});
    });

    it('keeps commands for their workspace\'s window, once each, fresh and few', async () => {
        let now = 0;
        const inbox = new CommandInbox(() => now);
        inbox.push(command('c1'));
        inbox.push(command('c1'));
        inbox.push(command('other', 0, 'ws-2'));
        expect((await inbox.take('ws-1', 0)).map(c => c.commandId)).toEqual(['c1']);
        expect(await inbox.take('ws-1', 0)).toEqual([]);

        for (let i = 0; i < COMMANDS_KEPT + 5; i++) {
            inbox.push(command(`k${i}`));
        }
        const kept = await inbox.take('ws-1', 0);
        expect(kept).toHaveLength(COMMANDS_KEPT);
        expect(kept[0].commandId).toBe('k5');

        inbox.push(command('late', 0));
        now = COMMAND_TTL_MS;
        expect(await inbox.take('ws-1', 0)).toEqual([]);
        expect((await inbox.take('ws-2', 0))).toEqual([]);
    });

    it('wakes a waiting window when its command comes, and answers empty when none does', async () => {
        const inbox = new CommandInbox();
        const waiting = inbox.take('ws-1', 10_000);
        inbox.push(command('c1', Date.now()));
        expect((await waiting).map(c => c.commandId)).toEqual(['c1']);
        expect(await inbox.take('ws-1', 5)).toEqual([]);
    });

    it('posts an event in the forwarder\'s envelope to the lease, under the member\'s token', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const ok = await postDesktopEvent(async (url, init) => {
            calls.push({ url, init });
            return new Response(null, { status: 202 });
        }, { studioUrl: 'https://studio', gatewayPrefix: '/cf', accessToken: async () => 'tok' }, 'lease 1', 'ws-1', 'workspace-activity', { type: 'x' });
        expect(ok).toBe(true);
        expect(calls[0].url).toBe('https://studio/cf/studio-theia/v1/desktop-sessions/lease%201/events');
        expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
        expect(JSON.parse(String(calls[0].init?.body))).toEqual({ session: { workspaceId: 'ws-1' }, kind: 'workspace-activity', event: { type: 'x' } });
        const refused = await postDesktopEvent(async () => new Response(null, { status: 404 }), { studioUrl: 's', gatewayPrefix: '', accessToken: async () => 't' }, 'l', 'w', 'k', {});
        expect(refused).toBe(false);
        const offline = await postDesktopEvent(async () => { throw new Error('offline'); }, { studioUrl: 's', gatewayPrefix: '', accessToken: async () => 't' }, 'l', 'w', 'k', {});
        expect(offline).toBe(false);
    });

    it('says what came of a command as a workspace activity', () => {
        expect(JSON.parse(eventEnvelope('ws', 'workspace-activity', commandActivity({ commandId: 'c', command: 'open_in_editor', ok: false, detail: 'no' }, 'now'))))
            .toEqual({ session: { workspaceId: 'ws' }, kind: 'workspace-activity', event: { type: 'desktop-command', commandId: 'c', command: 'open_in_editor', ok: false, detail: 'no', at: 'now' } });
    });

    it('waits longer after each failed connection, up to a minute', () => {
        expect([0, 1, 2, 5, 10].map(reconnectDelay)).toEqual([2_000, 4_000, 8_000, 60_000, 60_000]);
    });

    it('listens on the channel with the member\'s token, and reconnects when it ends', async () => {
        const inbox = new CommandInbox();
        const streams = [
            `data: ${JSON.stringify(sent('lease-1', { command_id: 'c1', command: 'open_in_editor', params: {} }))}\n\n`,
            `data: ${JSON.stringify(sent('lease-1', { command_id: 'c2', command: 'open_in_editor', params: {} }))}\n\n`,
        ];
        const asked: string[] = [];
        const waits: number[] = [];
        let listener: CommandListener | undefined = undefined;
        listener = new CommandListener(
            () => ({ studioUrl: 'https://studio', gatewayPrefix: '/cf', accessToken: async () => `tok${asked.length}` }),
            workspaceOf,
            inbox,
            async (url, init) => {
                asked.push(`${url} ${(init?.headers as Record<string, string>).Authorization}`);
                const text = streams.shift();
                if (text === undefined) {
                    listener!.stop();
                    return new Response(null, { status: 503 });
                }
                return new Response(text, { status: 200 });
            },
            async ms => { waits.push(ms); },
        );
        listener.start();
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(asked).toEqual([
            'https://studio/cf/studio-events/v1/stream Bearer tok0',
            'https://studio/cf/studio-events/v1/stream Bearer tok1',
            'https://studio/cf/studio-events/v1/stream Bearer tok2',
        ]);
        expect(waits).toEqual([2_000, 2_000]);
        expect((await inbox.take('ws-1', 0)).map(c => c.commandId)).toEqual(['c1', 'c2']);
        expect(listener.listening).toBe(false);
    });

    it('stops when nobody is signed in', async () => {
        let asked = 0;
        const listener = new CommandListener(() => undefined, workspaceOf, new CommandInbox(), async () => {
            asked++;
            return new Response('');
        });
        listener.start();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(asked).toBe(0);
        expect(listener.listening).toBe(false);
    });
});
