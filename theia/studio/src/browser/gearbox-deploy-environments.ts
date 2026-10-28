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
    readonly organizationId?: string;
    readonly environments: readonly StudioEnvironment[];
    readonly bound: Readonly<Record<string, string>>;
    readonly secrets?: readonly { readonly environmentId: string; readonly key: string }[];
}

/** A release as its cluster reports it now; mirrors `DeploymentStatus` there. */
export interface DeploymentStatus {
    readonly workloads: readonly { readonly name: string; readonly ready: number; readonly desired: number; readonly images: readonly string[] }[];
    readonly hosts: readonly string[];
}

/** A proposed CI build workflow; mirrors `BuildWorkflow` there. */
export interface BuildWorkflow {
    readonly path: string;
    readonly branch: string;
    readonly prUrl: string | undefined;
}

/** One build of the project's product; mirrors `ProductBuild` there. */
export interface ProductBuild {
    readonly buildId: string;
    readonly where: string;
    readonly status: 'running' | 'passed' | 'failed' | 'cancelled' | 'unknown';
    readonly product: string | undefined;
    readonly profile: string | undefined;
    readonly shortSha: string | undefined;
    readonly branch: string | undefined;
    readonly startedAt: string | undefined;
    readonly failure: string | undefined;
    readonly failureStep: string | undefined;
    readonly step: string | undefined;
    readonly chartRef: string | undefined;
    readonly chartVersion: string | undefined;
    readonly images: readonly { readonly app: string; readonly image: string }[];
}

/** One deploy the server recorded; mirrors `ProductDeployment` there. */
export interface ProductDeployment {
    readonly id: string;
    readonly environmentId: string;
    readonly environmentName: string;
    readonly namespace: string;
    readonly profile: string;
    readonly product: string;
    readonly action: string;
    readonly build: string | undefined;
    readonly chartVersion: string | undefined;
    readonly state: string;
    readonly reason: string | undefined;
    readonly requestedAt: string;
    readonly requestedBy: string | undefined;
}

/** How many builds the Deploy panel lists: the portal's Builds tab reads the same nodes. */
const BUILDS_LIMIT = 20;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * The `build` artifact nodes as builds, newest first -- as the portal's Builds
 * tab reads them (`ideBuildsOf`), so both name the same build the same way.
 * A Run is not a build of anything to deploy, so it is left out.
 */
export function buildsOf(nodes: readonly { instance_id: string; value?: Record<string, unknown> }[]): ProductBuild[] {
    const statusOf = (s: string | undefined): ProductBuild['status'] =>
        s === 'running' || s === 'passed' || s === 'failed' || s === 'cancelled' ? s : 'unknown';
    return nodes
        .map(n => ({ n, v: n.value ?? {} }))
        .filter(({ v }) => text(v.action) !== 'run')
        .map(({ n, v }): ProductBuild => {
            const chart = (v.chart ?? {}) as Record<string, unknown>;
            const commit = text(v.commit);
            return {
                buildId: text(v.build_id) ?? n.instance_id,
                where: text(v.where) ?? 'desktop',
                status: statusOf(text(v.status)),
                product: text(v.product),
                profile: text(v.profile),
                shortSha: text(v.short_sha) ?? commit?.slice(0, 7),
                branch: text(v.branch),
                startedAt: text(v.started_at),
                failure: text(v.failure),
                failureStep: text(v.failure_step),
                step: text(v.step),
                chartRef: text(chart.reference),
                chartVersion: text(chart.version),
                images: Array.isArray(v.images)
                    ? v.images.flatMap(i => {
                        const r = (i ?? {}) as Record<string, unknown>;
                        const app = text(r.app);
                        const image = text(r.image);
                        return app !== undefined && image !== undefined ? [{ app, image }] : [];
                    })
                    : [],
            };
        })
        .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
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
            organization_id?: string;
            secrets?: { environment_id: string; key: string }[];
        };
        return {
            projectId: scope.projectId,
            ...(typeof body.organization_id === 'string' ? { organizationId: body.organization_id } : {}),
            secrets: (body.secrets ?? []).map(x => ({ environmentId: x.environment_id, key: x.key })),
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

    /**
     * The project's builds -- Studio's and those IDEs reported -- with what each
     * published: the images and chart in the environment's registry a deploy
     * names. Rejects when the server could not be asked.
     */
    async builds(projectId: string): Promise<ProductBuild[]> {
        const query = new URLSearchParams({ type: 'build', scope: projectId, sort: 'updated', limit: String(BUILDS_LIMIT) });
        const res = await this.fetchApi(`/studio-artifact-ingest/v1/nodes?${query}`);
        if (!res.ok) {
            throw new Error(await refusal(res));
        }
        const body = await res.json() as { nodes?: { instance_id: string; value?: Record<string, unknown> }[] };
        return buildsOf(body.nodes ?? []);
    }

    /** The project's deploys, newest first; rejects when the server could not be asked. */
    async deployments(projectId: string): Promise<ProductDeployment[]> {
        const res = await this.fetchApi(`/studio-environments/v1/deployments?project_id=${encodeURIComponent(projectId)}`);
        if (!res.ok) {
            throw new Error(await refusal(res));
        }
        const body = await res.json() as { items?: Record<string, unknown>[] };
        return (body.items ?? [])
            .map((d): ProductDeployment => ({
                id: String(d.id),
                environmentId: String(d.environment_id),
                environmentName: text(d.environment_name) ?? String(d.environment_id),
                namespace: text(d.namespace) ?? '',
                profile: text(d.profile) ?? '',
                product: text(d.product) ?? '',
                action: text(d.action) ?? 'install',
                build: text(d.build),
                chartVersion: text(d.chart_version),
                state: text(d.state) ?? 'unknown',
                reason: text(d.reason),
                requestedAt: text(d.requested_at) ?? '',
                requestedBy: text(d.requested_by_name),
            }))
            .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    }

    /**
     * Bind `profile` to an environment. The server's PUT replaces the project's
     * whole set, so the current bindings are read first and kept -- another
     * profile's binding, and every binding's chart values, which this panel does
     * not show and must not wipe.
     */
    async bind(projectId: string, profile: string, environmentId: string): Promise<void> {
        const current = await this.fetchApi(`/studio-environments/v1/targets?project_id=${encodeURIComponent(projectId)}`);
        if (!current.ok) {
            throw new Error(await refusal(current));
        }
        const body = await current.json() as { bindings?: { profile: string; environment_id: string; values?: unknown }[] };
        const kept = (body.bindings ?? []).filter(b => b.profile !== profile);
        // The profile's own values stay with it when it moves to another environment.
        const values = (body.bindings ?? []).find(b => b.profile === profile)?.values;
        const items = [
            ...kept.map(b => ({ profile: b.profile, environment_id: b.environment_id, ...(b.values !== undefined && b.values !== null ? { values: b.values } : {}) })),
            { profile, environment_id: environmentId, ...(values !== undefined && values !== null ? { values } : {}) },
        ];
        const res = await this.fetchApi(`/studio-environments/v1/bindings?project_id=${encodeURIComponent(projectId)}`, {
            method: 'PUT',
            body: JSON.stringify({ items }),
        });
        if (!res.ok) {
            throw new Error(await refusal(res));
        }
    }

    /**
     * A deployed release's workloads and the hosts its ingresses answer on,
     * read from the environment's cluster now -- in the organization `targets`
     * named, as the portal's Environments page asks.
     */
    async status(organizationId: string, deploymentId: string): Promise<DeploymentStatus> {
        const res = await this.fetchApi(
            `/studio-environments/v1/deployments/${encodeURIComponent(deploymentId)}/status?organization_id=${encodeURIComponent(organizationId)}`,
        );
        if (!res.ok) {
            throw new Error(await refusal(res));
        }
        const body = await res.json() as { workloads?: { name?: string; ready?: number; desired?: number; images?: string[] }[]; hosts?: string[] };
        return {
            workloads: (body.workloads ?? []).map(w => ({
                name: w.name ?? '',
                ready: typeof w.ready === 'number' ? w.ready : 0,
                desired: typeof w.desired === 'number' ? w.desired : 0,
                images: Array.isArray(w.images) ? w.images.filter((i): i is string => typeof i === 'string') : [],
            })),
            hosts: (body.hosts ?? []).filter((h): h is string => typeof h === 'string'),
        };
    }

    /** Propose `.github/workflows/studio-build-<product>.yml` to the project's repository as a pull request (ADR-0048 §5). */
    async proposeBuildWorkflow(
        projectId: string,
        body: { environment_id: string; profile: string; product_file: string },
    ): Promise<BuildWorkflow> {
        const res = await this.fetchApi(`/studio-environments/v1/build-workflows?project_id=${encodeURIComponent(projectId)}`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(await refusal(res));
        }
        const answer = await res.json() as { path: string; branch: string; pr_url?: string | null };
        return { path: answer.path, branch: answer.branch, prUrl: text(answer.pr_url ?? undefined) };
    }

    /**
     * Set a secret of the release's configuration in one environment, or remove
     * it (`value` undefined). The value goes to credstore and never comes back.
     */
    async configSecret(projectId: string, environmentId: string, key: string, value: string | undefined): Promise<void> {
        const query = new URLSearchParams({ project_id: projectId, environment_id: environmentId });
        const res = await this.fetchApi(`/studio-environments/v1/config-secrets/${encodeURIComponent(key)}?${query}`,
            value === undefined ? { method: 'DELETE' } : { method: 'PUT', body: JSON.stringify({ value }) });
        if (!res.ok) {
            throw new Error(await refusal(res));
        }
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
