import { describe, expect, it } from 'vitest';
import { frontxThemes } from './index';

/**
 * Typography is a themed token, exactly like the palette: the shell declares
 * `--font-sans` per theme, Tailwind resolves `font-sans` to it, and `body`
 * applies it once. A theme that omits the token silently falls back to the
 * browser's default sans — so every registered theme must carry it.
 *
 * The name matches `--font-sans` in @gears-frontx/ui-kit's theme.css on
 * purpose: the kit governs MFE screens inside their shadow roots and the shell
 * governs the chrome, and one product should not read as two fonts.
 */
describe('frontxThemes typography tokens', () => {
  it('registers more than one theme', () => {
    expect(frontxThemes.length).toBeGreaterThan(1);
  });

  it.each(frontxThemes.map((theme) => [theme.id, theme] as const))(
    'theme %s declares a --font-sans stack led by Inter',
    (_id, theme) => {
      const stack = theme.variables['--font-sans'];
      expect(stack).toBeDefined();
      // 'Inter Variable' is the family @fontsource-variable registers — the
      // plain 'Inter' name has no @font-face behind it.
      expect(stack).toMatch(/^'Inter Variable'/);
    }
  );

  it.each(frontxThemes.map((theme) => [theme.id, theme] as const))(
    'theme %s keeps a system fallback after Inter, for first paint and offline',
    (_id, theme) => {
      expect(theme.variables['--font-sans']).toMatch(/system-ui/);
    }
  );

  it.each(frontxThemes.map((theme) => [theme.id, theme] as const))(
    'theme %s sizes the Body role with a length, not a bare number',
    (_id, theme) => {
      expect(theme.variables['--text-body-size']).toMatch(/^[\d.]+(rem|px)$/);
      expect(theme.variables['--text-body-line-height']).toMatch(/^[\d.]+(rem|px)$/);
    }
  );

  it.each(frontxThemes.map((theme) => [theme.id, theme] as const))(
    'theme %s sizes every role the shell renders',
    (_id, theme) => {
      for (const role of ['body', 'heading-1', 'label']) {
        expect(theme.variables[`--text-${role}-size`]).toMatch(/^[\d.]+(rem|px)$/);
        expect(theme.variables[`--text-${role}-line-height`]).toMatch(/^[\d.]+(rem|px)$/);
      }
    }
  );

  it('sizes the roles per the ui-kit ramp in the default theme', () => {
    const base = frontxThemes.find((theme) => theme.id === 'default');
    // Body 15/20, Heading 1 20/28, Label 13/16.
    expect(base?.variables['--text-body-size']).toBe('0.9375rem');
    expect(base?.variables['--text-body-line-height']).toBe('1.25rem');
    expect(base?.variables['--text-heading-1-size']).toBe('1.25rem');
    expect(base?.variables['--text-heading-1-line-height']).toBe('1.75rem');
    expect(base?.variables['--text-label-size']).toBe('0.8125rem');
    expect(base?.variables['--text-label-line-height']).toBe('1rem');
  });

  it('declares no weight tokens, since nothing resolves them', () => {
    for (const theme of frontxThemes) {
      const weightTokens = Object.keys(theme.variables).filter((name) =>
        /^--text-.*-weight$/.test(name)
      );
      expect(weightTokens).toEqual([]);
    }
  });
});
