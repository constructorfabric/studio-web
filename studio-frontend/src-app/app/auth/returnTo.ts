/**
 * Where the person was before the sign-in redirect (ADR-0022, "A link
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
