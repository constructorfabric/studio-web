/// <reference types="vite/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FrontXProvider, apiRegistry, createFrontXApp, registerSlice, MfeHandlerMF, gtsPlugin, FRONTX_MFE_ENTRY_MF, themeSchema, languageSchema, extensionScreenSchema, setMenuCollapsed, type JSONSchema } from '@gears-frontx/react';
import { Toaster } from '@/app/components/ui/sonner';
import { AccountsApiService } from '@/app/api';
import './globals.css'; // Global styles with CSS variables
import '@/app/events/bootstrapEvents'; // Register app-level events (type augmentation)
import { registerBootstrapEffects } from '@/app/effects/bootstrapEffects'; // Register app-level effects
import { registerAppContextEffects } from '@/app/effects/appContextEffects'; // Top-bar context slot
import { mfeBootstrapSlice } from '@/app/slices/mfeBootstrapSlice';
import { appContextSlice } from '@/app/slices/appContextSlice';
import { appSessionSlice } from '@/app/slices/appSessionSlice';
import { keycloakOidcProvider } from '@/app/auth/keycloakOidcProvider';
import extensionOverlaySchemaJson from '@/app/mfe/schemas/extension_overlay.v1.json';
import actionContextPublishSchemaJson from '@/app/mfe/schemas/action_context_publish.v1.json';
import sharedPropertyContextProjectSchemaJson from '@/app/mfe/schemas/shared_property_context_project.v1.json';
import sharedPropertyContextOrganizationSchemaJson from '@/app/mfe/schemas/shared_property_context_organization.v1.json';
import sharedPropertySessionProfileSchemaJson from '@/app/mfe/schemas/shared_property_session_user_profile.v1.json';
import App from './App';

// Import all themes
import { DEFAULT_THEME_ID, defaultTheme } from '@/app/themes/default';
import { darkTheme } from '@/app/themes/dark';
import { lightTheme } from '@/app/themes/light';
import { draculaTheme } from '@/app/themes/dracula';
import { draculaLargeTheme } from '@/app/themes/dracula-large';

// Register application-specific GTS schemas before constructing the FrontX app.
// These derived schemas encode application-level constraints (valid theme names,
// supported languages, screen extension shape) and are not part of the core
// type system in @gears-frontx/gts-plugin.
gtsPlugin.registerSchema(themeSchema);
gtsPlugin.registerSchema(languageSchema);
gtsPlugin.registerSchema(extensionScreenSchema);
// The overlay counterpart of extensionScreenSchema, owned here rather than in
// the template's src/gts: GTS refuses to register an instance whose type has no
// schema, and the overlay domain pins no derived type — so a contribution to it
// needs one declared somewhere. Without this, registering the search extension
// throws, bootstrapMFE rejects, and MfeScreenContainer never renders the screen
// slot: the drawer still lists its items while every click mounts into nothing.
gtsPlugin.registerSchema(extensionOverlaySchemaJson as JSONSchema);
// The context-slot action an MFE executes against the screen domain. Same rule
// as above: GTS refuses to route an action instance whose type has no schema.
gtsPlugin.registerSchema(actionContextPublishSchemaJson as JSONSchema);
// The shell -> MFE half of the same slot. `sharedProperties` on a domain and
// `requiredProperties` on an entry both carry an `x-gts-ref` that checks the type
// is IN THE REGISTRY, not merely that the string looks right, so an unregistered
// id fails registration and takes bootstrapMFE with it.
gtsPlugin.registerSchema(sharedPropertyContextProjectSchemaJson as JSONSchema);
// The other two halves of the same channel: which organization the session is
// working in, and who is signed in. Both are the shell's to know and every MFE's
// to be told — see mfe/contextActions.ts for what they replace.
gtsPlugin.registerSchema(sharedPropertyContextOrganizationSchemaJson as JSONSchema);
gtsPlugin.registerSchema(sharedPropertySessionProfileSchemaJson as JSONSchema);

// Register accounts service (application-level service for user info)
apiRegistry.register(AccountsApiService);

// Initialize API services
apiRegistry.initialize({});

// Create FrontX app instance
// Register MfeHandlerMF to enable Module Federation MFE loading
const app = createFrontXApp({
  microfrontends: {
    typeSystem: gtsPlugin,
    mfeHandlers: [new MfeHandlerMF(FRONTX_MFE_ENTRY_MF)],
  },
  // Default frontxApiTransport(): Bearer on every REST call of the host and
  // all MFEs, one deduplicated refresh-and-retry after a 401.
  auth: { provider: keycloakOidcProvider },
});

// Mock API off from the first paint. The framework's `mock()` plugin (part of
// the full preset) turns mock mode ON by default on localhost, and the accounts
// mock map answers `/me` with a tenant id that exists nowhere
// (`…0000000000aa`). Since MFEs share the host's QueryClient
// (`queryCacheShared()`), that fake identity leaks into every MFE that reads
// `/me` — projects-mfe then asks account-management for the children of a
// tenant AM has never heard of and gets a 404. The FrontX Studio panel can
// still switch mocks back on.
app.actions.toggleMockMode(false);

// Register app-level slices and effects (identity flows through app.auth)
registerSlice(mfeBootstrapSlice);
registerSlice(appContextSlice);
registerSlice(appSessionSlice);
registerBootstrapEffects(app);
registerAppContextEffects(app);

// Register all themes (default theme has default:true, activates automatically)
app.themeRegistry.register(defaultTheme);
app.themeRegistry.register(lightTheme);
app.themeRegistry.register(darkTheme);
app.themeRegistry.register(draculaTheme);
app.themeRegistry.register(draculaLargeTheme);

// Apply default theme explicitly
app.themeRegistry.apply(DEFAULT_THEME_ID);

// The navigation drawer starts closed. The framework's menu slice defaults to
// the open state a permanent left column wanted, so the shell states its own
// default here — dispatched rather than emitted so the first paint already has
// it closed, with no flash of an open panel. See layout/Menu.tsx for why
// `collapsed` is the drawer's closed flag.
app.store.dispatch(setMenuCollapsed(true));

/**
 * Render application
 * Bootstrap happens automatically when Layout mounts
 *
 * Flow:
 * 1. App renders → Layout mounts → bootstrap dispatched
 * 2. Components show skeleton loaders (translationsReady = false)
 * 3. User fetched → language set → translations loaded
 * 4. Components re-render with actual text (translationsReady = true)
 * 5. MFE system loads and mounts extensions via MfeScreenContainer
 *
 * Note: Mock API is controlled via the FrontX Studio panel.
 * The mock plugin (included in full preset) handles mock plugin lifecycle automatically.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FrontXProvider app={app}>
      <App />
      <Toaster />
    </FrontXProvider>
  </StrictMode>
);
