import type { SourceRow } from './sourceRows';

/** A synced GitHub source with nothing in flight */
export function sourceRow(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    kind: 'repository',
    id: 'c-github:acme/api',
    connectionId: 'c-github',
    provider: 'github',
    name: 'api',
    fullPath: 'acme/api',
    cloneUrl: 'https://github.com/acme/api.git',
    branch: 'main',
    nodeId: 'n-api',
    specs: 12,
    activity: null,
    lastSync: { kind: 'synced', at: '2026-10-14T10:52:00Z' },
    sync: { kind: 'none' },
    ...overrides,
  };
}
