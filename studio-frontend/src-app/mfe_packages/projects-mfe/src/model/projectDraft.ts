/**
 * What the New project wizard is collecting, before anything is sent.
 *
 * The draft is deliberately *not* the wire shape. A project is created as two
 * writes — an AM tenant, then its `cf.studio.project.config.v1~` metadata
 * (ADR-0010) — and the split between them is an artifact of AM's API, not of
 * what the user filled in.
 *
 * Assumptions recorded here rather than in the UI, because the mockups are
 * silent on both and the FEATURE fixes them:
 *
 * - **Journey stages.** The wizard has no stage picker on either screen, and
 *   `intent` is the one mandatory stage, so a new project starts with exactly
 *   `['intent']`. The other seven are added later from the project screen.
 * - **Sources.** A modernization takes one or more repositories, capped at
 *   `MAX_SOURCES`. ADR-0010 lists "modernize carries exactly one source" among
 *   the invariants that moved out of the database and became advisory when the
 *   `studio-project` gear was retired; this feature widens it, and the ADR
 *   records the change. Nothing on the wire enforces either shape — the
 *   metadata type is a free-form object.
 */

import type { ProjectMode } from '../api/types';

export type { ProjectMode };

/** Canonical order matters — `orderedStages` renders in it, not in config order. */
export const DEFAULT_STAGES: readonly string[] = ['intent'];

/** Only `draft` is reachable at creation; the ladder moves forward from there. */
export const INITIAL_STATUS = 'draft';

/**
 * Ceiling on how many repositories one project can be seeded from.
 *
 * A product limit, not a technical one: nothing on the wire counts, and the
 * array is stored verbatim. It is not accidentally reachable either — one
 * catalogue page is clamped to 100 rows, so filling it takes a deliberate sweep
 * across connections.
 */
export const MAX_SOURCES = 100;

export interface RepositoryPick {
  /** Provider-native id, unique within one connection. */
  readonly id: string;
  /** `group/repo`, what the user recognises. */
  readonly fullPath: string;
  readonly cloneUrl: string;
  /** Which connection it came from — the tab the user was on. */
  readonly connectionId: string;
}

/**
 * Identity of a pick, and it has to be composite.
 *
 * `id` is the provider's own, "unique within one connection" and nothing more —
 * two connections can hand back the same string for different repositories. The
 * selection spans connections (a project may be seeded from a GitHub repo and a
 * GitLab one), so comparing on `id` alone would make one row's checkbox toggle
 * another's.
 */
export function repoKey(connectionId: string, repoId: string): string {
  return `${connectionId}:${repoId}`;
}

export function sourceKey(pick: RepositoryPick): string {
  return repoKey(pick.connectionId, pick.id);
}

export interface ProjectDraft {
  readonly name: string;
  /** The mockup's GOAL field; stored as `brief` in project metadata. */
  readonly goal: string;
  /** Keycloak `sub`. One owner, not a list. */
  readonly ownerId: string | null;
  readonly mode: ProjectMode | null;
  /** Empty for greenfield, and for modernize until a row is picked. */
  readonly sources: readonly RepositoryPick[];
}

export const EMPTY_DRAFT: ProjectDraft = {
  name: '',
  goal: '',
  ownerId: null,
  mode: null,
  sources: [],
};

/**
 * A name is required and is trimmed before comparison, because AM stores what
 * we send and " Agent Platform" would read as a second project.
 *
 * Uniqueness inside the parent is NOT checked here. It was a unique index while
 * the retired gear owned projects; now it would take listing every sibling
 * through a cursor-paginated endpoint clamped at 200 rows, which is neither
 * atomic nor complete (ADR-0010). The wizard lets the write happen and reports
 * what AM answers.
 */
export function isNameUsable(name: string): boolean {
  return name.trim().length > 0;
}

/** One is enough to continue; the cap is enforced when picking, not here. */
export function hasRequiredSource(draft: ProjectDraft): boolean {
  return draft.mode !== 'modernize' || draft.sources.length > 0;
}
