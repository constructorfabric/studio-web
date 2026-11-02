import { withOwnQueryCache } from '@frontx-test-utils/withOwnQueryCache';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FrontXProvider, i18nRegistry } from '@gears-frontx/react';
import { CONNECTION_LIST_NAMESPACE } from '../../../i18n';
import en from '../i18n/en.json';
import { ConnectionsTable } from './ConnectionsTable';
import type { ConnectionRow } from '../../../shared/useConnectionList';

/**
 * The row, without any HTTP. The health cell is the one part that would reach
 * the network, so it is stubbed: what this test is for is the other five
 * columns, and above all that the four without a data source render a
 * placeholder rather than a value borrowed from a different fact.
 */
vi.mock('@gears-frontx/react', (importOriginal) => withOwnQueryCache(importOriginal));

vi.mock('./HealthInline', () => ({
  HealthInline: ({ connectionId }: { connectionId: string }) => (
    <span data-testid={`health-${connectionId}`}>stub</span>
  ),
}));

const ROW: ConnectionRow = {
  connection: {
    id: 'c-1',
    owner_tenant_id: 'org-1',
    provider: 'github',
    label: 'Platform GitHub',
    account: 'constructorfabric',
    base_url: 'https://api.github.com',
    scope: 'organization',
    secret_ref: 'ref',
    created_at_epoch_secs: 1_700_000_000,
  },
  providerName: 'GitHub',
};

async function mount(rows: ConnectionRow[]) {
  const { mfeApp } = await import('../../../init');
  i18nRegistry.register(CONNECTION_LIST_NAMESPACE, 'en' as never, en);

  render(
    <FrontXProvider app={mfeApp}>
      <ConnectionsTable rows={rows} tenantId="org-1" empty={null} />
    </FrontXProvider>
  );
}

describe('ConnectionsTable', () => {
  it('names the connection and captions it with the account and the scope', async () => {
    await mount([ROW]);

    expect(screen.getByText('Platform GitHub')).toBeTruthy();
    expect(screen.getByText('constructorfabric · organization')).toBeTruthy();
  });

  it('gives the row its own health cell, scoped to the organization', async () => {
    await mount([ROW]);

    expect(screen.getByTestId('health-c-1')).toBeTruthy();
  });

  it('renders a placeholder in all four columns with no data source', async () => {
    await mount([ROW]);

    // One per gap: available data, projects, last sync, actions.
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it("never shows the record's creation time under Last sync", async () => {
    await mount([ROW]);

    // 1_700_000_000 is 2023 — any rendering of it, relative or absolute, is wrong.
    expect(screen.queryByText(/2023|ago/)).toBeNull();
  });

  it('draws every column the mockup has', async () => {
    await mount([ROW]);

    for (const head of [
      en.col_connection,
      en.col_status,
      en.col_available,
      en.col_projects,
      en.col_last_sync,
      en.col_actions,
    ]) {
      expect(screen.getByRole('columnheader', { name: head })).toBeTruthy();
    }
  });
});
