/** Where DataGrid's text-search plugin puts its value in `DataGridLoadContext.filters`, its default key. */
export const TEXT_SEARCH_FILTER_KEY = 'textSearch';

/**
 * The value a tag group filter holds: the kit hands a list, also in `radio` mode,
 * and a stored value can have any shape, so anything but a list of strings reads as none.
 */
export function tagGroupChoice(state: { value?: unknown } | undefined): string | null {
  const value = state?.value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}
