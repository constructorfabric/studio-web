/** App Context Slice */


// @cpt-dod:cpt-studiofrontend-dod-shell-levels-no-address:p1
import { createSlice, type FrontXApp, type ReducerPayload } from '@gears-frontx/react';

export interface ContextEntity {
  id: string;
  name: string;
  count?: number;
}

/**
 * Where a catalog read stands. `failed` is not `ready` with nothing in it: an
 * organization with no workspace and one whose workspaces could not be read
 * are different states, and only the first is asked about again on every pass.
 */
export type CatalogStatus = 'pending' | 'ready' | 'failed';
export type WorkspacesStatus = CatalogStatus;

/**
 * Whether this person may act in an organization at all.
 *
 * `unassigned` is a supported, expected state, not an error: an authenticated
 * person with no organization membership has to see an onboarding message rather
 * than an empty switcher or a missing-tenant failure (ADR-0011 §3).
 */
export type AccessState = 'loading' | 'ready' | 'unassigned';

export interface AppContextState {
  org: ContextEntity | null;
  orgs: ContextEntity[];
  workspace: ContextEntity | null;
  workspaces: ContextEntity[];
  workspacesStatus: WorkspacesStatus;
  project: ContextEntity | null;
  projects: ContextEntity[];
  projectsStatus: CatalogStatus;
  section: string | null;
  loading: boolean;
  access: AccessState;
}

const SLICE_KEY = 'app/context' as const;

const initialState: AppContextState = {
  org: null,
  orgs: [],
  workspace: null,
  workspaces: [],
  workspacesStatus: 'pending',
  project: null,
  projects: [],
  projectsStatus: 'pending',
  section: null,
  loading: false,
  access: 'loading',
};

/**
 * What leaving a workspace takes with it: the project in scope, the list it
 * came from and the list's status — so the next scope reads its own list.
 * One definition, because five reducers leave a scope (reviewer finding).
 */
function leaveProjectScope(state: AppContextState): void {
  state.project = null;
  state.projects = [];
  state.projectsStatus = 'pending';
}

/** What leaving an organization takes with it: its workspaces, and everything under them. */
function leaveWorkspaceScope(state: AppContextState): void {
  state.workspace = null;
  state.workspaces = [];
  state.workspacesStatus = 'pending';
  leaveProjectScope(state);
}

const {
  slice,
  setContextAccess,
  setContextLoading,
  setContextOrganizations,
  setContextOrg,
  setContextWorkspaces,
  setContextWorkspacesStatus,
  setContextWorkspace,
  addContextWorkspace,
  setContextProjects,
  setContextProjectsStatus,
  rememberProject,
  openContextProject,
  closeContextProject,
  setContextSection,
} = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    setContextLoading: (state: AppContextState, action: ReducerPayload<boolean>) => {
      state.loading = action.payload;
    },

    setContextAccess: (state: AppContextState, action: ReducerPayload<AccessState>) => {
      state.access = action.payload;
    },

    /**
     * The organizations on offer. Which of them is in scope is the address's
     * to say (ADR-0028): the one in scope is refreshed from the list (its name
     * and count may have changed), one the list no longer vouches for is
     * dropped with everything under it, and none is picked in its place.
     */
    setContextOrganizations: (state: AppContextState, action: ReducerPayload<ContextEntity[]>) => {
      state.orgs = action.payload;
      if (!state.org) return;
      const kept = action.payload.find((org) => org.id === state.org?.id);
      if (kept) {
        state.org = kept;
        return;
      }
      state.org = null;
      leaveWorkspaceScope(state);
    },

    setContextOrg: (state: AppContextState, action: ReducerPayload<string>) => {
      const next = state.orgs.find((org) => org.id === action.payload);
      if (!next || next.id === state.org?.id) return;
      state.org = next;
      leaveWorkspaceScope(state);
    },

    // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-6
    /** The workspaces of the organization in scope. Same rule as the organizations: refresh or drop, never pick. */
    setContextWorkspaces: (state: AppContextState, action: ReducerPayload<ContextEntity[]>) => {
      state.workspaces = action.payload;
      if (!state.workspace) return;
      const kept = action.payload.find((item) => item.id === state.workspace?.id);
      if (kept) {
        state.workspace = kept;
        return;
      }
      state.workspace = null;
      leaveProjectScope(state);
    },
    // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-6

    // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-5
    setContextWorkspacesStatus: (
      state: AppContextState,
      action: ReducerPayload<WorkspacesStatus>
    ) => {
      state.workspacesStatus = action.payload;
    },
    // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-5

    setContextWorkspace: (state: AppContextState, action: ReducerPayload<string>) => {
      const next = state.workspaces.find((workspace) => workspace.id === action.payload);
      if (!next || next.id === state.workspace?.id) return;
      state.workspace = next;
      leaveProjectScope(state);
    },

    addContextWorkspace: (
      state: AppContextState,
      action: ReducerPayload<ContextEntity>
    ) => {
      const listed = state.workspaces.find((workspace) => workspace.id === action.payload.id);
      if (!listed) state.workspaces = [...state.workspaces, action.payload];
      const next = listed ?? action.payload;
      if (next.id === state.workspace?.id) return;
      state.workspace = next;
      leaveProjectScope(state);
    },

    /** The projects of the workspace in scope, from whoever read them: the shell's catalog or the MFE's own list. */
    setContextProjects: (
      state: AppContextState,
      action: ReducerPayload<ContextEntity[]>
    ) => {
      state.projects = action.payload;
      state.projectsStatus = 'ready';
    },

    setContextProjectsStatus: (state: AppContextState, action: ReducerPayload<CatalogStatus>) => {
      state.projectsStatus = action.payload;
    },

    /**
     * A project the shell learned about — from an `opened` publish, a sibling
     * list, or a tenant read for an address that named it. Data, not a
     * selection: which project is open is the address's to say (ADR-0028).
     */
    rememberProject: (state: AppContextState, action: ReducerPayload<ContextEntity>) => {
      const listed = state.projects.find((project) => project.id === action.payload.id);
      if (!listed) state.projects = [...state.projects, action.payload];
      else if (action.payload.name && listed.name !== action.payload.name) listed.name = action.payload.name;
      if (
        state.project?.id === action.payload.id &&
        action.payload.name &&
        state.project.name !== action.payload.name
      ) {
        state.project = { ...state.project, name: action.payload.name };
      }
    },

    openContextProject: (
      state: AppContextState,
      action: ReducerPayload<ContextEntity>
    ) => {
      if (state.project?.id !== action.payload.id) state.section = null;
      state.project = action.payload;
    },
    closeContextProject: (state: AppContextState) => {
      state.project = null;
      state.section = null;
    },

    setContextSection: (state: AppContextState, action: ReducerPayload<string | null>) => {
      state.section = action.payload;
    },
  },
});

/** The slice as every shell module reads it off the app's store; the initial state before the slice is registered. */
export function readAppContext(app: Pick<FrontXApp, 'store'>): AppContextState {
  return ((app.store.getState() as Record<string, unknown>)[SLICE_KEY] as AppContextState | undefined) ?? initialState;
}

export const appContextSlice = slice;
export {
  setContextAccess,
  setContextLoading,
  setContextOrganizations,
  setContextOrg,
  setContextWorkspaces,
  setContextWorkspacesStatus,
  setContextWorkspace,
  addContextWorkspace,
  setContextProjects,
  setContextProjectsStatus,
  rememberProject,
  openContextProject,
  closeContextProject,
  setContextSection,
};
export const APP_CONTEXT_SLICE_KEY = SLICE_KEY;

export default slice.reducer;
