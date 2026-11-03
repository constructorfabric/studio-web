/**
 * The handoff between the host's auth and an MFE's: a `Symbol.for()` key on
 * `globalThis`, the only channel that survives isolated module realms. The host
 * publishes (`sharedAuthTransport` in the shell); `authShared()` reads.
 */
import type { AuthContext, AuthSession, AuthTransportRequest } from '@gears-frontx/auth';
import { SHARED_AUTH_SESSION_SYMBOL } from '@gears-frontx/frontx-template-shell';
import type { AuthTransportOptions } from './authTransportCore';

/**
 * What the host publishes for children: read the session, ask for a refresh,
 * report a transport failure, and the cookie policy those requests must obey.
 * Deliberately narrower than `AuthRuntime` — a child has no business logging in,
 * logging out, or evaluating access on the host's behalf.
 *
 * `transport` travels with the accessor because a child cannot know the host's
 * policy — which origins may receive credentials, what the CSRF header is
 * called — and letting it guess is how this path ended up sending cookies to any
 * origin with no CSRF header. `refresh` is expected to arrive deduplicated, since
 * every child shares it.
 */
export interface SharedAuthSessionAccessor {
  getSession: (ctx?: AuthContext) => Promise<AuthSession | null>;
  refresh?: () => Promise<AuthSession | null>;
  onTransportError?: (event: {
    request: AuthTransportRequest;
    error: Error;
    status?: number;
  }) => void;
  transport?: AuthTransportOptions;
}

type SharedAuthHost = typeof globalThis & {
  [SHARED_AUTH_SESSION_SYMBOL]?: SharedAuthSessionAccessor;
};

/** Called by the shell's `sharedAuthTransport()`. Last writer wins — one host per page. */
export function publishSharedAuthSession(accessor: SharedAuthSessionAccessor): void {
  (globalThis as SharedAuthHost)[SHARED_AUTH_SESSION_SYMBOL] = accessor;
}

/**
 * Called by `sharedAuthTransport()` on teardown. Identity-checked so a host
 * being destroyed after a newer one was published cannot unpublish the live
 * accessor.
 */
export function clearSharedAuthSession(accessor: SharedAuthSessionAccessor): void {
  const host = globalThis as SharedAuthHost;
  if (host[SHARED_AUTH_SESSION_SYMBOL] === accessor) {
    delete host[SHARED_AUTH_SESSION_SYMBOL];
  }
}

/** The child's view of the host session, or undefined when no host published one. */
export function readSharedAuthSession(): SharedAuthSessionAccessor | undefined {
  return (globalThis as SharedAuthHost)[SHARED_AUTH_SESSION_SYMBOL];
}
