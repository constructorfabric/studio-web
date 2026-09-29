// Constructor Studio: tell the backend which folder this window has open.
//
// Off a session (`/workspace` absent, no `GEARBOX_WORKSPACE`) the backend's
// idea of the workspace is the folder the window names, and until it has been
// named it is the process's own directory -- on a desktop, the application's,
// which holds no product. Everything that asks the backend about the workspace
// says it first: the catalogue load did, product discovery did not, and the
// Start screen discovers at startup, before the first load has said anything.
// On the desktop that listed the application's folder, found no product, and
// the Product panel reported none until the next window reload won the race.

import type { GearboxService } from "../../common/protocol";

export interface OpenedWorkspace {
  readonly ready: Promise<unknown>;
  readonly workspace?: { readonly resource: { toString(): string } } | undefined;
}

export async function announceOpenedWorkspace(
  service: Pick<GearboxService, "useOpenedWorkspace">,
  workspace: OpenedWorkspace | undefined,
): Promise<void> {
  if (workspace === undefined) return;
  try {
    await workspace.ready;
    await service.useOpenedWorkspace(workspace.workspace?.resource.toString());
  } catch {
    // A backend from before this call, or no workspace yet: the defaults stand.
  }
}
