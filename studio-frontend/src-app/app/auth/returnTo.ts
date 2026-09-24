/**
 * Where the person was before the sign-in redirect (ADR-0028, "A link
 * survives the sign-in redirect").
 *
 * The OIDC `redirect_uri` is always the origin's root, so a pasted deep link
 * would be lost on the round trip. `login()` remembers the query and fragment
 * here; `AuthGate` puts them back with the same `replaceState` it already
 * uses to scrub the callback. Only a relative `?…` or `#…` is ever stored or
 * restored — never an origin, never a path — so nothing in storage can send
 * the person elsewhere.
 */
const KEY_RETURN_TO = 'studio.oidc.return_to';

function isRelative(value: string): boolean {
  return value.startsWith('?') || value.startsWith('#');
}

export function rememberReturnTo(location: { search: string; hash: string } = window.location): void {
  const value = `${location.search}${location.hash}`;
  if (isRelative(value)) sessionStorage.setItem(KEY_RETURN_TO, value);
  else sessionStorage.removeItem(KEY_RETURN_TO);
}

export function takeReturnTo(): string | null {
  const value = sessionStorage.getItem(KEY_RETURN_TO);
  sessionStorage.removeItem(KEY_RETURN_TO);
  return value !== null && isRelative(value) ? value : null;
}

function decodedName(segment: string): string {
  const name = segment.split('=')[0];
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * The query string without the named parameters, every other segment kept
 * byte-for-byte. Deliberately not `URLSearchParams`: deleting through it
 * re-serialises the whole query and turns the router grammar's `;` and `=`
 * inside a value into `%3B` and `%3D` (ADR-0028) — the address the shell
 * then reads names no screen at all.
 */
export function withoutCallbackParams(search: string, names: readonly string[]): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return '';
  const kept = raw.split('&').filter((segment) => segment !== '' && !names.includes(decodedName(segment)));
  return kept.length > 0 ? `?${kept.join('&')}` : '';
}
