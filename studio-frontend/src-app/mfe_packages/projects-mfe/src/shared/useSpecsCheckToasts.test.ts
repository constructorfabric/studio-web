import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecsCheck } from '../slices/specsCheckSlice';

const { notify, bridge, dispatch, checks, loaded } = vi.hoisted(() => ({
  notify: vi.fn(),
  bridge: { id: 'bridge' },
  dispatch: vi.fn(),
  checks: { current: {} as Record<string, SpecsCheck> },
  loaded: { current: true },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useMfeBridge: () => bridge,
  useAppDispatch: () => dispatch,
  useAppSelector: (select: (state: unknown) => unknown) =>
    select({ 'projects/specsCheck': { selected: [], shown: null, checks: checks.current } }),
}));
vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  notify,
}));
vi.mock('../i18n', () => {
  const t = Object.assign(
    (key: string, params?: Record<string, unknown>) =>
      params ? `${key}(${Object.values(params).join('|')})` : key,
    {
      count: (key: string, count: number, params?: Record<string, unknown>) =>
        `${key}#${count}${params ? `(${Object.values(params).join('|')})` : ''}`,
    }
  );
  return {
    useSpecsSectionTranslations: () => ({ isLoaded: loaded.current, error: null }),
    useSpecsText: () => t,
  };
});

import { outcomeShown } from '../slices/specsCheckSlice';
import type { SpecsCheckOutcome } from '../model/specsCheck';
import { useSpecsCheckToasts } from './useSpecsCheckToasts';

const running = (phases: SpecsCheck['phases'] = {}): SpecsCheck => ({
  project: 'Billing',
  count: 20,
  phases,
  outcome: null,
});
const ended = (outcome: SpecsCheckOutcome): SpecsCheck => ({ ...running(), outcome });

const notices = () => notify.mock.calls.map(([, notice]) => notice);

beforeEach(() => {
  notify.mockClear();
  dispatch.mockClear();
  checks.current = {};
  loaded.current = true;
});

describe("a check's toast", () => {
  it('says how many specs are being checked until a run reports', () => {
    checks.current = { 'p-1': running() };
    renderHook(() => useSpecsCheckToasts());
    expect(notify).toHaveBeenCalledWith(
      bridge,
      { kind: 'loading', text: 'check_progress#20(Billing)', id: 'specs-check:p-1' },
      'projects'
    );
  });

  it('shows the step and file of the run further behind, updated in place', () => {
    checks.current = {
      'p-1': running({ purpose: '7/20 · docs/a.md', leak: '3/20 · docs/prd.md' }),
    };
    const { rerender } = renderHook(() => useSpecsCheckToasts());
    expect(notices()).toEqual([
      { kind: 'loading', text: 'check_progress_at#20(Billing|3|20|prd.md)', id: 'specs-check:p-1' },
    ]);

    rerender();
    expect(notify).toHaveBeenCalledTimes(1);

    checks.current = { 'p-1': running({ purpose: '8/20 · docs/b.md', leak: '4/20 · docs/c.md' }) };
    rerender();
    expect(notices()[1]).toEqual({
      kind: 'loading',
      text: 'check_progress_at#20(Billing|4|20|c.md)',
      id: 'specs-check:p-1',
    });
  });

  it('waits for the dictionary', () => {
    loaded.current = false;
    checks.current = { 'p-1': running() };
    const { rerender } = renderHook(() => useSpecsCheckToasts());
    expect(notify).not.toHaveBeenCalled();
    loaded.current = true;
    rerender();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it.each<[string, SpecsCheckOutcome, string, string]>([
    [
      'every spec checked',
      { kind: 'checked', checked: 18, findings: 7, unchecked: 0, reason: null },
      'success',
      'check_done(Billing|check_summary(check_checked#18|check_findings#7))',
    ],
    [
      'every spec checked, without M',
      { kind: 'checked', checked: 18, findings: null, unchecked: 0, reason: null },
      'success',
      'check_done(Billing|check_checked#18)',
    ],
    [
      'some not checked',
      { kind: 'checked', checked: 16, findings: 5, unchecked: 2, reason: 'upstream 500' },
      'info',
      'check_partial_because(Billing|check_summary(check_checked#16|check_findings#5)|check_unchecked#2|upstream 500)',
    ],
    [
      'some not checked, for no reason given',
      { kind: 'checked', checked: 16, findings: 5, unchecked: 2, reason: null },
      'info',
      'check_partial(Billing|check_summary(check_checked#16|check_findings#5)|check_unchecked#2)',
    ],
    [
      'a run failed as a whole',
      { kind: 'stopped', done: 61, total: 120, error: 'lease expired' },
      'error',
      'check_stopped_because(Billing|61|120|lease expired)',
    ],
    [
      'a run failed with no error',
      { kind: 'stopped', done: 0, total: 20, error: null },
      'error',
      'check_stopped(Billing|0|20)',
    ],
    [
      'both POSTs refused',
      { kind: 'not_started', reason: 'not configured' },
      'error',
      'check_not_started_because(Billing|not configured)',
    ],
    [
      'both POSTs refused, for no reason given',
      { kind: 'not_started', reason: null },
      'error',
      'check_not_started(Billing)',
    ],
    ['a run lost', { kind: 'lost' }, 'info', 'check_lost(Billing)'],
  ])('ends as the outcome when %s, and lets the check go', (_, outcome, kind, text) => {
    checks.current = { 'p-1': ended(outcome) };
    renderHook(() => useSpecsCheckToasts());
    expect(notices()).toEqual([{ kind, text, id: 'specs-check:p-1' }]);
    expect(dispatch).toHaveBeenCalledWith(outcomeShown('p-1'));
  });

  it('keeps one toast per project', () => {
    checks.current = { 'p-1': running(), 'p-2': { ...running(), project: 'Other' } };
    renderHook(() => useSpecsCheckToasts());
    expect(notices().map((notice) => notice.id)).toEqual(['specs-check:p-1', 'specs-check:p-2']);
  });

  it('says a running check goes on when the projects screen is left, and picks it up on coming back', () => {
    checks.current = { 'p-1': running(), 'p-2': ended({ kind: 'lost' }) };
    const { unmount } = renderHook(() => useSpecsCheckToasts());
    notify.mockClear();
    checks.current = { 'p-1': running() };

    act(() => unmount());
    expect(notices()).toEqual([
      { kind: 'info', text: 'check_left(Billing)', id: 'specs-check:p-1' },
    ]);

    notify.mockClear();
    renderHook(() => useSpecsCheckToasts());
    expect(notices()).toEqual([
      { kind: 'loading', text: 'check_progress#20(Billing)', id: 'specs-check:p-1' },
    ]);
  });
});
