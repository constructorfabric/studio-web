import { describe, expect, it } from 'vitest';
import type { SpecRowDto, SpecRowsSourcesDto } from '../api/documentTypes';
import {
  buildSpecRows,
  documentTypeOptions,
  filterSpecRows,
  sortSpecRows,
  specsFooter,
  type SpecRow,
  type SpecsQuery,
} from './specRows';
import { specRowDto as dto } from './specRows.fixture';

const KNOWN: SpecRowsSourcesDto = {
  files_known: true,
  reviews_known: true,
  repos_known: true,
  counts: [],
};

const UNREAD: SpecRowsSourcesDto = { ...KNOWN, reviews_known: false };

const TYPES = [
  { key: 'prd', name: 'PRD' },
  { key: 'adr', name: 'ADR' },
];

const authored = (overrides: Partial<SpecRowDto> = {}): SpecRowDto =>
  dto({
    origin: 'authored',
    path: '',
    node_id: null,
    state: null,
    status: 'draft',
    repo: '',
    repo_full_path: '',
    confidence: null,
    ...overrides,
  });

const candidate = (): SpecRowDto => {
  const row = dto({
    type_key: null,
    state: null,
    confidence: null,
    checked_at: null,
    queues: ['not-scanned'],
  });
  return { ...row, id: `candidate:${row.node_id}` };
};

const one = (row: SpecRowDto, sources: SpecRowsSourcesDto = KNOWN): SpecRow =>
  buildSpecRows([row], sources, TYPES)[0];

const rowsOf = (...items: SpecRowDto[]): SpecRow[] => buildSpecRows(items, KNOWN, TYPES);

const ALL: SpecsQuery = { filter: 'all', documentType: null, search: '' };

describe('Review', () => {
  it('asks for a type first, whatever the verdicts say', () => {
    expect(one(dto({ type_key: null, findings: 3 })).review).toEqual({ kind: 'needs_type' });
  });

  it('is unknown for every typed row while the verdicts could not be read', () => {
    expect(one(dto({ findings: 3 }), UNREAD).review).toEqual({ kind: 'unknown' });
    expect(one(dto({ checked_at: null }), UNREAD).review).toEqual({ kind: 'unknown' });
  });

  it('counts findings before it looks at the date: an undated verdict still has them', () => {
    expect(one(dto({ findings: 2, checked_at: null })).review).toEqual({
      kind: 'findings',
      count: 2,
    });
  });

  it('needs a check when nothing has looked, and is clean when something found nothing', () => {
    expect(one(dto({ checked_at: null })).review).toEqual({ kind: 'check_needed' });
    expect(one(dto()).review).toEqual({ kind: 'clean' });
  });
});

describe('Type', () => {
  it("takes the workspace's name, or the key when the workspace has no such type", () => {
    expect(one(dto({ type_key: 'adr' })).type?.name).toBe('ADR');
    expect(one(dto({ type_key: 'runbook' })).type?.name).toBe('runbook');
  });

  it('is proposed, with its confidence, only while detected', () => {
    expect(one(dto({ state: 'detected', confidence: 0.72 })).type).toMatchObject({
      proposed: true,
      confidence: 0.72,
    });
    expect(one(dto({ state: 'confirmed', confidence: 0.72 })).type).toMatchObject({
      proposed: false,
      confidence: null,
    });
  });
});

describe('Source and opening', () => {
  it("is the repository and the file's folder", () => {
    const row = one(dto({ path: 'docs/specs/prd.md', node_id: 'n-prd' }));
    expect(row.source).toEqual({ kind: 'repository', fullPath: 'acme/web', folder: 'docs/specs' });
    expect(one(dto({ path: 'README.md' })).source).toMatchObject({ folder: '' });
    expect(row.location).toBe('acme/web/docs/specs/prd.md');
    expect(row.open).toEqual({
      kind: 'file',
      nodeId: 'n-prd',
      repository: 'acme/web',
      path: 'docs/specs/prd.md',
    });
  });

  it('is a repository that is gone only when both reads behind the path succeeded', () => {
    const lost = dto({ repo_full_path: '' });
    expect(one(lost).source).toEqual({ kind: 'gone' });
    expect(one(lost, { ...KNOWN, repos_known: false }).source).toEqual({ kind: 'unknown' });
    expect(one(lost, { ...KNOWN, files_known: false }).source).toEqual({ kind: 'unknown' });
    expect(one(lost).open).toBeNull();
  });

  it('is Studio for a document written there, which opens by its id', () => {
    const row = one(authored());
    expect(row.source).toEqual({ kind: 'studio' });
    expect(row.open).toEqual({ kind: 'document', documentId: row.id });
    expect(row.location).toBe('');
  });
});

describe('what a person may change and check', () => {
  it('decides the type of a binding, never of a Studio document or an unclassified file', () => {
    expect(one(dto()).typeEditable).toBe(true);
    expect(one(dto({ state: 'not_a_document', type_key: null })).typeEditable).toBe(true);
    expect(one(authored()).typeEditable).toBe(false);
    expect(one(candidate()).typeEditable).toBe(false);
  });

  it('checks a typed binding, proposed ones included, and a Studio document', () => {
    expect(one(dto()).checkable).toBe(true);
    expect(one(dto({ state: 'detected' })).checkable).toBe(true);
    expect(one(authored()).checkable).toBe(true);
  });

  it('does not check what has no type, no binding, or is not a specification', () => {
    expect(one(dto({ type_key: null, state: 'unknown' })).checkable).toBe(false);
    expect(one(candidate()).checkable).toBe(false);
    expect(one(dto({ state: 'not_a_document' })).checkable).toBe(false);
  });
});

describe('Filter specs', () => {
  const rows = rowsOf(
    dto({ findings: 2 }), // 0 with findings
    dto({ checked_at: null }), // 1 check needed
    dto({ type_key: null, state: 'unknown' }), // 2 type not set
    candidate(), // 3 type not set
    dto({ state: 'detected' }), // 4 type to confirm
    dto({ state: 'manual' }), // 5 confirmed
    authored(), // 6 confirmed
    dto({ state: 'not_a_document', type_key: null }) // 7 not a specification
  );
  const kept = (filter: SpecsQuery['filter']) =>
    filterSpecRows(rows, { ...ALL, filter }).map((row) => rows.indexOf(row));

  it('keeps all but the rejected rows for All specs, and only those for Not specifications', () => {
    expect(kept('all')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(kept('not_specifications')).toEqual([7]);
  });

  it('keeps each review and type state', () => {
    expect(kept('with_findings')).toEqual([0]);
    expect(kept('check_needed')).toEqual([1]);
    expect(kept('type_not_set')).toEqual([2, 3]);
    expect(kept('type_to_confirm')).toEqual([4]);
    expect(kept('type_confirmed')).toEqual([0, 1, 5, 6]);
  });

  it('keeps nothing under With findings and Check needed while verdicts are unread', () => {
    const unread = buildSpecRows([dto({ findings: 2 }), dto({ checked_at: null })], UNREAD, TYPES);
    expect(filterSpecRows(unread, { ...ALL, filter: 'with_findings' })).toEqual([]);
    expect(filterSpecRows(unread, { ...ALL, filter: 'check_needed' })).toEqual([]);
  });
});

describe('document type and search', () => {
  const prd = one(dto({ name: 'Product.md', path: 'docs/product/Product.md' }));
  const adr = one(
    dto({ type_key: 'adr', name: 'adr-1.md', path: 'adr/adr-1.md', repo_full_path: 'acme/api' })
  );
  const doc = one(authored({ name: 'Notes' }));
  const rows = [prd, adr, doc];

  it('keeps one type', () => {
    expect(filterSpecRows(rows, { ...ALL, documentType: 'adr' })).toEqual([adr]);
  });

  it('matches the name, the path and the repository, in any case', () => {
    expect(filterSpecRows(rows, { ...ALL, search: 'PRODUCT' })).toEqual([prd]);
    expect(filterSpecRows(rows, { ...ALL, search: 'acme/api' })).toEqual([adr]);
    const pasted = 'acme/web/docs/product/product.md';
    expect(filterSpecRows(rows, { ...ALL, search: pasted })).toEqual([prd]);
    expect(filterSpecRows(rows, { ...ALL, search: ' notes ' })).toEqual([doc]);
  });

  it('offers the types of the default view, once each, by name', () => {
    const rejected = one(dto({ type_key: 'runbook', state: 'not_a_document' }));
    expect(documentTypeOptions([prd, adr, prd, doc, rejected])).toEqual([
      { key: 'adr', name: 'ADR' },
      { key: 'prd', name: 'PRD' },
    ]);
  });
});

describe('order', () => {
  const names = (rows: readonly SpecRow[]) => rows.map((row) => row.name);
  const sorted = (rows: readonly SpecRow[], column: string, direction: 'asc' | 'desc') =>
    names(sortSpecRows(rows, { column, direction }));

  it('keeps the API order without one, and for a column it does not know', () => {
    const rows = rowsOf(dto({ name: 'b' }), dto({ name: 'a' }));
    expect(names(sortSpecRows(rows, undefined))).toEqual(['b', 'a']);
    expect(sorted(rows, 'updated', 'asc')).toEqual(['b', 'a']);
  });

  it('sorts Document by name either way', () => {
    const rows = rowsOf(dto({ name: 'b' }), dto({ name: 'a' }), dto({ name: 'c' }));
    expect(sorted(rows, 'document', 'asc')).toEqual(['a', 'b', 'c']);
    expect(sorted(rows, 'document', 'desc')).toEqual(['c', 'b', 'a']);
  });

  it('sorts Type by name, untyped last in either direction', () => {
    const rows = rowsOf(
      dto({ name: 'none', type_key: null }),
      dto({ name: 'prd' }),
      dto({ name: 'adr', type_key: 'adr' })
    );
    expect(sorted(rows, 'type', 'asc')).toEqual(['adr', 'prd', 'none']);
    expect(sorted(rows, 'type', 'desc')).toEqual(['prd', 'adr', 'none']);
  });

  it('puts the most findings first, then check needed, needs type, unknown and clean', () => {
    const rows = rowsOf(
      dto({ name: 'clean' }),
      dto({ name: 'one', findings: 1 }),
      dto({ name: 'untyped', type_key: null }),
      dto({ name: 'three', findings: 3 }),
      dto({ name: 'unchecked', checked_at: null })
    );
    expect(sorted(rows, 'review', 'desc')).toEqual([
      'three',
      'one',
      'unchecked',
      'untyped',
      'clean',
    ]);
    const unread = buildSpecRows(
      [dto({ name: 'unknown' }), dto({ name: 'untyped', type_key: null })],
      UNREAD,
      TYPES
    );
    expect(sorted(unread, 'review', 'desc')).toEqual(['untyped', 'unknown']);
  });

  it('sorts Source by repository and path, Studio documents last in either direction', () => {
    const rows = rowsOf(
      authored({ name: 'studio' }),
      dto({ name: 'web', repo_full_path: 'acme/web', path: 'a.md' }),
      dto({ name: 'api', repo_full_path: 'acme/api', path: 'z.md' })
    );
    expect(sorted(rows, 'source', 'asc')).toEqual(['api', 'web', 'studio']);
    expect(sorted(rows, 'source', 'desc')).toEqual(['web', 'api', 'studio']);
  });

  it('keeps the API order between rows that both sort last', () => {
    const rows = rowsOf(
      authored({ name: 'studio-1', type_key: 'adr' }),
      dto({ name: 'untyped-1', type_key: null }),
      authored({ name: 'studio-2', type_key: 'adr' }),
      dto({ name: 'untyped-2', type_key: null })
    );
    for (const direction of ['asc', 'desc'] as const) {
      expect(sorted(rows, 'source', direction).slice(2)).toEqual(['studio-1', 'studio-2']);
      expect(sorted(rows, 'type', direction).slice(2)).toEqual(['untyped-1', 'untyped-2']);
    }
  });

  it('keeps the API order between equals', () => {
    const rows = rowsOf(dto({ name: 'first' }), dto({ name: 'second' }));
    expect(sorted(rows, 'type', 'desc')).toEqual(['first', 'second']);
  });
});

describe('footer', () => {
  const rows = rowsOf(
    dto({ findings: 2 }),
    dto({ findings: 3 }),
    dto(),
    dto({ state: 'not_a_document', findings: 4 })
  );

  it('counts the default view and sums its findings', () => {
    expect(specsFooter(rows, true)).toEqual({ total: 3, findings: 5 });
  });

  it('counts the rows outside the default view under Not specifications', () => {
    expect(specsFooter(rows, true, 'not_specifications')).toEqual({ total: 1, findings: 4 });
    expect(specsFooter(rows, true, 'with_findings').total).toBe(3);
  });

  it('has no findings count while the verdicts could not be read', () => {
    expect(specsFooter(rows, false).findings).toBeNull();
  });
});
