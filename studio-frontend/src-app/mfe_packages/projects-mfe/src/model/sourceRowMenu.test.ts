import { describe, expect, it } from 'vitest';
import type { SourceRow } from './sourceRows';
import { sourceRow } from './sourceRows.fixture';
import { sourceRowMenu, uploadsRowMenu } from './sourceRowMenu';


const syncItem = (input: SourceRow, connectionsRead = true) => sourceRowMenu(input, connectionsRead)[0];

const IN_FLIGHT = { kind: 'in_flight', cancelling: false, canCancel: true } as const;
const FAILED = { kind: 'stopped', status: 'failed', reason: null, canRetry: true } as const;

describe('the row menu', () => {
  it('offers Sync now, Open specs, Open in and Disconnect, in that order', () => {
    expect(sourceRowMenu(sourceRow(), true)).toEqual([
      { kind: 'sync_now', retry: false, disabled: null },
      { kind: 'open_specs' },
      { kind: 'open_in', url: 'https://github.com/acme/api', provider: 'github' },
      { kind: 'disconnect' },
    ]);
  });

  it('keeps Open specs and Disconnect on a row that offers nothing else', () => {
    const items = sourceRowMenu(
      sourceRow({ provider: null, cloneUrl: 'git@github.com:acme/api.git', lastSync: { kind: 'not_connected' } }),
      false
    );
    expect(items.map((item) => item.kind)).toEqual(['sync_now', 'open_specs', 'disconnect']);
  });
});

describe("the uploads row's menu", () => {
  it('opens the uploaded documents, and offers Disconnect', () => {
    expect(uploadsRowMenu()).toEqual([{ kind: 'open_uploads' }, { kind: 'disconnect' }]);
  });
});

describe('the sync item', () => {
  it.each([
    ['a sync in flight with a run', sourceRow({ sync: IN_FLIGHT }), { kind: 'cancel_sync', disabled: null }],
    [
      'a cancel already pending',
      sourceRow({ sync: { kind: 'in_flight', cancelling: true, canCancel: false } }),
      { kind: 'cancel_sync', disabled: { reason: 'cancelling' } },
    ],
    [
      'a sync the gear has not given a run yet',
      sourceRow({ sync: { kind: 'in_flight', cancelling: false, canCancel: false } }),
      { kind: 'cancel_sync', disabled: { reason: 'requesting' } },
    ],
    [
      'a sync in flight whose connection is gone',
      sourceRow({ lastSync: { kind: 'not_connected' }, sync: IN_FLIGHT }),
      { kind: 'cancel_sync', disabled: null },
    ],
    [
      'a source whose connection is gone',
      sourceRow({ lastSync: { kind: 'not_connected' } }),
      { kind: 'sync_now', retry: false, disabled: { reason: 'not_connected' } },
    ],
    [
      'a failed sync whose connection is gone',
      sourceRow({ lastSync: { kind: 'not_connected' }, sync: FAILED }),
      { kind: 'sync_now', retry: false, disabled: { reason: 'not_connected' } },
    ],
    [
      'a provider that cannot sync',
      sourceRow({ provider: 'gitlab', lastSync: { kind: 'unavailable', provider: 'gitlab' } }),
      { kind: 'sync_now', retry: false, disabled: { reason: 'unavailable', provider: 'gitlab' } },
    ],
    ['a failed sync with a run', sourceRow({ sync: FAILED }), { kind: 'sync_now', retry: true, disabled: null }],
    [
      'a cancelled sync with a run',
      sourceRow({ sync: { kind: 'stopped', status: 'cancelled', reason: null, canRetry: true } }),
      { kind: 'sync_now', retry: true, disabled: null },
    ],
    [
      'a lost sync',
      sourceRow({ sync: { kind: 'stopped', status: 'lost', reason: null, canRetry: false } }),
      { kind: 'sync_now', retry: false, disabled: null },
    ],
    [
      'a sync request the gear refused',
      sourceRow({
        sync: {
          kind: 'stopped',
          status: 'failed',
          reason: { kind: 'i18n', key: 'artifacts_reason_request_failed' },
          canRetry: false,
        },
      }),
      { kind: 'sync_now', retry: false, disabled: null },
    ],
    [
      'a source never synced',
      sourceRow({ nodeId: null, lastSync: { kind: 'not_synced' } }),
      { kind: 'sync_now', retry: false, disabled: null },
    ],
  ])('%s', (_case, input, expected) => {
    expect(syncItem(input)).toEqual(expected);
  });

  it('needs the connections only for a new sync', () => {
    expect(syncItem(sourceRow(), false)).toEqual({
      kind: 'sync_now',
      retry: false,
      disabled: { reason: 'connections_unread' },
    });
    expect(syncItem(sourceRow({ sync: FAILED }), false)).toEqual({ kind: 'sync_now', retry: true, disabled: null });
    expect(syncItem(sourceRow({ sync: IN_FLIGHT }), false)).toEqual({ kind: 'cancel_sync', disabled: null });
  });
});

describe('Open in', () => {
  it('is left out for an SSH clone URL', () => {
    const kinds = sourceRowMenu(sourceRow({ cloneUrl: 'git@github.com:acme/api.git' }), true).map((item) => item.kind);
    expect(kinds).not.toContain('open_in');
  });

  it('is left out when the provider is not known', () => {
    const kinds = sourceRowMenu(sourceRow({ provider: null }), true).map((item) => item.kind);
    expect(kinds).not.toContain('open_in');
  });

  it('opens the address the clone URL gives, for the row provider', () => {
    expect(
      sourceRowMenu(
        sourceRow({ provider: 'bitbucket', cloneUrl: 'https://jdoe@bitbucket.org/acme/api.git' }),
        true
      ).find((item) => item.kind === 'open_in')
    ).toEqual({ kind: 'open_in', url: 'https://bitbucket.org/acme/api', provider: 'bitbucket' });
  });
});
