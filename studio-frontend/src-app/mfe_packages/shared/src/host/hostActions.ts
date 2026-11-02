/** The MFE -> shell channel */

import {
  FRONTX_ACTION_MOUNT_EXT,
  FRONTX_ACTION_UNMOUNT_EXT,
  FRONTX_OVERLAY_DOMAIN,
  FRONTX_SCREEN_DOMAIN,
  type ChildMfeBridge,
} from '@gears-frontx/react';
import {
  STUDIO_ACTION_CHAIN_DONE,
  STUDIO_ACTION_CHAIN_FAILED,
  createChainOutcomes,
  type ChainOutcomes,
} from './chainOutcome';

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

/**
 * Hands `action` to the host. Nothing comes back: mfes 0.4.0 returns no outcome,
 * and drops an action it refuses without throwing or telling the MFE.
 */
export function sendToHost(bridge: ChildMfeBridge | null, action: HostAction): void {
  bridge?.executeActionsChain({ action });
}

const outcomesByBridge = new WeakMap<ChildMfeBridge, ChainOutcomes>();

/**
 * Resolves once the host has carried `action` out and rejects when it took the
 * fallback, for a caller that shows the outcome. The replies come back to this
 * MFE's own extension, so its entry in mfe.json must list both
 * `STUDIO_ACTION_CHAIN_DONE` and `STUDIO_ACTION_CHAIN_FAILED` in `actions`: the
 * runtime drops a reply its target does not declare, silently, and the promise
 * never settles. No timer: an inactive bridge hands nothing over, which happens
 * only after the MFE has unmounted, when no form waits on it.
 */
export function requestFromHost(bridge: ChildMfeBridge | null, action: HostAction): Promise<void> {
  if (!bridge) return Promise.reject(new Error(`no MFE bridge for ${action.type}`));
  let outcomes = outcomesByBridge.get(bridge);
  if (!outcomes) {
    outcomes = createChainOutcomes();
    bridge.registerActionHandler(STUDIO_ACTION_CHAIN_DONE, outcomes.done);
    bridge.registerActionHandler(STUDIO_ACTION_CHAIN_FAILED, outcomes.failed);
    outcomesByBridge.set(bridge, outcomes);
  }
  return outcomes.run((chain) => bridge.executeActionsChain(chain), action, bridge.extensionId);
}

export function notify(bridge: ChildMfeBridge | null, notice: StudioNotice): void {
  sendToHost(bridge, { type: STUDIO_ACTION_NOTIFY, target: FRONTX_SCREEN_DOMAIN, payload: { ...notice } });
}

function overlayAction(type: string, extensionId: string): HostAction {
  return { type, target: FRONTX_OVERLAY_DOMAIN, payload: { subject: extensionId } };
}

export function openOverlay(bridge: ChildMfeBridge | null, extensionId: string): void {
  sendToHost(bridge, overlayAction(FRONTX_ACTION_MOUNT_EXT, extensionId));
}

export function closeOverlay(bridge: ChildMfeBridge | null, extensionId: string): void {
  sendToHost(bridge, overlayAction(FRONTX_ACTION_UNMOUNT_EXT, extensionId));
}
