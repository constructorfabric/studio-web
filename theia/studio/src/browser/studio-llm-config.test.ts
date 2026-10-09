import { planTheiaAi, SESSION_GATE, studioLlmBase } from './studio-llm-config';

describe('the IDE chat on the person\'s own key', () => {
    it('reaches the proxy under the workspace, so its connections count', () => {
        expect(studioLlmBase('d2')).toBe('/studio-llm/v1/workspaces/d2');
        expect(studioLlmBase('')).toBe('/studio-llm/v1');
    });

    it('configures the model client-config names, on the person\'s Studio token', () => {
        const plan = planTheiaAi(
            { model: 'claude-sonnet-5-5', provider: 'anthropic', developer_message_settings: 'system' },
            'studio-token',
            'ws-1',
        );
        expect(plan).toEqual({
            kind: 'configure',
            model: {
                id: 'studio-llm',
                model: 'claude-sonnet-5-5',
                url: `${SESSION_GATE}/studio-llm/v1/workspaces/ws-1`,
                apiKey: 'studio-token',
                developerMessageSettings: 'system',
            },
        });
    });

    it('leaves the chat unconfigured without a key, and says where to add one', () => {
        const reason = 'No anthropic or openai key for you: add one to your Studio profile, or connect one ' +
            '(for yourself or this workspace) under Connections.';
        const plan = planTheiaAi({ model: null, reason, developer_message_settings: 'system' }, 't', 'ws-1');
        expect(plan.kind).toBe('no-key');
        expect(plan.kind === 'no-key' && plan.message).toContain(reason);
        const bare = planTheiaAi({}, 't', '');
        expect(bare.kind === 'no-key' && bare.message).toContain('Studio profile');
    });
});
