/**
 * The address becomes the shell's state (ADR-0022).
 *
 * Idempotent by construction: every step compares the address with the slice
 * and the mounted screen and changes only what differs. When the state it
 * reached says something other than the address — a default filled, an id
 * refused — it writes the normalized route with `replace`. A converged state
 * writes nothing, which is what makes the library's echo of the shell's own
 * write harmless. This is the only writer of `org`, `workspace`, `project`
 * and `section`, and the only caller of `mountScreen`.
 */
import { screenDomain, type FrontXApp, type MfeRegistry, type ScreenExtension } from '@gears-frontx/react';
import { TENANT_TYPES } from '@constructor-studio/mfe-shared';
import { entryPointOf, levelOf, sectionOf, type ScreenLevel } from '@/app/mfe/screenLevels';
import { isMountingScreen, mountScreen } from '@/app/mfe/mountScreen';
import { publishStudioContext } from '@/app/mfe/sharedContext';
import {
  APP_CONTEXT_SLICE_KEY,
  closeContextProject,
  openContextProject,
  rememberProject,
  setContextOrg,
  setContextSection,
  setContextWorkspace,
  type AppContextState,
} from '@/app/slices/appContextSlice';
import type { ContextCatalogs } from '@/app/effects/contextCatalogs';
import { routesEqual, type ShellRoute } from './route';
import { groupOfExtension, groupOfToken, type ScreenGroup } from './screenTokens';
import type { ShellNavigation } from './navigation';

export interface MaterializerDeps {
  app: FrontXApp;
  navigation: ShellNavigation;
  groups: () => readonly ScreenGroup[];
  catalogs: ContextCatalogs;
  warn?: (message: string) => void;
}

export interface Materializer {
  materialize(): void;
  /** Forgets a mount that failed and applies the address again — for when the screen slot has re-attached. */
  retry(): void;
}

function contextOf(app: FrontXApp): AppContextState {
  return (app.store.getState() as Record<string, unknown>)[APP_CONTEXT_SLICE_KEY] as AppContextState;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMaterializer(deps: MaterializerDeps): Materializer {
  const { app, navigation, catalogs } = deps;
  const warn = deps.warn ?? ((text: string) => console.warn(text));
  const dispatch = app.store.dispatch;
  const resolving = new Set<string>();
  let recovering = false;
  /** The screen and address of a mount that did not happen, so it is not tried again until either changes. */
  let stuckOn: string | null = null;

  const screensOf = (registry: MfeRegistry): ScreenExtension[] =>
    registry.getExtensionsForDomain(screenDomain.id) as ScreenExtension[];

  /** The route of a level's entry point, carrying the context that level shows. */
  const entryRoute = (registry: MfeRegistry, level: ScreenLevel, from: ShellRoute | null): ShellRoute | null => {
    const entry = entryPointOf(screensOf(registry), level);
    const group = entry ? groupOfExtension(deps.groups(), entry.id) : undefined;
    if (!group) return null;
    const context = contextOf(app);
    const route: ShellRoute = { token: group.token };
    const org = from?.org ?? context.org?.id;
    if (org) route.org = org;
    if (level !== 'organization') {
      const workspace = from?.workspace ?? context.workspace?.id;
      if (workspace) route.workspace = workspace;
    }
    return route;
  };

  const resolveLater = (projectId: string, workspaceId: string, orgId: string | undefined): void => {
    if (resolving.has(projectId)) return;
    resolving.add(projectId);
    void catalogs.resolveProject(projectId).then((tenant) => {
      resolving.delete(projectId);
      const current = navigation.currentRoute();
      if (current?.project !== projectId) return;
      // A project may sit under its workspace or straight under the organization
      // (the wizard does the latter) — but every workspace sits under the
      // organization too, so the type has to say project as well.
      const parentOk =
        tenant !== null &&
        tenant.tenant_type === TENANT_TYPES.project &&
        (tenant.parent_id === workspaceId || (orgId !== undefined && tenant.parent_id === orgId));
      if (!tenant || !parentOk) {
        warn(`Project ${projectId} is not in workspace ${workspaceId}; closing it`);
        navigation.navigate({ ...current, project: undefined, section: undefined }, 'replace');
        materialize();
        return;
      }
      dispatch(rememberProject({ id: tenant.id, name: tenant.name }));
      materialize();
    });
  };

  const addressKey = (token: string): string => {
    const route = navigation.currentRoute();
    return [token, route?.token, route?.org, route?.workspace, route?.project, route?.section].join('|');
  };

  const isMounted = (registry: MfeRegistry, group: ScreenGroup): boolean => {
    const [mountedId] = registry.getMountedExtensions(screenDomain.id);
    return groupOfExtension(deps.groups(), mountedId)?.token === group.token;
  };

  const mountFailed = (registry: MfeRegistry, group: ScreenGroup, key: string, reason: string): void => {
    stuckOn = key;
    warn(`Screen "${group.token}" did not mount (${reason}); not trying again until the address changes`);
    if (recovering) return;
    recovering = true;
    const fallback = entryRoute(registry, levelOf(group.owner), navigation.currentRoute());
    if (!fallback || fallback.token === group.token) return;
    navigation.navigate(fallback, 'replace');
    materialize();
  };

  const mount = (registry: MfeRegistry, group: ScreenGroup): void => {
    if (isMountingScreen(registry)) return;
    const key = addressKey(group.token);
    if (stuckOn === key) return;
    void mountScreen(registry, group.owner)
      .then(() => {
        // The registry logs a failed chain and resolves — it never rejects — so
        // success is read off the mounted set, not off the promise.
        if (isMounted(registry, group)) {
          recovering = false;
          stuckOn = null;
          materialize();
          return;
        }
        // Another mount took over (a StrictMode re-attach); its own completion re-runs this.
        if (isMountingScreen(registry)) return;
        mountFailed(registry, group, key, 'the actions chain did not complete');
      })
      .catch((error: unknown) => mountFailed(registry, group, key, messageOf(error)));
  };

  const retry = (): void => {
    stuckOn = null;
    recovering = false;
    materialize();
  };

  const materialize = (): void => {
    const registry = app.mfeRegistry;
    if (!registry) return;
    const groups = deps.groups();
    if (groups.length === 0) return;
    if (contextOf(app).access === 'unassigned') return;

    const address = navigation.currentRoute();
    let route = address;
    let group = route ? groupOfToken(groups, route.token) : undefined;
    if (!route || !group) {
      if (route) warn(`No screen answers to "${route.token}"; opening the organization level instead`);
      // Substituted, not written yet: the pass below fills the defaults and
      // writes the whole normalized route once, and mounts in the same pass.
      route = entryRoute(registry, 'organization', null);
      group = route ? groupOfToken(groups, route.token) : undefined;
      if (!route || !group) return;
    }

    const wanted: ShellRoute = { ...route };
    const next: ShellRoute = { token: route.token };
    const ownerLevel = levelOf(group.owner);

    // Organization: validated only once the person's list is known.
    let context = contextOf(app);
    if (context.orgs.length > 0) {
      if (wanted.org && !context.orgs.some((org) => org.id === wanted.org)) {
        warn(`Organization ${wanted.org} is not one of yours; staying in the current one`);
        wanted.org = undefined;
        wanted.workspace = undefined;
        wanted.project = undefined;
        wanted.section = undefined;
      }
      wanted.org ??= context.org?.id ?? context.orgs[0]?.id;
      if (wanted.org && wanted.org !== context.org?.id) dispatch(setContextOrg(wanted.org));
    }
    if (wanted.org) next.org = wanted.org;

    // Workspace and project: only a screen below the organization carries them.
    if (ownerLevel !== 'organization') {
      context = contextOf(app);
      if (context.org && context.workspacesStatus === 'pending') catalogs.loadWorkspaces(context.org.id);
      if (context.workspacesStatus === 'ready') {
        if (wanted.workspace && !context.workspaces.some((workspace) => workspace.id === wanted.workspace)) {
          warn(`Workspace ${wanted.workspace} is not in this organization; opening the first one`);
          wanted.workspace = undefined;
          wanted.project = undefined;
          wanted.section = undefined;
        }
        wanted.workspace ??= context.workspace?.id ?? context.workspaces[0]?.id;
        if (wanted.workspace && wanted.workspace !== context.workspace?.id) dispatch(setContextWorkspace(wanted.workspace));
      }
      if (wanted.workspace) next.workspace = wanted.workspace;

      context = contextOf(app);
      if (wanted.project && next.workspace) {
        // Carried in the address while the workspace list is still on its way;
        // opened only once that list can vouch for the workspace.
        next.project = wanted.project;
        if (context.workspacesStatus === 'ready') {
          const known = context.projects.find((project) => project.id === wanted.project);
          if (context.project?.id !== wanted.project) {
            dispatch(openContextProject(known ?? { id: wanted.project, name: '' }));
          } else if (known && context.project.name !== known.name) {
            dispatch(openContextProject(known));
          }
          if (!known) resolveLater(wanted.project, next.workspace, next.org);
          if (context.projects.length === 0) catalogs.loadProjects(next.workspace);
        }
      } else if (context.project && !wanted.project) {
        dispatch(closeContextProject());
      }
    } else if (contextOf(app).project) {
      dispatch(closeContextProject());
    }

    // Section: of the level in scope, defaulting to that level's entry item.
    const levelInScope: ScreenLevel = next.project ? 'project' : ownerLevel;
    const sections = group.members
      .filter((member) => levelOf(member) === levelInScope)
      .map((member) => sectionOf(member))
      .filter((section): section is string => section !== undefined);
    if (sections.length > 0) {
      if (wanted.section && !sections.includes(wanted.section)) {
        warn(`"${wanted.section}" is not a section of ${group.token}; opening its first one`);
        wanted.section = undefined;
      }
      const entry = entryPointOf(group.members, levelInScope);
      next.section = wanted.section ?? (entry ? sectionOf(entry) : undefined) ?? sections[0];
      if (contextOf(app).section !== next.section) dispatch(setContextSection(next.section));
    } else if (contextOf(app).section !== null) {
      dispatch(setContextSection(null));
    }

    publishStudioContext(app);

    if (!routesEqual(next, address)) navigation.navigate(next, 'replace');

    if (!isMounted(registry, group)) mount(registry, group);
  };

  return { materialize, retry };
}
