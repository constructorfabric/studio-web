/**
 * The address becomes the shell's state (ADR-0028).
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
import { TENANT_TYPES, errorMessage } from '@constructor-studio/mfe-shared';
import { entryPointOf, levelOf, sectionOf, type ScreenLevel } from '@/app/mfe/screenLevels';
import { isMountingScreen, mountScreen } from '@/app/mfe/mountScreen';
import { publishStudioContext } from '@/app/mfe/sharedContext';
import {
  closeContextProject,
  openContextProject,
  readAppContext,
  rememberProject,
  setContextOrg,
  setContextSection,
  setContextWorkspace,
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
  /**
   * The observer's report that the address changed. A new visit: a mount that
   * did not happen in the previous one may be tried again, and a mount still
   * running from it is about a place the person has left.
   */
  transition(): void;
  /** Forgets a mount that failed and applies the address again — for when the screen slot has re-attached. */
  retry(): void;
}

export function createMaterializer(deps: MaterializerDeps): Materializer {
  const { app, navigation, catalogs } = deps;
  const warn = deps.warn ?? ((text: string) => console.warn(text));
  const dispatch = app.store.dispatch;
  const resolving = new Set<string>();
  /**
   * Counts the address transitions the observer has reported. A mount
   * remembers the visit it started in, so a failure is judged against the
   * visit it belongs to — not against a hash of the route, which a quick
   * there-and-back reproduces (reviewer finding).
   */
  let visit = 0;
  /** The visit whose mount did not happen, so it is not tried again until the address changes — a catalog arriving is not that. */
  let stuckIn: number | null = null;
  /** The entry point a failed mount fell back to, so its own failure is not fallen back from — once (ADR-0028). */
  let fallbackTo: string | null = null;

  const screensOf = (registry: MfeRegistry): ScreenExtension[] =>
    registry.getExtensionsForDomain(screenDomain.id) as ScreenExtension[];

  /** The route of a level's entry point, carrying the context that level shows. */
  const entryRoute = (registry: MfeRegistry, level: ScreenLevel, from: ShellRoute | null): ShellRoute | null => {
    const entry = entryPointOf(screensOf(registry), level);
    const group = entry ? groupOfExtension(deps.groups(), entry.id) : undefined;
    if (!group) return null;
    const context = readAppContext(app);
    const route: ShellRoute = { token: group.token };
    const org = from?.org ?? context.org?.id;
    if (org) route.org = org;
    if (level !== 'organization') {
      const workspace = from?.workspace ?? context.workspace?.id;
      if (workspace) route.workspace = workspace;
    }
    return route;
  };

  const resolveLater = (projectId: string, workspaceId: string | undefined, orgId: string | undefined): void => {
    if (resolving.has(projectId)) return;
    resolving.add(projectId);
    void catalogs.resolveProject(projectId).then((lookup) => {
      resolving.delete(projectId);
      const current = navigation.currentRoute();
      if (current?.project !== projectId) return;
      if (current.org !== orgId || current.workspace !== workspaceId) {
        // Asked in one scope, answered in another: the pass for the scope that
        // is current now asks again, and judges the answer against itself.
        materialize();
        return;
      }
      // A read that failed says nothing about the project: the address keeps
      // it, the MFE has its id already, and the next pass asks again.
      if (lookup === 'unavailable') return;
      const tenant = lookup;
      // Every workspace sits under the organization too, so the type has to
      // say project before the parent is looked at.
      if (tenant === null || tenant.tenant_type !== TENANT_TYPES.project) {
        warn(`Project ${projectId} is not a project this person can read; closing it`);
        navigation.navigate({ ...current, project: undefined, section: undefined }, 'replace');
        materialize();
        return;
      }
      // A project may sit under its workspace or straight under the organization
      // (the wizard does the latter).
      if (tenant.parent_id !== workspaceId && (orgId === undefined || tenant.parent_id !== orgId)) {
        const home = readAppContext(app).workspaces.find((workspace) => workspace.id === tenant.parent_id);
        if (!home) {
          warn(`Project ${projectId} is not in workspace ${workspaceId ?? '(none)'}; closing it`);
          navigation.navigate({ ...current, project: undefined, section: undefined }, 'replace');
          materialize();
          return;
        }
        // Under another workspace of this organization: the project id is the
        // more specific fact — a link may name the project alone, and the
        // workspace in the route is then the shell's own default — so the
        // address moves to the project's workspace instead of refusing it.
        // The pass that write triggers opens it there and reads its name.
        navigation.navigate({ ...current, workspace: home.id }, 'replace');
        materialize();
        return;
      }
      dispatch(rememberProject({ id: tenant.id, name: tenant.name }));
      materialize();
    });
  };

  const isMounted = (registry: MfeRegistry, group: ScreenGroup): boolean => {
    const [mountedId] = registry.getMountedExtensions(screenDomain.id);
    return groupOfExtension(deps.groups(), mountedId)?.token === group.token;
  };

  // @cpt-begin:cpt-studiofrontend-flow-shell-levels-descend:p1:inst-7
  const mountFailed = (registry: MfeRegistry, group: ScreenGroup, startedIn: number, reason: string): void => {
    if (startedIn !== visit) {
      // The address moved on while this mount was running: the failure is
      // about a visit the person has left, and the current address gets its
      // own pass — its own attempt included — rather than being marked stuck
      // or replaced by a fallback for the old one.
      warn(`Screen "${group.token}" did not mount (${reason}); the address has moved on since`);
      materialize();
      return;
    }
    warn(`Screen "${group.token}" did not mount (${reason}); not trying again until the address changes`);
    // @cpt-begin:cpt-studiofrontend-flow-shell-levels-descend:p1:inst-8
    const fallback =
      fallbackTo === group.token ? null : entryRoute(registry, levelOf(group.owner), navigation.currentRoute());
    if (!fallback || fallback.token === group.token) {
      // The level's entry point did not mount either, or there is none to fall
      // back to: nothing is mounted, the warning above has said so, and this
      // visit is not tried again. The next address starts afresh.
      stuckIn = visit;
      fallbackTo = null;
      return;
    }
    // The fallback changes the address, so nothing is stuck: the entry point
    // gets its one attempt, in the pass the write triggers or in this one.
    fallbackTo = fallback.token;
    navigation.navigate(fallback, 'replace');
    materialize();
    // @cpt-end:cpt-studiofrontend-flow-shell-levels-descend:p1:inst-8
  };
  // @cpt-end:cpt-studiofrontend-flow-shell-levels-descend:p1:inst-7

  // @cpt-begin:cpt-studiofrontend-algo-shell-levels-click:p1:inst-7
  const mount = (registry: MfeRegistry, group: ScreenGroup): void => {
    if (isMountingScreen(registry)) return;
    if (stuckIn === visit) return;
    const startedIn = visit;
    void mountScreen(registry, group.owner)
      .then(() => {
        // The registry logs a failed chain and resolves — it never rejects — so
        // success is read off the mounted set, not off the promise.
        if (isMounted(registry, group)) {
          fallbackTo = null;
          stuckIn = null;
          materialize();
          return;
        }
        // Another mount took over (a StrictMode re-attach); its own completion re-runs this.
        if (isMountingScreen(registry)) return;
        mountFailed(registry, group, startedIn, 'the actions chain did not complete');
      })
      .catch((error: unknown) => mountFailed(registry, group, startedIn, errorMessage(error)));
  };
  // @cpt-end:cpt-studiofrontend-algo-shell-levels-click:p1:inst-7

  const transition = (): void => {
    visit += 1;
    materialize();
  };

  const retry = (): void => {
    stuckIn = null;
    fallbackTo = null;
    materialize();
  };

  const materialize = (): void => {
    const registry = app.mfeRegistry;
    if (!registry) return;
    const groups = deps.groups();
    if (groups.length === 0) return;
    if (readAppContext(app).access === 'unassigned') return;

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
    let context = readAppContext(app);
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

    // The organization's workspaces are wanted at every level: an organization-
    // level screen still publishes the default workspace to the MFEs.
    context = readAppContext(app);
    if (context.org && context.workspacesStatus === 'pending') catalogs.loadWorkspaces(context.org.id);

    // Workspace: below the organization the address names it; at the
    // organization level the address carries none and the slice's choice is
    // the preference the next descent starts from (ADR-0028). Either way it
    // is checked against the list once that is known, and defaulted from it —
    // the catalog reducers keep or drop a selection, they never pick one.
    if (ownerLevel === 'organization') wanted.workspace = undefined;
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

    // Project: only a screen below the organization carries it.
    // @cpt-begin:cpt-studiofrontend-algo-shell-levels-click:p1:inst-4
    if (ownerLevel !== 'organization') {
      if (wanted.workspace) next.workspace = wanted.workspace;

      context = readAppContext(app);
      if (wanted.project) {
        // Carried in the address while the workspace list is still on its way,
        // whether or not the address named a workspace — a link may name the
        // project alone. Opened once the list can vouch for the workspace, or
        // say the organization has none and the project sits straight under it.
        next.project = wanted.project;
        if (context.workspacesStatus === 'ready') {
          const known = context.projects.find((project) => project.id === wanted.project);
          if (context.project?.id !== wanted.project) {
            dispatch(openContextProject(known ?? { id: wanted.project, name: '' }));
          } else if (known && context.project.name !== known.name) {
            dispatch(openContextProject(known));
          }
          if (!known) resolveLater(wanted.project, next.workspace, next.org);
          // The siblings for the switcher, asked for while nobody has read
          // them; a read that failed is not asked again on every pass.
          if (next.workspace && context.projectsStatus === 'pending') catalogs.loadProjects(next.workspace);
        }
      } else if (context.project) {
        dispatch(closeContextProject());
      }
    } else if (readAppContext(app).project) {
      dispatch(closeContextProject());
    }
    // @cpt-end:cpt-studiofrontend-algo-shell-levels-click:p1:inst-4

    // Section: of the level in scope, defaulting to that level's entry item.
    // @cpt-begin:cpt-studiofrontend-algo-shell-levels-click:p1:inst-2
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
      if (readAppContext(app).section !== next.section) dispatch(setContextSection(next.section));
    } else if (readAppContext(app).section !== null) {
      dispatch(setContextSection(null));
    }

    publishStudioContext(app);
    // @cpt-end:cpt-studiofrontend-algo-shell-levels-click:p1:inst-2

    if (!routesEqual(next, address)) navigation.navigate(next, 'replace');

    // @cpt-begin:cpt-studiofrontend-algo-shell-levels-click:p1:inst-3
    // @cpt-begin:cpt-studiofrontend-algo-shell-levels-click:p1:inst-6
    if (!isMounted(registry, group)) mount(registry, group);
    // @cpt-end:cpt-studiofrontend-algo-shell-levels-click:p1:inst-6
    // @cpt-end:cpt-studiofrontend-algo-shell-levels-click:p1:inst-3
  };

  return { materialize, transition, retry };
}
