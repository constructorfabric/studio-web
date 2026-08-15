// @cpt-flow:cpt-frontx-flow-framework-composition-app-bootstrap:p1

/**
 * Bootstrap Effects
 *
 * Effects for app-level bootstrap operations.
 * Following flux architecture: Listen to events from actions, dispatch to slices.
 */

import trim from 'lodash/trim';
import { eventBus, setUser, setHeaderLoading, apiRegistry, type AppDispatch, type HeaderUser } from '@gears-frontx/react';
import { AccountsApiService, type ApiUser } from '@/app/api';
import { keycloakOidcProvider } from '@/app/auth/keycloakOidcProvider';

/**
 * Convert API user to header user info
 */
// @cpt-begin:cpt-frontx-flow-framework-composition-app-bootstrap:p1:inst-1
function toHeaderUser(user: ApiUser): HeaderUser {
  const displayName = trim(`${user.firstName || ''} ${user.lastName || ''}`);
  return {
    displayName: displayName || undefined,
    email: user.email || undefined,
    avatarUrl: user.avatarUrl,
  };
}

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
 * Called once during app initialization
 */
export function registerBootstrapEffects(appDispatch: AppDispatch): void {
  // Store dispatch for use in event listeners
  const dispatch = appDispatch;

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
      const identity = await keycloakOidcProvider.getIdentity();
      const claims = identity?.claims as Record<string, unknown> | undefined;
      const displayName =
        claimString(claims, 'name') ??
        claimString(claims, 'preferred_username') ??
        (me?.subject_id ? `${me.subject_id.slice(0, 8)}…` : undefined);
      dispatch(setUser({ displayName, email: claimString(claims, 'email') }));
    } catch (error) {
      console.warn('Failed to fetch user:', error);
    } finally {
      if (headerLoadingStarted) {
        dispatch(setHeaderLoading(false));
      }
    }
  });

  // Listen for 'app/user/loaded' event - updates header when any screen loads user data
  eventBus.on('app/user/loaded', ({ user }) => {
    dispatch(setUser(toHeaderUser(user)));
  });
}
// @cpt-end:cpt-frontx-flow-framework-composition-app-bootstrap:p1:inst-1
