import { StudioApi } from './studio-api';
import type { AnalyzeScope } from './analyze-studio-client';
import { foldersAbove } from './gearbox-deploy-environments';

/**
 * The key gearbox-studio's Build and Run report a build under
 * (`BuildReports` there, ADR-0045 phase 2). A `Symbol.for` key, so this
 * extension binds it without importing gearbox-studio; the report's shape
 * mirrors its `common/build-report.ts`.
 */
export const GEARBOX_BUILD_REPORTS = Symbol.for('gearbox-studio.BuildReports');

/** One report, as gearbox-studio hands it over: everything but `where`. */
export interface IdeBuildReport {
    readonly build_id: string;
    readonly action: 'build' | 'run';
    readonly status: 'running' | 'passed' | 'failed' | 'cancelled';
    readonly product: string;
    readonly profile?: string;
    readonly commit?: string;
    readonly started_at: string;
    readonly finished_at?: string;
    readonly failure?: string;
    readonly failure_step?: string;
    readonly images?: readonly { readonly app: string; readonly image: string }[];
    readonly chart_ref?: string;
    readonly chart_version?: string;
}

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;
type Scope = (roots: readonly string[]) => Promise<AnalyzeScope | undefined>;

/**
 * Sends Build and Run's reports to the project the product's folder was
 * opened for: `POST /studio-artifact-ingest/v1/builds?project_id=`, with
 * where the build ran. A product outside a Studio project, or a member signed
 * out, reports nothing; a refusal is thrown with the server's words, and the
 * caller only logs it.
 */
export class BuildReports {
    constructor(
        protected readonly scope: Scope,
        protected readonly desktop: () => Promise<boolean>,
        protected readonly fetchApi: Fetch = (path, init) => StudioApi.fetch(path, init),
    ) { }

    async report(file: string, report: IdeBuildReport): Promise<void> {
        const scope = await this.scope(foldersAbove(file));
        if (scope?.kind !== 'project') {
            return;
        }
        const where = (await this.desktop()) ? 'desktop' : 'session';
        const res = await this.fetchApi(`/studio-artifact-ingest/v1/builds?project_id=${encodeURIComponent(scope.projectId)}`, {
            method: 'POST',
            body: JSON.stringify({ ...report, where }),
        });
        if (!res.ok) {
            throw new Error(`the Studio server did not take the build report (HTTP ${res.status})`);
        }
    }
}
