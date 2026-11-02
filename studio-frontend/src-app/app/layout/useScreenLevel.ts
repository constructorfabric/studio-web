/** The level the session is at: the level of the screen on display. */

import {
  useAppSelector,
  FRONTX_SCREEN_DOMAIN,
} from '@gears-frontx/react';
import { useMountedExtensions } from '@/app/mfe/domainOccupancy';
import { levelOf, type ScreenLevel, type StudioScreenExtension } from '@/app/mfe/screenLevels';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';

export function useScreenLevel(): ScreenLevel {
  // Index 0 is meaningful because the screen domain mounts exclusively.
  const mounted = useMountedExtensions(FRONTX_SCREEN_DOMAIN)[0] as StudioScreenExtension | undefined;
  const project = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.project ?? null
  );

  // An open project deepens the level without changing what is mounted: the
  // projects MFE opens one from its own list, and its announcement is what
  // moves the session down. Mounting is the only other way levels change, so
  // the two together are the whole rule.
  if (project) return 'project';
  return mounted ? levelOf(mounted) : 'organization';
}
