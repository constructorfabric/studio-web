/** The Specs list's type decisions still being sent, by binding id (#690). */

import { createSlice, type ReducerPayload } from '@gears-frontx/react';
import { closeProject, openProject } from './navSlice';

export interface TypeDecisionState {
  pending: string[];
}

const SLICE_KEY = 'projects/typeDecision' as const;

const initialState: TypeDecisionState = { pending: [] };

const { slice, decisionStarted, decisionSettled } = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    decisionStarted: (state: TypeDecisionState, action: ReducerPayload<string>) => {
      if (!state.pending.includes(action.payload)) state.pending.push(action.payload);
    },
    decisionSettled: (state: TypeDecisionState, action: ReducerPayload<string>) => {
      state.pending = state.pending.filter((id) => id !== action.payload);
    },
  },
  extraReducers: (builder) => {
    builder.addCase(openProject, () => initialState).addCase(closeProject, () => initialState);
  },
});

export const typeDecisionSlice = slice;
export { decisionStarted, decisionSettled };
export const TYPE_DECISION_SLICE_KEY = SLICE_KEY;

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/typeDecision': TypeDecisionState;
  }
}

export default slice.reducer;
