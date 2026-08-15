// @cpt-flow:cpt-frontx-flow-framework-composition-app-bootstrap:p1

/**
 * Bootstrap Effects
 *
 * Effects for app-level bootstrap operations.
 * Following flux architecture: Listen to events from actions, dispatch to slices.
 */

import { eventBus, setUser, setHeaderLoading, apiRegistry, type FrontXApp } from '@gears-frontx/react';
import { AccountsApiService } from '@/app/api';

/**
 * Header identity assembly: display data (name, email) comes from the token
 * claims; the /me call is the backend's confirmation of whom the token
 * authenticates as, and its subject id is the display fallback for tokens
 * without profile claims (static dev tokens).
 */
function claimString(claims: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = claims?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Register bootstrap effects
 * Called once during app initialization. Takes the app instance so identity
 * flows through the framework auth runtime, not a concrete provider.
 */
// @cpt-begin:cpt-frontx-flow-framework-composition-app-bootstrap:p1:inst-1
export function registerBootstrapEffects(app: FrontXApp): void {
  const dispatch = app.store.dispatch;

  // Listen for 'app/user/fetch' event
  eventBus.on('app/user/fetch', async () => {
    let headerLoadingStarted = false;
    try {
      // Check if accounts service is registered before trying to use it
      if (!apiRegistry.has(AccountsApiService)) {
        // Accounts service not registered - skip user fetch
        return;
      }

      dispatch(setHeaderLoading(true));
      headerLoadingStarted = true;

      // Get accounts service using class-based registration
      const accountsService = apiRegistry.getService(AccountsApiService);
      const me = await accountsService.me.fetch();
      const identity = (await app.auth?.getIdentity?.()) ?? null;
      const claims = identity?.claims as Record<string, unknown> | undefined;
      const displayName =
        claimString(claims, 'name') ??
        claimString(claims, 'preferred_username') ??
        (me?.subject_id ? `${me.subject_id.slice(0, 8)}…` : undefined);
      dispatch(setUser({ displayName, email: claimString(claims, 'email') }));
    } catch (error) {
      // Log the message only: an AxiosError carries the request config,
      // Authorization header included — the raw object would print the token.
      console.warn('Failed to fetch user:', error instanceof Error ? error.message : String(error));
    } finally {
      if (headerLoadingStarted) {
        dispatch(setHeaderLoading(false));
      }
    }
  });
}
// @cpt-end:cpt-frontx-flow-framework-composition-app-bootstrap:p1:inst-1
