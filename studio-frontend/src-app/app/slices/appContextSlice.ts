/** App Context Slice */


// @cpt-dod:cpt-studiofrontend-dod-shell-levels-no-address:p1
import { createSlice, type ReducerPayload } from '@gears-frontx/react';

export interface ContextEntity {
  id: string;
  name: string;
  count?: number;
}

export type WorkspacesStatus = 'pending' | 'ready' | 'failed';

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
  section: null,
  loading: false,
  access: 'loading',
};

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

    /** The resolved organization list and which of them is current. */
    setContextOrganizations: (
      state: AppContextState,
      action: ReducerPayload<{ current: ContextEntity | null; items: ContextEntity[] }>
    ) => {
      state.org = action.payload.current;
      state.orgs = action.payload.items;
    },

    setContextOrg: (state: AppContextState, action: ReducerPayload<string>) => {
      const next = state.orgs.find((org) => org.id === action.payload);
      if (!next || next.id === state.org?.id) return;
      state.org = next;
      state.workspace = null;
      state.workspaces = [];
      state.workspacesStatus = 'pending';
      state.project = null;
      state.projects = [];
    },

    // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-6
    setContextWorkspaces: (
      state: AppContextState,
      action: ReducerPayload<ContextEntity[]>
    ) => {
      state.workspaces = action.payload;
      const kept = action.payload.find((item) => item.id === state.workspace?.id);
      state.workspace = kept ?? action.payload[0] ?? null;
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
      state.project = null;
      state.projects = [];
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
      state.project = null;
      state.projects = [];
    },

    setContextProjects: (
      state: AppContextState,
      action: ReducerPayload<ContextEntity[]>
    ) => {
      state.projects = action.payload;
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
  openContextProject,
  closeContextProject,
  setContextSection,
};
export const APP_CONTEXT_SLICE_KEY = SLICE_KEY;

export default slice.reducer;
