/**
 * App Context Slice
 *
 * What the top bar's second slot shows, and what its dropdown offers.
 *
 * The slot has two scopes. At `org` scope it names the organization the session
 * is in and switches between the user's organizations; at `project` scope it
 * names the open project and switches between projects. One slot, because the
 * mockup gives it one place — the scope decides which list is behind the
 * chevron.
 *
 * Ownership is split along the gear that owns the data, and the split is the
 * reason this slice exists rather than the shell fetching everything:
 *
 * - Organizations are account-management, which the shell already talks to
 *   (`AccountsApiService`), so the shell fills `org`/`orgs` itself.
 * - Projects are the studio-project gear, which is projects-mfe's territory.
 *   The shell never requests them; the MFE writes `project`/`projects` in by
 *   emitting `app/context/project/opened` and `app/context/projects`.
 *
 * Until projects-mfe emits those, the slot simply stays at `org` scope. That is
 * the designed resting state, not a missing feature.
 */

import { createSlice, type ReducerPayload } from '@gears-frontx/react';

/** Anything the slot can name: an id to switch by and a name to show. */
export interface ContextEntity {
  id: string;
  name: string;
}

/** Which list the chevron opens. */
export type ContextScope = 'org' | 'project';

export interface AppContextState {
  scope: ContextScope;
  /** The organization in scope. Null until account-management answers. */
  org: ContextEntity | null;
  /** Organizations the user may switch to, current one included. */
  orgs: ContextEntity[];
  /** The open project. Non-null exactly when `scope` is `project`. */
  project: ContextEntity | null;
  /** Projects the switcher offers, as published by projects-mfe. */
  projects: ContextEntity[];
  /** True while the organization lookup is in flight. */
  loading: boolean;
}

const SLICE_KEY = 'app/context' as const;

const initialState: AppContextState = {
  scope: 'org',
  org: null,
  orgs: [],
  project: null,
  projects: [],
  loading: false,
};

const {
  slice,
  setContextLoading,
  setContextOrganizations,
  setContextOrg,
  setContextProjects,
  openContextProject,
  closeContextProject,
} = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    setContextLoading: (state: AppContextState, action: ReducerPayload<boolean>) => {
      state.loading = action.payload;
    },

    /** The resolved organization list and which of them is current. */
    setContextOrganizations: (
      state: AppContextState,
      action: ReducerPayload<{ current: ContextEntity | null; items: ContextEntity[] }>
    ) => {
      state.org = action.payload.current;
      state.orgs = action.payload.items;
    },

    /**
     * Switch organization. Kept separate from the list so a switch does not
     * have to restate every option, and resolved against `orgs` so an unknown
     * id cannot leave the slot naming an organization that is not offered.
     */
    setContextOrg: (state: AppContextState, action: ReducerPayload<string>) => {
      const next = state.orgs.find((org) => org.id === action.payload);
      if (!next) return;
      state.org = next;
      // Leaving the organization invalidates anything scoped under it.
      state.scope = 'org';
      state.project = null;
      state.projects = [];
    },

    setContextProjects: (
      state: AppContextState,
      action: ReducerPayload<ContextEntity[]>
    ) => {
      state.projects = action.payload;
    },

    /** A project was opened — the slot starts naming it. */
    openContextProject: (
      state: AppContextState,
      action: ReducerPayload<ContextEntity>
    ) => {
      state.scope = 'project';
      state.project = action.payload;
    },

    /**
     * Back up to the organization. The shell triggers this itself whenever a
     * global screen mounts from the drawer: choosing Projects or People means
     * you are no longer inside a project, and no MFE has to tell us so.
     */
    closeContextProject: (state: AppContextState) => {
      state.scope = 'org';
      state.project = null;
    },
  },
});

export const appContextSlice = slice;
export {
  setContextLoading,
  setContextOrganizations,
  setContextOrg,
  setContextProjects,
  openContextProject,
  closeContextProject,
};
export const APP_CONTEXT_SLICE_KEY = SLICE_KEY;

export default slice.reducer;
