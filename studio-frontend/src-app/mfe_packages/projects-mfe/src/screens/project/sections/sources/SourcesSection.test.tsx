import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataGridLoadContext } from '@gears-frontx/ui-kit';
import en from './i18n/en.json';
import projectEn from '../../i18n/en.json';
import { sourceRow } from '../../../../model/sourceRows.fixture';
import { filterSourceRows, type SourceRow } from '../../../../model/sourceRows';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import type { SourcesLoad } from '../../../../shared/useSourcesLoad';

/** The Sources section on the kit's DataGrid (#688). */

const { sources, scope, translations, loadArgs } = vi.hoisted(() => ({
  sources: { current: { ready: true, failed: false, rows: [] as SourceRow[] } },
  scope: {
    current: {
      org: { id: 'org-1', name: 'Acme' } as { id: string; name: string } | null,
      orgLoading: false,
      workspace: { id: 'ws-1', name: 'Main' } as { id: string; name: string } | null,
      workspaceLoading: false,
    },
  },
  translations: { current: { isLoaded: true, error: null as Error | null } },
  loadArgs: [] as unknown[][],
}));
const { retry, openSourcesConnect, bridge } = vi.hoisted(() => ({
  retry: vi.fn(),
  openSourcesConnect: vi.fn(),
  bridge: { id: 'bridge' },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useMfeBridge: () => bridge,
  useFormatters: () => ({ formatRelative: () => 'recently' }),
  useTranslation: () => ({ t: (key: string) => key, language: 'en' }),
  useAppSelector: (select: (state: unknown) => unknown) =>
    select({ 'projects/nav': { projectId: 'p-1', section: 'sources' } }),
}));

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useOrganization: () => ({
    org: scope.current.org,
    loading: scope.current.orgLoading,
    failed: false,
  }),
  useWorkspace: () => ({
    workspace: scope.current.workspace,
    loading: scope.current.workspaceLoading,
  }),
}));

vi.mock('../../../../i18n', async () => {
  const { dictionaryText } = await import('@frontx-test-utils/dictionaryText');
  return {
    useSourcesText: () => dictionaryText(en),
    useProjectText: () => dictionaryText(projectEn),
    useSourcesSectionTranslations: () => translations.current,
  };
});

// The rows as the hook builds them, searched and paged as its load does.
vi.mock('../../../../shared/useSourcesLoad', () => ({
  useSourcesLoad: (...args: unknown[]): SourcesLoad => {
    loadArgs.push(args);
    const { ready, failed, rows } = sources.current;
    return {
      ready,
      failed,
      rows,
      footer: { sources: rows.length, specs: 3, openPullRequests: 0 },
      windowDays: 7,
      retry,
      load: async (context: DataGridLoadContext) => {
        const shown = filterSourceRows(rows, context.filters?.textSearch?.value ?? '', 'Uploaded files');
        const { page, limit } = context.pagination ?? { page: 1, limit: shown.length };
        return { results: shown.slice((page - 1) * limit, page * limit), total: shown.length };
      },
      rowsBridge: <></>,
    };
  },
}));
vi.mock('../../../../shared/useSourceRowActions', () => ({
  useSourceRowActions: () => ({
    connectionsRead: true,
    providerName: (provider: string) => provider,
    syncNow: vi.fn(),
    cancelSync: vi.fn(),
    openSpecs: vi.fn(),
    openUploads: vi.fn(),
  }),
}));
vi.mock('../../../../shared/useSyncRefusals', () => ({ useSyncRefusals: () => undefined }));
vi.mock('../../upload/UploadPanel', () => ({ UploadPanel: () => null }));
vi.mock('../../upload/UploadDocumentsButton', () => ({
  UploadDocumentsButton: ({ projectId }: { projectId: string }) => (
    <button type="button">Upload documents to {projectId}</button>
  ),
}));
vi.mock('../../../../actions/sourcesConnectActions', () => ({ openSourcesConnect }));

import { SourcesSection } from './SourcesSection';

const rows = (count: number, name = (index: number) => `acme/repo-${index}`) =>
  Array.from({ length: count }, (_, index) =>
    sourceRow({ id: `c:${name(index)}`, name: name(index).split('/')[1], fullPath: name(index) })
  );

const section = () => render(<SourcesSection projectId="p-1" projectName="Billing" />);

const shownRows = () => screen.queryAllByRole('button', { name: /^Actions for / }).length;
const search = () => screen.getByPlaceholderText('Search sources');
const FOOTER = /sources · 3 specs from sources · 0 open pull requests$/;

beforeEach(() => {
  stubResizeObserver();
  sources.current = { ready: true, failed: false, rows: [] };
  scope.current = {
    org: { id: 'org-1', name: 'Acme' },
    orgLoading: false,
    workspace: { id: 'ws-1', name: 'Main' },
    workspaceLoading: false,
  };
  translations.current = { isLoaded: true, error: null };
  loadArgs.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SourcesSection', () => {
  it('shows a skeleton until every read has answered', () => {
    sources.current.ready = false;
    const { container } = section();

    expect(container.querySelector('[class*="skeleton"]')).not.toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(FOOTER)).toBeNull();
  });

  it.each(['orgLoading', 'workspaceLoading'] as const)('shows a skeleton while %s', (loading) => {
    sources.current.rows = rows(2);
    scope.current[loading] = true;
    const { container } = section();

    expect(container.querySelector('[class*="skeleton"]')).not.toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a skeleton while its dictionary loads, and the table once it failed', async () => {
    sources.current.rows = rows(2);
    translations.current = { isLoaded: false, error: null };
    const { container } = section();
    expect(container.querySelector('[class*="skeleton"]')).not.toBeNull();
    cleanup();

    translations.current = { isLoaded: false, error: new Error('dictionary') };
    section();
    await waitFor(() => expect(shownRows()).toBe(2));
  });

  it('says so when no organization is open, without waiting for a workspace', () => {
    scope.current.org = null;
    scope.current.workspaceLoading = true;
    section();

    expect(screen.getByText('Sources are read in an organization, and none is open.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(loadArgs).toEqual([]);
  });

  it('shows the rows with no workspace open, and reads no documents of one', async () => {
    sources.current.rows = rows(2);
    scope.current.workspace = null;
    section();

    await waitFor(() => expect(shownRows()).toBe(2));
    expect(loadArgs[0]).toEqual(['p-1', null, 'org-1', 'Uploaded files']);
  });

  it('says the sources could not be read, and Try again reads them again', () => {
    sources.current.failed = true;
    section();

    expect(screen.getByRole('alert').textContent).toBe("The project's sources could not be read.");
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(FOOTER)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('with no sources, offers Upload documents and Connect source, and still counts', async () => {
    section();

    expect(await screen.findByText('No sources connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upload documents to p-1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect source' }));
    expect(openSourcesConnect).toHaveBeenCalledWith(bridge);
    expect(screen.getByText(FOOTER).textContent).toMatch(/^0 sources/);
  });

  it('shows the rows, keeps the ones the search matches, and leaves the footer as it was', async () => {
    sources.current.rows = [...rows(2), ...rows(1, () => 'lab/tool')];
    section();

    await waitFor(() => expect(shownRows()).toBe(3));
    fireEvent.change(search(), { target: { value: 'ACME' } });
    await waitFor(() => expect(shownRows()).toBe(2));
    expect(screen.getByText(FOOTER).textContent).toMatch(/^3 sources/);
  });

  it('says when nothing matches, and Clear search brings the rows back', async () => {
    sources.current.rows = rows(2);
    section();
    await waitFor(() => expect(shownRows()).toBe(2));

    fireEvent.change(search(), { target: { value: 'nothing like it' } });
    expect(await screen.findByText('No sources match this search.')).toBeTruthy();
    expect(screen.queryByText('No sources connected')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(shownRows()).toBe(2));
    expect((search() as HTMLInputElement).value).toBe('');
  });

  it('pages from 26 sources, not before', async () => {
    sources.current.rows = rows(25);
    section();
    await waitFor(() => expect(shownRows()).toBe(25));
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
    cleanup();

    sources.current.rows = rows(26);
    section();
    await waitFor(() => expect(shownRows()).toBe(25));
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeTruthy();
  });
});
