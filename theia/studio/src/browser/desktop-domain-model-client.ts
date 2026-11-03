// The Studio calls behind the desktop's Domain model view: the documents
// gear's spec-model routes, the ones the portal's project tab Domain model
// reads (`studio-frontend-prototype/src/api.ts`, `specModel*`). Through
// `StudioApi`, so the desktop backend's `/studio-api` proxy attaches the
// member's token; this file is the list of routes the view depends on.

import { injectable } from '@theia/core/shared/inversify';
import { STUDIO_SIGNED_OUT, StudioApi } from './studio-api';
import type {
    DomainModel, DomainModelBuild, DomainModelFinding, FindingDecision, GlossaryEntry
} from '../common/desktop-domain-model';

const MODEL = '/studio-documents/v1/spec-model';

@injectable()
export class DesktopDomainModelClient {

    /** The facts of every document at its current revision, where each
     *  document stands, and the build as the server knows it. */
    model(projectId: string): Promise<DomainModel> {
        return this.get(`${MODEL}?project_id=${encodeURIComponent(projectId)}`);
    }

    /** Where the documents disagree, or refer to what is not there, with each
     *  finding's decision. */
    async findings(projectId: string): Promise<DomainModelFinding[]> {
        return (await this.get<{ items: DomainModelFinding[] }>(`${MODEL}/findings?project_id=${encodeURIComponent(projectId)}`)).items;
    }

    /** The names the documents use, as members decided them. A server
     *  without a glossary answers nothing, not an error: the view still has
     *  the model. */
    async glossary(projectId: string): Promise<GlossaryEntry[]> {
        try {
            return (await this.get<{ items: GlossaryEntry[] }>(`${MODEL}/glossary?project_id=${encodeURIComponent(projectId)}`)).items;
        } catch (error) {
            if (error instanceof DomainModelError && error.status === 404) {
                return [];
            }
            throw error;
        }
    }

    /** Read every document not read at its revision, or with `path` that one
     *  again, on the caller's own model key. A build already running is
     *  answered with its state. */
    startBuild(projectId: string, path?: string): Promise<DomainModelBuild> {
        return this.post(`${MODEL}/builds`, path ? { project_id: projectId, path } : { project_id: projectId });
    }

    decide(projectId: string, fingerprint: string, decision: FindingDecision): Promise<unknown> {
        return this.post(`${MODEL}/findings/${encodeURIComponent(fingerprint)}/decision`, { project_id: projectId, decision });
    }

    protected async get<T>(path: string): Promise<T> {
        return readJson<T>(await StudioApi.fetch(path));
    }

    protected async post<T>(path: string, body: unknown): Promise<T> {
        return readJson<T>(await StudioApi.fetch(path, { method: 'POST', body: JSON.stringify(body) }));
    }
}

/** A spec-model call that did not answer 2xx: its status, the `reason` the
 *  desktop proxy names (`signed-out`), and the gear's own `detail`. */
export class DomainModelError extends Error {
    constructor(readonly status: number, readonly reason?: string, readonly detail?: string) {
        super(detail || `HTTP ${status}`);
        this.name = 'DomainModelError';
    }
}

async function readJson<T>(res: Response): Promise<T> {
    if (!res.ok) {
        let body: { reason?: unknown; detail?: unknown; title?: unknown } | undefined;
        try {
            body = await res.json();
        } catch {
            // Not JSON, or no body: the status is all there is.
        }
        const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
        throw new DomainModelError(res.status, text(body?.reason), text(body?.detail) ?? text(body?.title));
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
}

/** What a failed call says to a member: the gear's own words when it gave
 *  them (a build refused for want of a model key says why), else what the
 *  status means here. */
export function failureText(error: unknown): string {
    if (error instanceof DomainModelError) {
        if (error.reason === STUDIO_SIGNED_OUT) {
            return 'Sign in to Constructor Studio (the Studio view) to see the project\'s domain model.';
        }
        if (error.detail) {
            return error.detail;
        }
        if (error.status === 403) {
            return 'Studio refused: you are not a member of this project, or your role cannot do this.';
        }
        if (error.status === 404) {
            return 'This Studio has no domain model for the project: an older server, or the project is gone.';
        }
        return `Studio answered ${error.status}${error.reason ? ` (${error.reason})` : ''}.`;
    }
    return error instanceof Error ? error.message : String(error);
}
