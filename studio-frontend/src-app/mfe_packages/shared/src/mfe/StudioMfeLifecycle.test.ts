import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createMfeBridgeFixture } from '@frontx-test-utils/createMfeBridgeFixture';
import { createTestApp } from '@frontx-test-utils/createTestApp';
import { StudioMfeLifecycle } from './StudioMfeLifecycle';
import { prewarmShadowStyles, warmShadowStyles } from './shadowStyles';

// jsdom has no constructable stylesheets: just enough of them for the warm
// path, in place before shadowStyles checks for them at load.
vi.hoisted(() => {
  class FakeSheet {
    text = '';
    replaceSync(css: string): void {
      this.text = css;
    }
  }
  const adopted = new WeakMap<ShadowRoot, unknown[]>();
  Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
    configurable: true,
    get(this: ShadowRoot) {
      return adopted.get(this) ?? [];
    },
    set(this: ShadowRoot, sheets: unknown[]) {
      adopted.set(this, sheets);
    },
  });
  globalThis.CSSStyleSheet = FakeSheet as unknown as typeof CSSStyleSheet;
});

const ADDITIONAL = ':host { --kit: 1; }';
const HOST_STYLE = 'body { margin: 0; }';
const TRANSPARENT = ':host { background-color: transparent; }';
/** FrontX's own resets, a `<style>` the base class places on every mount. */
const isResets = (css: string) => css.includes('border-color: currentColor');

class TestLifecycle extends StudioMfeLifecycle {
  protected renderContent(): ReactNode {
    return null;
  }
}

// One FrontX app per runtime: the base class renders into it.
const app = createTestApp();
const { bridge } = createMfeBridgeFixture({ domainId: 'screen', instanceId: 'inst' });
const mounted: Array<{ lifecycle: TestLifecycle; shadow: ShadowRoot }> = [];

const absolute = (href: string) => new URL(href, location.href).href;
const cssOf = (href: string) => `/* ${absolute(href)} */`;
const texts = (shadow: ShadowRoot) => shadow.adoptedStyleSheets.map((sheet) => (sheet as unknown as { text: string }).text);

/** A shadow root as the MF handler leaves it before mount: its own stylesheet linked in. */
function shadowLinking(href: string): ShadowRoot {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  shadow.appendChild(link);
  return shadow;
}

function mount(shadow: ShadowRoot): void {
  const lifecycle = new TestLifecycle(app, ADDITIONAL);
  lifecycle.mount(shadow, bridge);
  mounted.push({ lifecycle, shadow });
}

async function warmed(href: string): Promise<ShadowRoot> {
  const shadow = shadowLinking(href);
  prewarmShadowStyles([absolute(href)]);
  await vi.waitFor(() => expect(warmShadowStyles(shadow)).not.toBeNull());
  return shadow;
}

beforeEach(() => {
  const style = document.createElement('style');
  style.textContent = HOST_STYLE;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/host.css';
  document.head.replaceChildren(link, style);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => new Response(`/* ${String(input)} */`));
});

afterEach(async () => {
  for (const { lifecycle, shadow } of mounted.splice(0)) await lifecycle.unmount(shadow);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('StudioMfeLifecycle', () => {
  it("a warm mount adopts host sheets before the MFE's own", async () => {
    const shadow = await warmed('/mfe-order.css');

    mount(shadow);

    const adopted = texts(shadow);
    expect(adopted.slice(0, 2)).toEqual([cssOf('/host.css'), HOST_STYLE]);
    expect(adopted.slice(3)).toEqual([cssOf('/mfe-order.css'), ADDITIONAL, TRANSPARENT]);
  });

  // A first mount takes the cold path and the next ones the warm path, so a tie
  // between two sheets has to go the same way on both: FrontX's resets say
  // `border-color: currentColor` and the host's preflight its own border colour.
  it('ranks the sheets in one order on both paths: host, resets, MFE, kit theme, transparent host', async () => {
    const cold = shadowLinking('/mfe-rank-cold.css');
    mount(cold);
    const warm = await warmed('/mfe-rank-warm.css');
    mount(warm);

    const label = (css: string, href?: string): string => {
      if (href?.endsWith('/host.css') || css === cssOf('/host.css') || css === HOST_STYLE) return 'host';
      if (isResets(css)) return 'resets';
      if (href?.includes('/mfe-rank-') || css.includes('/mfe-rank-')) return 'mfe';
      if (css === ADDITIONAL) return 'kit';
      return css === TRANSPARENT ? 'transparent' : css;
    };
    const coldOrder = Array.from(cold.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style, link[rel="stylesheet"]'), (node) =>
      node instanceof HTMLLinkElement ? label('', node.href) : label(node.textContent ?? '')
    );
    // Adopted sheets rank after every `<style>`, so on the warm path the order is
    // the adopted one; the resets `<style>` left in the root ranks below it all.
    const warmOrder = texts(warm).map((css) => label(css));

    const order = ['host', 'host', 'resets', 'mfe', 'kit', 'transparent'];
    expect(coldOrder).toEqual(order);
    expect(warmOrder).toEqual(order);
  });

  it("a warm mount switches off the handler's links", async () => {
    const shadow = await warmed('/mfe-links.css');

    mount(shadow);

    expect(shadow.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.media).toBe('not all');
    expect(shadow.querySelector('[data-frontx-adopted-host-style]')).toBeNull();
  });

  it('a cold mount uses the base class and warms the cache', async () => {
    const shadow = shadowLinking('/mfe-cold.css');

    mount(shadow);

    expect(shadow.adoptedStyleSheets).toEqual([]);
    expect(shadow.querySelectorAll('[data-frontx-adopted-host-style]')).toHaveLength(2);
    const next = shadowLinking('/mfe-cold.css');
    await vi.waitFor(() => expect(warmShadowStyles(next)).not.toBeNull());
  });

  it('additionalStyles reaches the shadow root on both paths', async () => {
    const cold = shadowLinking('/mfe-both-cold.css');
    mount(cold);
    const warm = await warmed('/mfe-both-warm.css');
    mount(warm);

    const styleTexts = (shadow: ShadowRoot) => Array.from(shadow.querySelectorAll('style'), (style) => style.textContent);
    expect(styleTexts(cold)).toContain(ADDITIONAL);
    expect(texts(warm)).toContain(ADDITIONAL);
    expect(styleTexts(warm)).not.toContain(ADDITIONAL);
  });

  // FrontX's resets paint `:host` with `--background`, over the page the shell paints.
  it("the host paints nothing over the shell's page, on both paths", async () => {
    const transparent = /^:host \{ background-color: transparent; \}$/;
    const cold = shadowLinking('/mfe-host-cold.css');
    mount(cold);
    const warm = await warmed('/mfe-host-warm.css');
    mount(warm);

    const coldStyles = Array.from(cold.querySelectorAll('style'), (style) => style.textContent ?? '');
    const resets = coldStyles.findIndex((css) => css.includes('background-color: var(--background)'));
    expect(resets).toBeGreaterThanOrEqual(0);
    const warmSheets = texts(warm);
    expect(coldStyles[coldStyles.length - 1]).toMatch(transparent);
    expect(warmSheets[warmSheets.length - 1]).toMatch(transparent);
  });
});
