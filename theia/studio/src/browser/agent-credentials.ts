// Each window's agents run on that window's person (ADR-0030).
//
// Several people share one IDE session and one backend. Claude Code and Codex
// take a key per request from the frontend (`request.apiKey`), and the backend
// hands it to that one run only. In a Studio session the key is the member's
// own Studio token, taken from the portal bridge: the session sets
// STUDIO_LLM_AUTH=bearer, so the backend passes it on as a bearer to Studio's
// provider proxy, which swaps it for that member's key from their profile
// (`/studio-llm/v1/providers/*`). Nobody's provider key is in the container,
// and nothing here is written to the preferences, which every person in the
// container shares.

import { RemoteConnectionProvider, ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { interfaces } from '@theia/core/shared/inversify';
import { CLAUDE_CODE_SERVICE_PATH, ClaudeCodeClient, ClaudeCodeService } from '@theia/ai-claude-code/lib/common/claude-code-service';
import { CODEX_SERVICE_PATH, CodexClient, CodexService } from '@theia/ai-codex/lib/common/codex-service';
import { StudioApi } from './studio-api';

interface SendsWithKey {
    send(request: { apiKey?: string }, streamId: string): Promise<void>;
}

/**
 * The agent service, with the given token as every request's `apiKey`. When
 * there is none — outside a Studio session — the request is left as it was,
 * so the person's own preference still applies.
 */
export function withMemberToken<T extends object>(service: T, token: () => string | undefined): T {
    return new Proxy(service, {
        get(target, property) {
            const value = (target as Record<PropertyKey, unknown>)[property];
            if (property === 'send' && typeof value === 'function') {
                return (request: { apiKey?: string }, streamId: string) => {
                    const member = token();
                    return (target as unknown as SendsWithKey).send(member ? { ...request, apiKey: member } : request, streamId);
                };
            }
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
    });
}

const memberToken = (): string | undefined => StudioApi.token || undefined;

/** Rebind both agents' backend services to carry the window's person. */
export function bindAgentCredentials(rebind: interfaces.Rebind): void {
    rebind(ClaudeCodeService).toDynamicValue(ctx => {
        const connection = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        const client = ctx.container.get<ClaudeCodeClient>(ClaudeCodeClient);
        return withMemberToken(connection.createProxy<ClaudeCodeService>(CLAUDE_CODE_SERVICE_PATH, client), memberToken);
    }).inSingletonScope();
    rebind(CodexService).toDynamicValue(ctx => {
        const connection = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        const client = ctx.container.get<CodexClient>(CodexClient);
        return withMemberToken(connection.createProxy<CodexService>(CODEX_SERVICE_PATH, client), memberToken);
    }).inSingletonScope();
}
