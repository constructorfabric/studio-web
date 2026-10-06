/**
 * studio-tasks — the background run a repository sync is.
 *
 * `POST /sync` answers the run's id; this is where the run is read. The host
 * has its own copy of this service, but an MFE registers the services it uses.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';

export const STUDIO_TASKS_API_BASE_URL = '/cf/studio-tasks/v1';

export type TaskRunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** The part of `RunDto` a poller reads. */
export interface TaskRunDto {
  id: string;
  state: TaskRunState;
  /** The phase the handler last reported. */
  progress: string | null;
  /** One line about what it did, once it succeeded. */
  summary: string | null;
  /** The handler's counts; its shape belongs to the task type. */
  result: Record<string, unknown> | null;
  last_error: string | null;
}

export class StudioTasksApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);

    super({ baseURL: STUDIO_TASKS_API_BASE_URL }, restProtocol, restEndpoints);
  }

  /** Read with `staleTime: 0`: the shared cache would answer one state per 30 s. */
  readonly run = this.protocol(RestEndpointProtocol).queryWith<TaskRunDto, { runId: string }>(
    ({ runId }) => `/runs/${encodeURIComponent(runId)}`
  );
}
