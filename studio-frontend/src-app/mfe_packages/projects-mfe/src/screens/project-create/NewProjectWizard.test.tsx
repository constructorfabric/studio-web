import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider, createFrontXApp } from '@gears-frontx/react';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '@frontx-test-utils/createMfeBridgeFixture.ts';

/** The wizard's frame around its steps: the first-load skeleton and the failure. */

const { translations } = vi.hoisted(() => ({
  translations: { current: { isLoaded: true, error: null as Error | null } },
}));

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  OrganizationProvider: ({ children }: { children: React.ReactNode }) => children,
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
  useOrganization: () => ({ org: { id: 'org-1', name: 'Fabric' }, loading: false, failed: false }),
  useWorkspace: () => ({ workspace: { id: 'ws-1', name: 'Platform' }, loading: false, failed: false }),
  useHostChrome: () => ({ containerRef: { current: null }, dataTheme: 'light', language: 'en' }),
}));

vi.mock('../../i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../i18n')>()),
  useProjectCreateScreenTranslations: () => translations.current,
  useProjectCreateText: () => (key: string) => key,
}));

vi.mock('../../shared/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 'user-1', asUser: null }),
}));

// The steps have their own tests; here each is a marker the frame shows or holds back.
vi.mock('./steps/DetailsStep', () => ({ DetailsStep: () => <p>details step</p> }));
vi.mock('./steps/RepositoriesStep', () => ({ RepositoriesStep: () => null }));
vi.mock('./steps/RepositoriesFooterNote', () => ({ RepositoriesFooterNote: () => null }));

async function mountWizard() {
  createFrontXApp({});
  const { mfeApp } = await import('../../init');
  const { NewProjectWizard } = await import('./NewProjectWizard');
  const { bridge } = createMfeBridgeFixture({ domainId: 'overlay', instanceId: 'inst' });

  const tree = () => (
    <FrontXProvider app={mfeApp} mfeBridge={mfeContextValue(bridge)}>
      <NewProjectWizard />
    </FrontXProvider>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

beforeEach(() => {
  translations.current = { isLoaded: true, error: null };
});

describe('the wizard behind its first-load skeleton', () => {
  it('waits for the dictionary once, not again while a language change loads it', async () => {
    translations.current = { isLoaded: false, error: null };
    const { rerender } = await mountWizard();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByText('details step')).toBeNull();

    translations.current = { isLoaded: true, error: null };
    rerender();
    expect(screen.getByRole('heading', { name: 'title' })).toBeTruthy();
    expect(screen.getByText('details step')).toBeTruthy();

    translations.current = { isLoaded: false, error: null };
    rerender();
    expect(screen.getByText('details step')).toBeTruthy();
  });

  it('shows the failure, not the skeleton, when the dictionary does not load', async () => {
    translations.current = { isLoaded: false, error: new Error('no dictionary') };
    await mountWizard();

    expect(screen.getByRole('alert').textContent).toBe('Could not load this screen.');
    expect(screen.getByText('details step')).toBeTruthy();
  });
});
