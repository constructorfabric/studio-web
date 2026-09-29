/** The MFE -> shell channel */

import type { ChildMfeBridge } from '@gears-frontx/react';

/** Screen domain: `kind: opened | closed | section`. */
export const STUDIO_ACTION_CONTEXT_PUBLISH =
  'gts.frontx.mfes.comm.action.v1~constructor_studio.context.projects.publish.v1~';

/** Screen or overlay domain: `kind: created | selected | scoped`. */
export const STUDIO_ACTION_WORKSPACES_PUBLISH =
  'gts.frontx.mfes.comm.action.v1~constructor_studio.context.workspaces.publish.v1~';

/**
 * Screen domain: a member asked to open one artifact. The MFE says which; the
 * shell answers with `STUDIO_SHARED_PROPERTY_CONTEXT_ARTIFACT` (#320).
 */
export const STUDIO_ACTION_ARTIFACT_OPEN =
  'gts.frontx.mfes.comm.action.v1~constructor_studio.context.artifact.open.v1~';

export const STUDIO_ARTIFACT_KINDS = [
  'repo',
  'file',
  'issue',
  'pullRequest',
  'commit',
  'comment',
  'user',
] as const;

export type StudioArtifactKind = (typeof STUDIO_ARTIFACT_KINDS)[number];

const ARTIFACT_KINDS: ReadonlySet<string> = new Set(STUDIO_ARTIFACT_KINDS);

export function isStudioArtifactKind(value: unknown): value is StudioArtifactKind {
  return typeof value === 'string' && ARTIFACT_KINDS.has(value);
}

export interface StudioArtifact {
  artifactId: string;
  repository: string;
  path: string;
  kind: StudioArtifactKind;
}

/** A request to open an artifact: the artifact and the project it sits in. */
export type StudioArtifactRequest = StudioArtifact & { projectId: string };

/** projects-mfe's New workspace overlay, opened from organization-mfe as well. */
export const STUDIO_EXTENSION_WORKSPACE_CREATE =
  'gts.frontx.mfes.ext.extension.v1~frontx.screensets.layout.overlay.v1~constructor_studio.overlays.workspace_create.main.v1';

export interface HostAction {
  type: string;
  target: string;
  payload: Record<string, unknown>;
}

export function sendToHost(bridge: ChildMfeBridge | null, action: HostAction): Promise<void> {
  if (!bridge) return Promise.reject(new Error(`no MFE bridge for ${action.type}`));
  return bridge.executeActionsChain({ action }).then(() => undefined);
}

export function sendAndForget(bridge: ChildMfeBridge | null, action: HostAction, tag: string): void {
  if (!bridge) return;
  void sendToHost(bridge, action).catch((error: unknown) => {
    console.error(`[${tag}] host action failed`, action.type, error);
  });
}
