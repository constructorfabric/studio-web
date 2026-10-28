/**
 * studio-documents — the journey-stage catalogue, and a project's specs.
 *
 * The stage list used to be `JOURNEY_STAGES`, a constant in this MFE and a
 * second copy in the prototype, left behind when the `studio-project` gear was
 * retired and `GET /studio-project/v1/stages` went with it (ADR-0010). It is the
 * path a product takes through the studio, so an organization has to be able to
 * change it — which a constant in a client cannot express. ADR-0014 section 7
 * moved the catalogue back to the server.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type {
  AnalyzeBindingsRequest,
  AnalyzeEnqueuedDto,
  CreateDocumentDto,
  DecideBindingDto,
  DocumentBindingDto,
  DocumentDto,
  DocumentListDto,
  DocumentTypeListDto,
  QualityDetector,
  SpecRowListDto,
  SpecsPerSourceListDto,
  StageListDto,
} from './documentTypes';
import { IdempotencyKeyPlugin } from './idempotencyKeyPlugin';

export const DOCUMENTS_API_BASE_URL = '/cf/studio-documents/v1';

export interface StagesParams {
  workspaceId: string;
}

export interface ProjectParams {
  workspaceId: string;
  projectId: string;
}

export interface ProjectDocumentsParams extends ProjectParams {
  limit?: number;
  offset?: number;
}

const QUALITY_RUN = new RegExp(
  `^${DOCUMENTS_API_BASE_URL}/workspaces/[^/]+/projects/[^/]+/quality/[^/?]+(\\?.*)?$`
);

/** Whether a request URL, as the plugins see it (base included), starts a quality run. */
export function startsQualityRun(url: string): boolean {
  return QUALITY_RUN.test(url);
}

function projectDocumentsPath({
  workspaceId,
  projectId,
  limit,
  offset,
}: ProjectDocumentsParams): string {
  const path = `/workspaces/${workspaceId}/projects/${projectId}/documents`;
  const query = new URLSearchParams();
  if (limit !== undefined) query.set('limit', String(limit));
  if (offset !== undefined) query.set('offset', String(offset));
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

export class DocumentsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    // `POST …/quality/{detector}` starts a run (202 + run_id): its retry must answer that run.
    restProtocol.plugins.add(new IdempotencyKeyPlugin(startsQualityRun));

    super({ baseURL: DOCUMENTS_API_BASE_URL }, restProtocol, restEndpoints);
  }

  readonly stages = this.protocol(RestEndpointProtocol).queryWith<StageListDto, StagesParams>(
    ({ workspaceId }) => `/workspaces/${workspaceId}/stages`
  );

  /** The workspace's effective document types. */
  readonly types = this.protocol(RestEndpointProtocol).queryWith<
    DocumentTypeListDto,
    { workspaceId: string }
  >(({ workspaceId }) => `/workspaces/${workspaceId}/types`);

  /** Every spec of the project, repository files and documents written in Studio alike. */
  readonly specRows = this.protocol(RestEndpointProtocol).queryWith<
    SpecRowListDto,
    { projectId: string }
  >(({ projectId }) => `/spec-rows?${new URLSearchParams({ project_id: projectId })}`);

  /** Specs per repository of a workspace or project, keyed by repo node id. */
  readonly specsPerSource = this.protocol(RestEndpointProtocol).queryWith<
    SpecsPerSourceListDto,
    { scope: string }
  >(({ scope }) => `/specs-per-source?${new URLSearchParams({ scope })}`);

  /** A project's documents, its own and the workspace's, newest `updated_at` first. */
  readonly projectDocuments = this.protocol(RestEndpointProtocol).queryWith<
    DocumentListDto,
    ProjectDocumentsParams
  >(projectDocumentsPath);

  /** A document written in Studio. Its type is fixed: `PUT …/documents/{id}` takes none. */
  createDocument({ workspaceId, projectId }: ProjectParams) {
    return this.protocol(RestEndpointProtocol).mutation<DocumentDto, CreateDocumentDto>(
      'POST',
      projectDocumentsPath({ workspaceId, projectId })
    );
  }

  /** A person's decision on a repository file's type. */
  decideBinding({ workspaceId, bindingId }: { workspaceId: string; bindingId: string }) {
    return this.protocol(RestEndpointProtocol).mutation<DocumentBindingDto, DecideBindingDto>(
      'PUT',
      `/workspaces/${workspaceId}/document-bindings/${bindingId}`
    );
  }

  /**
   * Starts a Spec Quality run of one detector over the named bindings and
   * documents. The run records its verdicts itself.
   */
  analyze({ workspaceId, projectId, detector }: ProjectParams & { detector: QualityDetector }) {
    return this.protocol(RestEndpointProtocol).mutation<AnalyzeEnqueuedDto, AnalyzeBindingsRequest>(
      'POST',
      `/workspaces/${workspaceId}/projects/${projectId}/quality/${detector}`
    );
  }
}
