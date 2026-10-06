// Theia -> studio event forwarding (ADR-0022 phase 3).
//
// Registers as one additional, non-browser `StudioRuntimeClient` inside the
// node backend. Every broadcast the endpoint already fans out to browser
// clients is also POSTed to studio-backend's event ingress, carrying the S2S
// token. The wire payload for each event is the callback argument verbatim,
// wrapped in a small envelope { kind, sequence?, event } — no new event model.
//
// Dormant unless both STUDIO_THEIA_S2S_TOKEN and an ingress URL are configured,
// so a normal IDE session forwards nothing. Delivery is best-effort and
// fire-and-forget: a dropped POST is recovered by studio-backend pulling
// `getOperationDeltas` on reconnect, so a network blip never blocks a broadcast.

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

import {
    StudioAuditEntry,
    StudioOperationEvent,
    StudioRepositoryDescriptor,
    StudioRuntimeClient
} from '../common/studio-protocol';
import {
    WorkspaceActivityEvent,
    WorkspaceSnapshot
} from '../common/workspace-protocol';

export const EVENT_INGRESS_URL_ENV = 'STUDIO_THEIA_EVENT_INGRESS_URL';
export const CONTROL_TOKEN_ENV = 'STUDIO_THEIA_S2S_TOKEN';
export const GATEWAY_URL_ENV = 'STUDIO_GATEWAY_URL';
export const CONTROL_TOKEN_HEADER = 'x-cfs-theia-token';

interface ForwarderConfig {
    readonly ingressUrl: string;
    readonly token: string;
    readonly workspaceId: string;
}

/**
 * Resolve the forwarder configuration from the environment, or `undefined` when
 * the bridge is not provisioned (then the forwarder is not created).
 */
export function resolveForwarderConfig(
    workspaceId: string,
    env: NodeJS.ProcessEnv = process.env
): ForwarderConfig | undefined {
    const token = (env[CONTROL_TOKEN_ENV] ?? '').trim();
    if (!token) {
        return undefined;
    }
    const explicit = (env[EVENT_INGRESS_URL_ENV] ?? '').trim();
    const gateway = (env[GATEWAY_URL_ENV] ?? '').trim();
    const ingressUrl = explicit || (gateway ? joinUrl(gateway, '/studio-theia/v1/events') : '');
    if (!ingressUrl) {
        return undefined;
    }
    return { ingressUrl, token, workspaceId };
}

export class StudioEventForwarder implements StudioRuntimeClient {
    protected readonly target: URL;

    constructor(protected readonly config: ForwarderConfig) {
        this.target = new URL(config.ingressUrl);
    }

    onOperationEvent(event: StudioOperationEvent): void {
        this.post('operation', event, event.sequence);
    }

    onAuditEvent(entry: StudioAuditEntry): void {
        this.post('audit', entry, entry.sequence);
    }

    onRepositoriesChanged(repositories: readonly StudioRepositoryDescriptor[]): void {
        this.post('repositories-changed', repositories);
    }

    onWorkspaceSnapshotChanged(snapshot: WorkspaceSnapshot): void {
        this.post('workspace-snapshot-changed', snapshot);
    }

    onWorkspaceActivityEvent(event: WorkspaceActivityEvent): void {
        this.post('workspace-activity', event);
    }

    protected post(kind: string, event: unknown, sequence?: number): void {
        const body = JSON.stringify({
            session: { workspaceId: this.config.workspaceId },
            kind,
            sequence,
            event
        });
        const isHttps = this.target.protocol === 'https:';
        const request = (isHttps ? https : http).request(
            {
                protocol: this.target.protocol,
                hostname: this.target.hostname,
                port: this.target.port || (isHttps ? 443 : 80),
                path: this.target.pathname + this.target.search,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                    [CONTROL_TOKEN_HEADER]: this.config.token
                }
            },
            response => {
                // Drain and ignore: delivery is best-effort, studio-backend
                // backfills via getOperationDeltas on reconnect.
                response.resume();
            }
        );
        // A network error must never bubble into the synchronous broadcast.
        request.on('error', () => undefined);
        request.write(body);
        request.end();
    }
}

function joinUrl(base: string, path: string): string {
    return `${base.replace(/\/+$/, '')}${path}`;
}
