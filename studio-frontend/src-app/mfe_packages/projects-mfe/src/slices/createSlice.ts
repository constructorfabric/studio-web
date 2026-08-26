/**
 * The New project wizard's state: which step, and the draft being filled.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-reset:p1
// @cpt-dod:cpt-studiofrontend-dod-project-create-many-sources:p1
import { createSlice, type ReducerPayload } from '@gears-frontx/react';
import {
  EMPTY_DRAFT,
  MAX_SOURCES,
  sourceKey,
  type ProjectDraft,
  type RepositoryPick,
} from '../model/projectDraft';
import { FIRST_STEP_KEY, type WizardStepKey } from '../model/wizardSteps';

export interface CreateState {
  stepKey: WizardStepKey;
  draft: ProjectDraft;
  connectionId: string | null;
  repoSearch: string;
  submitting: boolean;
  error: string | null;
}

const SLICE_KEY = 'projects/create' as const;

const initialState: CreateState = {
  stepKey: FIRST_STEP_KEY,
  draft: EMPTY_DRAFT,
  connectionId: null,
  repoSearch: '',
  submitting: false,
  error: null,
};

const {
  slice,
  resetWizard,
  goToStep,
  editDraft,
  pickSource,
  selectConnection,
  searchRepositories,
  submitStarted,
  submitFailed,
} = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    // @cpt-begin:cpt-studiofrontend-dod-project-create-reset:p1:inst-1
    resetWizard: (state: CreateState) => {
      state.stepKey = FIRST_STEP_KEY;
      state.draft = EMPTY_DRAFT;
      state.connectionId = null;
      state.repoSearch = '';
      state.submitting = false;
      state.error = null;
    },
    // @cpt-end:cpt-studiofrontend-dod-project-create-reset:p1:inst-1
    goToStep: (state: CreateState, action: ReducerPayload<WizardStepKey>) => {
      state.stepKey = action.payload;
    },
    editDraft: (state: CreateState, action: ReducerPayload<Partial<ProjectDraft>>) => {
      state.draft = { ...state.draft, ...action.payload };
      state.error = null;
    },
    // @cpt-begin:cpt-studiofrontend-dod-project-create-many-sources:p1:inst-1
    pickSource: (state: CreateState, action: ReducerPayload<RepositoryPick>) => {
      const key = sourceKey(action.payload);
      const kept = state.draft.sources.filter((pick) => sourceKey(pick) !== key);
      const wasPicked = kept.length !== state.draft.sources.length;
      if (wasPicked) {
        state.draft = { ...state.draft, sources: kept };
      } else {
        if (kept.length >= MAX_SOURCES) return;
        state.draft = { ...state.draft, sources: [...kept, action.payload] };
      }
      state.error = null;
    },
    // @cpt-end:cpt-studiofrontend-dod-project-create-many-sources:p1:inst-1
    selectConnection: (state: CreateState, action: ReducerPayload<string>) => {
      if (state.connectionId === action.payload) return;
      state.connectionId = action.payload;
      state.repoSearch = '';
    },
    searchRepositories: (state: CreateState, action: ReducerPayload<string>) => {
      state.repoSearch = action.payload;
    },
    submitStarted: (state: CreateState) => {
      state.submitting = true;
      state.error = null;
    },
    submitFailed: (state: CreateState, action: ReducerPayload<string>) => {
      state.submitting = false;
      state.error = action.payload;
    },
  },
});

export const createWizardSlice = slice;
export {
  resetWizard,
  goToStep,
  editDraft,
  pickSource,
  selectConnection,
  searchRepositories,
  submitStarted,
  submitFailed,
};
export const CREATE_SLICE_KEY = SLICE_KEY;

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/create': CreateState;
  }
}

export default slice.reducer;
