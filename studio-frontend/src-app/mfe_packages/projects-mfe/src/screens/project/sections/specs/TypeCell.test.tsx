import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecRowDto, SpecRowsSourcesDto } from '../../../../api/documentTypes';

const { pending, requestTypeDecision } = vi.hoisted(() => ({
  pending: [] as string[],
  requestTypeDecision: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useAppSelector: (select: (state: unknown) => unknown) =>
    select({ 'projects/typeDecision': { pending } }),
  useFormatters: () => ({ formatPercent: (value: number) => `${Math.round(value * 100)}%` }),
}));
vi.mock('../../../../i18n', () => ({
  useSpecsText: () => (key: string, params?: Record<string, string>) =>
    params ? `${key} ${Object.values(params).join(' ')}` : key,
}));
vi.mock('../../../../actions/typeDecisionActions', () => ({ requestTypeDecision }));

import { buildSpecRows } from '../../../../model/specRows';
import { specRowDto } from '../../../../model/specRows.fixture';
import { TypeCell } from './TypeCell';

const SOURCES: SpecRowsSourcesDto = {
  files_known: true,
  reviews_known: true,
  repos_known: true,
  counts: [],
};
const TYPES = [
  { key: 'prd', name: 'PRD' },
  { key: 'adr', name: 'ADR' },
];

const rowOf = (overrides: Partial<SpecRowDto>) =>
  buildSpecRows([specRowDto({ name: 'prd.md', ...overrides })], SOURCES, TYPES)[0];

function renderCell(overrides: Partial<SpecRowDto> = {}) {
  const row = rowOf(overrides);
  render(<TypeCell row={row} types={TYPES} projectId="p-1" workspaceId="w-1" />);
  return row;
}

async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /type_change prd\.md/ }));
  return screen.findByRole('menu');
}

const sent = () => requestTypeDecision.mock.calls.map(([request]) => request.decision);

beforeEach(() => {
  pending.length = 0;
  requestTypeDecision.mockClear();
});

describe('the Type cell', () => {
  it('names a decided type', () => {
    renderCell({ type_key: 'adr' });
    expect(screen.getByRole('button').textContent).toContain('ADR');
    expect(screen.getByRole('button').textContent).not.toContain('type_proposed');
  });

  it('marks a proposed type with its confidence', () => {
    renderCell({ state: 'detected', confidence: 0.72 });
    expect(screen.getByRole('button').textContent).toContain('PRD · type_proposed 72%');
  });

  it('asks to set a type when a binding has none', () => {
    renderCell({ type_key: null, state: 'unknown' });
    expect(screen.getByRole('button').textContent).toContain('type_set');
  });

  it('has no menu for a file no scan has classified', () => {
    renderCell({ id: 'candidate:n-1', type_key: null, state: null });
    expect(screen.getByText('type_not_scanned')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('has no menu for a Studio document, whose type cannot change', () => {
    renderCell({ origin: 'authored', path: '', node_id: null, state: null, repo_full_path: '' });
    expect(screen.getByText('PRD')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is busy while its decision is sent', () => {
    const row = rowOf({});
    pending.push(row.id);
    render(<TypeCell row={row} types={TYPES} projectId="p-1" workspaceId="w-1" />);
    expect(screen.getByRole('button').getAttribute('aria-busy')).toBe('true');
  });
});

describe('the Type menu', () => {
  it("sends a person's decision for the binding, with the document's name", async () => {
    const row = renderCell({ type_key: 'prd' });
    fireEvent.click(within(await openMenu()).getByText('ADR'));
    expect(requestTypeDecision).toHaveBeenCalledWith({
      projectId: 'p-1',
      workspaceId: 'w-1',
      bindingId: row.id,
      name: 'prd.md',
      decision: { action: 'set', type_key: 'adr' },
    });
  });

  it('sends nothing for the type already decided', async () => {
    renderCell({ type_key: 'prd' });
    fireEvent.click(within(await openMenu()).getByText('PRD'));
    expect(requestTypeDecision).not.toHaveBeenCalled();
  });

  it('confirms a proposed type, from its own item or from the list', async () => {
    renderCell({ state: 'detected' });
    fireEvent.click(within(await openMenu()).getByText('type_confirm PRD'));
    fireEvent.click(within(await openMenu()).getByText('PRD'));
    expect(sent()).toEqual([{ action: 'confirm' }, { action: 'confirm' }]);
  });

  it('offers Confirm only for a proposed type', async () => {
    renderCell({ type_key: 'prd' });
    expect(within(await openMenu()).queryByText(/type_confirm/)).toBeNull();
  });

  it('resets a typed binding', async () => {
    renderCell({ type_key: 'prd' });
    fireEvent.click(within(await openMenu()).getByText('type_unknown'));
    expect(sent()).toEqual([{ action: 'reset' }]);
  });

  it('offers no Not a specification until the filters can bring a rejected row back (#878)', async () => {
    renderCell({ type_key: 'prd' });
    const menu = await openMenu();
    expect(within(menu).queryByText('type_not_spec')).toBeNull();
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
  });

  it('sends nothing for Unknown on a binding that has no type', async () => {
    renderCell({ type_key: null, state: 'unknown' });
    fireEvent.click(within(await openMenu()).getByText('type_unknown'));
    expect(requestTypeDecision).not.toHaveBeenCalled();
  });

  it('brings a rejected row back, as Unknown or with a type', async () => {
    renderCell({ type_key: null, state: 'not_a_document' });
    fireEvent.click(within(await openMenu()).getByText('type_unknown'));
    fireEvent.click(within(await openMenu()).getByText('ADR'));
    expect(sent()).toEqual([{ action: 'reset' }, { action: 'set', type_key: 'adr' }]);
  });

  it('marks the current type', async () => {
    renderCell({ type_key: 'adr' });
    const checked = within(await openMenu()).getByRole('menuitemradio', { checked: true });
    expect(checked.textContent).toContain('ADR');
  });
});
