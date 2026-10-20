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
import { checkNotice, useSpecsCheckToasts } from './useSpecsCheckToasts';
import { screenText } from '@constructor-studio/mfe-shared';
import en from '../screens/project/sections/specs/i18n/en.json';
import ru from '../screens/project/sections/specs/i18n/ru.json';

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

const DICTIONARIES: Record<'en' | 'ru', Record<string, string>> = { en, ru };

/** The real dictionary, read the way `I18nRegistry` reads one: a missing key is the key, `{name}` filled. */
function textIn(language: 'en' | 'ru') {
  const dictionary = DICTIONARIES[language];
  return screenText(
    (key, params) =>
      (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
        params?.[name] === undefined ? match : String(params[name])
      ),
    language
  );
}

const OUTCOMES: SpecsCheckOutcome[] = [
  { kind: 'checked', checked: 18, findings: 7, unchecked: 0, reason: null },
  { kind: 'checked', checked: 3, findings: 2, unchecked: 2, reason: 'upstream 500' },
  { kind: 'checked', checked: 1, findings: null, unchecked: 1, reason: null },
  { kind: 'stopped', done: 61, total: 120, error: 'lease' },
  { kind: 'stopped', done: 0, total: 3, error: null },
  { kind: 'not_started', reason: 'not configured' },
  { kind: 'not_started', reason: null },
  { kind: 'lost' },
];

describe("a check's toast, in the real dictionaries", () => {
  const atlas = (check: Partial<SpecsCheck>): SpecsCheck => ({
    project: 'Atlas',
    count: 20,
    phases: {},
    outcome: null,
    ...check,
  });

  it('reads as sentences in English', () => {
    const t = textIn('en');
    expect(checkNotice(t, atlas({ count: 1 })).text).toBe('Atlas: checking 1 spec…');
    expect(checkNotice(t, atlas({ phases: { leak: '3/20 · docs/prd.md' } })).text).toBe(
      'Atlas: checking 20 specs · 3/20 · prd.md'
    );
    expect(checkNotice(t, atlas({ outcome: OUTCOMES[0] })).text).toBe(
      'Atlas: 18 checked · 7 findings'
    );
    expect(checkNotice(t, atlas({ outcome: OUTCOMES[1] })).text).toBe(
      "Atlas: 3 checked · 2 findings. 2 couldn't be checked: upstream 500"
    );
    expect(checkNotice(t, atlas({ outcome: OUTCOMES[3] })).text).toBe(
      'Atlas: the check stopped after 61 of 120: lease'
    );
  });

  it("takes Russian's one, few and many forms", () => {
    const t = textIn('ru');
    expect(checkNotice(t, atlas({ count: 1 })).text).toBe('Atlas: проверяется 1 спецификация…');
    expect(checkNotice(t, atlas({ count: 22 })).text).toBe('Atlas: проверяются 22 спецификации…');
    expect(checkNotice(t, atlas({ count: 25 })).text).toBe('Atlas: проверяется 25 спецификаций…');
    expect(checkNotice(t, atlas({ outcome: OUTCOMES[1] })).text).toBe(
      'Atlas: проверены 3 · 2 замечания. 2 не удалось проверить: upstream 500'
    );
  });

  it('leaves no key and no placeholder unfilled, in either language', () => {
    for (const language of ['en', 'ru'] as const) {
      const t = textIn(language);
      const texts = [
        ...[0, 1, 2, 5, 22].map((count) => checkNotice(t, atlas({ count })).text),
        checkNotice(t, atlas({ phases: { purpose: '1/2 · a.md' } })).text,
        ...OUTCOMES.map((outcome) => checkNotice(t, atlas({ outcome })).text),
        t('check_left', { project: 'Atlas' }),
      ];
      for (const text of texts) expect(text).not.toMatch(/check_|\{/);
    }
  });

  it('names the same placeholders in English and Russian', () => {
    // `check_one`, `check_few` and `check_many` are one string with the form picked by count.
    const placeholders = (dictionary: Record<string, string>) => {
      const byName = new Map<string, Set<string>>();
      for (const [key, value] of Object.entries(dictionary)) {
        if (!key.startsWith('check')) continue;
        const name = key.replace(/_(one|few|many)$/, '');
        const found = byName.get(name) ?? new Set<string>();
        for (const [, placeholder] of value.matchAll(/\{(\w+)\}/g)) found.add(placeholder);
        byName.set(name, found);
      }
      return Object.fromEntries([...byName].map(([name, found]) => [name, [...found].sort()]));
    };
    expect(placeholders(ru)).toEqual(placeholders(en));
  });
});
