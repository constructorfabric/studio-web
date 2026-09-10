/**
 * studio-documents — the journey-stage catalogue.
 *
 * The stage list used to be `JOURNEY_STAGES`, a constant in this MFE and a
 * second copy in the prototype, left behind when the `studio-project` gear was
 * retired and `GET /studio-project/v1/stages` went with it (ADR-0010). It is the
 * path a product takes through the studio, so an organization has to be able to
 * change it — which a constant in a client cannot express. ADR-0014 section 7
 * moved the catalogue back to the server.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';

export const DOCUMENTS_API_BASE_URL = '/cf/studio-documents/v1';

/**
 * One stage, as the catalogue serves it.
 *
 * What comes back is already the EFFECTIVE list for that workspace: the platform
 * catalogue, overlaid by the organization, overlaid by the workspace, tombstones
 * removed, in catalogue order. A caller must not re-sort it, and must not assume
 * `intent` is present — a workspace may have replaced it.
 */
export interface JourneyStage {
  key: string;
  label: string;
  required: boolean;
  position: number;
  /** Document-type keys this stage is not complete without. */
  requires: string[];
  /** `builtin` | `organization` | `workspace` — which level defined it. */
  owner: string;
  owner_tenant_id?: string | null;
}

export interface StageListDto {
  items: JourneyStage[];
}

export interface StagesParams {
  workspaceId: string;
}

export class DocumentsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);

    super({ baseURL: DOCUMENTS_API_BASE_URL }, restProtocol, restEndpoints);
  }

  readonly stages = this.protocol(RestEndpointProtocol).queryWith<StageListDto, StagesParams>(
    ({ workspaceId }) => `/workspaces/${workspaceId}/stages`
  );
}
