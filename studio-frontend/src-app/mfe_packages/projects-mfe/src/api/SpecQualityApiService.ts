/** studio-spec-quality — whether documents can be checked at all */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';

export const SPEC_QUALITY_API_BASE_URL = '/cf/studio-spec-quality/v1';

/** Mirrors `SpecQualityStatusDto`. Nothing secret: only whether each part is set. */
export interface SpecQualityStatusDto {
  /** Both the upstream's base URL and its key are set. */
  configured: boolean;
  base_url_set: boolean;
  key_set: boolean;
}

export class SpecQualityApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);

    super({ baseURL: SPEC_QUALITY_API_BASE_URL }, restProtocol, restEndpoints);
  }

  readonly status = this.protocol(RestEndpointProtocol).query<SpecQualityStatusDto>('/status');
}
