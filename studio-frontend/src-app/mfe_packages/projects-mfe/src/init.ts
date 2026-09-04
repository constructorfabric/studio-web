/**
 * MFE Bootstrap — executed once per loaded entry, NOT once per MFE.
 */
// @cpt-dod:cpt-frontx-dod-mfe-isolation-internal-dataflow:p1
// @cpt-flow:cpt-frontx-flow-mfe-isolation-mfe-bootstrap:p1

import {
  createFrontX,
  registerSlice,
  apiRegistry,
  authShared,
  effects,
  i18n,
  queryCacheShared,
} from '@gears-frontx/react';
import { navSlice } from './slices/navSlice';
import { createWizardSlice } from './slices/createSlice';
import { workspaceCreateSlice } from './slices/workspaceSlice';
import { artifactSyncSlice } from './slices/artifactSyncSlice';
import { initProjectsEffects } from './effects/projectsEffects';
import { initWizardEffects } from './effects/wizardEffects';
import { initWorkspaceEffects } from './effects/workspaceEffects';
import { initArtifactEffects } from './effects/artifactEffects';
import { AccountsApiService } from './api/AccountsApiService';
import { ArtifactIngestApiService } from './api/ArtifactIngestApiService';
import { ConnectorsApiService } from '@constructor-studio/mfe-shared';

// Register API services BEFORE build so plugin sync finds them.
// Three gears: account-management holds the projects themselves (tenants, since
// the studio-project gear was retired), studio-connector the source hosts the
// New project wizard imports from, and studio-artifact-ingest the graph of what
// a project's repositories contain.
apiRegistry.register(AccountsApiService);
apiRegistry.register(ConnectorsApiService);
apiRegistry.register(ArtifactIngestApiService);
apiRegistry.initialize();

// Create only the local MFE app shell.
// queryCacheShared() joins the host-owned QueryClient without reconfiguring it.
const mfeApp = createFrontX()
  .use(effects())
  .use(i18n())
  .use(queryCacheShared())
  .use(authShared())
  .build();

// Register slices with effects (needs store from build())
registerSlice(navSlice, initProjectsEffects);
// The wizard's effect takes the app as well as the dispatch: it reads the
// workspace's projects for the announcement and drops the list screen's cached
// page, and both live on the app-bound QueryClient.
registerSlice(createWizardSlice, (dispatch) => initWizardEffects(dispatch, mfeApp));
registerSlice(workspaceCreateSlice, initWorkspaceEffects);
// The import's effect needs the app as well as the dispatch: it re-reads the
// artifacts mid-flight, and cache invalidation outside React goes through the
// app-bound QueryClient.
registerSlice(artifactSyncSlice, (dispatch) => initArtifactEffects(dispatch, mfeApp));

export { mfeApp };
