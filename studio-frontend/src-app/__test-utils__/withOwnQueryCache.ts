/**
 * `@gears-frontx/react` for an MFE test that renders under `FrontXProvider`.
 * One FrontX app per runtime: the MFE's own from `init.ts`, with no host to
 * share a query client, so `queryCacheShared` answers with the app's own
 * `queryCache`; without it the provider throws "Mounted MFEs require
 * queryCacheShared() in the child app…". A test that fakes other exports
 * returns them from `overrides`, which gets the real module first:
 *
 *     vi.mock('@gears-frontx/react', (importOriginal) => withOwnQueryCache(importOriginal));
 *
 * Import it first: `vi.mock` is hoisted, and its factory runs on the first
 * import that loads the module, which can be any import below.
 */
type FrontXReact = typeof import('@gears-frontx/react');

export async function withOwnQueryCache(
  importOriginal: <T = unknown>() => Promise<T>,
  overrides?: (actual: FrontXReact) => Record<string, unknown>
): Promise<FrontXReact> {
  const actual = await importOriginal<FrontXReact>();
  return { ...actual, queryCacheShared: actual.queryCache, ...overrides?.(actual) } as FrontXReact;
}
