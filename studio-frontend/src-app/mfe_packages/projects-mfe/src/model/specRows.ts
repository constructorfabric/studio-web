/**
 * The Specs list's rows, built from `spec-rows`: what each row shows, what
 * *Filter specs*, the document type and the search keep, the order of each
 * column and the footer (#689). The table reads them through
 * `shared/useSpecsLoad.tsx`.
 */

import type {
  BindingState,
  DocumentTypeDto,
  SpecRowDto,
  SpecRowsSourcesDto,
} from '../api/documentTypes';
import type { SpecsFilter } from './specsFilter';

/** `null` on the row while nothing has decided a type. */
export interface SpecType {
  key: string;
  /** The workspace's name for it, or the key when the workspace has no such type. */
  name: string;
  /** A classifier's guess still waiting for a person (`detected`). */
  proposed: boolean;
  /** 0..1, only on a proposed type that came with one. */
  confidence: number | null;
}

export type SpecReview =
  | { kind: 'needs_type' }
  /** The verdicts could not be read (`reviews_known` false): neither checked nor not. */
  | { kind: 'unknown' }
  | { kind: 'findings'; count: number }
  | { kind: 'check_needed' }
  | { kind: 'clean' };

export type SpecSource =
  | { kind: 'repository'; fullPath: string; folder: string }
  | { kind: 'studio' }
  /** The repository could not be read, so its path is missing rather than gone. */
  | { kind: 'unknown' }
  | { kind: 'gone' };

/** What opening the row asks the shell for (#692, #694). */
export type SpecOpen =
  | { kind: 'file'; nodeId: string; repository: string; path: string }
  | { kind: 'document'; documentId: string };

export interface SpecRow {
  /** The binding id, the document id, or `candidate:<node_id>` for an unclassified file. */
  id: string;
  origin: 'repository' | 'authored';
  name: string;
  state: BindingState | null;
  type: SpecType | null;
  review: SpecReview;
  source: SpecSource;
  /** `null` for a file whose repository is not known: there is no checkout to open it from. */
  open: SpecOpen | null;
  /** `repo_full_path/path`, for the search and the Source order. Empty for a Studio document. */
  location: string;
  /** A binding a person can decide the type of (#690). A Studio document's type never changes. */
  typeEditable: boolean;
  /** What Check may send (#691): typed, and a binding or a Studio document. */
  checkable: boolean;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

// `findings` before `checked_at`: a verdict recorded before verdicts were dated
// has findings and no date.
function reviewOf(row: SpecRowDto, reviewsKnown: boolean): SpecReview {
  if (!row.type_key) return { kind: 'needs_type' };
  if (!reviewsKnown) return { kind: 'unknown' };
  if (row.findings > 0) return { kind: 'findings', count: row.findings };
  if (row.checked_at === null) return { kind: 'check_needed' };
  return { kind: 'clean' };
}

// An empty path is a repository the graph no longer holds only when both reads
// behind it succeeded (`SpecRowDto.repo_full_path`).
function sourceOf(row: SpecRowDto, sources: SpecRowsSourcesDto): SpecSource {
  if (row.origin === 'authored') return { kind: 'studio' };
  if (row.repo_full_path) {
    return { kind: 'repository', fullPath: row.repo_full_path, folder: folderOf(row.path) };
  }
  return sources.files_known && sources.repos_known ? { kind: 'gone' } : { kind: 'unknown' };
}

function openOf(row: SpecRowDto): SpecOpen | null {
  if (row.origin === 'authored') return { kind: 'document', documentId: row.id };
  if (!row.node_id || !row.repo_full_path) return null;
  return { kind: 'file', nodeId: row.node_id, repository: row.repo_full_path, path: row.path };
}

export function buildSpecRows(
  items: readonly SpecRowDto[],
  sources: SpecRowsSourcesDto,
  types: readonly DocumentTypeDto[]
): SpecRow[] {
  const names = new Map(types.map((type) => [type.key, type.name]));
  return items.map((row) => {
    const proposed = row.state === 'detected';
    const type: SpecType | null = row.type_key
      ? {
          key: row.type_key,
          name: names.get(row.type_key) ?? row.type_key,
          proposed,
          confidence: proposed ? row.confidence : null,
        }
      : null;
    const typeEditable = row.origin === 'repository' && !row.id.startsWith('candidate:');
    return {
      id: row.id,
      origin: row.origin,
      name: row.name,
      state: row.state,
      type,
      review: reviewOf(row, sources.reviews_known),
      source: sourceOf(row, sources),
      open: openOf(row),
      location: [row.repo_full_path, row.path].filter(Boolean).join('/'),
      typeEditable,
      checkable:
        type !== null &&
        row.state !== 'not_a_document' &&
        (row.origin === 'authored' || typeEditable),
    };
  });
}

/** Every row but the ones a person said are not specifications. */
export function inDefaultView(row: SpecRow): boolean {
  return row.state !== 'not_a_document';
}

function keptBy(filter: SpecsFilter, row: SpecRow): boolean {
  if (filter === 'not_specifications') return !inDefaultView(row);
  if (!inDefaultView(row)) return false;
  switch (filter) {
    case 'all':
      return true;
    case 'with_findings':
      return row.review.kind === 'findings';
    case 'check_needed':
      return row.review.kind === 'check_needed';
    case 'type_not_set':
      return row.type === null;
    case 'type_to_confirm':
      return row.state === 'detected';
    case 'type_confirmed':
      return row.state === 'confirmed' || row.state === 'manual' || row.origin === 'authored';
  }
}

export interface SpecsQuery {
  filter: SpecsFilter;
  documentType: string | null;
  search: string;
}

export function filterSpecRows(rows: readonly SpecRow[], query: SpecsQuery): SpecRow[] {
  const needle = query.search.trim().toLowerCase();
  return rows.filter(
    (row) =>
      keptBy(query.filter, row) &&
      (query.documentType === null || row.type?.key === query.documentType) &&
      (!needle ||
        row.name.toLowerCase().includes(needle) ||
        row.location.toLowerCase().includes(needle))
  );
}

export interface SpecsOrder {
  column: string;
  direction: 'asc' | 'desc';
}

const REVIEW_WEIGHT: Record<SpecReview['kind'], number> = {
  clean: 0,
  unknown: 1,
  needs_type: 2,
  check_needed: 3,
  findings: 4,
};

/** Each column's key; `null` sorts last in either direction. */
const SORT_KEYS: Record<string, (row: SpecRow) => string | number | null> = {
  document: (row) => row.name,
  type: (row) => row.type?.name ?? null,
  review: ({ review }) =>
    REVIEW_WEIGHT[review.kind] + (review.kind === 'findings' ? review.count : 0),
  source: (row) => (row.origin === 'authored' ? null : row.location),
};

/**
 * The rows in that order; ties, and no order, keep the API's (newest first).
 * `findings` outweigh each other by count, so the most findings come first descending.
 */
export function sortSpecRows(rows: readonly SpecRow[], order: SpecsOrder | undefined): SpecRow[] {
  const key = order && SORT_KEYS[order.column];
  if (!key) return [...rows];
  const sign = order.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const cmp =
      typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return cmp * sign;
  });
}

/** The footer's M and K; its N is the snapshot's `shown`. */
export interface SpecsFooter {
  /** The rows of the default view. */
  total: number;
  /** Their findings, summed; `null` while the verdicts could not be read. */
  findings: number | null;
}

export function specsFooter(rows: readonly SpecRow[], reviewsKnown: boolean): SpecsFooter {
  const listed = rows.filter(inDefaultView);
  return {
    total: listed.length,
    findings: reviewsKnown
      ? listed.reduce(
          (sum, row) => sum + (row.review.kind === 'findings' ? row.review.count : 0),
          0
        )
      : null,
  };
}

/** The *Document type* menu: the types the default view holds, by name. */
export function documentTypeOptions(rows: readonly SpecRow[]): { key: string; name: string }[] {
  const types = new Map<string, string>();
  for (const row of rows) {
    if (row.type && inDefaultView(row)) types.set(row.type.key, row.type.name);
  }
  return [...types]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
