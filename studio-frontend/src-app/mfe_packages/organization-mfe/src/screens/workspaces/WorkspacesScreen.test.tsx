import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { tableProps, queryResult, org } = vi.hoisted(() => ({
  tableProps: { current: null as { rows: unknown[]; total: number } | null },
  queryResult: { current: {} as Record<string, unknown> },
  org: { current: { id: 'org-1', name: 'Fabric' } as { id: string; name: string } | null },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => ({ getWorkspaces: vi.fn(() => ({})) }) },
  useApiQuery: () => queryResult.current,
  useMfeBridge: () => null,
  useSharedProperty: () => null,
}));

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOrganization: () => ({ org: org.current, loading: false }),
}));

vi.mock('../../i18n', () => ({
  useWorkspacesScreenTranslations: () => ({ isLoaded: true, error: null }),
  useWorkspacesText: () => (key: string) => key,
}));

vi.mock('./components/WorkspacesToolbar', () => ({
  WorkspacesToolbar: ({
    onQueryChange,
  }: {
    onQueryChange: (value: string) => void;
  }) => (
    <input
      aria-label="search"
      onChange={(event) => onQueryChange(event.currentTarget.value)}
    />
  ),
}));

// Stubbed to read what the screen hands it: the caption's own wording is the
// table's business and is covered in WorkspacesTable.test.tsx.
vi.mock('./components/WorkspacesTable', () => ({
  WorkspacesTable: (props: { rows: unknown[]; total: number }) => {
    tableProps.current = props;
    return <div data-testid="table" />;
  },
}));

import { WorkspacesScreen } from './WorkspacesScreen';

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `w${index}`,
    name: index === 0 ? 'Platform' : `Workspace ${index}`,
    child_count: 1,
  }));

describe('WorkspacesScreen', () => {
  beforeEach(() => {
    org.current = { id: 'org-1', name: 'Fabric' };
    queryResult.current = {
      data: { items: rows(10) },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    tableProps.current = null;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('hands the table every workspace when nothing is searched for', () => {
    render(<WorkspacesScreen />);
    expect(tableProps.current?.rows).toHaveLength(10);
    expect(tableProps.current?.total).toBe(10);
  });

  // The regression: `total` followed the filtered rows, so the caption said
  // "1-2 of 2" and stopped naming the organization's real count.
  it('narrows the rows but keeps the organization count when a search runs', () => {
    render(<WorkspacesScreen />);

    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'Platform' } });

    expect(tableProps.current?.rows).toHaveLength(1);
    expect(tableProps.current?.total).toBe(10);
  });
});
