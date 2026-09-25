// The Studio calls behind the Analyze panel.
//
// Everything goes through `StudioApi`, i.e. `studio-api/<gear path>`: in a
// hosted session the session gate forwards that with the portal's token, and
// in the desktop app the IDE's own backend is the gate and attaches the
// member's (`configure()` in `node/desktop-studio-contribution.ts`). The panel
// therefore never knows which of the two it runs in, except in one place —
// finding out which project it is looking at, which the two learn differently
// (see `scope`).
//
// Kept apart from the controller so the controller's tests can stub Studio
// with a plain object, and so this file can be read as the list of routes the
// panel depends on.

import { injectable } from '@theia/core/shared/inversify';
import { Endpoint } from '@theia/core/lib/browser/endpoint';
import { StudioApi } from './studio-api';
import type { ConformanceReport, SpecFinding } from './analyze-metrics';

export type SpecDetector = 'purpose' | 'leak' | 'bloat' | 'traceability';

/** Which tenants the window is working in. */
export type AnalyzeScope =
    /** A project session: its own documents, under its parent workspace. */
    | { readonly kind: 'project'; readonly workspaceId: string; readonly projectId: string }
    /** A workspace session sees every project under it; a file belongs to
     *  whichever of them has a binding for it. */
    | { readonly kind: 'workspace'; readonly workspaceId: string; readonly projectIds: readonly string[] };

/** A repository file as the documents gear records it (`DocumentBindingDto`). */
export interface DocumentBinding {
    readonly id: string;
    readonly project_id?: string | null;
    readonly node_id: string;
    readonly path: string;
    readonly type_key?: string | null;
    readonly state: string;
    readonly conforms?: boolean | null;
    readonly validation?: Omit<ConformanceReport, 'checkedAt'> | null;
    readonly updated_at: string;
}

/** A document written in Studio (`DocumentDto`), the fields the panel reads. */
export interface StudioDocument {
    readonly id: string;
    readonly project_id?: string | null;
    readonly type_key: string;
    readonly title: string;
    readonly updated_at: string;
}

/** A studio-tasks run (`RunDto`), the fields the panel reads. */
export interface TaskRun {
    readonly id: string;
    /** `queued` | `running` | `succeeded` | `failed` | `cancelled`. */
    readonly state: string;
    readonly progress?: string | null;
    readonly result?: { readonly items?: readonly RunItem[] } | null;
    readonly last_error?: string | null;
}

/** One document's place in a detector run's result. */
export interface RunItem {
    readonly id: string;
    readonly task_id?: string | null;
    readonly status: string;
    readonly error?: string | null;
}

/** A detector's answer, as the backend reads it (`VerdictDto`). */
export interface SpecVerdict {
    readonly doc_type?: string | null;
    readonly spec_share?: number | null;
    readonly gate_passed?: boolean | null;
    readonly passed?: boolean | null;
    readonly leak_share?: number | null;
    readonly foreign_roles?: string[] | null;
    readonly by_path?: Record<string, string[]> | null;
    readonly recognised?: boolean | null;
}

/** A text sent with the run, because the server's copy is not the one on screen. */
export interface InlineDocument {
    readonly path: string;
    readonly text: string;
    readonly type_key?: string;
}

export interface FindingToSave {
    readonly detector: SpecDetector;
    readonly subject: string;
    readonly path: string;
    readonly severity: string;
    readonly summary: string;
    readonly score?: number;
    readonly details?: Record<string, unknown>;
}

/** A request Studio refused or could not answer, with what it said. */
export class StudioRequestError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = 'StudioRequestError';
    }
}

/** The documents gear clamps a page at 200; a cache this short only saves
 *  re-reading the same list while somebody flips between tabs. */
const CACHE_MS = 60_000;

const PROJECT_TYPE = /cf\.studio\.tenant\.project\.v1/;
const WORKSPACE_TYPE = /cf\.studio\.tenant\.workspace\.v1/;

@injectable()
export class AnalyzeStudioClient {
    protected readonly scopes = new Map<string, AnalyzeScope>();
    protected readonly bindingCache = new Map<string, { readonly at: number; readonly items: Promise<DocumentBinding[]> }>();
    protected readonly findingCache = new Map<string, { readonly at: number; readonly items: Promise<SpecFinding[]> }>();

    /**
     * The tenants this window works in, or `undefined` when nothing says.
     *
     * A hosted session is told by the portal's handshake (`studio.init`
     * `workspaceId`, kept as `StudioApi.scope`) — which names the tenant the
     * session was opened for, a project or a workspace. The desktop app has no
     * handshake; its backend remembers which tenant each folder was opened for
     * (`GET /studio-desktop/opened`). Either way the tenant's own record says
     * which kind it is and, for a project, its parent workspace — where the
     * documents gear keeps the project's bindings.
     */
    async scope(rootFsPaths: readonly string[]): Promise<AnalyzeScope | undefined> {
        const tenantId = StudioApi.scope || await this.desktopTenant(rootFsPaths);
        if (!tenantId) {
            return undefined;
        }
        const known = this.scopes.get(tenantId);
        if (known) {
            return known;
        }
        const res = await StudioApi.fetch(`/account-management/v1/tenants/${encodeURIComponent(tenantId)}`);
        if (!res.ok) {
            // Not cached: a session whose token has not arrived yet asks again
            // on the next document, and by then it may have one.
            return undefined;
        }
        const tenant = await res.json() as { id: string; tenant_type?: string; parent_id?: string | null };
        let scope: AnalyzeScope | undefined;
        if (PROJECT_TYPE.test(tenant.tenant_type ?? '') && tenant.parent_id) {
            scope = { kind: 'project', workspaceId: tenant.parent_id, projectId: tenantId };
        } else if (WORKSPACE_TYPE.test(tenant.tenant_type ?? '')) {
            const children = await StudioApi.fetch(`/account-management/v1/tenants/${encodeURIComponent(tenantId)}/children`);
            const items = children.ok ? ((await children.json()).items ?? []) as { id: string; tenant_type?: string }[] : [];
            scope = {
                kind: 'workspace',
                workspaceId: tenantId,
                projectIds: items.filter(t => PROJECT_TYPE.test(t.tenant_type ?? '')).map(t => t.id),
            };
        }
        if (scope) {
            this.scopes.set(tenantId, scope);
        }
        return scope;
    }

    /** The desktop backend's answer for the first root it knows; nothing in a
     *  hosted session, where the route does not exist. */
    protected async desktopTenant(rootFsPaths: readonly string[]): Promise<string | undefined> {
        for (const root of rootFsPaths) {
            try {
                const url = new Endpoint({ path: 'studio-desktop/opened' }).getRestUrl().toString();
                const res = await fetch(`${url}?root=${encodeURIComponent(root)}`);
                if (res.ok) {
                    const body = await res.json() as { tenantId?: string };
                    if (body.tenantId) {
                        return body.tenantId;
                    }
                }
            } catch {
                // No desktop backend to ask.
            }
        }
        return undefined;
    }

    /** Every binding the project sees, paged to `total`. */
    bindings(workspaceId: string, projectId: string): Promise<DocumentBinding[]> {
        const key = `${workspaceId}/${projectId}`;
        const held = this.bindingCache.get(key);
        if (held && Date.now() - held.at < CACHE_MS) {
            return held.items;
        }
        const items = StudioApi.fetchAllPages<DocumentBinding>(
            `/studio-documents/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/document-bindings`,
            'items',
        );
        // A failed read must not be remembered as the answer.
        items.catch(() => this.bindingCache.delete(key));
        this.bindingCache.set(key, { at: Date.now(), items });
        return items;
    }

    async studioDocument(workspaceId: string, documentId: string): Promise<StudioDocument | undefined> {
        const res = await StudioApi.fetch(
            `/studio-documents/v1/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(documentId)}`,
        );
        if (res.status === 404) {
            return undefined;
        }
        return readJson<StudioDocument>(res);
    }

    /** The template check the portal runs for a document written in Studio. */
    async validateStudioDocument(workspaceId: string, documentId: string): Promise<Omit<ConformanceReport, 'checkedAt'>> {
        const res = await StudioApi.fetch(
            `/studio-documents/v1/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(documentId)}/validate`,
            { method: 'POST' },
        );
        return readJson(res);
    }

    /** The findings recorded for one document in a project. */
    async findings(projectId: string, subject: string): Promise<SpecFinding[]> {
        const all = await this.projectFindings(projectId);
        return all.filter(finding => finding.subject === subject);
    }

    protected projectFindings(projectId: string): Promise<SpecFinding[]> {
        const held = this.findingCache.get(projectId);
        if (held && Date.now() - held.at < CACHE_MS) {
            return held.items;
        }
        const items = StudioApi.fetchAllPages<{ value?: Record<string, unknown> }>(
            `/studio-artifact-ingest/v1/nodes?type=spec_finding&scope=${encodeURIComponent(projectId)}`,
            'nodes',
        ).then(nodes => nodes.map(node => toFinding(node.value)).filter((f): f is SpecFinding => f !== undefined));
        items.catch(() => this.findingCache.delete(projectId));
        this.findingCache.set(projectId, { at: Date.now(), items });
        return items;
    }

    /** Forget what a run has just changed. */
    invalidate(workspaceId: string, projectId: string): void {
        this.findingCache.delete(projectId);
        this.bindingCache.delete(`${workspaceId}/${projectId}`);
    }

    /** Start one detector over the named bindings and the texts sent with it. */
    async startRun(
        workspaceId: string,
        projectId: string,
        detector: SpecDetector,
        body: { readonly binding_ids: readonly string[]; readonly documents: readonly InlineDocument[] },
    ): Promise<{ run_id: string }> {
        const res = await StudioApi.fetch(
            `/studio-documents/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}` +
            `/quality/${detector}`,
            { method: 'POST', body: JSON.stringify(body) },
        );
        return readJson(res);
    }

    async run(runId: string): Promise<TaskRun> {
        return readJson(await StudioApi.fetch(`/studio-tasks/v1/runs/${encodeURIComponent(runId)}`));
    }

    /** One analysis, as the backend reads it. `paths` is required by the set
     *  detectors: a document absent from it is absent from the answer. */
    async verdict(taskId: string, detector: SpecDetector, paths: readonly string[] = []): Promise<SpecVerdict> {
        const query = new URLSearchParams({ task_id: taskId, detector });
        for (const path of paths) {
            query.append('path', path);
        }
        return readJson(await StudioApi.fetch(`/studio-spec-quality/v1/verdicts?${query.toString()}`));
    }

    async saveFindings(findings: readonly FindingToSave[], workspaceId: string, projectId: string): Promise<void> {
        await readJson(await StudioApi.fetch('/studio-artifact-ingest/v1/quality', {
            method: 'POST',
            body: JSON.stringify({ findings, workspace_id: workspaceId, project_id: projectId }),
        }));
    }

    /** The pass/fail a stage gate reads, kept on a repository file's binding. */
    async recordBindingAnalysis(
        workspaceId: string,
        bindingId: string,
        detector: SpecDetector,
        body: { readonly state: 'pending' | 'passed' | 'failed'; readonly task_id?: string; readonly summary?: string },
    ): Promise<void> {
        await readJson(await StudioApi.fetch(
            `/studio-documents/v1/workspaces/${encodeURIComponent(workspaceId)}/document-bindings/${encodeURIComponent(bindingId)}` +
            `/analyses/${detector}`,
            { method: 'PUT', body: JSON.stringify(body) },
        ));
    }
}

/** The body of a good answer, or what Studio said was wrong with the request. */
async function readJson<T>(res: Response): Promise<T> {
    if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
            const problem = await res.json() as { detail?: string; title?: string; error?: string; message?: string };
            message = problem.detail || problem.error || problem.message || problem.title || message;
        } catch {
            // Not a problem document; the status is all there is.
        }
        throw new StudioRequestError(res.status, message);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
}

/** A `spec_finding` node's payload as a finding, or nothing if it is not one. */
export function toFinding(value: Record<string, unknown> | undefined): SpecFinding | undefined {
    if (!value || typeof value.detector !== 'string' || typeof value.subject !== 'string') {
        return undefined;
    }
    return {
        detector: value.detector,
        subject: value.subject,
        path: typeof value.path === 'string' ? value.path : undefined,
        severity: typeof value.severity === 'string' ? value.severity : undefined,
        summary: typeof value.summary === 'string' ? value.summary : undefined,
        score: typeof value.score === 'number' ? value.score : undefined,
        details: value.details && typeof value.details === 'object' && !Array.isArray(value.details)
            ? value.details as Record<string, unknown>
            : undefined,
        recordedAt: typeof value.recorded_at === 'string' ? value.recorded_at : undefined,
    };
}

/**
 * The paths a file might be known by, most specific first.
 *
 * A binding's path is relative to its repository, and the window's root is
 * not always one: a managed session clones each source into a folder under
 * `/workspace`, so `api/docs/prd.md` on screen is `docs/prd.md` to Studio.
 * Which ancestor is the repository is not something the panel can see, so it
 * tries the whole relative path first — right when the root IS the
 * repository — and then drops one leading folder at a time.
 */
export function pathCandidates(relativePath: string): string[] {
    const segments = relativePath.split('/').filter(segment => segment.length > 0);
    return segments.map((_, index) => segments.slice(index).join('/'));
}

export type BindingMatch =
    | { readonly kind: 'found'; readonly binding: DocumentBinding }
    | { readonly kind: 'ambiguous'; readonly path: string; readonly count: number }
    | { readonly kind: 'none' };

/**
 * The binding a file on screen is, by path.
 *
 * The first candidate any binding answers to decides. Two bindings at that one
 * path — the same `README.md` in two repositories — cannot be told apart from
 * here, and saying so beats recording one document's verdict on the other.
 */
export function matchBindingByPath(bindings: readonly DocumentBinding[], candidates: readonly string[]): BindingMatch {
    for (const candidate of candidates) {
        const hits = bindings.filter(binding => binding.path === candidate);
        if (hits.length === 1) {
            return { kind: 'found', binding: hits[0] };
        }
        if (hits.length > 1) {
            return { kind: 'ambiguous', path: candidate, count: hits.length };
        }
    }
    return { kind: 'none' };
}
