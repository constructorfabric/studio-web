// The IDE's chat (Theia AI) on the person's own model key.
//
// Studio holds no provider key for the chat. The backend's LLM proxy sends
// every chat request on the caller's key — their profile key, else an AI
// connection they reach (their own, this workspace's, the organization's) —
// and its client-config says which model that gets them, or why there is
// none. Both live under the workspace, so a workspace's connection counts.

/** What `GET …/client-config` answers. */
export interface StudioLlmClientConfig {
    model?: string | null;
    provider?: string | null;
    developer_message_settings?: string;
    reason?: string | null;
}

/** Theia ai-openai's custom model entry. */
export interface StudioLlmModel {
    id: string;
    model: string;
    url: string;
    apiKey: string;
    developerMessageSettings: string;
}

export type TheiaAiPlan =
    | { kind: 'configure'; model: StudioLlmModel }
    | { kind: 'no-key'; message: string };

/** The in-container session gate that forwards `/studio-api` to the gateway. */
export const SESSION_GATE = 'http://127.0.0.1:3003/studio-api';

/** The proxy's routes for this IDE: under its workspace when it has one. */
export function studioLlmBase(scope: string): string {
    return scope ? `/studio-llm/v1/workspaces/${encodeURIComponent(scope)}` : '/studio-llm/v1';
}

const NO_KEY_FALLBACK =
    'No model provider key for you: add one to your Studio profile, or connect one ' +
    '(for yourself or this workspace) under Connections.';

/**
 * What to do with a client-config answer: configure the chat on the given
 * model, or leave it unconfigured and say where a key goes.
 */
export function planTheiaAi(cfg: StudioLlmClientConfig, token: string, scope: string): TheiaAiPlan {
    if (!cfg.model) {
        return {
            kind: 'no-key',
            message: `studio: Theia AI left unconfigured — ${cfg.reason || NO_KEY_FALLBACK}`,
        };
    }
    return {
        kind: 'configure',
        model: {
            id: 'studio-llm',
            model: cfg.model,
            url: `${SESSION_GATE}${studioLlmBase(scope)}`,
            apiKey: token,
            developerMessageSettings: cfg.developer_message_settings ?? 'system',
        },
    };
}
