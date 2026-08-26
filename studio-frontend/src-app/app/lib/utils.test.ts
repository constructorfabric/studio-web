import { describe, expect, it } from 'vitest';
import { cn } from './utils';

/**
 * The shell adds named text roles (`text-body`, `text-heading-1`, `text-label`)
 * to Tailwind's fontSize scale. tailwind-merge cannot infer that from the class
 * name: `text-<word>` looks exactly like a text COLOUR to it, so out of the box
 * it drops a real colour as "conflicting" with a role, and lets two roles
 * coexist. Both are silent. `cn` therefore has to be taught the roles.
 */
describe('cn', () => {
  it('keeps a text colour and a text role together', () => {
    const result = cn('text-mainMenu-foreground', 'text-body');
    expect(result).toContain('text-mainMenu-foreground');
    expect(result).toContain('text-body');
  });

  it('keeps the last role when two roles collide', () => {
    expect(cn('text-body', 'text-label')).toBe('text-label');
  });

  it('lets a role override a built-in font size', () => {
    expect(cn('text-sm', 'text-body')).toBe('text-body');
  });

  it('lets a built-in font size override a role', () => {
    expect(cn('text-body', 'text-xs')).toBe('text-xs');
  });

  it('still resolves plain colour conflicts', () => {
    expect(cn('text-foreground', 'text-muted-foreground')).toBe('text-muted-foreground');
  });
});
