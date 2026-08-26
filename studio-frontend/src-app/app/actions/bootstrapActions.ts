// @cpt-flow:cpt-frontx-flow-framework-composition-app-bootstrap:p1

/**
 * Bootstrap Actions
 *
 * Actions for app-level bootstrap operations.
 * Following flux architecture: Actions emit events, Effects listen and dispatch.
 */

import { eventBus } from '@gears-frontx/react';

/**
 * Fetch current user
 * Emits 'app/user/fetch' event
 */
// @cpt-begin:cpt-frontx-flow-framework-composition-app-bootstrap:p1:inst-1
export function fetchCurrentUser(): void {
  eventBus.emit('app/user/fetch');
}
// @cpt-end:cpt-frontx-flow-framework-composition-app-bootstrap:p1:inst-1

/**
 * Resolve the organizations the top bar's context slot offers.
 * Emits 'app/context/fetch'; the effect reads /me and account-management.
 */
export function fetchAppContext(): void {
  eventBus.emit('app/context/fetch');
}
