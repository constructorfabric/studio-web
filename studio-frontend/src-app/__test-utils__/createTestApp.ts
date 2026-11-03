import { createFrontX, presets, type FrontXApp } from '@gears-frontx/react';

/** The full preset without an MFE runtime or auth: the app an MFE test renders under. */
export function createTestApp(): FrontXApp {
  return createFrontX().useAll(presets.full()).build();
}
