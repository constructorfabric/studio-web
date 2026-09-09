import { createSlice, type ReducerPayload } from '@gears-frontx/react';

export type ProjectSection =
  | 'overview'
  | 'artifacts'
  | 'findings'
  | 'activity'
  | 'timeline'
  | 'team'
  | 'settings';

/** Where a freshly opened project lands, and what its rail item is. */
export const DEFAULT_PROJECT_SECTION: ProjectSection = 'overview';

export const PROJECT_SECTIONS: readonly ProjectSection[] = [
  'overview',
  'artifacts',
  'findings',
  'activity',
  'timeline',
  'team',
  'settings',
];

/** The shell relays the section as an opaque token; this is where it is checked. */
export function isProjectSection(value: unknown): value is ProjectSection {
  return typeof value === 'string' && (PROJECT_SECTIONS as readonly string[]).includes(value);
}

export interface NavState {
  projectId: string | null;
  section: ProjectSection;
}

const SLICE_KEY = 'projects/nav' as const;

const initialState: NavState = {
  projectId: null,
  section: 'overview',
};

const { slice, openProject, closeProject, selectSection, landOnFirstImport } = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
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
    landOnFirstImport: (state: NavState) => {
      if (state.section === 'overview') state.section = 'artifacts';
    },
  },
});

export const navSlice = slice;
export { openProject, closeProject, selectSection, landOnFirstImport };
export const NAV_SLICE_KEY = SLICE_KEY;

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/nav': NavState;
  }
}

export default slice.reducer;
