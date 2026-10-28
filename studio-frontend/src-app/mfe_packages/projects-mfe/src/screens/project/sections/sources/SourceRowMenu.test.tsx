import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../i18n', () => {
  const t = (key: string, params?: Record<string, string>) =>
    params ? `${key} ${JSON.stringify(params)}` : key;
  return { useSourcesText: () => t };
});

import type { SourceRow } from '../../../../model/sourceRows';
import { sourceRow } from '../../../../model/sourceRows.fixture';
import type { SourceRowActions } from '../../../../shared/useSourceRowActions';
import { SourceRowMenu } from './SourceRowMenu';

/** The menu draws what `sourceRowMenu` says and hands each item to the section's actions. */

const ROW = sourceRow();

const NAMES: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab' };

const actions = (): SourceRowActions => ({
  connectionsRead: true,
  providerName: (provider) => NAMES[provider] ?? provider,
  syncNow: vi.fn(),
  cancelSync: vi.fn(),
  openSpecs: vi.fn(),
  openUploads: vi.fn(),
});

async function openMenu(row: SourceRow, given: SourceRowActions) {
  render(<SourceRowMenu row={row} actions={given} />);
  fireEvent.click(screen.getByRole('button', { name: 'row_actions {"name":"api"}' }));
  return screen.findByRole('menu');
}

afterEach(() => vi.restoreAllMocks());

describe('the row menu', () => {
  it('lists Sync now, Open specs, Open in and, after a separator, Disconnect, disabled', async () => {
    const menu = await openMenu(ROW, actions());
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'menu_sync_now',
      'menu_open_specs',
      'menu_open_in {"provider":"GitHub"}',
      'menu_disconnect',
    ]);
    expect(items[3].getAttribute('aria-disabled')).toBe('true');
    expect(items[3].getAttribute('title')).toBe('menu_disconnect_unavailable');
    expect(within(menu).getByRole('separator')).toBeTruthy();
  });

  it('Sync now retries a stopped run that can be retried', async () => {
    const given = actions();
    const stopped = { kind: 'stopped', status: 'failed', reason: null, canRetry: true } as const;
    const menu = await openMenu(sourceRow({ sync: stopped }), given);
    fireEvent.click(within(menu).getByText('menu_sync_now'));
    expect(given.syncNow).toHaveBeenCalledWith(expect.objectContaining({ fullPath: 'acme/api' }), true);
  });

  it('Cancel sync stops a sync in flight', async () => {
    const given = actions();
    const inFlight = { kind: 'in_flight', cancelling: false, canCancel: true } as const;
    const menu = await openMenu(sourceRow({ sync: inFlight }), given);
    fireEvent.click(within(menu).getByText('menu_cancel_sync'));
    expect(given.cancelSync).toHaveBeenCalledWith(expect.objectContaining({ fullPath: 'acme/api' }));
  });

  it.each([
    ['cancelling', sourceRow({ sync: { kind: 'in_flight', cancelling: true, canCancel: false } }), true, 'sync_cancelling'],
    ['requesting', sourceRow({ sync: { kind: 'in_flight', cancelling: false, canCancel: false } }), true, 'sync_requesting'],
    ['not_connected', sourceRow({ lastSync: { kind: 'not_connected' } }), true, 'sync_not_connected'],
    [
      'unavailable',
      sourceRow({ provider: 'gitlab', lastSync: { kind: 'unavailable', provider: 'gitlab' } }),
      true,
      'sync_unavailable {"provider":"GitLab"}',
    ],
    ['connections_unread', sourceRow(), false, 'sync_connections_unread'],
  ] as const)('a sync item disabled as %s says so in its title', async (_reason, row, connectionsRead, title) => {
    const menu = await openMenu(row, { ...actions(), connectionsRead });
    const [item] = within(menu).getAllByRole('menuitem');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toBe(title);
  });

  it('a sync item that cannot be used says why, and does nothing', async () => {
    const given = actions();
    const menu = await openMenu(
      sourceRow({ provider: 'gitlab', lastSync: { kind: 'unavailable', provider: 'gitlab' } }),
      given
    );
    const item = within(menu).getByText('menu_sync_now').closest('[role="menuitem"]');
    expect(item?.getAttribute('aria-disabled')).toBe('true');
    expect(item?.getAttribute('title')).toBe('sync_unavailable {"provider":"GitLab"}');
    fireEvent.click(within(menu).getByText('menu_sync_now'));
    expect(given.syncNow).not.toHaveBeenCalled();
  });

  it('Open specs asks for the specs of the row', async () => {
    const given = actions();
    const menu = await openMenu(ROW, given);
    fireEvent.click(within(menu).getByText('menu_open_specs'));
    expect(given.openSpecs).toHaveBeenCalledWith(expect.objectContaining({ fullPath: 'acme/api' }));
  });

  it("Open in opens the repository's page in a new tab, without the opener", async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const menu = await openMenu(ROW, actions());
    fireEvent.click(within(menu).getByText('menu_open_in {"provider":"GitHub"}'));
    expect(open).toHaveBeenCalledWith('https://github.com/acme/api', '_blank', 'noopener,noreferrer');
  });
});
