import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FrontXProvider, createFrontXApp, i18nRegistry } from '@gears-frontx/react';
import {
  PROJECT_LIST_NAMESPACE,
  useProjectListScreenTranslations,
  useProjectListText,
} from './i18n';

/**
 * Two things worth pinning down about the split: that a child can read without
 * being handed a `t`, and that the namespace never reaches a call site.
 */
const Child: React.FC = () => {
  const t = useProjectListText();
  return <span data-testid="child">{t('title')}</span>;
};

const Screen: React.FC = () => {
  const { isLoaded, error } = useProjectListScreenTranslations();
  return (
    <>
      <span data-testid="loaded">{String(isLoaded)}</span>
      <span data-testid="error">{error ? error.message : 'none'}</span>
      <Child />
    </>
  );
};

async function mount() {
  createFrontXApp({});
  const { mfeApp } = await import('./init');
  await act(async () => {
    await i18nRegistry.setLanguage('en' as never);
  });
  render(
    <FrontXProvider app={mfeApp}>
      <Screen />
    </FrontXProvider>
  );
}

describe('screen translation split', () => {
  it('composes the framework namespace so call sites keep bare keys', () => {
    // The screenset/screen pair the loading hook is given has to agree with the
    // namespace the reading hook prefixes, and the framework builds the former
    // out of sight — this is the one place the two are compared.
    expect(PROJECT_LIST_NAMESPACE).toBe('screen.projects.list');
  });

  it('lets a child read the screen dictionary with no `t` passed to it', async () => {
    await mount();

    // The load is an effect awaiting a dynamic import; poll rather than guess
    // how many microtask turns the import chain takes.
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'));
    expect(screen.getByTestId('error').textContent).toBe('none');
    // Child never received a prop; it resolved 'title' through the registry.
    expect(screen.getByTestId('child').textContent).toBe('Projects');
  });
});
