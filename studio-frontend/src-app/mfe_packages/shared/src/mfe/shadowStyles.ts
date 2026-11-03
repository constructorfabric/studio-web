/**
 * Constructable stylesheets for shadow-root adoption.
 *
 * Styles used to reach a shadow root as DOM nodes, including the `<link>`
 * `MfeHandlerMF.injectRemoteStylesheets` appends before `mount`. Those arrive
 * strictly after the first paint of the mounted tree — a `<link>` in a
 * still-detached root does not even begin loading (measured: nothing after 300ms
 * detached, 18ms once attached). So first paint was unstyled: a flash on every
 * mount, a jump in the overlay whose card shrink-wraps content that late CSS
 * sizes.
 *
 * The fix is a cache that is already warm by the time anyone mounts, not a
 * mount that waits. `prewarmShadowStyles` fetches every sheet at bootstrap, from
 * URLs the MFE manifest carries long before a click; `warmShadowStyles` then
 * reads them back **synchronously**, so `mount` adopts everything before its
 * first render without introducing an await. A cold read returns `null` and the
 * caller takes the old DOM-node path for that one mount — slower, never blank,
 * and warm by the next one.
 *
 * @packageDocumentation
 */

/**
 * Adoption is all-or-nothing, and that is a cascade fact: adopted sheets rank
 * after a root's own `styleSheets` whatever the insertion order, so moving only
 * some of them would silently re-rank the rest — the shell's Tailwind would start
 * beating the ui-kit theme. A runtime without constructed sheets therefore keeps
 * the DOM-node path for all of them. jsdom 26 is that runtime, which is why the
 * fallback is what vitest exercises.
 */
const CONSTRUCTED_SHEETS_SUPPORTED: boolean = (() => {
  if (typeof ShadowRoot === 'undefined' || typeof CSSStyleSheet === 'undefined') return false;
  if (!('adoptedStyleSheets' in ShadowRoot.prototype)) return false;
  try {
    new CSSStyleSheet().replaceSync('');
    return true;
  } catch {
    return false;
  }
})();

export function constructedSheetsSupported(): boolean {
  return CONSTRUCTED_SHEETS_SUPPORTED;
}

/**
 * Sheets built from a host `<style>`, keyed by the element. Mutated in place
 * rather than rebuilt, so a Vite HMR update to the shell's CSS reaches every
 * root that already adopted it. No warming needed: a `<style>`'s text is
 * available synchronously, which is why only `<link>`s appear below.
 */
const sheetByElement = new WeakMap<Element, { text: string; sheet: CSSStyleSheet }>();

/** Sheets built from CSS text the caller owns (base resets, per-MFE additions). */
const sheetByText = new Map<string, CSSStyleSheet>();

/**
 * In-flight fetches, so concurrent warmings of one URL share a request. The
 * entry is dropped again on a network failure — see `sheetFromHref`.
 */
const pendingByHref = new Map<string, Promise<void>>();

/**
 * The warm cache the synchronous path reads. A `CSSStyleSheet` is adoptable; a
 * `null` is a sheet that was fetched and found permanently unadoptable; a
 * missing key means "not fetched yet, or last attempt failed transiently".
 * Prod URLs are content-hashed; in dev they are stable while the bytes change,
 * so HMR of an MFE's own CSS needs a reload (the `<style>` path has no such gap).
 */
const settledByHref = new Map<string, CSSStyleSheet | null>();

/** Cached by the text itself, so callers must pass stable strings. */
export function sheetFromText(css: string): CSSStyleSheet {
  const cached = sheetByText.get(css);
  if (cached) return cached;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  sheetByText.set(css, sheet);
  return sheet;
}

function sheetFromElement(element: Element): CSSStyleSheet {
  const text = element.textContent ?? '';
  const cached = sheetByElement.get(element);
  if (cached && cached.text === text) return cached.sheet;
  const sheet = cached?.sheet ?? new CSSStyleSheet();
  sheet.replaceSync(text);
  sheetByElement.set(element, { text, sheet });
  return sheet;
}

/**
 * A response that will never yield a sheet however many times it is fetched — a
 * 404 after a bad deploy — as opposed to a fetch that happened to fail. The two
 * are cached differently: this one sticks, so a bad deploy costs one request and
 * one warning rather than one per mount per MFE; a transient failure is
 * forgotten, because the cache is shared by the shell and every MFE and a moment
 * offline must not degrade the whole session to the DOM-node path.
 *
 * Note what is NOT in this class: adoption drops a constructed sheet's base URL,
 * so a relative `url()` would resolve against the document and `@import` is
 * dropped by `replaceSync` outright. Neither is guarded here. No sheet in this
 * repo has either — the only `url()`s are the shell's root-relative `@font-face`
 * srcs, which resolve identically with or without a base and are inert in a
 * shadow root anyway. Guarding it meant ~30 lines of regex that, on today's
 * input, rewrote 19 tokens into themselves.
 */
class UnadoptableSheet extends Error {}

function sheetFromHref(href: string): Promise<void> {
  if (settledByHref.has(href)) return Promise.resolve();
  const inFlight = pendingByHref.get(href);
  if (inFlight) return inFlight;

  const pending = fetch(href)
    .then((response) => {
      if (!response.ok) throw new UnadoptableSheet(`HTTP ${response.status}`);
      return response.text();
    })
    .then((css) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      settledByHref.set(href, sheet);
    })
    .catch((error: unknown) => {
      if (error instanceof UnadoptableSheet) settledByHref.set(href, null);
      console.warn(
        `[shadowStyles] Could not adopt stylesheet '${href}'; it keeps the <link> path:`,
        error instanceof Error ? error.message : String(error)
      );
    })
    .finally(() => {
      pendingByHref.delete(href);
    });

  pendingByHref.set(href, pending);
  return pending;
}

function isSameOrigin(href: string): boolean {
  try {
    return new URL(href, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * The shell's own same-origin `<link>`s. Cross-origin ones are deliberately NOT
 * fetched: a third party's latency would sit between the click and the first
 * paint (63ms measured for Google Fonts, 3x the MFE's own CSS), and all that
 * lives there is `@font-face`, which a shadow root ignores anyway.
 */
function hostStylesheetHrefs(): string[] {
  return Array.from(
    document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
    (link) => link.href
  ).filter(isSameOrigin);
}

/**
 * Fetch every sheet a shadow root will need, ahead of any mount.
 *
 * Call once at bootstrap with the MFEs' own CSS URLs — the manifest carries them
 * as `metaData.publicPath` + `entries[].exposeAssets.css`, which is exactly what
 * `MfeHandlerMF.injectRemoteStylesheets` resolves its `<link>` hrefs from, so the
 * keys match. The shell's own `<link>`s are added here rather than asked for.
 *
 * Fire-and-forget by design: nothing waits on it, and a mount that arrives first
 * simply takes the DOM-node path once.
 */
export function prewarmShadowStyles(hrefs: readonly string[] = []): void {
  if (!CONSTRUCTED_SHEETS_SUPPORTED) return;
  for (const href of [...hostStylesheetHrefs(), ...hrefs]) {
    void sheetFromHref(href);
  }
}

/** What FrontX's lifecycle marks its copies of the host's styles with. */
export const ADOPTED_HOST_STYLE_ATTR = 'data-frontx-adopted-host-style';

/** The handler's own `<link>`s in a shadow root, without copies of the host's. */
function handlerLinks(shadowRoot: ShadowRoot): HTMLLinkElement[] {
  return Array.from(
    shadowRoot.querySelectorAll<HTMLLinkElement>(`link[rel="stylesheet"]:not([${ADOPTED_HOST_STYLE_ATTR}])`)
  );
}

/** Everything a shadow root adopts, plus the nodes that need handling around it. */
export interface WarmStyles {
  /**
   * Adoption order: the host document's, in head order, then the MFE's own CSS,
   * the order FrontX's DOM path gives them, so the MFE wins ties.
   */
  readonly sheets: readonly CSSStyleSheet[];
  /** How many of `sheets`, from the front, are the host document's. */
  readonly hostSheets: number;
  /** The handler's `<link>`s whose sheets are in `sheets` and must stop applying. */
  readonly supersededLinks: readonly HTMLLinkElement[];
  /** Host `<link>`s never adopted (cross-origin), cloned in as they always were. */
  readonly crossOriginLinks: readonly HTMLLinkElement[];
}

/**
 * Read the whole set back from the warm cache, synchronously, or `null` if any
 * sheet that belongs in `adoptedStyleSheets` is missing from it.
 *
 * All-or-nothing, and not out of tidiness: a `<link>` left in the root ranks
 * *before* every adopted sheet, so adopting the host's Tailwind while the MFE's
 * CSS stays a link would invert those two and hand utility-vs-module ties to the
 * host. Cross-origin host links are exempt because they are never
 * adopted in either mode, and carry only `@font-face`, which a shadow root
 * ignores — their rank cannot matter.
 */
export function warmShadowStyles(shadowRoot: ShadowRoot): WarmStyles | null {
  const remoteLinks = handlerLinks(shadowRoot);
  const sheets: CSSStyleSheet[] = [];

  // One query for both tags, so the host's half is in document order — which is
  // the order these sheets have as DOM nodes, and therefore the order adoption
  // must preserve. In a production build that is the compiled-Tailwind `<link>`
  // first and the runtime-appended `<style>`s after it (`injectStudioStyles`;
  // note `#frontx-theme-vars` is NOT one of them — `themeRegistry` writes it
  // through `insertRule`, so its `textContent` is empty and it contributes
  // nothing here either way).
  const crossOriginLinks: HTMLLinkElement[] = [];
  const hostNodes = Array.from(
    document.head.querySelectorAll<HTMLStyleElement | HTMLLinkElement>(
      'style, link[rel="stylesheet"]'
    )
  );
  for (const node of hostNodes) {
    if (node instanceof HTMLLinkElement) {
      if (!isSameOrigin(node.href)) {
        crossOriginLinks.push(node);
        continue;
      }
      const settled = settledByHref.get(node.href);
      if (!settled) return null;
      sheets.push(settled);
      continue;
    }
    sheets.push(sheetFromElement(node));
  }

  const hostSheets = sheets.length;
  for (const link of remoteLinks) {
    const settled = settledByHref.get(link.href);
    if (!settled) return null;
    sheets.push(settled);
  }

  return { sheets, hostSheets, supersededLinks: remoteLinks, crossOriginLinks };
}

/** The handler's `<link>` hrefs in this root, to warm after a cold mount. */
export function remoteStylesheetHrefs(shadowRoot: ShadowRoot): string[] {
  return handlerLinks(shadowRoot).map((link) => link.href);
}

/**
 * Stop an adopted `<link>` from also applying, without taking ownership of a
 * node `MfeHandlerMF` created — the handler removes it by id on unmount, and a
 * future version may dedupe injection by internal state.
 *
 * `media`, not `disabled`: the `disabled` setter returns early while the
 * element's associated CSS style sheet is null, and on a warm cache that is
 * exactly the state here — the root is still detached, so the link has not
 * begun loading. Setting `disabled` there is a silent no-op and the sheet would
 * later load and be parsed a second time. `media` is a content attribute and
 * applies immediately.
 */
export function supersedeLink(link: HTMLLinkElement): void {
  link.media = 'not all';
}
