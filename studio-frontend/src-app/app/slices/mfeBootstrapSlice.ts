/**
 * MFE Bootstrap Slice
 *
 * Tracks whether the MFE manifest has been fetched and its extensions
 * registered. Two things need this, and neither can derive it:
 *
 * 1. The menu must tell "still loading" from "genuinely no screens". Without it
 *    the first paint shows the empty-state hint and then swaps to the items.
 * 2. Extension registration is invisible to the store. `bootstrap.ts` calls
 *    `registry.registerExtension()` directly, and @gears-frontx/mfes neither
 *    emits an event nor dispatches — only mounting reaches the store, via the
 *    `executeActionsChain` wrapper in the microfrontends plugin. So a
 *    subscriber (`useDomainExtensions`) has nothing to wake it. Flipping this
 *    status to `ready` is that one store change, which is all a subscriber
 *    needs: by then every extension is registered.
 */

import { createSlice, type ReducerPayload } from '@gears-frontx/react';

/** `failed` means the manifest could not be loaded — the menu stays empty. */
export type MfeBootstrapStatus = 'pending' | 'ready' | 'failed';

export interface MfeBootstrapState {
  status: MfeBootstrapStatus;
}

const SLICE_KEY = 'app/mfe-bootstrap' as const;

const initialState: MfeBootstrapState = { status: 'pending' };

const { slice, setMfeBootstrapStatus } = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    setMfeBootstrapStatus: (
      state: MfeBootstrapState,
      action: ReducerPayload<MfeBootstrapStatus>
    ) => {
      state.status = action.payload;
    },
  },
});

export const mfeBootstrapSlice = slice;
export { setMfeBootstrapStatus };
export const MFE_BOOTSTRAP_SLICE_KEY = SLICE_KEY;

export default slice.reducer;
