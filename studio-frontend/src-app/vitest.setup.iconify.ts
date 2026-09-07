// Host-app test setup: stub `@iconify/react`'s `Icon`.
//
// The real `Icon` resolves its icon asynchronously (a `setTimeout` that later
// calls `setState`). Under Vitest that deferred callback can fire *after* the
// jsdom environment for a test file has torn down, at which point react-dom
// touches `window` and throws `ReferenceError: window is not defined` as an
// unhandled exception — failing the run even though every test passes
// (observed in `app/layout/Menu.test.tsx`). Rendering a synchronous placeholder
// removes the timer entirely while keeping the icon queryable (`data-icon`).
//
// Scoped to `src-app` (added to this project's `setupFiles`) so the shared
// template `vitest.setup.ts` — copied verbatim into scaffolded projects — does
// not drift.
import { vi } from 'vitest';

vi.mock('@iconify/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@iconify/react')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Icon: (props: { icon?: unknown; className?: string }) =>
      createElement('span', {
        className: props.className,
        'data-icon': typeof props.icon === 'string' ? props.icon : undefined,
        'aria-hidden': 'true',
      }),
  };
});
