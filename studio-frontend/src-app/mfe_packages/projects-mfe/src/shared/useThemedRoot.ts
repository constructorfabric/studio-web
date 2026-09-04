/** For popups that portal out of the MFE's shadow
 * root and would otherwise paint with the document's theme. */


import { useCallback, useState } from 'react';

export function useThemedRoot(): [HTMLElement | null, (node: HTMLElement | null) => void] {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    setRoot(node?.closest<HTMLElement>('[data-theme]') ?? null);
  }, []);
  return [root, attach];
}
