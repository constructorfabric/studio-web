import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider, createFrontXApp } from '@gears-frontx/react';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '@frontx-test-utils/createMfeBridgeFixture.ts';

/**
 * The per-row choice of how a picked repository's edits are shared: present
 * only once the row is picked, defaulting to the branch, and offering a pull
 * request only where the connection's provider can open one.
 */

const { provider } = vi.hoisted(() => ({ provider: { current: 'github' } }));

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useOrganization: () => ({ org: { id: 'org-1', name: 'Fabric' }, loading: false, failed: false }),
}));

vi.mock('../../../i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../i18n')>()),
  useProjectCreateText: () => (key: string, params?: Record<string, string>) =>
    params?.repo ? `${key}:${params.repo}` : key,
}));

vi.mock('../../../shared/useConnections', () => ({
  useSourceConnections: () => ({
    connections: [{ id: 'c-1', provider: provider.current, label: 'acme' }],
    loading: false,
    failed: false,
    providerName: (name: string) => name,
  }),
}));

vi.mock('../../../shared/useRepositories', () => ({
  useRepositories: () => ({
    repositories: [
      {
        id: 'r1',
        name: 'web',
        full_path: 'acme/web',
        clone_url: 'https://git.test/acme/web.git',
        visibility: 'private',
      },
    ],
    loading: false,
    failed: false,
  }),
}));

async function mount() {
  createFrontXApp({});
  const { mfeApp } = await import('../../../init');
  const { resetWizard } = await import('../../../slices/createSlice');
  const { RepositoriesStep } = await import('./RepositoriesStep');
  mfeApp.store.dispatch(resetWizard());
  const { bridge } = createMfeBridgeFixture({ domainId: 'overlay', instanceId: 'inst' });

  render(
    <FrontXProvider app={mfeApp} mfeBridge={mfeContextValue(bridge)}>
      <RepositoriesStep />
    </FrontXProvider>
  );
  return {
    sources: () => mfeApp.store.getState()['projects/create'].draft.sources,
  };
}

const shareControl = () => screen.queryByRole('combobox', { name: 'share_label:acme/web' });

beforeEach(() => {
  provider.current = 'github';
  // jsdom has no PointerEvent, and the kit's checkbox and select build one on click.
  if (typeof window.PointerEvent !== 'function') {
    vi.stubGlobal('PointerEvent', class extends MouseEvent {});
  }
});

describe('how a picked repository is shared', () => {
  it('is asked only once the repository is picked, and starts on the branch', async () => {
    const { sources } = await mount();
    expect(shareControl()).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/web' }));

    expect(shareControl()?.textContent).toContain('share_branch');
    expect(sources().map((pick) => pick.shareMode)).toEqual(['branch']);
  });

  it('switches to a pull request without unpicking the row', async () => {
    const { sources } = await mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/web' }));

    await act(async () => {
      fireEvent.click(shareControl()!);
    });
    const option = await screen.findByRole('option', { name: 'share_pull_request' });
    // A mouse click on an item only commits when it started on that item.
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: 'mouse' });
      fireEvent.click(option);
    });

    expect(sources().map((pick) => pick.shareMode)).toEqual(['pull_request']);
  });

  it('does not offer a pull request where the provider cannot open one', async () => {
    provider.current = 'bitbucket';
    await mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/web' }));

    await act(async () => {
      fireEvent.click(shareControl()!);
    });
    const list = await screen.findByRole('listbox');
    const option = within(list).getByRole('option', { name: /share_pull_request/ });

    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toContain('share_github_only');
  });
});
