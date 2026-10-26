import { FRONTX_SCREEN_DOMAIN, type ChildMfeBridge } from '@gears-frontx/react';
import {
  STUDIO_ACTION_ARTIFACT_OPEN,
  sendAndForget,
  type StudioArtifactKind,
} from '@constructor-studio/mfe-shared';
import type { ArtifactRow } from '../model/artifact';
import type { SpecRow } from '../model/specRows';

/** What the shell opens: an artifact-gear node, or a Studio document (#694). */
export type OpenableArtifact = Pick<ArtifactRow, 'id' | 'repository' | 'path'> & {
  kind: StudioArtifactKind | null;
};

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-open-request:p1
export function requestOpenArtifact(
  bridge: ChildMfeBridge | null,
  projectId: string,
  row: OpenableArtifact
): void {
  if (row.kind === null) return;
  sendAndForget(
    bridge,
    {
      type: STUDIO_ACTION_ARTIFACT_OPEN,
      target: FRONTX_SCREEN_DOMAIN,
      payload: {
        projectId,
        artifactId: row.id,
        repository: row.repository,
        path: row.path,
        kind: row.kind,
      },
    },
    'projects'
  );
}

/** A Specs row (#692): a repository file by its node, a Studio document by its id, its title where a file has its path. */
export function requestOpenSpec(bridge: ChildMfeBridge | null, projectId: string, row: SpecRow): void {
  const { open } = row;
  if (!open) return;
  requestOpenArtifact(
    bridge,
    projectId,
    open.kind === 'file'
      ? { id: open.nodeId, repository: open.repository, path: open.path, kind: 'file' }
      : { id: open.documentId, repository: '', path: row.name, kind: 'document' }
  );
}
