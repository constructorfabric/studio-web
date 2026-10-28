// @cpt-algo:cpt-studiofrontend-algo-project-sources-row-menu:p2
// @cpt-dod:cpt-studiofrontend-dod-project-sources-menu:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-menu-open-in:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-menu-disconnect:p1
import { repositoryWebUrl } from './projectSources';
import type { SourceLastSync, SourceRow, SourceSync } from './sourceRows';

export type SyncDisabled =
  | { reason: 'cancelling' }
  | { reason: 'requesting' }
  | { reason: 'not_connected' }
  | { reason: 'unavailable'; provider: string }
  | { reason: 'connections_unread' };

export type SourceMenuItem =
  | { kind: 'cancel_sync'; disabled: SyncDisabled | null }
  | { kind: 'sync_now'; retry: boolean; disabled: SyncDisabled | null }
  | { kind: 'open_specs' }
  | { kind: 'open_in'; url: string; provider: string }
  | { kind: 'open_uploads' }
  | { kind: 'disconnect' };

function cancelSyncItem(sync: Extract<SourceSync, { kind: 'in_flight' }>): SourceMenuItem {
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-2
  if (sync.canCancel) return { kind: 'cancel_sync', disabled: null };
  return {
    kind: 'cancel_sync',
    disabled: { reason: sync.cancelling ? 'cancelling' : 'requesting' },
  };
  // @cpt-end:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-2
}

function cannotSync(lastSync: SourceLastSync): SyncDisabled | null {
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-3
  if (lastSync.kind === 'not_connected') return { reason: 'not_connected' };
  // @cpt-end:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-3
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-4
  if (lastSync.kind === 'unavailable') {
    return { reason: 'unavailable', provider: lastSync.provider };
  }
  // @cpt-end:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-4
  return null;
}

function syncNowItem(row: SourceRow, connectionsRead: boolean): SourceMenuItem {
  const blocked = cannotSync(row.lastSync);
  if (blocked) return { kind: 'sync_now', retry: false, disabled: blocked };
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-5
  if (row.sync.kind === 'stopped' && row.sync.canRetry) {
    return { kind: 'sync_now', retry: true, disabled: null };
  }
  // @cpt-end:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-5
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-6
  // A new sync sends the connection's provider, base URL and credential reference.
  if (!connectionsRead) {
    return { kind: 'sync_now', retry: false, disabled: { reason: 'connections_unread' } };
  }
  // @cpt-end:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-6
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-7
  return { kind: 'sync_now', retry: false, disabled: null };
  // @cpt-end:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-7
}

function syncItemOf(row: SourceRow, connectionsRead: boolean): SourceMenuItem {
  return row.sync.kind === 'in_flight'
    ? cancelSyncItem(row.sync)
    : syncNowItem(row, connectionsRead);
}

export function sourceRowMenu(row: SourceRow, connectionsRead: boolean): SourceMenuItem[] {
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-1
  const items: SourceMenuItem[] = [syncItemOf(row, connectionsRead)];
  // @cpt-end:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-1
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-8
  items.push({ kind: 'open_specs' });
  // @cpt-end:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-8
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-9
  const url = repositoryWebUrl(row.cloneUrl);
  if (row.provider !== null && url !== null) {
    items.push({ kind: 'open_in', url, provider: row.provider });
  }
  // @cpt-end:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-9
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-10
  items.push({ kind: 'disconnect' });
  // @cpt-end:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-10
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-11
  return items;
  // @cpt-end:cpt-studiofrontend-algo-project-sources-row-menu:p2:inst-11
}

export function uploadsRowMenu(): SourceMenuItem[] {
  return [{ kind: 'open_uploads' }, { kind: 'disconnect' }];
}
