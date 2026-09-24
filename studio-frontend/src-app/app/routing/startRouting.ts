/**
 * Where the shell starts listening to its address (ADR-0028, "Start-up and
 * the first report").
 *
 * Called once the screen slot is attached and every manifest is registered:
 * the registered-extensions source is built from the registry then and never
 * changes, so it supplies no `onChange`. The history is resolved lazily here —
 * after `AuthGate` has scrubbed the OIDC callback with its own `replaceState`
 * — so no write is ever made behind the library's back. The observer's first
 * report is synchronous, and `materialize` mounts from it at once.
 */
import { screenDomain, type FrontXApp, type ScreenExtension } from '@gears-frontx/react';
import {
  resolveNavigationHistory,
  type ExtensionToken,
  type NavigationHistory,
  type RegisteredExtensionsSource,
} from '@gears-frontx/routing';
import type { ContextCatalogs } from '@/app/effects/contextCatalogs';
import { createMaterializer } from './materialize';
import { createShellNavigation, type ShellNavigation } from './navigation';
import { SCREEN_DOMAIN_KEY } from './route';
import { groupScreens, type ScreenGroup } from './screenTokens';

export interface RoutingHandle {
  navigation: ShellNavigation;
  groups(): readonly ScreenGroup[];
  materialize(): void;
  /** Applies the address again after the screen slot re-attached, forgetting a mount that failed. */
  retry(): void;
  release(): void;
}

export function startRouting(
  app: FrontXApp,
  catalogs: ContextCatalogs,
  history: NavigationHistory = resolveNavigationHistory()
): RoutingHandle {
  const registry = app.mfeRegistry;
  if (!registry) throw new Error('[routing] the MFE registry is not available on the app');

  const navigation = createShellNavigation(history);
  const groups = groupScreens(registry.getExtensionsForDomain(screenDomain.id) as ScreenExtension[]);
  const materializer = createMaterializer({ app, navigation, groups: () => groups, catalogs });

  const source: RegisteredExtensionsSource<ScreenGroup> = {
    getRegistrations: () =>
      groups.map((group) => ({ extension: group.token as ExtensionToken, routeOwner: group })),
  };
  const release = navigation.createObserver(SCREEN_DOMAIN_KEY, source, () => materializer.transition());

  return {
    navigation,
    groups: () => groups,
    materialize: materializer.materialize,
    retry: materializer.retry,
    release,
  };
}
