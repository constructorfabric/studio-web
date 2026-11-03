/** The shell's toast, bound to this MFE's bridge: the only way an MFE shows one. */

import { useCallback } from 'react';
import { useMfeBridge } from '@gears-frontx/react';
import { notify, type StudioNotice } from './hostActions';

export function useNotify(): (notice: StudioNotice) => void {
  const bridge = useMfeBridge();
  return useCallback((notice: StudioNotice) => notify(bridge, notice), [bridge]);
}
