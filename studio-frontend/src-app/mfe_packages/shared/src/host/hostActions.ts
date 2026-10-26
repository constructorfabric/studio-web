/** The MFE -> shell channel */

import {
  FRONTX_ACTION_MOUNT_EXT,
  FRONTX_ACTION_UNMOUNT_EXT,
  FRONTX_OVERLAY_DOMAIN,
  FRONTX_SCREEN_DOMAIN,
  type ChildMfeBridge,
} from '@gears-frontx/react';

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
  /** A Studio document (`studio-documents`), not a node of the artifact gear: its title rides in `path`. */
  'document',
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

/**
 * Screen domain: a toast. The shell owns the only toaster, so an MFE asks for
 * one; the text comes already in the user's language, since the dictionary is
 * the MFE's.
 */
export const STUDIO_ACTION_NOTIFY =
  'gts.frontx.mfes.comm.action.v1~constructor_studio.shell.notification.show.v1~';

/** `loading` stays up until a notice with its `id` replaces it, so a `loading` notice needs an `id`. */
export const STUDIO_NOTICE_KINDS = ['error', 'success', 'info', 'loading'] as const;

/** A notice with the id of a shown toast replaces it, so progress and its outcome are one toast. */
export type StudioNotice =
  | { kind: Exclude<(typeof STUDIO_NOTICE_KINDS)[number], 'loading'>; text: string; id?: string }
  | { kind: 'loading'; text: string; id: string };

/** projects-mfe's New workspace overlay, opened from organization-mfe as well. */
export const STUDIO_EXTENSION_WORKSPACE_CREATE =
  'gts.frontx.mfes.ext.extension.v1~frontx.screensets.layout.overlay.v1~constructor_studio.overlays.workspace_create.main.v1';

/** connections-mfe's connection form, opened from projects-mfe as well. */
export const STUDIO_EXTENSION_CONNECTION_CREATE =
  'gts.frontx.mfes.ext.extension.v1~frontx.screensets.layout.overlay.v1~constructor_studio.overlays.connect_source.main.v1';

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

export function notify(bridge: ChildMfeBridge | null, notice: StudioNotice, tag: string): void {
  sendAndForget(
    bridge,
    { type: STUDIO_ACTION_NOTIFY, target: FRONTX_SCREEN_DOMAIN, payload: { ...notice } },
    tag
  );
}

function overlayAction(type: string, extensionId: string): HostAction {
  return { type, target: FRONTX_OVERLAY_DOMAIN, payload: { subject: extensionId } };
}

export function openOverlay(bridge: ChildMfeBridge | null, extensionId: string, tag: string): void {
  sendAndForget(bridge, overlayAction(FRONTX_ACTION_MOUNT_EXT, extensionId), tag);
}

export function closeOverlay(
  bridge: ChildMfeBridge | null,
  extensionId: string,
  tag: string
): Promise<void> {
  if (!bridge) return Promise.resolve();
  return sendToHost(bridge, overlayAction(FRONTX_ACTION_UNMOUNT_EXT, extensionId)).catch(
    (error: unknown) => {
      console.error(`[${tag}] closing the overlay failed`, extensionId, error);
    }
  );
}
