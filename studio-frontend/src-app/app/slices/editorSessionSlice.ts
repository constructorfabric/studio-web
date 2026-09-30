// @cpt-state:cpt-studiofrontend-state-editor-session:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-session-address:p1
/**
 * Editor Session Slice — what the editor's session is doing, for the status
 * over the editor's slot.
 */

import { createSlice, type FrontXApp, type ReducerPayload } from '@gears-frontx/react';

export type EditorSessionPhase = 'idle' | 'launching' | 'ready' | 'failed';

export type EditorSessionFailure =
  /** The project's sources or the organization's connections could not be read; nothing was launched. */
  | { kind: 'sources' }
  /** The launch was refused; a 503's `detail` says whether sessions are off or there is no capacity. */
  | { kind: 'refused'; detail: string | null }
  /** 404: the member no longer reaches the project. */
  | { kind: 'unavailable' }
  /** The readiness run failed or was cancelled. */
  | { kind: 'run'; error: string | null }
  | { kind: 'stopped' }
  /** No run, and the record did not say running within one probe attempt. */
  | { kind: 'timeout' }
  /** The run or the record could not be read several times in a row (401, 403, 5xx); the console has the first. */
  | { kind: 'read' }
  /** The session is up, but the IDE in the frame said nothing for two minutes; a late answer still opens it. */
  | { kind: 'unanswered' }
  /** The portal itself threw while launching; the console has the error. */
  | { kind: 'unexpected' };

export interface EditorSessionState {
  phase: EditorSessionPhase;
  failure: EditorSessionFailure | null;
  shown: boolean;
}

const SLICE_KEY = 'app/editor-session' as const;

const initialState: EditorSessionState = { phase: 'idle', failure: null, shown: false };

const {
  slice,
  editorSessionReset,
  editorSessionLaunching,
  editorSessionReady,
  editorSessionFailed,
  editorSessionShown,
} = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    editorSessionReset: (state: EditorSessionState) => {
      state.phase = 'idle';
      state.failure = null;
    },
    editorSessionLaunching: (state: EditorSessionState) => {
      state.phase = 'launching';
      state.failure = null;
    },
    editorSessionReady: (state: EditorSessionState) => {
      state.phase = 'ready';
      state.failure = null;
    },
    editorSessionFailed: (state: EditorSessionState, action: ReducerPayload<EditorSessionFailure>) => {
      state.phase = 'failed';
      state.failure = action.payload;
    },
    editorSessionShown: (state: EditorSessionState, action: ReducerPayload<boolean>) => {
      state.shown = action.payload;
    },
  },
});

export function readEditorSession(app: Pick<FrontXApp, 'store'>): EditorSessionState {
  return (
    ((app.store.getState() as Record<string, unknown>)[SLICE_KEY] as EditorSessionState | undefined) ??
    initialState
  );
}

export const editorSessionSlice = slice;
export {
  editorSessionReset,
  editorSessionLaunching,
  editorSessionReady,
  editorSessionFailed,
  editorSessionShown,
};
export const EDITOR_SESSION_SLICE_KEY = SLICE_KEY;

export default slice.reducer;
