/**
 * Where this MFE is: the flat project list, or one open project and which of
 * its sections. It is MFE-local navigation on purpose — ADR-0008 puts the
 * project's 232px rail *inside* the project frame, and the shell has no router,
 * so there is no URL to own.
 *
 * `projectId === null` IS the list view; a separate `view` field could disagree
 * with it.
 */

import { createSlice, type ReducerPayload } from '@gears-frontx/react';

export type ProjectSection =
  | 'overview'
  | 'artifacts'
  | 'findings'
  | 'activity'
  | 'timeline'
  | 'team'
  | 'settings';

export interface NavState {
  projectId: string | null;
  section: ProjectSection;
}

const SLICE_KEY = 'projects/nav' as const;

const initialState: NavState = {
  projectId: null,
  section: 'overview',
};

const { slice, openProject, closeProject, selectSection } = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    /** Opening always lands on the first section, never on the last one seen. */
    openProject: (state: NavState, action: ReducerPayload<string>) => {
      state.projectId = action.payload;
      state.section = 'overview';
    },
    closeProject: (state: NavState) => {
      state.projectId = null;
      state.section = 'overview';
    },
    selectSection: (state: NavState, action: ReducerPayload<ProjectSection>) => {
      state.section = action.payload;
    },
  },
});

export const navSlice = slice;
export { openProject, closeProject, selectSection };
export const NAV_SLICE_KEY = SLICE_KEY;

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/nav': NavState;
  }
}

export default slice.reducer;
