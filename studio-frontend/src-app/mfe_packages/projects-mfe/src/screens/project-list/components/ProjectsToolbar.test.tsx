import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider, createFrontXApp, i18nRegistry } from '@gears-frontx/react';
import { PROJECT_LIST_NAMESPACE } from '../../../i18n';
import en from '../i18n/en.json';
import { ProjectsToolbar } from './ProjectsToolbar';

/**
 * The header's controls come from the kit and are configured, not written, so
 * what is worth asserting is that each one still reaches the accessibility tree
 * under the name the mockup gives it — the search box through `Input`'s `icon`
 * plus `aria-label`, and the title through the busy switch. A misconfigured kit
 * control renders empty and nothing else fails, which is exactly the sort of
 * break a type-check does not catch.
 *
 * Translations are registered synchronously here rather than left to the
 * loader: the registry's default and fallback language are both English, so a
 * direct `register` resolves every key without waiting on `setLanguage`, and
 * the test never races the async load.
 */
async function mount(busy: boolean) {
  createFrontXApp({});
  const { mfeApp } = await import('../../../init');
  i18nRegistry.register(PROJECT_LIST_NAMESPACE, 'en' as never, en);

  render(
    <FrontXProvider app={mfeApp}>
      <ProjectsToolbar query="" onQueryChange={vi.fn()} busy={busy} />
    </FrontXProvider>
  );
}

describe('ProjectsToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every control the header currently carries', async () => {
    await mount(false);

    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: en.search_placeholder })).toBeTruthy();
    expect(screen.getByRole('button', { name: en.new_project })).toBeTruthy();
    // The sort chip is out of the header for now; `SortSelect` is still in tree.
    expect(screen.queryByLabelText(en.sort_label)).toBeNull();
  });

  it('shows a skeleton instead of the title until the screen is ready', async () => {
    await mount(true);

    expect(screen.queryByText(en.title)).toBeNull();
  });
});
