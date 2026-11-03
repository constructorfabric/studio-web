import { withOwnQueryCache } from '@frontx-test-utils/withOwnQueryCache';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider, type FrontXApp } from '@gears-frontx/react';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '@frontx-test-utils/createMfeBridgeFixture.ts';
import type { ConnectionDto, RemoteRepoDto } from '@constructor-studio/mfe-shared';

/** The wizard's step hands the picker the create slice, and its handlers reach their reducers. */

vi.mock('@gears-frontx/react', (importOriginal) => withOwnQueryCache(importOriginal));

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useOrganization: () => ({ org: { id: 'org-1', name: 'Fabric' }, loading: false, failed: false }),
}));

vi.mock('../../../i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../i18n')>()),
  useProjectCreateText: () => (key: string) => key,
}));

const connection = (id: string, provider: string): ConnectionDto =>
  ({ id, provider, label: id, base_url: '', secret_ref: `ref-${id}` }) as ConnectionDto;

vi.mock('../../../shared/useConnections', () => ({
  useSourceConnections: () => ({
    providers: [{ provider: 'github', displayName: 'GitHub' }],
    connections: [connection('c-1', 'github'), connection('c-2', 'github')],
    loading: false,
    failed: false,
    providerName: (provider: string) => provider,
  }),
}));

vi.mock('../../../shared/useRepositories', () => ({
  useRepositories: (connectionId: string): { repositories: RemoteRepoDto[]; loading: boolean; failed: boolean } => ({
    repositories: [
      {
        id: `${connectionId}-api`,
        name: 'api',
        full_path: 'acme/api',
        clone_url: 'https://github.com/acme/api.git',
        default_branch: 'main',
        visibility: 'private',
      },
    ],
    loading: false,
    failed: false,
  }),
}));

async function mountStep(): Promise<FrontXApp> {
  const { mfeApp } = await import('../../../init');
  const { resetWizard } = await import('../../../slices/createSlice');
  const { RepositoriesStep } = await import('./RepositoriesStep');
  const { bridge } = createMfeBridgeFixture({ domainId: 'overlay', instanceId: 'inst' });
  act(() => {
    mfeApp.store.dispatch(resetWizard());
  });
  render(
    <FrontXProvider app={mfeApp} mfeBridge={mfeContextValue(bridge)}>
      <RepositoriesStep />
    </FrontXProvider>
  );
  return mfeApp;
}

const wizard = (app: FrontXApp) => app.store.getState()['projects/create'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the repositories step', () => {
  it('sends the chip, the connection tab, the search and a pick to the create slice', async () => {
    const app = await mountStep();

    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(wizard(app).providerId).toBe('github');

    fireEvent.click(screen.getByRole('tab', { name: 'github · c-2' }));
    expect(wizard(app).connectionId).toBe('c-2');

    fireEvent.change(screen.getByRole('searchbox', { name: 'search_placeholder' }), {
      target: { value: 'api' },
    });
    expect(wizard(app).search).toBe('api');

    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/api' }).closest('tr')!);
    expect(wizard(app).draft.sources).toEqual([
      expect.objectContaining({ id: 'c-2-api', fullPath: 'acme/api', connectionId: 'c-2', defaultBranch: 'main' }),
    ]);
  });
});
