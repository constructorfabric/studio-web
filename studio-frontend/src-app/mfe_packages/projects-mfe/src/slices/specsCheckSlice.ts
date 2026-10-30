/**
 * The Specs list's Check (#691): the rows it would send, which the header
 * button and the table share, and each project's check while it runs.
 */

import { createSlice, type ReducerPayload } from '@gears-frontx/react';
import type { QualityDetector } from '../api/documentTypes';
import type { SpecRow } from '../model/specRows';
import type { SpecsCheckOutcome, SpecsCheckTarget } from '../model/specsCheck';
import { closeProject, openProject } from './navSlice';

export interface SpecsCheck {
  /** The project's name, for the toast. */
  project: string;
  /** The specs asked for. */
  count: number;
  /** Each running run's last phase, `i/total · path`; absent until it reports. */
  phases: Partial<Record<QualityDetector, string>>;
  /** Set when both runs have ended; the toast shows it and lets the check go. */
  outcome: SpecsCheckOutcome | null;
}

export interface SpecsCheckState {
  /** The ticked row ids, written by #879's selection column. */
  selected: string[];
  /** The `checkable` rows the filters show, written after every load; `null` until the first. */
  shown: SpecsCheckTarget[] | null;
  /** By project id: a check outlives a switch of project. */
  checks: Record<string, SpecsCheck>;
}

const SLICE_KEY = 'projects/specsCheck' as const;

const initialState: SpecsCheckState = { selected: [], shown: null, checks: {} };

const {
  slice,
  specsSelected,
  specsShown,
  checkStarted,
  checkProgressed,
  checkEnded,
  outcomeShown,
} = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    specsSelected: (state: SpecsCheckState, action: ReducerPayload<string[]>) => {
      state.selected = action.payload;
    },
    /** #689's `snapshot.shown`; only its `checkable` rows are kept. */
    specsShown: (
      state: SpecsCheckState,
      action: ReducerPayload<readonly Pick<SpecRow, 'id' | 'origin' | 'checkable'>[]>
    ) => {
      state.shown = action.payload
        .filter((row) => row.checkable)
        .map(({ id, origin }) => ({ id, origin }));
    },
    /** The ticks stay while it runs: the reload at its end clears them (#879). */
    checkStarted: (
      state: SpecsCheckState,
      action: ReducerPayload<{ projectId: string; project: string; count: number }>
    ) => {
      const { projectId, project, count } = action.payload;
      state.checks[projectId] = { project, count, phases: {}, outcome: null };
    },
    /** `phase: null` drops a run that has ended. */
    checkProgressed: (
      state: SpecsCheckState,
      action: ReducerPayload<{
        projectId: string;
        detector: QualityDetector;
        phase: string | null;
      }>
    ) => {
      const { projectId, detector, phase } = action.payload;
      const check = state.checks[projectId];
      if (!check) return;
      if (phase === null) delete check.phases[detector];
      else check.phases[detector] = phase;
    },
    checkEnded: (
      state: SpecsCheckState,
      action: ReducerPayload<{ projectId: string; outcome: SpecsCheckOutcome }>
    ) => {
      const check = state.checks[action.payload.projectId];
      if (check) check.outcome = action.payload.outcome;
    },
    outcomeShown: (state: SpecsCheckState, action: ReducerPayload<string>) => {
      if (state.checks[action.payload]?.outcome) delete state.checks[action.payload];
    },
  },
  extraReducers: (builder) => {
    const reset = (state: SpecsCheckState) => ({ ...initialState, checks: state.checks });
    builder.addCase(openProject, reset).addCase(closeProject, reset);
  },
});

/** Whether the project's check is still running. */
export function checkRunning(state: SpecsCheckState, projectId: string): boolean {
  const check = state.checks[projectId];
  return Boolean(check) && check.outcome === null;
}

export const specsCheckSlice = slice;
export { specsSelected, specsShown, checkStarted, checkProgressed, checkEnded, outcomeShown };
export const SPECS_CHECK_SLICE_KEY = SLICE_KEY;

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/specsCheck': SpecsCheckState;
  }
}

export default slice.reducer;
