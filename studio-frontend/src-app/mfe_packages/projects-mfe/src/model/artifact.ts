import {
  ARTIFACT_NODE_TYPES,
  type ArtifactKind,
  type ArtifactNodeDto,
  type ArtifactNodeValue,
} from '../api/artifactTypes';

export type ArtifactProvenance = 'checkout' | 'tree' | 'upload' | 'repository';

export interface ArtifactRow {
  id: string;
  /** `null` when the gear sent a kind this portal does not draw — see below. */
  kind: ArtifactKind | null;
  name: string;
  repository: string;
  path: string;
  url: string | null;
  sync: 'ingested';
  updatedAt: number | null;
  provenance: ArtifactProvenance | null;
}

export interface ArtifactRepository {
  id: string;
  name: string;
}

const KIND_BY_TYPE_ID = new Map<string, ArtifactKind>(
  Object.entries(ARTIFACT_NODE_TYPES).map(([kind, typeId]) => [typeId, kind as ArtifactKind])
);

function kindOf(node: ArtifactNodeDto): ArtifactKind | null {
  return KIND_BY_TYPE_ID.get(node.type_id) ?? null;
}

function instant(value: ArtifactNodeValue): number | null {
  const raw = value.updated_at ?? value.created_at;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function fileProvenance(value: ArtifactNodeValue): ArtifactProvenance {
  if (value.origin) return 'upload';
  if (value.has_text === true) return 'checkout';
  return 'tree';
}

function pathFromUrl(raw: string | undefined, repository: string): string {
  if (!raw) return '';
  let path: string;
  try {
    const { pathname, search } = new URL(raw);
    path = `${pathname}${search}`;
  } catch {
    path = raw;
  }
  path = path.replace(/^\//, '');
  if (repository && path.startsWith(`${repository}/`)) {
    return path.slice(repository.length + 1);
  }
  return path;
}

function pathOf(
  kind: ArtifactKind | null,
  value: ArtifactNodeValue,
  repository: string
): string {
  if (kind === 'repo') return '';
  if (kind === 'file') return value.path ?? '';
  return pathFromUrl(value.url, repository);
}

function nameOf(kind: ArtifactKind | null, value: ArtifactNodeValue): string {
  if (kind === 'repo') return value.full_path ?? '';
  if (kind === 'file') return value.path?.split('/').pop() ?? value.path ?? '';
  const title = value.title ?? '';
  return value.number != null ? `#${value.number} ${title}`.trim() : title;
}

export function buildRepositories(nodes: readonly ArtifactNodeDto[]): ArtifactRepository[] {
  const repositories: ArtifactRepository[] = [];
  for (const node of nodes) {
    if (kindOf(node) !== 'repo') continue;
    const name = node.value.full_path ?? '';
    if (name) repositories.push({ id: node.instance_id, name });
  }
  return repositories.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every node in the answer becomes a row. Which kinds belong in a listing is
 * the gear's decision, taken before it pages — a client that dropped rows here
 * would be filtering after the page was cut, which leaves `total` and the page
 * count describing a set the table never shows.
 */
export function buildArtifactRows(
  nodes: readonly ArtifactNodeDto[],
  repoNames: ReadonlyMap<string, string>
): ArtifactRow[] {
  const rows: ArtifactRow[] = [];
  for (const node of nodes) {
    const kind = kindOf(node);
    const value = node.value;
    const updatedAt = instant(value);
    const repository =
      kind === 'repo' ? (value.full_path ?? '') : (repoNames.get(value.repo ?? '') ?? '');
    rows.push({
      id: node.instance_id,
      kind,
      name: nameOf(kind, value),
      repository,
      path: pathOf(kind, value, repository),
      url: value.url ?? null,
      sync: 'ingested',
      updatedAt,
      provenance:
        updatedAt !== null || kind === null
          ? null
          : kind === 'file'
            ? fileProvenance(value)
            : 'repository',
    });
  }

  return rows;
}
