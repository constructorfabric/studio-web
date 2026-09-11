/**
 * MFE Bootstrap — executed once when any entry first loads.
 * Creates the minimal FrontX app, registers slices, effects, and API services.
 * Cache/runtime note:
 * - The host app owns the shared runtime via queryCache().
 * - Child apps join that shared QueryClient via queryCacheShared().
 * - Do not add queryCache(), createFrontXApp(), or QueryClientProvider here.
 */
// @cpt-dod:cpt-frontx-dod-mfe-isolation-internal-dataflow:p1
// @cpt-dod:cpt-frontx-dod-unit-test-generation-and-agent-verification-blank-mfe-tests:p1
// @cpt-flow:cpt-frontx-flow-mfe-isolation-mfe-bootstrap:p1

import {
  createFrontX,
  registerSlice,
  apiRegistry,
  effects,
  queryCacheShared,
  authShared,
  i18n,
} from '@gears-frontx/react';
import { homeSlice } from './slices/homeSlice';
import { initHomeEffects } from './effects/homeEffects';
import { _BlankApiService } from './api/_BlankApiService';
import { AccountsApiService } from '@constructor-studio/mfe-shared';

// Register API services BEFORE build — mock plugin syncs during build(),
// so services must already be present for mock activation to find them
apiRegistry.register(_BlankApiService);
apiRegistry.register(AccountsApiService);
apiRegistry.initialize();

// Create only the local MFE app shell.
// queryCacheShared() joins the host-owned QueryClient without reconfiguring it.
const mfeApp = createFrontX()
  .use(effects())
  .use(i18n())
  .use(queryCacheShared())
  // The host's auth plugin lives in the host's realm, so an MFE request goes
  // out with no bearer unless this reads the shared session — the workspaces
  // read is this MFE's first real call to a gear.
  .use(authShared())
  .build();

// Register slices with effects (needs store from build())
registerSlice(homeSlice, initHomeEffects);

export { mfeApp };
