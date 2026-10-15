/**
 * Every GTS schema the shell registers before it constructs the FrontX app, in
 * registration order. `main.tsx` registers this list, and the tests that stand
 * up a registry of their own register the same one — a copy of it in a test
 * passes while the browser fails.
 */

import {
  themeSchema,
  languageSchema,
  extensionScreenSchema,
  type JSONSchema,
} from '@gears-frontx/react';
import extensionOverlaySchemaJson from './extension_overlay.v1.json';
import extensionScreenLeveledSchemaJson from './extension_screen_leveled.v1.json';
import actionContextPublishSchemaJson from './action_context_publish.v1.json';
import actionContextWorkspacesPublishSchemaJson from './action_context_workspaces_publish.v1.json';
import actionContextArtifactOpenSchemaJson from './action_context_artifact_open.v1.json';
import actionShellNotificationShowSchemaJson from './action_shell_notification_show.v1.json';
import sharedPropertyContextArtifactSchemaJson from './shared_property_context_artifact.v1.json';
import sharedPropertyContextProjectSchemaJson from './shared_property_context_project.v1.json';
import sharedPropertyContextOrganizationSchemaJson from './shared_property_context_organization.v1.json';
import sharedPropertyContextWorkspaceSchemaJson from './shared_property_context_workspace.v1.json';
import sharedPropertyContextSectionSchemaJson from './shared_property_context_section.v1.json';
import sharedPropertySessionProfileSchemaJson from './shared_property_session_user_profile.v1.json';
import sharedPropertySpaceFrameUrlSchemaJson from './shared_property_space_frame_url.v1.json';
import entryIframeSchemaJson from './entry_iframe.v1.json';

export const SHELL_SCHEMAS: readonly JSONSchema[] = [
  // Application-level constraints (valid theme names, supported languages,
  // screen extension shape) that are not part of the core type system in
  // @gears-frontx/gts-plugin.
  themeSchema,
  languageSchema,
  extensionScreenSchema,
  // The overlay counterpart of extensionScreenSchema, owned here rather than in
  // the template's src/gts: GTS refuses to register an instance whose type has no
  // schema, and the overlay domain pins no derived type — so a contribution to it
  // needs one declared somewhere. Without this, registering the search extension
  // throws, bootstrapMFE rejects, and MfeScreenContainer never renders the screen
  // slot: the tabs still list their items while every click mounts into nothing.
  extensionOverlaySchemaJson as JSONSchema,
  // One derivation further down the screen chain: the level a screen belongs to —
  // organization, workspace or project — which the tabs group by. After
  // extensionScreenSchema on purpose: a derived schema resolves its parent by
  // chain, so the type it extends has to be in the registry first, and a screen
  // extension that chains through this one fails to register otherwise.
  extensionScreenLeveledSchemaJson as JSONSchema,
  // The context-slot action an MFE executes against the screen domain. Same rule
  // as above: GTS refuses to route an action instance whose type has no schema.
  actionContextPublishSchemaJson as JSONSchema,
  // The overlay-domain counterpart: a workspace an MFE has just created, handed to
  // the shell that owns the list it belongs in.
  actionContextWorkspacesPublishSchemaJson as JSONSchema,
  // One artifact a member asked to open (#319), and the shell's echo of which one
  // the editor is on (#320). The MFE publishes, the shell owns the answer.
  actionContextArtifactOpenSchemaJson as JSONSchema,
  sharedPropertyContextArtifactSchemaJson as JSONSchema,
  // A toast an MFE asks for: the shell owns the only toaster.
  actionShellNotificationShowSchemaJson as JSONSchema,
  // The shell -> MFE half of the same slot. `sharedProperties` on a domain and
  // `requiredProperties` on an entry both carry an `x-gts-ref` that checks the type
  // is IN THE REGISTRY, not merely that the string looks right, so an unregistered
  // id fails registration and takes bootstrapMFE with it.
  sharedPropertyContextProjectSchemaJson as JSONSchema,
  // The other two halves of the same channel: which organization the session is
  // working in, and who is signed in. Both are the shell's to know and every MFE's
  // to be told — see contextActions.ts for what they replace.
  sharedPropertyContextOrganizationSchemaJson as JSONSchema,
  // The level between them: a project's parent and the Projects list's root.
  sharedPropertyContextWorkspaceSchemaJson as JSONSchema,
  // The tabs are the shell's, the sections are the MFE's — this is the choice
  // crossing between them.
  sharedPropertyContextSectionSchemaJson as JSONSchema,
  sharedPropertySessionProfileSchemaJson as JSONSchema,
  // The address a frame-entry MFE loads. Registered for the same reason as the
  // context properties above.
  sharedPropertySpaceFrameUrlSchemaJson as JSONSchema,
  // A frame is an entry the host loads into an iframe. Registered before any
  // package declaring one: GTS refuses to register an instance whose type has
  // no schema, and the refusal takes bootstrapMFE down with it.
  entryIframeSchemaJson as JSONSchema,
];
