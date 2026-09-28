import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactRow } from '../../../model/artifact';
import type { ArtifactColumn } from './artifactColumns';
import { ArtifactsTable, type ArtifactsTableLabels } from './ArtifactsTable';

/** A new filter or page keeps the table's frame; only the rows wait. */

const LABELS: ArtifactsTableLabels = {
  table: 'Artifacts',
  emptyMessage: 'No artifacts match.',
  previous: 'Previous',
  next: 'Next',
  sortedNewest: 'Newest first',
  range: (from, to, total) => `${from}–${to} of ${total}`,
  page: (index) => `Page ${index}`,
};

const COLUMNS: ArtifactColumn[] = [
  { key: 'name', label: 'Name', className: '', render: (row: ArtifactRow) => row.name },
  { key: 'actions', label: '', className: '', render: () => null },
];

const ROW: ArtifactRow = {
  id: 'n-1',
  kind: 'file',
  name: 'README.md',
  repository: 'group/repo',
  path: 'README.md',
  url: null,
  sync: 'ingested',
  updatedAt: null,
  provenance: 'tree',
};

function table(props: { rows: ArtifactRow[]; loading?: boolean }) {
  return (
    <ArtifactsTable
      columns={COLUMNS}
      labels={LABELS}
      offset={0}
      total={40}
      pageSize={18}
      onOffsetChange={vi.fn()}
      {...props}
    />
  );
}

describe('artifacts table while rows are on the way', () => {
  it('keeps the header and the paginator, and marks the body busy', () => {
    const { rerender } = render(table({ rows: [ROW] }));
    rerender(table({ rows: [], loading: true }));

    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 2' })).toBeTruthy();
    expect(screen.queryByText('README.md')).toBeNull();
    expect(screen.queryByText('No artifacts match.')).toBeNull();

    const body = screen.getAllByRole('rowgroup')[1];
    expect(body.getAttribute('aria-busy')).toBe('true');
    expect(within(body).getAllByRole('row')).toHaveLength(3);
  });

  it('draws as many skeleton rows as the page it replaces', () => {
    const page = Array.from({ length: 5 }, (_, index) => ({ ...ROW, id: `n-${index}` }));
    const { rerender } = render(table({ rows: [], loading: true }));
    rerender(table({ rows: page }));
    rerender(table({ rows: [], loading: true }));

    expect(within(screen.getAllByRole('rowgroup')[1]).getAllByRole('row')).toHaveLength(5);
  });

  it('shows the rows and drops the busy mark once they arrive', () => {
    const { rerender } = render(table({ rows: [], loading: true }));
    rerender(table({ rows: [ROW] }));

    expect(screen.getByText('README.md')).toBeTruthy();
    expect(screen.getAllByRole('rowgroup')[1].hasAttribute('aria-busy')).toBe(false);
  });
});
