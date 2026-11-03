import { describe, expect, it } from 'vitest';
import { anchorKitThemeOnShadowHost } from './anchorKitThemeOnShadowHost';

describe('anchorKitThemeOnShadowHost', () => {
  it('re-anchors a bare :root block on :host', () => {
    const css = ':root {\n  --background: #fff;\n}';
    expect(anchorKitThemeOnShadowHost(css)).toBe(':host {\n  --background: #fff;\n}');
  });

  it('re-anchors every :root in a selector list', () => {
    const css = ":root,[data-theme='light'] { --x: 1; }";
    expect(anchorKitThemeOnShadowHost(css)).toBe(":host,[data-theme='light'] { --x: 1; }");
  });

  it('handles minified single-line CSS with multiple :root rules', () => {
    const css = ":root{--a:1}:root:not([data-theme='light']){--a:2}[data-theme='dark']{--a:3}";
    expect(anchorKitThemeOnShadowHost(css)).toBe(
      ":host{--a:1}:host:not([data-theme='light']){--a:2}[data-theme='dark']{--a:3}"
    );
  });

  it('strips comments so :root inside a comment produces no phantom rule', () => {
    const css = '/* :root is documented here */ :root { --x: 1; }';
    expect(anchorKitThemeOnShadowHost(css)).toBe(' :host { --x: 1; }');
  });

  it('does not touch selectors that merely contain the word root', () => {
    const css = '.root { --x: 1; } #root { --y: 2; }';
    expect(anchorKitThemeOnShadowHost(css)).toBe('.root { --x: 1; } #root { --y: 2; }');
  });
});
