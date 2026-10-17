/**
 * The Specs list's Check (#691): which specs it sends, how far its two Spec
 * Quality runs are, and what the toast says when they end.
 */

import type { StudioRunState } from '@constructor-studio/mfe-shared';
import type { AnalyzeBindingsRequest, QualityDetector } from '../api/documentTypes';
import type { SpecRow } from './specRows';

/** The two runs a check starts, in the order their reasons are read. */
export const CHECK_DETECTORS: readonly QualityDetector[] = ['purpose', 'leak'];

/** More specs than this asks first: the runs check them one at a time. */
export const CHECK_CONFIRM_ABOVE = 50;

/** A row Check may send: one of #689's `checkable` rows. */
export type SpecsCheckTarget = Pick<SpecRow, 'id' | 'origin'>;

/** The selected rows, or, with none selected, every row the filters show. */
export function checkTargets(
  selected: readonly string[],
  shown: readonly SpecsCheckTarget[]
): SpecsCheckTarget[] {
  if (selected.length === 0) return [...shown];
  const ticked = new Set(selected);
  return shown.filter((row) => ticked.has(row.id));
}

export function checkRequest(targets: readonly SpecsCheckTarget[]): AnalyzeBindingsRequest {
  return {
    binding_ids: targets.filter((row) => row.origin === 'repository').map((row) => row.id),
    document_ids: targets.filter((row) => row.origin === 'authored').map((row) => row.id),
  };
}

export interface CheckPhase {
  /** The spec the run is on, from 1. */
  step: number;
  total: number;
  /** The spec's path in the run: repo-relative, or `studio-doc/<id>.md`. */
  path: string;
}

/** A run's phase, `i/total · path` (`spec_quality.analyze_batch`), or `null` for anything else. */
export function parsePhase(phase: string | null | undefined): CheckPhase | null {
  const match = /^(\d+)\/(\d+) · (.+)$/.exec(phase ?? '');
  return match ? { step: Number(match[1]), total: Number(match[2]), path: match[3] } : null;
}

/** The phase of the run further behind; `null` until a run reports. */
export function behindPhase(phases: readonly (string | null | undefined)[]): CheckPhase | null {
  return phases
    .map(parsePhase)
    .reduce<CheckPhase | null>(
      (behind, phase) => (phase && (!behind || phase.step < behind.step) ? phase : behind),
      null
    );
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** How one of the two runs went, as the effect saw it. */
export type CheckRun =
  /** Its POST was refused. */
  | { kind: 'refused'; reason: string | null }
  /** `createRunFollower` gave up on it. */
  | { kind: 'lost'; documents: number }
  | {
      kind: 'ended';
      /** What its 202 said it would check. */
      documents: number;
      state: StudioRunState;
      /** The last phase it reported. */
      phase: string | null;
      error: string | null;
      result: Record<string, unknown> | null;
    };

/** What the toast says when the runs have ended. The words are the hook's. */
export type SpecsCheckOutcome =
  | {
      kind: 'checked';
      checked: number;
      /** M: the checked specs' findings; `null` when they could not be read. */
      findings: number | null;
      /** K: the specs a run did not check. */
      unchecked: number;
      /** The first reason the server gave for one. */
      reason: string | null;
    }
  /** A run failed as a whole, so its `result` is lost. */
  | { kind: 'stopped'; done: number; total: number; error: string | null }
  | { kind: 'not_started'; reason: string | null }
  | { kind: 'lost' };

interface ItemOutcome {
  id: string;
  status: string;
  error: string | null;
}

// `result.items[]` of `spec_quality.analyze_batch`; anything else in it is skipped.
function itemsOf(result: Record<string, unknown> | null): ItemOutcome[] {
  const items = result?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { id, status, error } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof status !== 'string') return [];
    return [{ id, status, error: typeof error === 'string' && error ? error : null }];
  });
}

/**
 * The outcome of a check, from both runs and M. A spec is checked when every
 * run checked it, so a refused POST leaves every spec unchecked.
 */
export function checkOutcome(
  runs: readonly CheckRun[],
  findings: number | null
): SpecsCheckOutcome {
  const refusals = runs.flatMap((run) => (run.kind === 'refused' ? [run.reason] : []));
  const accepted = runs.filter((run) => run.kind !== 'refused');
  if (accepted.length === 0) {
    return { kind: 'not_started', reason: refusals.find((reason) => reason !== null) ?? null };
  }

  const ended = accepted.filter(
    (run): run is Extract<CheckRun, { kind: 'ended' }> => run.kind === 'ended'
  );
  const failed = ended.find((run) => run.state !== 'succeeded');
  if (failed) {
    const phase = parsePhase(failed.phase);
    // The phase names the spec the run was on when it stopped; the ones before it are done.
    return {
      kind: 'stopped',
      done: phase ? phase.step - 1 : 0,
      total: phase?.total ?? failed.documents,
      error: failed.error,
    };
  }
  if (ended.length < accepted.length) return { kind: 'lost' };

  const taken = Math.max(...ended.map((run) => run.documents));
  const outcomes = ended.map((run) => itemsOf(run.result));
  const succeeded = outcomes.map(
    (items) => new Set(items.filter((item) => item.status === 'succeeded').map((item) => item.id))
  );
  const checked =
    refusals.length > 0
      ? 0
      : [...succeeded[0]].filter((id) => succeeded.every((run) => run.has(id))).length;
  const firstError = outcomes
    .flat()
    .find((item) => item.status !== 'succeeded' && item.error)?.error;
  return {
    kind: 'checked',
    checked,
    findings,
    unchecked: Math.max(0, taken - checked),
    reason: refusals.find((reason) => reason !== null) ?? firstError ?? null,
  };
}
