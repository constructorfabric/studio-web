import { createSlice, type ReducerPayload } from '@gears-frontx/react';
import {
  isFileProblem,
  nameProblem,
  type BatchProblem,
  type UploadEntry,
  type UploadProblem,
  type UploadRead,
  type UploadSection,
} from '../model/documentUpload';
import { closeProject, openProject } from './navSlice';

export interface DocumentUploadState {
  entries: UploadEntry[];
  batchErrors: Partial<Record<UploadSection, BatchProblem>>;
}

const SLICE_KEY = 'projects/documentUpload' as const;

const initialState: DocumentUploadState = { entries: [], batchErrors: {} };

const entryOf = (state: DocumentUploadState, id: string) =>
  state.entries.find((entry) => entry.id === id);

const {
  slice,
  uploadPicked,
  uploadRead,
  uploadRetitled,
  uploadTyped,
  uploadTypedAll,
  uploadRemoved,
  uploadAdding,
  uploadAdded,
  uploadRefused,
  uploadDismissed,
} = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    /** Refused as a whole, nothing is added and `batchError` says why. */
    uploadPicked: (
      state: DocumentUploadState,
      action: ReducerPayload<{
        section: UploadSection;
        entries: UploadEntry[];
        batchError: BatchProblem | null;
      }>
    ) => {
      const { section, entries, batchError } = action.payload;
      if (batchError) state.batchErrors[section] = batchError;
      else delete state.batchErrors[section];
      state.entries.push(...entries);
    },
    /** The name is checked here, once: against the project's documents and the rest of the batch. */
    uploadRead: (
      state: DocumentUploadState,
      action: ReducerPayload<{ id: string; read: UploadRead; existingTitles: string[] }>
    ) => {
      const { id, read, existingTitles } = action.payload;
      const entry = entryOf(state, id);
      if (entry?.status !== 'reading') return;
      if ('problem' in read) {
        entry.status = 'error';
        entry.problem = read.problem;
        return;
      }
      entry.content = read.content;
      const problem = nameProblem(entry, state.entries, existingTitles);
      entry.status = problem ? 'error' : 'ready';
      entry.problem = problem;
    },
    /** The panel checks the name as it is typed; the row keeps why it stopped until it is sent. */
    uploadRetitled: (state: DocumentUploadState, action: ReducerPayload<{ id: string; title: string }>) => {
      const entry = entryOf(state, action.payload.id);
      if (entry) entry.title = action.payload.title;
    },
    uploadTyped: (state: DocumentUploadState, action: ReducerPayload<{ id: string; typeKey: string }>) => {
      const entry = entryOf(state, action.payload.id);
      if (entry) entry.typeKey = action.payload.typeKey;
    },
    uploadTypedAll: (
      state: DocumentUploadState,
      action: ReducerPayload<{ section: UploadSection; typeKey: string }>
    ) => {
      const { section, typeKey } = action.payload;
      for (const entry of state.entries) {
        if (
          entry.section === section &&
          entry.status !== 'added' &&
          entry.status !== 'adding' &&
          !isFileProblem(entry.problem)
        ) {
          entry.typeKey = typeKey;
        }
      }
    },
    uploadRemoved: (state: DocumentUploadState, action: ReducerPayload<string>) => {
      state.entries = state.entries.filter(
        (entry) => entry.id !== action.payload || entry.status === 'adding'
      );
    },
    uploadAdding: (state: DocumentUploadState, action: ReducerPayload<string[]>) => {
      for (const id of action.payload) {
        const entry = entryOf(state, id);
        if (!entry) continue;
        entry.status = 'adding';
        entry.problem = null;
        entry.message = null;
      }
    },
    uploadAdded: (state: DocumentUploadState, action: ReducerPayload<{ id: string; documentId: string }>) => {
      const entry = entryOf(state, action.payload.id);
      if (!entry) return;
      entry.status = 'added';
      entry.documentId = action.payload.documentId;
      entry.content = null;
    },
    uploadRefused: (
      state: DocumentUploadState,
      action: ReducerPayload<{ id: string; problem: UploadProblem; message?: string | null }>
    ) => {
      const entry = entryOf(state, action.payload.id);
      if (!entry) return;
      entry.status = 'error';
      entry.problem = action.payload.problem;
      entry.message = action.payload.message ?? null;
    },
    uploadDismissed: (state: DocumentUploadState, action: ReducerPayload<UploadSection>) => {
      state.entries = state.entries.filter((entry) => entry.section !== action.payload);
      delete state.batchErrors[action.payload];
    },
  },
  extraReducers: (builder) => {
    builder.addCase(openProject, () => initialState).addCase(closeProject, () => initialState);
  },
});

export const documentUploadSlice = slice;
export {
  uploadPicked,
  uploadRead,
  uploadRetitled,
  uploadTyped,
  uploadTypedAll,
  uploadRemoved,
  uploadAdding,
  uploadAdded,
  uploadRefused,
  uploadDismissed,
};
export const DOCUMENT_UPLOAD_SLICE_KEY = SLICE_KEY;

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/documentUpload': DocumentUploadState;
  }
}

export default slice.reducer;
