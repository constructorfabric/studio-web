/**
 * MFE Bootstrap — executed once per loaded entry, NOT once per MFE.
 */
// @cpt-dod:cpt-frontx-dod-mfe-isolation-internal-dataflow:p1
// @cpt-flow:cpt-frontx-flow-mfe-isolation-mfe-bootstrap:p1

import {
  createFrontX,
  registerSlice,
  apiRegistry,
  effects,
  i18n,
  queryCacheShared,
} from '@gears-frontx/react';
import { connectSlice } from './slices/connectSlice';
import { initConnectEffects } from './effects/connectEffects';
import { ConnectorsApiService, authShared } from '@constructor-studio/mfe-shared';

// Register API services BEFORE build so plugin sync finds them.
apiRegistry.register(ConnectorsApiService);
apiRegistry.initialize();

const mfeApp = createFrontX()
  .use(effects())
  .use(i18n())
  .use(queryCacheShared())
  .use(authShared())
  .build();

registerSlice(connectSlice, (dispatch) => initConnectEffects(dispatch, mfeApp));

export { mfeApp };
