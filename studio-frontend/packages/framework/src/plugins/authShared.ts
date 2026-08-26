/**
 * authShared — the auth counterpart of `queryCacheShared()`.
 *
 * Why it has to exist: `MfeHandlerMF` gives every MFE load its own module
 * evaluation chain (blob URLs, per ADR-0004 / ADR-0020), so an MFE has its own
 * instance of `@gears-frontx/api` — and therefore its own
 * `protocolPluginRegistry`. The host's `auth()` plugin registers its
 * `AuthRestPlugin` in the HOST realm's registry, which the child's
 * `RestProtocol.getGlobalPlugins()` cannot see. Result before this plugin:
 * every REST call made from an MFE left without an `Authorization` header and
 * the backend answered 401 `MISSING_BEARER`.
 *
 * The handoff is a `Symbol.for()` key on `globalThis` — the same mechanism
 * `queryCache()` / `queryCacheShared()` already use for the QueryClient, and
 * the only one that survives isolated module realms.
 *
 * Ownership stays with the host: the child only ever READS the current session
 * and never runs its own refresh timer. A 401 asks the host to refresh, so the
 * page keeps exactly one refresh chain no matter how many MFEs are mounted.
 */

import { RestPlugin, RestProtocol } from '@gears-frontx/api';
import type { AuthContext, AuthSession, AuthTransportRequest } from '@gears-frontx/auth';
import type { FrontXPlugin } from '../types';
import {
  BaseAuthRestPlugin,
  type AuthTransportOptions,
  type ResolvedAuthTransport,
} from './authTransportCore';

const SHARED_AUTH_SESSION_SYMBOL = Symbol.for('frontx:auth:shared-session');

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

/** Called by `auth()` on the host. Last writer wins — one host per page. */
export function publishSharedAuthSession(accessor: SharedAuthSessionAccessor): void {
  (globalThis as SharedAuthHost)[SHARED_AUTH_SESSION_SYMBOL] = accessor;
}

/**
 * Called by `auth()` on teardown. Identity-checked so a host being destroyed
 * after a newer one was published cannot unpublish the live accessor.
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

/**
 * The child's binding of the shared transport: the host's session, under the
 * host's policy. Behaviour lives in `BaseAuthRestPlugin` — a child's requests
 * are not a lesser kind of request — including why the accessor is resolved per
 * request and why this stays a class of its own.
 */
class SharedAuthRestPlugin extends BaseAuthRestPlugin {
  protected resolveTransport(): ResolvedAuthTransport | null {
    const accessor = readSharedAuthSession();
    if (!accessor) return null;

    return {
      source: {
        getSession: (ctx) => accessor.getSession(ctx),
        refresh: accessor.refresh,
        onTransportError: accessor.onTransportError,
      },
      // No published policy reads as relative-and-same-origin only, which is the
      // safe end of the scale rather than the permissive one.
      options: accessor.transport ?? {},
    };
  }
}

/**
 * Join the host's auth session from a child app (an MFE).
 *
 * ```ts
 * const mfeApp = createFrontX().use(effects()).use(queryCacheShared()).use(authShared()).build();
 * ```
 *
 * Composing it in an app that also composes `auth()` is harmless but pointless —
 * that app already has the real transport binding.
 */
export function authShared(): FrontXPlugin {
  let restPlugin: SharedAuthRestPlugin | null = null;

  return {
    name: 'auth-shared',
    onInit(app) {
      if (!readSharedAuthSession()) {
        // Not fatal: the accessor is resolved per request, so a host that
        // publishes later still works. Warn, because the far more likely cause
        // is a host that never composed auth() at all — and then every request
        // from this app goes out unauthenticated with no other symptom.
        console.warn(
          '[Gears FrontX] authShared(): no host auth session published yet. ' +
            'Requests stay unauthenticated until the host app composes auth().'
        );
      }
      restPlugin = new SharedAuthRestPlugin();
      app.apiRegistry.plugins.add(RestProtocol, restPlugin);
    },
    onDestroy(app) {
      if (!restPlugin) return;
      // Typed through the same signature `auth()` uses for its own removal: a
      // RestPlugin subclass that overrides `onError` with the richer context
      // shape is not structurally assignable to the base plugin class.
      const removeRestPlugin = (pluginClass: new (...args: never[]) => RestPlugin): void => {
        app.apiRegistry.plugins.remove(RestProtocol, pluginClass);
      };
      removeRestPlugin(SharedAuthRestPlugin);
      restPlugin = null;
    },
  };
}
