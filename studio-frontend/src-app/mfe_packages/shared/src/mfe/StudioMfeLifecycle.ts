/**
 * FrontX's MFE lifecycle with our shadow styles on top. When the warm cache
 * holds every sheet a shadow root needs, the mount adopts constructed sheets
 * instead of cloning `<link>`s that load after it, so the first paint is
 * styled; otherwise it takes FrontX's path and warms the cache for the next
 * mount. Both paths rank the same sheets in the same order: the host's,
 * FrontX's own base resets, the MFE's CSS, `additionalStyles` (the kit theme on
 * `:host`), then a transparent host.
 */
import { ThemeAwareReactLifecycle, type FrontXApp } from '@gears-frontx/react';
import {
  ADOPTED_HOST_STYLE_ATTR,
  constructedSheetsSupported,
  prewarmShadowStyles,
  remoteStylesheetHrefs,
  sheetFromText,
  supersedeLink,
  warmShadowStyles,
} from './shadowStyles';

const STUDIO_STYLES_ATTR = 'data-studio-mfe-styles';

/** FrontX's resets paint `:host` with `--background`, over the page the shell paints itself. */
const TRANSPARENT_HOST = ':host { background-color: transparent; }';

/** The id FrontX gives its base resets `<style>` (`BASE_RESETS_STYLE_ID`, not exported). */
const BASE_RESETS_STYLE_ID = '__frontx-base-resets__';

/** One `<style>` per `name`, reused across mounts and kept last. */
function appendStyle(container: ShadowRoot, name: string, css: string): void {
  const style =
    container.querySelector<HTMLStyleElement>(`style[${STUDIO_STYLES_ATTR}="${name}"]`) ?? document.createElement('style');
  style.setAttribute(STUDIO_STYLES_ATTR, name);
  style.textContent = css;
  container.appendChild(style);
}

export abstract class StudioMfeLifecycle extends ThemeAwareReactLifecycle {
  /**
   * Shadow roots whose last mount adopted constructed sheets, `additionalStyles`
   * among them, with how many of those sheets are the host's.
   */
  private readonly adopted = new WeakMap<ShadowRoot, number>();

  constructor(
    app: FrontXApp,
    private readonly additionalStyles: string
  ) {
    super(app);
  }

  protected override adoptHostStylesIntoShadowRoot(shadowRoot: ShadowRoot): void {
    const warm = constructedSheetsSupported() ? warmShadowStyles(shadowRoot) : null;
    if (!warm) {
      if (this.adopted.delete(shadowRoot)) shadowRoot.adoptedStyleSheets = [];
      const hrefs = remoteStylesheetHrefs(shadowRoot);
      super.adoptHostStylesIntoShadowRoot(shadowRoot);
      prewarmShadowStyles(hrefs);
      return;
    }
    shadowRoot.adoptedStyleSheets = [...warm.sheets, sheetFromText(this.additionalStyles), sheetFromText(TRANSPARENT_HOST)];
    for (const link of warm.supersededLinks) supersedeLink(link);
    for (const stale of shadowRoot.querySelectorAll(`[${ADOPTED_HOST_STYLE_ATTR}]`)) stale.remove();
    // Never adopted (cross-origin, `@font-face` only), so cloned in as FrontX does.
    for (const link of warm.crossOriginLinks) {
      const clone = link.cloneNode(true) as HTMLLinkElement;
      clone.setAttribute(ADOPTED_HOST_STYLE_ATTR, '');
      shadowRoot.insertBefore(clone, shadowRoot.firstChild);
    }
    this.adopted.set(shadowRoot, warm.hostSheets);
  }

  protected override initializeStyles(container: Element | ShadowRoot): void {
    if (!(container instanceof ShadowRoot)) return;
    const hostSheets = this.adopted.get(container);
    if (hostSheets === undefined) {
      appendStyle(container, 'kit', this.additionalStyles);
      appendStyle(container, 'host', TRANSPARENT_HOST);
      return;
    }
    // Adopted sheets rank after every `<style>`, so the resets FrontX has just
    // placed would lose to the host's preflight here, while on the cold path
    // they follow the host's copies. A copy is adopted where the cold path has
    // them; the `<style>` itself ranks below everything and changes nothing.
    const resets = container.querySelector(`style[id="${BASE_RESETS_STYLE_ID}"]`)?.textContent;
    if (!resets) return;
    const sheets = container.adoptedStyleSheets;
    container.adoptedStyleSheets = [...sheets.slice(0, hostSheets), sheetFromText(resets), ...sheets.slice(hostSheets)];
  }
}
