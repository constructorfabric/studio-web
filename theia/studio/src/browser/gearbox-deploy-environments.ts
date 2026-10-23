import { StudioApi } from './studio-api';
import type { AnalyzeScope } from './analyze-studio-client';

/**
 * The key gearbox-studio's Generate view asks for the organization's
 * deployment environments under (`DeployEnvironmentsSource` there, ADR-0043).
 * A `Symbol.for` key, so this extension binds it without importing
 * gearbox-studio; the shapes below mirror its `common/deploy-product.ts`.
 */
export const GEARBOX_DEPLOY_ENVIRONMENTS = Symbol.for('gearbox-studio.DeployEnvironmentsSource');

export interface StudioEnvironment {
    readonly id: string;
    readonly name: string;
    readonly namespace: string;
    readonly registry: string;
    readonly protected: boolean;
    readonly registryLogin?: boolean;
}

export interface DeployTargets {
    readonly projectId: string;
    readonly environments: readonly StudioEnvironment[];
    readonly bound: Readonly<Record<string, string>>;
}

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;
type Scope = (roots: readonly string[]) => Promise<AnalyzeScope | undefined>;

/**
 * Every folder `file` is in, nearest first: the candidates for the folder the
 * desktop opened the project in (`GET /studio-desktop/opened?root=`), which
 * is some ancestor of the product's `product.gdl`.
 */
export function foldersAbove(file: string): string[] {
    const sep = file.includes('\\') && !file.includes('/') ? '\\' : '/';
    const parts = file.split(/[\\/]/);
    const out: string[] = [];
    for (let n = parts.length - 1; n > 0; n--) {
        const folder = parts.slice(0, n).join(sep);
        if (folder !== '' && !/^[A-Za-z]:$/.test(folder)) {
            out.push(folder);
        }
    }
    return out;
}

/** The server's words in a refusal: its problem's `detail`, else the status. */
async function refusal(res: Response): Promise<string> {
    try {
        const body = await res.json() as { detail?: string; title?: string; reason?: string };
        return body.detail ?? body.reason ?? body.title ?? `HTTP ${res.status}`;
    } catch {
        return `HTTP ${res.status}`;
    }
}

export class DeployEnvironments {
    constructor(
        protected readonly scope: Scope,
        protected readonly fetchApi: Fetch = (path, init) => StudioApi.fetch(path, init),
    ) { }

    /** Where the product at `file` can be deployed; undefined outside a Studio project or signed out. */
    async targets(file: string): Promise<DeployTargets | undefined> {
        const scope = await this.scope(foldersAbove(file));
        if (scope?.kind !== 'project') {
            return undefined;
        }
        const res = await this.fetchApi(`/studio-environments/v1/targets?project_id=${encodeURIComponent(scope.projectId)}`);
        if (!res.ok) {
            return undefined;
        }
        const body = await res.json() as {
            environments?: {
                environment: { id: string; name: string; registry?: string; protected?: boolean; registry_connection_id?: string | null };
                namespace: string;
            }[];
            bindings?: { profile: string; environment_id: string }[];
        };
        return {
            projectId: scope.projectId,
            environments: (body.environments ?? []).map(t => ({
                id: t.environment.id,
                name: t.environment.name,
                namespace: t.namespace,
                registry: t.environment.registry ?? '',
                protected: t.environment.protected === true,
                registryLogin: typeof t.environment.registry_connection_id === 'string' && t.environment.registry_connection_id !== '',
            })),
            bound: Object.fromEntries((body.bindings ?? []).map(b => [b.profile, b.environment_id])),
        };
    }

    /** Build the product in the environment's cluster (ADR-0048 §9); rejects with what the server said. */
    async startBuild(
        projectId: string,
        body: { environment_id: string; profile: string; product_file: string; ref?: string },
    ): Promise<{ build_id: string; namespace: string }> {
        const res = await this.fetchApi(`/studio-environments/v1/builds?project_id=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(await refusal(res));
        }
        return await res.json() as { build_id: string; namespace: string };
    }

    /** A push-only token for `repositories` under the environment's registry (ADR-0048); rejects with what the server said. */
    async pushToken(
        projectId: string,
        environmentId: string,
        repositories: readonly string[],
    ): Promise<{ registry: string; prefix: string; token: string; expires_in?: number | null }> {
        const res = await this.fetchApi(
            `/studio-environments/v1/environments/${encodeURIComponent(environmentId)}/push-tokens?project_id=${encodeURIComponent(projectId)}`,
            { method: 'POST', body: JSON.stringify({ repositories }) },
        );
        if (!res.ok) {
            throw new Error(await refusal(res));
        }
        return await res.json() as { registry: string; prefix: string; token: string; expires_in?: number | null };
    }

    /** Ask the server to deploy; rejects with what it said. */
    async requestDeploy(projectId: string, body: unknown): Promise<{ state: string; environment_name: string; namespace: string }> {
        const res = await this.fetchApi(`/studio-environments/v1/deployments?project_id=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(await refusal(res));
        }
        return await res.json() as { state: string; environment_name: string; namespace: string };
    }
}
