/**
 * @jest-environment node
 */
import { DESKTOP_SESSIONS_PATH, DesktopLeases, LeaseTarget } from './desktop-leases';

const TARGET: LeaseTarget = {
    studioUrl: 'https://studio.example.com',
    gatewayPrefix: '/cf',
    accessToken: async () => 'member-token',
    deviceId: 'device-1',
    deviceName: 'laptop',
};

interface Call { url: string; init?: RequestInit }

function studio(answers: Response[]): { leases: DesktopLeases; calls: Call[] } {
    const calls: Call[] = [];
    const leases = new DesktopLeases(async (url, init) => {
        calls.push({ url, init });
        return answers.shift() ?? new Response(null, { status: 204 });
    });
    return { leases, calls };
}

const lease = (id: string): Response => new Response(JSON.stringify({ id }), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('a desktop\'s leases', () => {
    it('renews a workspace as this device, with the member\'s token', async () => {
        const { leases, calls } = studio([lease('lease-1')]);
        expect(await leases.renew(TARGET, 'ws-1')).toBe(true);
        expect(calls[0].url).toBe(`https://studio.example.com/cf${DESKTOP_SESSIONS_PATH}`);
        expect(calls[0].init?.method).toBe('POST');
        expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer member-token');
        expect(JSON.parse(String(calls[0].init?.body))).toEqual({ workspace_id: 'ws-1', device_id: 'device-1', device_name: 'laptop' });
        expect(leases.open).toEqual(['ws-1']);
    });

    it('ends the lease Studio named, and only once', async () => {
        const { leases, calls } = studio([lease('lease-1')]);
        await leases.renew(TARGET, 'ws-1');
        await leases.end(TARGET, 'ws-1');
        await leases.end(TARGET, 'ws-1');
        expect(calls.map(c => `${c.init?.method} ${c.url}`)).toEqual([
            `POST https://studio.example.com/cf${DESKTOP_SESSIONS_PATH}`,
            `DELETE https://studio.example.com/cf${DESKTOP_SESSIONS_PATH}/lease-1`,
        ]);
        expect(leases.open).toEqual([]);
    });

    it('holds nothing for a workspace Studio refused', async () => {
        const { leases } = studio([lease('lease-1'), new Response(null, { status: 404 })]);
        await leases.renew(TARGET, 'ws-1');
        expect(await leases.renew(TARGET, 'ws-1')).toBe(false);
        expect(leases.open).toEqual([]);
    });

    it('ends every lease on the way out', async () => {
        const { leases, calls } = studio([lease('a'), lease('b')]);
        await leases.renew(TARGET, 'ws-1');
        await leases.renew(TARGET, 'ws-2');
        await leases.endAll(TARGET);
        expect(calls.filter(c => c.init?.method === 'DELETE').map(c => c.url.split('/').pop()).sort()).toEqual(['a', 'b']);
        expect(leases.open).toEqual([]);
    });

    it('does not fail the way out when Studio is unreachable', async () => {
        const leases = new DesktopLeases(async (_url, init) => {
            if (init?.method === 'DELETE') {
                throw new Error('offline');
            }
            return lease('a');
        });
        await leases.renew(TARGET, 'ws-1');
        await expect(leases.endAll(TARGET)).resolves.toBeUndefined();
    });
});
