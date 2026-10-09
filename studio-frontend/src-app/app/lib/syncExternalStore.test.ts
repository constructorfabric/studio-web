import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSyncExternalStoreWithSelector } from './syncExternalStore';

/**
 * The shell serves use-sync-external-store from this module instead of the
 * CommonJS package (see the module comment). These pin the behaviour the
 * libraries on top of it rely on: a selection follows the store, and an
 * equal selection keeps its identity so nothing re-renders for nothing.
 */
function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

describe('useSyncExternalStoreWithSelector', () => {
  it('returns the selection and follows the store', () => {
    const s = store({ count: 1, label: 'a' });
    const { result } = renderHook(() =>
      useSyncExternalStoreWithSelector(s.subscribe, s.get, null, (v) => v.count)
    );
    expect(result.current).toBe(1);
    act(() => s.set({ count: 2, label: 'a' }));
    expect(result.current).toBe(2);
  });

  it('keeps the previous selection when isEqual says it did not change', () => {
    const s = store({ ids: [1, 2], label: 'a' });
    const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const { result } = renderHook(() =>
      useSyncExternalStoreWithSelector(s.subscribe, s.get, null, (v) => [...v.ids], sameIds)
    );
    const first = result.current;
    act(() => s.set({ ids: [1, 2], label: 'b' }));
    expect(result.current).toBe(first);
    act(() => s.set({ ids: [1, 3], label: 'b' }));
    expect(result.current).toEqual([1, 3]);
  });
});
