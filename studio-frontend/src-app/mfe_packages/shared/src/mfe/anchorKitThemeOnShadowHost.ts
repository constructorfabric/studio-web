/**
 * Re-anchors the ui-kit theme stylesheet on a Shadow DOM host.
 *
 * A ShadowRoot is a DocumentFragment, so a `:root` block delivers nothing
 * inside it — the kit's tokens must be re-anchored on `:host` to reach the
 * mounted screen. Comments are stripped first so `:root` inside a comment
 * cannot produce a phantom rule; the rewrite then anchors on /:root\b/g,
 * covering minified single-line CSS and `selector,:root` lists.
 *
 * `:root:not([data-theme='light'])` becomes `:host:not(...)`, which never
 * matches (a shadow host is featureless to non-functional compound
 * selectors) — deliberate: the screen root always carries an explicit
 * data-theme, so the kit's prefers-color-scheme fallback must not leak
 * through.
 */
export function anchorKitThemeOnShadowHost(css: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutComments.replace(/:root\b/g, ':host');
}
