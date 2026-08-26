/**
 * App Session Slice
 *
 * Who is signed in, as the shell knows them.
 *
 * A slice of its own, and not a field on `app/context`: that one is the top
 * bar's slot — which organization, which project, what the chevron offers. The
 * subject of the session is not that, and giving it a home there would make the
 * slot's state mean two things.
 *
 * It exists because the shell had nowhere to keep this. The framework's
 * `setUser` fills the header with a display name and an email and drops the
 * identifier, so "who am I, authoritatively" was a fact the shell resolved and
 * then forgot. That gap is what pushed projects-mfe into reading the framework's
 * auth handoff off `globalThis` and decoding the JWT itself: the answer existed
 * for one call stack and was never stored, so it could not be published.
 *
 * Now it is stored, and `bootstrapMFE` reads it here to publish the session
 * profile to MFEs as soon as their domains are registered — whichever finished
 * first, the identity fetch or the manifest fetch.
 *
 * Display data only. `id` is what the backend means by this subject (`/me`'s
 * `subject_id`) and what a project's `owner_id` is written from; the two strings
 * come from token claims. Every authorization decision stays with the backend,
 * which verifies the signature.
 */

import { createSlice, type ReducerPayload } from '@gears-frontx/react';

export interface SessionProfile {
  id: string;
  displayName?: string;
  email?: string;
}

export interface AppSessionState {
  profile: SessionProfile | null;
}

const SLICE_KEY = 'app/session' as const;

const initialState: AppSessionState = { profile: null };

const { slice, setSessionProfile, clearSessionProfile } = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    setSessionProfile: (
      state: AppSessionState,
      action: ReducerPayload<SessionProfile>
    ) => {
      state.profile = action.payload;
    },
    clearSessionProfile: (state: AppSessionState) => {
      state.profile = null;
    },
  },
});

export const appSessionSlice = slice;
export { setSessionProfile, clearSessionProfile };
export const APP_SESSION_SLICE_KEY = SLICE_KEY;

export default slice.reducer;
