import { AccountsApiService } from '@constructor-studio/mfe-shared';
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
import { specsFilterSlice } from './slices/specsFilterSlice';
import { createWizardSlice } from './slices/createSlice';
import { workspaceCreateSlice } from './slices/workspaceSlice';
import { artifactSyncSlice } from './slices/artifactSyncSlice';
import { sourcesConnectSlice } from './slices/sourcesConnectSlice';
import { typeDecisionSlice } from './slices/typeDecisionSlice';
import { specsCheckSlice } from './slices/specsCheckSlice';
import { documentUploadSlice } from './slices/documentUploadSlice';
import { initWizardEffects } from './effects/wizardEffects';
import { initWorkspaceEffects } from './effects/workspaceEffects';
import { initArtifactEffects } from './effects/artifactEffects';
import { initSourcesConnectEffects } from './effects/sourcesConnectEffects';
import { initTypeDecisionEffects } from './effects/typeDecisionEffects';
import { initSpecsCheckEffects } from './effects/specsCheckEffects';
import { initDocumentUploadEffects } from './effects/documentUploadEffects';
import { ArtifactIngestApiService } from './api/ArtifactIngestApiService';
import { DocumentsApiService } from './api/DocumentsApiService';
import { SpecQualityApiService } from './api/SpecQualityApiService';
import {
  ConnectorsApiService,
  StudioEventsApiService,
  StudioTasksApiService,
} from '@constructor-studio/mfe-shared';

// Register API services BEFORE build so plugin sync finds them.
// Seven gears: account-management holds the projects themselves (tenants, since
// the studio-project gear was retired), studio-connector the source hosts the
// New project wizard imports from, studio-artifact-ingest the graph of what a
// project's repositories contain, studio-tasks the run each repository's sync
// is, studio-events the stream those runs are announced on, studio-documents
// the journey-stage catalogue a new project is seeded from and the project's
// specs, and studio-spec-quality whether those specs can be checked.
apiRegistry.register(AccountsApiService);
apiRegistry.register(ConnectorsApiService);
apiRegistry.register(ArtifactIngestApiService);
apiRegistry.register(DocumentsApiService);
apiRegistry.register(SpecQualityApiService);
apiRegistry.register(StudioTasksApiService);
apiRegistry.register(StudioEventsApiService);
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
registerSlice(navSlice);
registerSlice(specsFilterSlice);
// The wizard's effect takes the app as well as the dispatch: it reads the
// workspace's projects for the announcement and drops the list screen's cached
// page, and both live on the app-bound QueryClient.
registerSlice(createWizardSlice, (dispatch) => initWizardEffects(dispatch, mfeApp));
registerSlice(workspaceCreateSlice, initWorkspaceEffects);
// The import's effect needs the app as well as the dispatch: it re-reads the
// artifacts mid-flight, and cache invalidation outside React goes through the
// app-bound QueryClient.
registerSlice(artifactSyncSlice, (dispatch) => initArtifactEffects(dispatch, mfeApp));
registerSlice(sourcesConnectSlice, (dispatch) => initSourcesConnectEffects(dispatch, mfeApp));
// A type decision drops the Sources section's cached Specs counts, on the app-bound QueryClient.
registerSlice(typeDecisionSlice, (dispatch) => initTypeDecisionEffects(dispatch, mfeApp));
// Check's runs, followed here so a check outlives a switch of section or project.
registerSlice(specsCheckSlice, initSpecsCheckEffects);
// Upload documents: the panel's rows are sent here, and the documents read invalidated on the app-bound QueryClient.
registerSlice(documentUploadSlice, (dispatch) => initDocumentUploadEffects(dispatch, mfeApp));

export { mfeApp };
