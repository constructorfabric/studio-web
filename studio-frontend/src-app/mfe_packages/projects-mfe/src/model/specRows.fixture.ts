import type { SpecRowDto } from '../api/documentTypes';

let n = 0;

/** A typed, confirmed, checked repository file with nothing found, unless told otherwise. */
export function specRowDto(overrides: Partial<SpecRowDto> = {}): SpecRowDto {
  n += 1;
  return {
    id: `b-${n}`,
    origin: 'repository',
    name: `doc-${n}.md`,
    path: `docs/doc-${n}.md`,
    type_key: 'prd',
    node_id: `node-${n}`,
    state: 'confirmed',
    status: null,
    conforms: null,
    updated_at: '2026-10-01T00:00:00Z',
    repo: 'repo-1',
    repo_full_path: 'acme/web',
    confidence: 0.9,
    checked_at: '2026-10-02T00:00:00Z',
    findings: 0,
    queues: ['bound'],
    ...overrides,
  };
}
