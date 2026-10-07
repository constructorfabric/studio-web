/**
 * Reading the backend calls out of a portal's sources — the half that
 * `check-api-usage.mjs` (rule G3: every call has an endpoint) and
 * `prototype-api-map.mjs` (the /architecture/ page: which screen calls what)
 * share. One reader, so the page and the CI check cannot disagree about what
 * the prototype calls.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The gateway prefix every portal URL carries and no registered path does. */
export const PREFIX = '/cf';

/**
 * A path segment that stands for a value: `{id}` on the backend side,
 * `${...}` or an encoded interpolation on the portal side. A NUL, because no
 * real path segment contains one.
 */
export const WILDCARD = '\u0000';

/** Every `.ts`/`.tsx` file under `dir`. */
export function sources(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * Read the string or template literal opening at `start` in `text`; returns
 * its contents, with each `${…}` reduced to the marker `${}`, and where it ends.
 */
export function readLiteral(text, start) {
  const quote = text[start];
  let value = '';
  let at = start + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === '\\') {
      at += 2;
      continue;
    }
    if (char === quote) return { value, end: at + 1 };
    if (quote === '`' && char === '$' && text[at + 1] === '{') {
      value += '${}';
      at = skipInterpolation(text, at + 1);
      continue;
    }
    if (quote !== '`' && char === '\n') break; // an unterminated quote
    value += char;
    at += 1;
  }
  return { value, end: at + 1 };
}

/** Skip from an opening `${` to its matching `}`, nesting and all. */
function skipInterpolation(text, start) {
  let depth = 0;
  let at = start;
  while (at < text.length) {
    const char = text[at];
    if (char === '\\') at += 1;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return at + 1;
    } else if (char === '`' || char === "'" || char === '"') {
      at = readLiteral(text, at).end - 1; // a nested literal contributes nothing here
    }
    at += 1;
  }
  return text.length;
}

/**
 * Contents of every string and template literal in `text`, with each `${…}`
 * reduced to the marker `${}`.
 *
 * Hand-written rather than a regex because a template literal nests: the
 * prototype writes
 * `` `/studio-tasks/v1/runs${suffix ? `?state=${s}` : ''}` ``, and a regex that
 * ends the literal at the first backtick it meets reads that as a fragment —
 * which is a call this check would then silently not cover.
 */
export function literals(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '`' || char === "'" || char === '"') {
      const { value, end } = readLiteral(text, i);
      out.push(value);
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * `/cf/studio-documents/v1/workspaces/${id}/documents?x=1` →
 * `['studio-documents', 'v1', 'workspaces', WILDCARD, 'documents']`.
 *
 * Returns `null` for anything that is not a URL path we can reason about: a
 * bare base URL, a path in someone else's shape, or a template whose
 * interpolation nests another template — the literal scanner stops at the inner
 * backtick, so what is left is a fragment, and guessing at a fragment invents
 * findings rather than finding them. `stats.unparsed` counts the last kind.
 */
export function normalise(raw, stats = { unparsed: 0 }) {
  let path = raw.split('?')[0].split('#')[0];
  if (path.startsWith(PREFIX + '/')) path = path.slice(PREFIX.length);
  if (!path.startsWith('/')) return null;
  // An interpolation is one segment's worth of value, whatever it holds. So is
  // a `*` in a mock handler's pattern.
  path = path.replace(/\$\{[^}]*\}/g, WILDCARD);
  if (path.includes('${')) {
    stats.unparsed += 1; // an interpolation the literal scanner could not close
    return null;
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2 || !/^v\d+$/.test(segments[1])) return null;
  // `/studio-events/v1` on its own is a service's base URL, not a call.
  if (segments.length === 2) return null;
  return segments.map((segment) =>
    segment.includes(WILDCARD) || segment === '*' ? WILDCARD : segment
  );
}

/**
 * The base URL a service file declares, e.g. `/cf/studio-events/v1`.
 *
 * A file with two of them (or none) resolves no relative path: guessing which
 * base a `.query('/me')` belongs to would invent findings rather than find
 * them.
 */
export function baseUrl(text) {
  const bases = new Set(
    literals(text).filter((literal) => /^\/cf\/[a-z][a-z0-9-]*\/v\d+$/.test(literal))
  );
  return bases.size === 1 ? [...bases][0] : null;
}

/**
 * Relative endpoint paths declared through the FrontX protocols:
 * `.query<T>('/me')`, `.stream<T>('/stream')`, `.mutation<T, B>('POST', '/x')`.
 */
export function relativeEndpoints(text) {
  const out = [];
  const call = /\.(query|stream|mutation)\s*<[\s\S]*?>\s*\(\s*(?:(['"])([A-Z]+)\2\s*,\s*)?(['"`])([^'"`]*)\4/g;
  let match;
  while ((match = call.exec(text)) !== null) {
    if (match[5].startsWith('/')) out.push(match[5]);
  }
  return out;
}
