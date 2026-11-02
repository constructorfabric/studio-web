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
import { RestProtocol, type FrontXPlugin, type RestPlugin } from '@gears-frontx/react';
import { BaseAuthRestPlugin, type ResolvedAuthTransport } from './authTransportCore';
import { readSharedAuthSession } from './sharedAuthSession';

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
 * that app's own transport (`frontxApiTransport()`) already binds its session.
 */
export function authShared(): FrontXPlugin {
  let restPlugin: SharedAuthRestPlugin | null = null;

  return {
    name: 'auth-shared',
    onInit(app) {
      if (!readSharedAuthSession()) {
        // Not fatal: the accessor is resolved per request, so a host that
        // publishes later still works. Warn, because the far more likely cause
        // is a host whose auth plugin publishes nothing — `auth()` without the
        // shell's `sharedAuthTransport()` — and then every request from this app
        // goes out unauthenticated with no other symptom.
        console.warn(
          '[Gears FrontX] authShared(): no host auth session published yet. ' +
            'Requests stay unauthenticated until the host composes auth({ transport: sharedAuthTransport() }).'
        );
      }
      restPlugin = new SharedAuthRestPlugin();
      app.apiRegistry.plugins.add(RestProtocol, restPlugin);
    },
    onDestroy(app) {
      if (!restPlugin) return;
      // Typed through a constructor signature of its own: a RestPlugin subclass
      // that overrides `onError` with the richer context shape is not
      // structurally assignable to the base plugin class.
      const removeRestPlugin = (pluginClass: new (...args: never[]) => RestPlugin): void => {
        app.apiRegistry.plugins.remove(RestProtocol, pluginClass);
      };
      removeRestPlugin(SharedAuthRestPlugin);
      restPlugin = null;
    },
  };
}
