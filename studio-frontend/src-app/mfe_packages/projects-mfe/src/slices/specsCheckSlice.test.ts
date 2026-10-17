import { describe, expect, it } from 'vitest';
import { closeProject, openProject } from './navSlice';
import reducer, {
  checkEnded,
  checkProgressed,
  checkRunning,
  checkStarted,
  outcomeShown,
  specsSelected,
  specsShown,
} from './specsCheckSlice';

const OUTCOME = { kind: 'lost' } as const;
const start = (projectId = 'p-1') => checkStarted({ projectId, project: 'Billing', count: 20 });

describe("Check's rows", () => {
  it('has no shown rows until the first load writes them, and keeps only the checkable ones', () => {
    expect(reducer(undefined, { type: '@@init' }).shown).toBeNull();
    const state = reducer(
      undefined,
      specsShown([
        { id: 'b-1', origin: 'repository', checkable: true },
        { id: 'candidate:n-1', origin: 'repository', checkable: false },
        { id: 'd-1', origin: 'authored', checkable: true },
      ])
    );
    expect(state.shown).toEqual([
      { id: 'b-1', origin: 'repository' },
      { id: 'd-1', origin: 'authored' },
    ]);
  });

  it('forgets the selection and the shown rows with the project, but not the checks', () => {
    let state = reducer(undefined, specsSelected(['b-1']));
    state = reducer(state, specsShown([{ id: 'b-1', origin: 'repository', checkable: true }]));
    state = reducer(state, start());
    state = reducer(state, specsSelected(['b-2']));
    for (const action of [openProject('p-2'), closeProject()]) {
      const next = reducer(state, action);
      expect(next.selected).toEqual([]);
      expect(next.shown).toBeNull();
      expect(checkRunning(next, 'p-1')).toBe(true);
    }
  });

  it('clears the selection when a check starts', () => {
    const state = reducer(reducer(undefined, specsSelected(['b-1', 'b-2'])), start());
    expect(state.selected).toEqual([]);
  });
});

describe('a check', () => {
  it('runs until it has an outcome, and is let go once the toast showed it', () => {
    let state = reducer(undefined, start());
    expect(checkRunning(state, 'p-1')).toBe(true);
    expect(checkRunning(state, 'p-2')).toBe(false);

    state = reducer(state, outcomeShown('p-1'));
    expect(checkRunning(state, 'p-1')).toBe(true);

    state = reducer(state, checkEnded({ projectId: 'p-1', outcome: OUTCOME }));
    expect(checkRunning(state, 'p-1')).toBe(false);
    expect(state.checks['p-1'].outcome).toEqual(OUTCOME);
    expect(reducer(state, outcomeShown('p-1')).checks).toEqual({});
  });

  it("keeps each running run's last phase, and drops a run that ended", () => {
    let state = reducer(undefined, start());
    state = reducer(
      state,
      checkProgressed({ projectId: 'p-1', detector: 'purpose', phase: '3/20 · a.md' })
    );
    state = reducer(
      state,
      checkProgressed({ projectId: 'p-1', detector: 'leak', phase: '1/20 · a.md' })
    );
    state = reducer(state, checkProgressed({ projectId: 'p-1', detector: 'leak', phase: null }));
    expect(state.checks['p-1'].phases).toEqual({ purpose: '3/20 · a.md' });
  });

  it('keeps the checks of several projects apart', () => {
    let state = reducer(undefined, start('p-1'));
    state = reducer(state, start('p-2'));
    state = reducer(state, checkEnded({ projectId: 'p-2', outcome: OUTCOME }));
    expect(checkRunning(state, 'p-1')).toBe(true);
    expect(checkRunning(state, 'p-2')).toBe(false);
  });
});
