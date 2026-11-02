import { withOwnQueryCache } from '@frontx-test-utils/withOwnQueryCache';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider } from '@gears-frontx/react';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '@frontx-test-utils/createMfeBridgeFixture.ts';
import type { ConnectionDto, ProjectConfig, RemoteRepoDto } from '@constructor-studio/mfe-shared';

const PROJECT = 'p-1';

const { data, actions } = vi.hoisted(() => ({
  data: {
    connections: [] as ConnectionDto[],
    repositories: {} as Record<string, RemoteRepoDto[]>,
    config: null as ProjectConfig | null,
    configFailed: false,
  },
  actions: {
    requestSourcesConnect: vi.fn(),
    openConnectionForm: vi.fn(),
    closeSourcesConnect: vi.fn(),
  },
}));

vi.mock('@gears-frontx/react', (importOriginal) =>
  withOwnQueryCache(importOriginal, () => ({ useSharedProperty: () => PROJECT }))
);

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  OrganizationProvider: ({ children }: { children: React.ReactNode }) => children,
  useOrganization: () => ({ org: { id: 'org-1', name: 'Fabric' }, loading: false, failed: false }),
  useHostChrome: () => ({ containerRef: { current: null }, dataTheme: 'light', language: 'en' }),
}));

vi.mock('../../i18n', async (importOriginal) => {
  const text = Object.assign((key: string) => key, {
    count: (key: string, n: number) => `${key}:${n}`,
  });
  return {
    ...(await importOriginal<typeof import('../../i18n')>()),
    useProjectCreateScreenTranslations: () => ({ isLoaded: true, error: null }),
    useSourcesConnectScreenTranslations: () => ({ isLoaded: true, error: null }),
    useProjectCreateText: () => text,
    useSourcesConnectText: () => text,
  };
});

vi.mock('../../shared/useConnections', () => ({
  useSourceConnections: () => ({
    providers: [
      { provider: 'github', displayName: 'GitHub' },
      { provider: 'gitlab', displayName: 'GitLab' },
      { provider: 'bitbucket', displayName: 'Bitbucket' },
    ],
    connections: data.connections,
    loading: false,
    failed: false,
    providerName: (provider: string) => provider,
  }),
}));

vi.mock('../../shared/useRepositories', () => ({
  useRepositories: (connectionId: string) => ({
    repositories: data.repositories[connectionId] ?? [],
    loading: false,
    failed: false,
  }),
}));

vi.mock('../../shared/useProjectConfig', () => ({
  useProjectConfig: () => ({
    config: data.config,
    loading: false,
    unset: false,
    failed: data.configFailed,
  }),
}));

vi.mock('../../actions/sourcesConnectActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../actions/sourcesConnectActions')>()),
  ...actions,
}));

const connection = (id: string, provider: string): ConnectionDto =>
  ({ id, provider, label: id, base_url: '', secret_ref: `ref-${id}` }) as ConnectionDto;

const repo = (full_path: string, default_branch: string | null = null): RemoteRepoDto => ({
  id: full_path,
  name: full_path.split('/')[1]!,
  full_path,
  clone_url: `https://example.test/${full_path}.git`,
  default_branch,
  visibility: 'private',
});

async function mountDialog() {
  const { mfeApp } = await import('../../init');
  const { SourcesConnectDialog } = await import('./SourcesConnectDialog');
  const { bridge } = createMfeBridgeFixture({ domainId: 'overlay', instanceId: 'inst' });
  render(
    <FrontXProvider app={mfeApp} mfeBridge={mfeContextValue(bridge)}>
      <SourcesConnectDialog />
    </FrontXProvider>
  );
  return mfeApp;
}

const attachedSources = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    connection_id: 'c-github',
    full_path: `old/repo-${index}`,
    clone_url: `https://example.test/old/repo-${index}.git`,
  }));

const row = (name: string) => screen.getByText(name).closest('tr')!;
const connectButton = () => screen.getByRole('button', { name: 'connect' }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  data.connections = [
    connection('c-github', 'github'),
    connection('c-github-2', 'github'),
    connection('c-gitlab', 'gitlab'),
  ];
  data.repositories = {
    'c-github': [repo('acme/api'), repo('acme/web', 'main')],
    'c-github-2': [repo('team/site')],
    'c-gitlab': [repo('lab/tool', 'trunk')],
  };
  data.config = {
    sources: [
      { connection_id: 'c-github', full_path: 'acme/api', clone_url: 'https://example.test/acme/api.git' },
    ],
  };
  data.configFailed = false;
});

const chooseProvider = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('Connect source', () => {
  it('opens on the providers with nothing listed, and says to choose one', async () => {
    await mountDialog();

    expect(screen.getByRole('button', { name: 'GitHub' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('providers_hint')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    // Back alone until a provider is chosen: no Connect source, no count.
    expect(screen.getByRole('button', { name: 'back' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'connect' })).toBeNull();
    expect(screen.queryByText('selected_none')).toBeNull();
    // Only the providers the organization has a connection to.
    expect(screen.queryByRole('button', { name: 'Bitbucket' })).toBeNull();
  });

  it('counts the picks once a provider is chosen; Back returns to the providers, then closes', async () => {
    await mountDialog();

    chooseProvider('GitHub');
    expect(screen.getByRole('button', { name: 'GitHub' }).getAttribute('aria-pressed')).toBe('true');
    // Pressing the chosen chip again keeps it chosen.
    chooseProvider('GitHub');
    expect(screen.getByRole('button', { name: 'GitHub' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('selected_none')).toBeTruthy();
    expect(connectButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(screen.getByRole('button', { name: 'GitHub' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('providers_hint')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'connect' })).toBeNull();
    expect(actions.closeSourcesConnect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(actions.closeSourcesConnect).toHaveBeenCalledTimes(1);
  });

  it("names a provider's one connection in a line, and gives each of several a tab", async () => {
    await mountDialog();

    chooseProvider('GitLab');
    expect(screen.getByText('gitlab · c-gitlab')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();

    chooseProvider('GitHub');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'github · c-github',
      'github · c-github-2',
    ]);
  });

  it('connects two repositories picked from two providers', async () => {
    await mountDialog();

    chooseProvider('GitHub');
    fireEvent.click(row('web'));
    chooseProvider('GitLab');
    fireEvent.click(row('tool'));
    fireEvent.click(connectButton());

    expect(actions.requestSourcesConnect).toHaveBeenCalledWith(PROJECT, [
      expect.objectContaining({ fullPath: 'acme/web', connectionId: 'c-github', defaultBranch: 'main' }),
      expect.objectContaining({ fullPath: 'lab/tool', connectionId: 'c-gitlab', defaultBranch: 'trunk' }),
    ]);
  });

  it('shows a repository the project already has as picked, and does not let it be picked again', async () => {
    await mountDialog();
    chooseProvider('GitHub');

    const attached = screen.getByRole('checkbox', { name: 'acme/api' });
    expect(attached.getAttribute('aria-checked')).toBe('true');
    expect(row('api').getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(row('api'));
    expect(connectButton().disabled).toBe(true);
  });

  it('lets one more be picked with 99 attached, then makes the rest inert and says so', async () => {
    data.config = { sources: attachedSources(99) };
    data.repositories['c-github'] = [repo('acme/api'), repo('acme/web'), repo('acme/docs')];
    await mountDialog();
    chooseProvider('GitHub');

    fireEvent.click(row('web'));

    expect(row('docs').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('selected_max')).toBeTruthy();
  });

  it('says the project is full when its attached repositories reach the ceiling alone', async () => {
    data.config = { sources: attachedSources(100) };
    await mountDialog();
    chooseProvider('GitHub');

    expect(row('web').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('attached_max')).toBeTruthy();
    expect(screen.queryByText('selected_none')).toBeNull();
  });

  it("says the project's sources could not be read, and offers nothing to connect", async () => {
    data.config = null;
    data.configFailed = true;
    await mountDialog();
    chooseProvider('GitHub');

    expect(screen.getByRole('alert').textContent).toBe('error_config');
    expect(screen.queryByRole('button', { name: 'connect' })).toBeNull();
    expect(screen.queryByText('selected_none')).toBeNull();
  });

  it('offers GitHub when a connection of another provider exposes no repositories', async () => {
    data.repositories['c-gitlab'] = [];
    await mountDialog();

    chooseProvider('GitLab');
    expect(screen.getByText('repos_empty_title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'try_github' }));

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'github · c-github',
      'github · c-github-2',
    ]);
  });

  it('offers Add connection when the organization has no source connection', async () => {
    data.connections = [];
    await mountDialog();

    expect(screen.queryByRole('button', { name: 'GitHub' })).toBeNull();
    expect(screen.getByText('connections_empty_title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'add_connection' }));

    expect(actions.openConnectionForm).toHaveBeenCalledTimes(1);
  });

  it('keeps the picks and shows the reason when the write is refused', async () => {
    const app = await mountDialog();
    const { connectFailed } = await import('../../slices/sourcesConnectSlice');

    chooseProvider('GitHub');
    fireEvent.click(row('web'));
    act(() => {
      app.store.dispatch(connectFailed({ kind: 'i18n', key: 'error_write' }));
    });

    expect(screen.getByRole('alert').textContent).toBe('error_write');
    expect(connectButton().disabled).toBe(false);
    expect(screen.getByRole('checkbox', { name: 'acme/web' }).getAttribute('aria-checked')).toBe('true');
  });

  it('holds Back and Connect source while the write is under way', async () => {
    const app = await mountDialog();
    const { connectStarted } = await import('../../slices/sourcesConnectSlice');

    chooseProvider('GitHub');
    fireEvent.click(row('web'));
    act(() => {
      app.store.dispatch(connectStarted());
    });

    expect(connectButton().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'back' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes once the write has succeeded, and not before', async () => {
    await mountDialog();
    const { eventBus } = await import('@gears-frontx/react');

    chooseProvider('GitHub');
    fireEvent.click(row('web'));
    fireEvent.click(connectButton());
    expect(actions.requestSourcesConnect).toHaveBeenCalledTimes(1);
    expect(actions.closeSourcesConnect).not.toHaveBeenCalled();

    act(() => {
      eventBus.emit('mfe/projects/sources-connected', { projectId: PROJECT });
    });

    expect(actions.closeSourcesConnect).toHaveBeenCalledTimes(1);
  });
});
