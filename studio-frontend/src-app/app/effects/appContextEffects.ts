/**
 * App Context Effects — events in, routes out (ADR-0028).
 *
 * Nothing here decides what is in scope. A person's action arrives as an
 * event, the handler computes the route it means and writes it with
 * `navigate`; the router reports the transition and `materialize` moves the
 * slice and the screen. The handlers read the *current route* for the context
 * they carry forward, and fall back to the slice only before the first
 * address is written. The catalogs (organizations, workspaces, projects) are
 * data, fetched in `contextCatalogs.ts` and stored before any navigation.
 */
import { eventBus, screenDomain, type FrontXApp, type ScreenExtension } from '@gears-frontx/react';
import { levelOf, sectionOf, type ScreenLevel } from '@/app/mfe/screenLevels';
import { createContextCatalogs } from '@/app/effects/contextCatalogs';
import { startRouting, type RoutingHandle } from '@/app/routing/startRouting';
import { entryTokenOf, groupOfToken, tokenOf } from '@/app/routing/screenTokens';
import type { ShellRoute } from '@/app/routing/route';
import {
  addContextWorkspace,
  readAppContext,
  rememberProject,
  setContextProjects,
  setContextWorkspace,
} from '@/app/slices/appContextSlice';

/** Long enough for an aborted duplicate to have settled. */
const WORKSPACE_RETRY_DELAY_MS = 400;

// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-claim:p1
/**
 * Whether an announcement belongs to a scope the session has left. An
 * unclaimed scope (`undefined`) is never stale; only a sender that named its
 * scope can be found to have named the wrong one.
 */
function staleScope(current: string | null, claimed: string | undefined): boolean {
  return claimed !== undefined && claimed !== current;
}

export function registerAppContextEffects(app: FrontXApp): void {
  const dispatch = app.store.dispatch;
  const context = () => readAppContext(app);

  let routing: RoutingHandle | null = null;
  const catalogs = createContextCatalogs(app, () => routing?.materialize());

  const screens = (): ScreenExtension[] =>
    (app.mfeRegistry?.getExtensionsForDomain(screenDomain.id) ?? []) as ScreenExtension[];

  /** The route for `token` at `level`, carrying what the address (or, before one exists, the slice) knows. */
  const routeFor = (token: string, level: ScreenLevel, overrides: Partial<ShellRoute> = {}): ShellRoute => {
    const current = routing?.navigation.currentRoute() ?? null;
    const slice = context();
    const route: ShellRoute = { token };
    const org = overrides.org ?? current?.org ?? slice.org?.id;
    if (org) route.org = org;
    if (level !== 'organization') {
      const workspace = overrides.workspace ?? current?.workspace ?? slice.workspace?.id;
      if (workspace) route.workspace = workspace;
    }
    if (level === 'project') {
      const project = overrides.project ?? current?.project ?? slice.project?.id;
      if (project) route.project = project;
    }
    if (overrides.section) route.section = overrides.section;
    return route;
  };

  const currentGroupLevel = (): ScreenLevel | undefined => {
    const current = routing?.navigation.currentRoute();
    const group = routing && current ? groupOfToken(routing.groups(), current.token) : undefined;
    return group ? levelOf(group.owner) : undefined;
  };

  const currentOrgId = (): string | null =>
    routing?.navigation.currentRoute()?.org ?? context().org?.id ?? null;
  const currentWorkspaceId = (): string | null =>
    routing?.navigation.currentRoute()?.workspace ?? context().workspace?.id ?? null;

  eventBus.on('app/routing/start', () => {
    if (routing) {
      // The slot re-attached: whatever failed to mount before has a root again.
      routing.retry();
      return;
    }
    routing = startRouting(app, catalogs);
  });

  eventBus.on('app/context/fetch', () => {
    void catalogs.loadOrganizations();
  });

  eventBus.on('app/context/level/requested', ({ level }) => {
    if (!routing) return;
    const token = entryTokenOf(screens(), level);
    if (!token) return;
    const route = routeFor(token, level);
    if (level === 'project' && !route.project) return;
    routing.navigation.navigate(route, 'push');
  });

  // @cpt-begin:cpt-studiofrontend-algo-shell-levels-click:p1:inst-1
  eventBus.on('app/context/screen/requested', ({ extensionId }) => {
    if (!routing) return;
    const target = screens().find((candidate) => candidate.id === extensionId);
    const token = target ? tokenOf(target) : undefined;
    if (!target || !token) return;
    const section = sectionOf(target);
    routing.navigation.navigate(routeFor(token, levelOf(target), section ? { section } : {}), 'push');
  });
  // @cpt-end:cpt-studiofrontend-algo-shell-levels-click:p1:inst-1

  eventBus.on('app/context/org/changed', ({ orgId }) => {
    if (!routing) return;
    if (currentOrgId() === orgId) {
      if (context().workspacesStatus === 'failed') catalogs.loadWorkspaces(orgId);
      return;
    }
    const current = routing.navigation.currentRoute();
    const stays = current !== null && currentGroupLevel() === 'organization';
    const token = stays ? current.token : entryTokenOf(screens(), 'organization');
    if (!token) return;
    const route: ShellRoute = { token, org: orgId };
    if (stays && current.section) route.section = current.section;
    routing.navigation.navigate(route, 'push');
  });

  eventBus.on('app/context/workspace/changed', ({ workspaceId, name, organizationId, enter }) => {
    if (!routing) return;
    if (staleScope(currentOrgId(), organizationId)) return;
    if (name !== undefined) dispatch(addContextWorkspace({ id: workspaceId, name }));
    if (!enter && currentGroupLevel() === 'organization') {
      // Below the organization the address decides; at its level the workspace
      // is a preference the slice keeps for the next descent (ADR-0028).
      dispatch(setContextWorkspace(workspaceId));
      routing.materialize();
      return;
    }
    const token = enter ? entryTokenOf(screens(), 'workspace') : routing.navigation.currentRoute()?.token;
    if (!token) return;
    routing.navigation.navigate(routeFor(token, 'workspace', { workspace: workspaceId }), 'push');
  });

  eventBus.on('app/context/workspace/created', ({ id, name, organizationId }) => {
    if (!routing) return;
    if (staleScope(currentOrgId(), organizationId)) return;
    dispatch(addContextWorkspace({ id, name }));
    const current = routing.navigation.currentRoute();
    if (current && currentGroupLevel() !== 'organization') {
      routing.navigation.navigate(routeFor(current.token, 'workspace', { workspace: id }), 'push');
    } else {
      routing.materialize();
    }
  });

  eventBus.on('app/context/workspace/scoped', () => {
    const slice = context();
    if (slice.workspacesStatus === 'failed' && slice.org) catalogs.loadWorkspaces(slice.org.id);
  });

  eventBus.on('app/context/workspaces/failed', () => {
    window.setTimeout(() => {
      const slice = context();
      if (slice.workspacesStatus !== 'failed' || !slice.org) return;
      catalogs.loadWorkspaces(slice.org.id, true);
    }, WORKSPACE_RETRY_DELAY_MS);
  });

  //  Published by whoever owns projects (projects-mfe)

  eventBus.on('app/context/projects', ({ items, workspaceId }) => {
    if (staleScope(currentWorkspaceId(), workspaceId)) return;
    dispatch(setContextProjects(items));
  });

  eventBus.on('app/context/project/opened', ({ id, name, workspaceId }) => {
    if (!routing) return;
    if (staleScope(currentWorkspaceId(), workspaceId)) return;
    dispatch(rememberProject({ id, name }));
    const token = routing.navigation.currentRoute()?.token ?? entryTokenOf(screens(), 'workspace');
    if (!token) return;
    routing.navigation.navigate(routeFor(token, 'project', { workspace: workspaceId, project: id }), 'push');
  });

  eventBus.on('app/context/project/changed', ({ projectId }) => {
    if (!routing) return;
    const current = routing.navigation.currentRoute();
    if (!current || (current.project ?? context().project?.id) === projectId) return;
    routing.navigation.navigate(routeFor(current.token, 'project', { project: projectId }), 'push');
  });

  eventBus.on('app/context/project/closed', () => {
    if (!routing) return;
    const current = routing.navigation.currentRoute();
    if (!current) return;
    routing.navigation.navigate(routeFor(current.token, 'workspace'), 'push');
  });

  // @cpt-begin:cpt-studiofrontend-flow-shell-levels-section:p1:inst-4
  // @cpt-begin:cpt-studiofrontend-flow-shell-levels-section:p1:inst-5
  // The MFE's own report of the section it moved to, written without a
  // history entry: the person did not navigate, the screen did. The rail
  // follows it from the address, like every other section.
  eventBus.on('app/context/project/section', ({ section }) => {
    if (!routing) return;
    const current = routing.navigation.currentRoute();
    if (!current) return;
    routing.navigation.navigate({ ...current, section: section ?? undefined }, 'replace');
  });
  // @cpt-end:cpt-studiofrontend-flow-shell-levels-section:p1:inst-5
  // @cpt-end:cpt-studiofrontend-flow-shell-levels-section:p1:inst-4
}
