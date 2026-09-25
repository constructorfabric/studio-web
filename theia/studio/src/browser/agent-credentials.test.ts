import { withMemberToken } from './agent-credentials';

describe('agent credentials', () => {
    function service() {
        const sent: Array<{ apiKey?: string; prompt?: string }> = [];
        return {
            sent,
            send: async (request: { apiKey?: string; prompt?: string }, _streamId: string) => { sent.push(request); },
            cancel: (id: string) => `cancelled ${id}`,
        };
    }

    it('sends the window\'s person as the key of every agent request', async () => {
        const backend = service();
        let token = 'token-of-ana';
        const wrapped = withMemberToken(backend, () => token);
        await wrapped.send({ prompt: 'a', apiKey: 'sk-from-shared-preferences' }, 's1');
        token = 'token-of-ana-refreshed';
        await wrapped.send({ prompt: 'b' }, 's2');
        expect(backend.sent).toEqual([
            { prompt: 'a', apiKey: 'token-of-ana' },
            { prompt: 'b', apiKey: 'token-of-ana-refreshed' },
        ]);
    });

    it('leaves the request alone outside a Studio session', async () => {
        const backend = service();
        const wrapped = withMemberToken(backend, () => undefined);
        await wrapped.send({ prompt: 'a', apiKey: 'sk-mine' }, 's1');
        expect(backend.sent).toEqual([{ prompt: 'a', apiKey: 'sk-mine' }]);
    });

    it('passes every other call through untouched', () => {
        const wrapped = withMemberToken(service(), () => 'token');
        expect(wrapped.cancel('s9')).toBe('cancelled s9');
    });
});
