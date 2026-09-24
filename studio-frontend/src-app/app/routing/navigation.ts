/**
 * Reading and writing the shell's one entry (ADR-0028, "The URL is where
 * navigation is decided").
 *
 * `navigate` is the only way the shell changes the address. It names only
 * what changed for the `screen` key and lets `backProjectEntries` compose the
 * URL, which is what keeps foreign query segments and the hash intact. The
 * library refuses a `replaced` whose old token is absent and a
 * `payloadChanged` for a token not in the address, so the delta is chosen
 * from what the address currently holds.
 */
import {
  createRouteSignal,
  parseGrammar,
  type BackProjectionDelta,
  type Entry,
  type ExtensionToken,
  type HistoryVerb,
  type NavigationHistory,
  type RouteSignal,
} from '@gears-frontx/routing';
import { SCREEN_DOMAIN_KEY, routeFromEntry, routeToParams, routesEqual, type ShellRoute } from './route';

export interface ShellNavigation {
  currentRoute(): ShellRoute | null;
  navigate(route: ShellRoute, verb: HistoryVerb): void;
  createObserver: RouteSignal['createObserver'];
}

export function createShellNavigation(history: NavigationHistory): ShellNavigation {
  const { backProjectEntries, createObserver } = createRouteSignal(history);

  const screenEntry = (): Entry | undefined => {
    const { path, search, hash } = history.location;
    return parseGrammar({ shellSubroute: path, search, hash }).entries.find(
      (entry) => entry.domainKey === SCREEN_DOMAIN_KEY
    );
  };

  const currentRoute = (): ShellRoute | null => {
    const entry = screenEntry();
    return entry ? routeFromEntry(entry) : null;
  };

  const navigate = (route: ShellRoute, verb: HistoryVerb): void => {
    const current = screenEntry();
    const currentRouteValue = current ? routeFromEntry(current) : null;
    if (routesEqual(currentRouteValue, route)) return;
    const entry = { extension: route.token as ExtensionToken, params: routeToParams(route) };
    const delta: BackProjectionDelta = !current
      ? { added: [entry] }
      : current.extension !== entry.extension
        ? { replaced: [{ oldExtension: current.extension, entry }] }
        : { payloadChanged: [entry] };
    backProjectEntries(SCREEN_DOMAIN_KEY, delta, verb);
  };

  return { currentRoute, navigate, createObserver };
}
