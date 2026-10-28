/**
 * The Specs section on the kit's real DataGrid: only the API, the store, the
 * bridge and the shell's actions are stubbed.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecRowDto, SpecRowListDto, SpecRowsSourcesDto } from '../../../../api/documentTypes';

const { state, workspace, dispatched, specRows, translations, requestOpenSpec, openSourcesConnect } = vi.hoisted(() => ({
  state: { current: {} as Record<string, unknown> },
  workspace: { current: { workspace: null as { id: string; name: string } | null, loading: false } },
  dispatched: [] as { type: string; payload?: unknown }[],
  specRows: vi.fn(),
  translations: { isLoaded: true, error: null as Error | null },
  requestOpenSpec: vi.fn(),
  openSourcesConnect: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: {
    getService: () => ({
      specRows: () => ({ fetch: specRows }),
      types: () => ({ fetch: () => Promise.resolve({ items: [{ key: 'prd', name: 'PRD' }] }) }),
    }),
  },
  useAppSelector: (select: (store: unknown) => unknown) => select(state.current),
  useAppDispatch: () => (action: { type: string; payload?: unknown }) => dispatched.push(action),
  useMfeBridge: () => 'the-bridge',
  useFormatters: () => ({ formatPercent: (value: number) => `${Math.round(value * 100)}%` }),
}));
vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useWorkspace: () => workspace.current,
}));
vi.mock('../../../../api/DocumentsApiService', () => ({ DocumentsApiService: class {} }));
vi.mock('../../../../i18n', () => {
  const t = Object.assign((key: string) => key, {
    count: (key: string, count: number) => `${key} ${count}`,
  });
  return { useSpecsSectionTranslations: () => translations, useSpecsText: () => t, useProjectText: () => t };
});
vi.mock('./useTypeDecisionRefusals', () => ({ useTypeDecisionRefusals: () => undefined }));
vi.mock('../../../../actions/artifactActions', () => ({ requestOpenSpec }));
vi.mock('../../../../actions/sourcesConnectActions', () => ({ openSourcesConnect }));
vi.mock('../../upload/UploadPanel', () => ({ UploadPanel: () => null }));
vi.mock('../../upload/UploadDocumentsButton', () => ({
  UploadDocumentsButton: ({ projectId }: { projectId: string }) => (
    <button type="button">{`upload ${projectId}`}</button>
  ),
}));

import { eventBus } from '@gears-frontx/react';
import { specRowDto } from '../../../../model/specRows.fixture';
import { SpecsSection } from './SpecsSection';

const ALL_READ: SpecRowsSourcesDto = { files_known: true, reviews_known: true, repos_known: true, counts: [] };

const answer = (items: SpecRowDto[], sources: Partial<SpecRowsSourcesDto> = {}): SpecRowListDto => ({
  items,
  total: items.length,
  sources: { ...ALL_READ, ...sources },
});

const PRD = specRowDto({ id: 'b-prd', name: 'prd.md', path: 'docs/prd.md', repo_full_path: 'acme/web', findings: 2 });
/** Checked, nothing found. */
const API = specRowDto({ id: 'b-api', name: 'api.md', path: 'api.md', repo_full_path: 'acme/api' });
const STUDIO = specRowDto({
  id: 'doc-1',
  origin: 'authored',
  name: 'Payments PRD',
  path: '',
  node_id: null,
  repo_full_path: '',
  checked_at: null,
});

function given(search = '') {
  state.current = {
    'projects/specsFilter': { search, filter: 'all', documentType: null },
    'projects/typeDecision': { pending: [] },
  };
}

const renderSection = () => render(<SpecsSection projectId="p-1" projectName="Billing" />);
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
const actions = (type: string) => dispatched.filter((action) => action.type.endsWith(`/${type}`));
const lastPayload = (type: string) => actions(type).slice(-1)[0]?.payload;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  given();
  workspace.current = { workspace: { id: 'w-1', name: 'Acme' }, loading: false };
  dispatched.length = 0;
  specRows.mockReset().mockResolvedValue(answer([PRD, API, STUDIO]));
  requestOpenSpec.mockClear();
  openSourcesConnect.mockClear();
  Object.assign(translations, { isLoaded: true, error: null });
});

describe('the Specs section', () => {
  it('shows a skeleton while its dictionary loads', () => {
    Object.assign(translations, { isLoaded: false, error: null });
    const { container } = renderSection();
    expect(container.querySelector('[class*="skeleton"]')).not.toBeNull();
    expect(specRows).not.toHaveBeenCalled();
  });

  it('shows the table when its dictionary failed to load, rather than a skeleton for good', async () => {
    Object.assign(translations, { isLoaded: false, error: new Error('offline') });
    const { container } = renderSection();

    expect(await screen.findByText('prd.md')).toBeTruthy();
    expect(container.querySelector('[class*="skeleton"]')).toBeNull();
  });

  it('waits for the workspace, and says so when none is open', () => {
    workspace.current = { workspace: null, loading: true };
    const { container, rerender } = renderSection();
    expect(container.querySelector('[class*="skeleton"]')).not.toBeNull();

    workspace.current = { workspace: null, loading: false };
    rerender(<SpecsSection projectId="p-1" projectName="Billing" />);
    expect(screen.getByText('no_workspace')).toBeTruthy();
    expect(specRows).not.toHaveBeenCalled();
  });

  it("lists the project's specs with their type, review and source", async () => {
    renderSection();
    await screen.findByText('prd.md');

    const prd = within(rowOf('prd.md'));
    expect(prd.getByText('PRD')).toBeTruthy();
    expect(prd.getByText('review_findings 2')).toBeTruthy();
    expect(rowOf('prd.md').textContent).toContain('acme/web / docs');
    expect(within(rowOf('api.md')).getByText('review_findings 0').className).toMatch(/clean/);
    const studio = within(rowOf('Payments PRD'));
    expect(studio.getByText('review_check_needed')).toBeTruthy();
    expect(studio.getByText('source_studio')).toBeTruthy();
  });

  it('opens a row in the IDE from its name', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Payments PRD' }));

    expect(requestOpenSpec).toHaveBeenCalledTimes(1);
    const [bridge, projectId, row] = requestOpenSpec.mock.calls[0];
    expect([bridge, projectId, row.id]).toEqual(['the-bridge', 'p-1', 'doc-1']);
  });

  it('shows a file with no repository as text, with nothing to open', async () => {
    specRows.mockResolvedValue(answer([specRowDto({ name: 'orphan.md', repo_full_path: '' })]));
    renderSection();

    await screen.findByText('orphan.md');
    expect(screen.queryByRole('button', { name: 'orphan.md' })).toBeNull();
  });

  it('hands Check the checkable rows the search shows', async () => {
    renderSection();
    await screen.findByText('prd.md');

    await waitFor(() => expect(actions('specsShown').length).toBeGreaterThan(0));
    const shown = lastPayload('specsShown') as { id: string }[];
    expect(shown.map((row) => row.id)).toEqual(['b-prd', 'b-api', 'doc-1']);
  });

  it("starts from the slice's search, so Sources opens it on one repository, and keeps it there", async () => {
    given('acme/api');
    renderSection();

    await screen.findByText('api.md');
    await waitFor(() => expect(screen.queryByText('prd.md')).toBeNull());
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('acme/api');
    expect(lastPayload('setSpecsSearch')).toBe('acme/api');
    await waitFor(() => expect((lastPayload('specsShown') as { id: string }[]).map((row) => row.id)).toEqual(['b-api']));

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'api.md' } });
    expect(lastPayload('setSpecsSearch')).toBe('api.md');
  });

  it('says there are no specs yet and offers Upload documents and Connect source', async () => {
    specRows.mockResolvedValue(answer([]));
    renderSection();

    expect(await screen.findByText('empty_title')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'upload p-1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'empty_connect' }));
    expect(openSourcesConnect).toHaveBeenCalledWith('the-bridge');
  });

  it('says so when nothing matches the search', async () => {
    given('nothing like this');
    renderSection();

    expect(await screen.findByText('no_matches')).toBeTruthy();
    expect(screen.queryByText('empty_title')).toBeNull();
  });

  it("warns when the repositories' files could not be read", async () => {
    specRows.mockResolvedValue(answer([PRD], { files_known: false }));
    renderSection();

    expect(await screen.findByText('files_unknown')).toBeTruthy();
  });

  it('shows its own error when the specs cannot be read, and reads them again on Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    specRows.mockRejectedValueOnce(new Error('503'));
    renderSection();

    expect(await screen.findByText('read_failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));

    expect(await screen.findByText('prd.md')).toBeTruthy();
    expect(specRows).toHaveBeenCalledTimes(2);
  });

  it('shows its own error with Retry when the first read fails under a seeded search', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    given('acme/api');
    specRows.mockRejectedValueOnce(new Error('503'));
    renderSection();

    expect(await screen.findByText('read_failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'retry' })).toBeTruthy();
    expect(specRows).toHaveBeenCalledTimes(1);
    // The slice keeps the source's search, so Retry opens the list on it again.
    expect(actions('setSpecsSearch')).toEqual([]);
  });

  it('gives Check nothing to send once a reload fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderSection();
    await screen.findByText('prd.md');

    specRows.mockRejectedValueOnce(new Error('503'));
    act(() => eventBus.emit('mfe/projects/specs-changed', { projectId: 'p-1' }));

    expect(await screen.findByText('read_failed')).toBeTruthy();
    expect(lastPayload('specsShown')).toEqual([]);
  });

  it('counts the shown rows, the open findings and names the project under the table', async () => {
    renderSection();
    await screen.findByText('prd.md');

    expect(await screen.findByText('footer_of 3 · footer_findings 2 · Billing')).toBeTruthy();
  });

  it('shows the Review a check left, once the list is told the specs changed', async () => {
    renderSection();
    await screen.findByText('review_check_needed');

    specRows.mockResolvedValue(answer([PRD, API, { ...STUDIO, checked_at: '2026-10-26T00:00:00Z', findings: 3 }]));
    act(() => eventBus.emit('mfe/projects/specs-changed', { projectId: 'p-1' }));

    expect(await screen.findByText('review_findings 3')).toBeTruthy();
    expect(screen.queryByText('review_check_needed')).toBeNull();
  });
});
