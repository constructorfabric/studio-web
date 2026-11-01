import { describe, expect, it, vi } from 'vitest';
import type { MfeRegistry } from '@gears-frontx/react';
import { occupancyOf } from './domainOccupancy';

const registry = (): MfeRegistry => ({}) as MfeRegistry;

describe('domain occupancy', () => {
  it("an extension is mounted from its container's creation until its destruction", () => {
    const occupancy = occupancyOf(registry());

    expect(occupancy.mounted('screen')).toEqual([]);
    occupancy.created('screen', 'projects');
    expect(occupancy.mounted('screen')).toEqual(['projects']);
    occupancy.destroyed('screen', 'projects');
    expect(occupancy.mounted('screen')).toEqual([]);
  });

  it('mounted keeps the order of creation', () => {
    const occupancy = occupancyOf(registry());

    occupancy.created('overlay', 'search');
    occupancy.created('overlay', 'wizard');
    occupancy.created('overlay', 'connect');
    occupancy.destroyed('overlay', 'wizard');

    expect(occupancy.mounted('overlay')).toEqual(['search', 'connect']);
    expect(occupancy.mounted('screen')).toEqual([]);
  });

  it('subscribers hear every change', () => {
    const occupancy = occupancyOf(registry());
    const listener = vi.fn();
    const unsubscribe = occupancy.subscribe(listener);

    occupancy.created('screen', 'projects');
    occupancy.destroyed('screen', 'projects');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    occupancy.created('screen', 'people');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('each registry has its own store', () => {
    const first = registry();
    const second = registry();

    occupancyOf(first).created('screen', 'projects');

    expect(occupancyOf(first)).toBe(occupancyOf(first));
    expect(occupancyOf(first).mounted('screen')).toEqual(['projects']);
    expect(occupancyOf(second).mounted('screen')).toEqual([]);
  });
});
