/**
 * MFE Bootstrap — executed once per loaded entry, NOT once per MFE.
 *
 * That distinction cost a debugging session, so it is stated plainly: this MFE
 * exposes two entries (`./lifecycle` and `./wizardLifecycle`), and
 * `MfeHandlerMF.loadExposedModuleIsolated` gives each one its own blob-URL
 * module graph — its `blobUrlMap` is created inside the call, and
 * `sharedDepTextCache` caches source text, not blob URLs. So this module is
 * evaluated twice and there are TWO of everything it creates: two `mfeApp`s,
 * two redux stores, two event buses, two api registries.
 *
 * Nothing built here crosses between the entries. What crosses is what the
 * framework deliberately hands off through `globalThis`: the QueryClient
 * (`queryCacheShared`) and the host session (`authShared`). Anything the two
 * roots must agree on has to travel through the query cache, or be resolved
 * independently on both sides.
 * Creates the minimal FrontX app, registers slices, effects, and API services.
 * Cache/runtime note:
 * - The host app owns the shared runtime via queryCache().
 * - Child apps join that shared QueryClient via queryCacheShared().
 * - Do not add queryCache(), createFrontXApp(), or QueryClientProvider here.
 *
 * `authShared()` is what makes requests from here authenticated at all: the MFE
 * runs in its own module realm, so the host's auth REST plugin is invisible to
 * this app's `apiRegistry` — the shared plugin reads the host session through the
 * `globalThis` handoff instead. Without it every call is a 401 MISSING_BEARER.
 *
 * The framework's `mock()` plugin is deliberately absent: its toggle is driven
 * from the host's dev panel over the host's eventBus, which does not cross the
 * realm boundary. There is no mock mode: this MFE talks to the real gear.
 *
 * `i18n()` is what makes both halves of translation work: `useFormatters()`
 * (dates, numbers) resolves `app.i18nRegistry`, and without the plugin that is
 * undefined — the first formatted cell throws and the whole screen renders
 * blank. Screen dictionaries are NOT registered here: the framework's
 * `useScreenTranslations` registers each screen's loader itself, on mount, so
 * the screens stay lazy (see `src/i18n.ts`). The registry is this realm's own;
 * ProjectsRoot feeds it the language it gets from the bridge.
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
import { initProjectsEffects } from './effects/projectsEffects';
import { initWizardEffects } from './effects/wizardEffects';
import { AccountsApiService } from './api/AccountsApiService';
import { ConnectorsApiService } from './api/ConnectorsApiService';

// Register API services BEFORE build so plugin sync finds them.
// Two gears: account-management holds the projects themselves (tenants, since
// the studio-project gear was retired), studio-connector the source hosts the
// New project wizard imports from.
apiRegistry.register(AccountsApiService);
apiRegistry.register(ConnectorsApiService);
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
registerSlice(createWizardSlice, initWizardEffects);

export { mfeApp };
