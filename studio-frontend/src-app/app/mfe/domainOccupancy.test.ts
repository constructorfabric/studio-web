import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrontXContext, type Extension, type FrontXApp, type MfeRegistry } from '@gears-frontx/react';
import { occupancyOf, useMountedExtensions } from './domainOccupancy';

const registry = (): MfeRegistry => ({}) as MfeRegistry;

describe('domain occupancy', () => {
  it('an extension counts as mounted from the end of its mount until destroyed', () => {
    const occupancy = occupancyOf(registry());

    expect(occupancy.mounted('screen')).toEqual([]);
    occupancy.mountFinished('screen', 'projects');
    expect(occupancy.mounted('screen')).toEqual(['projects']);
    occupancy.destroyed('screen', 'projects');
    expect(occupancy.mounted('screen')).toEqual([]);
  });

  it('mounted keeps the order of creation', () => {
    const occupancy = occupancyOf(registry());

    occupancy.mountFinished('overlay', 'search');
    occupancy.mountFinished('overlay', 'wizard');
    occupancy.mountFinished('overlay', 'connect');
    occupancy.destroyed('overlay', 'wizard');

    expect(occupancy.mounted('overlay')).toEqual(['search', 'connect']);
    expect(occupancy.mounted('screen')).toEqual([]);
  });

  it('subscribers hear every change', () => {
    const occupancy = occupancyOf(registry());
    const listener = vi.fn();
    const unsubscribe = occupancy.subscribe(listener);

    occupancy.mountFinished('screen', 'projects');
    occupancy.destroyed('screen', 'projects');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    occupancy.mountFinished('screen', 'people');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('each registry has its own store', () => {
    const first = registry();
    const second = registry();

    occupancyOf(first).mountFinished('screen', 'projects');

    expect(occupancyOf(first)).toBe(occupancyOf(first));
    expect(occupancyOf(first).mounted('screen')).toEqual(['projects']);
    expect(occupancyOf(second).mounted('screen')).toEqual([]);
  });
});

describe('useMountedExtensions', () => {
  afterEach(() => vi.restoreAllMocks());

  const SEARCH = { id: 'search', domain: 'overlay' } as Extension;
  const WIZARD = { id: 'wizard', domain: 'overlay' } as Extension;

  /** A registry that knows `extensions`, and nothing else. */
  const registryOf = (...extensions: Extension[]): MfeRegistry =>
    ({ getExtension: (id: string) => extensions.find((extension) => extension.id === id) }) as unknown as MfeRegistry;

  function renderMounted(mfeRegistry: MfeRegistry | undefined) {
    const app = { mfeRegistry } as unknown as FrontXApp;
    return renderHook(() => useMountedExtensions('overlay'), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(FrontXContext.Provider, { value: app }, children),
    });
  }

  it('returns the same array across renders while nothing changes', () => {
    const mfeRegistry = registryOf(SEARCH);
    occupancyOf(mfeRegistry).mountFinished('overlay', 'search');
    const { result, rerender } = renderMounted(mfeRegistry);
    const first = result.current;

    rerender();

    expect(first).toEqual([SEARCH]);
    expect(result.current).toBe(first);
  });

  it('returns a new array once a mount finishes or an extension is destroyed', () => {
    const mfeRegistry = registryOf(SEARCH, WIZARD);
    const { result } = renderMounted(mfeRegistry);
    const before = result.current;

    act(() => occupancyOf(mfeRegistry).mountFinished('overlay', 'wizard'));
    const afterMount = result.current;
    act(() => occupancyOf(mfeRegistry).destroyed('overlay', 'wizard'));

    expect(before).toEqual([]);
    expect(afterMount).toEqual([WIZARD]);
    expect(result.current).toEqual([]);
    expect(result.current).not.toBe(afterMount);
  });

  it('leaves out an id whose extension is no longer registered', () => {
    const mfeRegistry = registryOf(SEARCH);
    occupancyOf(mfeRegistry).mountFinished('overlay', 'unregistered');
    occupancyOf(mfeRegistry).mountFinished('overlay', 'search');

    const { result } = renderMounted(mfeRegistry);

    expect(result.current).toEqual([SEARCH]);
  });

  it('throws without the microfrontends plugin', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderMounted(undefined)).toThrow(/requires the microfrontends plugin/);
  });
});
