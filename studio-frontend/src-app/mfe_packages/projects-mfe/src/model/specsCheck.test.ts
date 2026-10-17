import { describe, expect, it } from 'vitest';
import {
  behindPhase,
  checkOutcome,
  checkRequest,
  checkTargets,
  fileName,
  parsePhase,
  type CheckRun,
} from './specsCheck';

const SHOWN = [
  { id: 'b-1', origin: 'repository' as const },
  { id: 'b-2', origin: 'repository' as const },
  { id: 'd-1', origin: 'authored' as const },
];

describe('what Check takes', () => {
  it('takes every shown row when none is selected', () => {
    expect(checkTargets([], SHOWN)).toEqual(SHOWN);
  });

  it('takes the selected rows, and leaves out a selected row that is not checkable', () => {
    // `candidate:n-9` is selected but not in `shown`: #689 did not mark it checkable.
    expect(checkTargets(['d-1', 'candidate:n-9', 'b-1'], SHOWN)).toEqual([SHOWN[0], SHOWN[2]]);
  });

  it('sends repository rows as bindings and Studio documents as documents', () => {
    expect(checkRequest(SHOWN)).toEqual({ binding_ids: ['b-1', 'b-2'], document_ids: ['d-1'] });
  });
});

describe('a run’s progress', () => {
  it('reads the step, the total and the path', () => {
    expect(parsePhase('3/20 · docs/prd.md')).toEqual({ step: 3, total: 20, path: 'docs/prd.md' });
    expect(parsePhase('running')).toBeNull();
    expect(parsePhase(null)).toBeNull();
  });

  it('shows the run further behind, and nothing until a run reports', () => {
    expect(behindPhase(['7/20 · a.md', '3/20 · b.md'])).toEqual({
      step: 3,
      total: 20,
      path: 'b.md',
    });
    expect(behindPhase(['5/20 · a.md', undefined])).toEqual({ step: 5, total: 20, path: 'a.md' });
    expect(behindPhase([undefined, undefined])).toBeNull();
  });

  it('names the file without its folders', () => {
    expect(fileName('docs/specs/prd.md')).toBe('prd.md');
    expect(fileName('prd.md')).toBe('prd.md');
  });
});

const item = (id: string, status = 'succeeded', error?: string) => ({ id, status, error });

function ended(items: ReturnType<typeof item>[], overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    kind: 'ended',
    documents: 3,
    state: 'succeeded',
    phase: '3/3 · c.md',
    error: null,
    result: { detector: 'purpose', items, recorded: items.length },
    ...overrides,
  } as CheckRun;
}

const ALL = [item('a.md'), item('b.md'), item('c.md')];

describe('the outcome of a check', () => {
  it('every spec checked', () => {
    expect(checkOutcome([ended(ALL), ended(ALL)], 7)).toEqual({
      kind: 'checked',
      checked: 3,
      findings: 7,
      unchecked: 0,
      reason: null,
    });
  });

  it('some not checked: a spec counts once, with the first reason the server gave', () => {
    const purpose = [item('a.md'), item('b.md', 'failed', 'upstream 500'), item('c.md')];
    const leak = [
      item('a.md'),
      item('b.md', 'not_submitted', 'type not judged'),
      item('c.md', 'timed_out', 'slow'),
    ];
    expect(checkOutcome([ended(purpose), ended(leak)], 5)).toEqual({
      kind: 'checked',
      checked: 1,
      findings: 5,
      unchecked: 2,
      reason: 'upstream 500',
    });
  });

  it('counts the specs a run that was stopped never reached as not checked', () => {
    const outcome = checkOutcome([ended(ALL), ended([item('a.md')])], 0);
    expect(outcome).toMatchObject({ kind: 'checked', checked: 1, unchecked: 2, reason: null });
  });

  it('a run that failed as a whole stopped after the specs before its last step', () => {
    const failed = ended([], {
      state: 'failed',
      phase: '62/120 · prd.md',
      error: "longer than this queue's 900s lease",
      result: null,
    } as Partial<CheckRun>);
    expect(checkOutcome([ended(ALL), failed], 3)).toEqual({
      kind: 'stopped',
      done: 61,
      total: 120,
      error: "longer than this queue's 900s lease",
    });
  });

  it('a run that failed before it reported stopped after none of what its 202 took', () => {
    const failed = ended([], {
      state: 'failed',
      phase: null,
      error: null,
      result: null,
    } as Partial<CheckRun>);
    expect(checkOutcome([failed, ended(ALL)], null)).toEqual({
      kind: 'stopped',
      done: 0,
      total: 3,
      error: null,
    });
  });

  it('both POSTs refused', () => {
    const outcome = checkOutcome(
      [
        { kind: 'refused', reason: null },
        { kind: 'refused', reason: 'Spec Quality is not configured' },
      ],
      null
    );
    expect(outcome).toEqual({ kind: 'not_started', reason: 'Spec Quality is not configured' });
  });

  it('one POST refused: the specs it would have checked count as not checked', () => {
    const outcome = checkOutcome([{ kind: 'refused', reason: 'detector busy' }, ended(ALL)], 4);
    expect(outcome).toEqual({
      kind: 'checked',
      checked: 0,
      findings: 4,
      unchecked: 3,
      reason: 'detector busy',
    });
  });

  it('a run lost', () => {
    expect(checkOutcome([ended(ALL), { kind: 'lost' }], 2)).toEqual({ kind: 'lost' });
  });

  it('has no M without the read of the findings', () => {
    expect(checkOutcome([ended(ALL), ended(ALL)], null)).toMatchObject({ findings: null });
  });

  it('skips what in a result is not an item', () => {
    const odd = ended([], {
      result: {
        items: [item('a.md'), null, { id: 7, status: 'succeeded' }, item('b.md'), item('c.md')],
      },
    } as Partial<CheckRun>);
    expect(checkOutcome([odd, ended(ALL)], 0)).toMatchObject({ checked: 3, unchecked: 0 });
  });
});
