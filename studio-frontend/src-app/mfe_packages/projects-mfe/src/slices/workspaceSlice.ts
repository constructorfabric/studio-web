/** The New workspace form's state: one name, and what happened to it.*/

import { createSlice, type ReducerPayload } from '@gears-frontx/react';
import type { Refusal } from '@constructor-studio/mfe-shared';

/** The written workspace, with the organization it was written under. */
export interface CreatedWorkspace {
  id: string;
  name: string;
  orgId: string;
}

export interface WorkspaceCreateState {
  name: string;
  submitting: boolean;
  error: Refusal | null;
  created: CreatedWorkspace | null;
}

const SLICE_KEY = 'projects/workspace-create' as const;

const initialState: WorkspaceCreateState = {
  name: '',
  submitting: false,
  error: null,
  created: null,
};

const {
  slice,
  resetWorkspaceForm,
  editWorkspaceName,
  workspaceSubmitStarted,
  workspaceSubmitFailed,
  workspaceAnnounceFailed,
} = createSlice({
    name: SLICE_KEY,
    initialState,
    reducers: {
      /** Every opening starts clean — the store outlives the overlay root. */
      resetWorkspaceForm: (state: WorkspaceCreateState) => {
        state.name = '';
        state.submitting = false;
        state.error = null;
        state.created = null;
      },
      editWorkspaceName: (state: WorkspaceCreateState, action: ReducerPayload<string>) => {
        state.name = action.payload;
        state.error = null;
      },
      workspaceSubmitStarted: (state: WorkspaceCreateState) => {
        state.submitting = true;
        state.error = null;
      },
      /** The name survives a refusal: it is the thing the member must correct. */
      workspaceSubmitFailed: (
        state: WorkspaceCreateState,
        action: ReducerPayload<Refusal>
      ) => {
        state.submitting = false;
        state.error = action.payload;
      },
      workspaceAnnounceFailed: (
        state: WorkspaceCreateState,
        action: ReducerPayload<{ workspace: CreatedWorkspace; error: Refusal }>
      ) => {
        state.submitting = false;
        state.created = action.payload.workspace;
        state.error = action.payload.error;
      },
    },
  });

export const workspaceCreateSlice = slice;
export {
  resetWorkspaceForm,
  editWorkspaceName,
  workspaceSubmitStarted,
  workspaceSubmitFailed,
  workspaceAnnounceFailed,
};
export const WORKSPACE_CREATE_SLICE_KEY = SLICE_KEY;

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/workspace-create': WorkspaceCreateState;
  }
}

export default slice.reducer;
