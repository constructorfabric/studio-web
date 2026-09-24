import { describe, expect, it } from 'vitest';
import reducer, { openContextProject, rememberProject, setContextProjects } from './appContextSlice';

describe('rememberProject', () => {
  const start = reducer(undefined, { type: '@@init' });

  it('adds an unknown project to the list without opening it', () => {
    const state = reducer(start, rememberProject({ id: 'p1', name: 'Atlas' }));
    expect(state.projects).toEqual([{ id: 'p1', name: 'Atlas' }]);
    expect(state.project).toBeNull();
  });

  it('fills in the name of the open project once it is known', () => {
    let state = reducer(start, setContextProjects([{ id: 'p2', name: 'Borealis' }]));
    state = reducer(state, openContextProject({ id: 'p1', name: '' }));
    state = reducer(state, rememberProject({ id: 'p1', name: 'Atlas' }));
    expect(state.project).toEqual({ id: 'p1', name: 'Atlas' });
    expect(state.projects.map((p) => p.id)).toEqual(['p2', 'p1']);
  });

  it('does not blank a known name with an empty one', () => {
    let state = reducer(start, setContextProjects([{ id: 'p1', name: 'Atlas' }]));
    state = reducer(state, rememberProject({ id: 'p1', name: '' }));
    expect(state.projects[0].name).toBe('Atlas');
  });
});
