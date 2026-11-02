import { afterEach, describe, expect, it } from 'vitest';
import { createThemeRegistry, type ThemeConfig } from '@gears-frontx/react';
import { darkTheme } from './dark';
import { lightTheme } from './light';

/**
 * What ADR-0034 takes from the framework's theme registry, now that it comes
 * from npm: `apply()` stamps `data-theme` from the theme's `appearance`, light
 * when it has none, so the kit's palette follows; and it writes the theme's
 * variables under `:root:root`, which outranks the kit's `[data-theme]` rules.
 */
describe('the framework theme registry with our themes', () => {
  afterEach(() => {
    document.getElementById('frontx-theme-vars')?.remove();
    document.documentElement.removeAttribute('data-theme');
  });

  it('stamps data-theme from the applied theme, light when it declares none', () => {
    const registry = createThemeRegistry();
    const bare: ThemeConfig = { id: 'bare', name: 'Bare', variables: {} };
    [darkTheme, lightTheme, bare].forEach((theme) => registry.register(theme));

    registry.apply(darkTheme.id);
    expect(document.documentElement.dataset.theme).toBe('dark');
    registry.apply(lightTheme.id);
    expect(document.documentElement.dataset.theme).toBe('light');
    registry.apply(darkTheme.id);
    registry.apply(bare.id);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it("writes a theme's variables under :root:root, above the kit's [data-theme] rules", () => {
    const registry = createThemeRegistry();
    registry.register(darkTheme);
    registry.apply(darkTheme.id);

    const sheet = (document.getElementById('frontx-theme-vars') as HTMLStyleElement).sheet;
    const rule = sheet?.cssRules[0] as CSSStyleRule | undefined;
    expect(rule?.selectorText).toBe(':root:root');
    expect(rule?.cssText).toContain('--font-sans');
  });
});
