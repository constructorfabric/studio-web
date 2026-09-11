/**
 * The manifest names a rail icon as `lucide:<name>`; lucide's own loader takes
 * the bare name. Anything else — an Iconify set the shell no longer serves, or
 * a name lucide does not have — is dropped rather than guessed at, so a typo
 * shows as a missing glyph in an item that still has its label and its place.
 */

import type { IconName } from 'lucide-react/dynamic';

const LUCIDE_PREFIX = 'lucide:';

export function railIconName(
  declared: string | undefined,
  known: readonly IconName[]
): IconName | undefined {
  if (!declared?.startsWith(LUCIDE_PREFIX)) return undefined;
  const name = declared.slice(LUCIDE_PREFIX.length) as IconName;
  return known.includes(name) ? name : undefined;
}
