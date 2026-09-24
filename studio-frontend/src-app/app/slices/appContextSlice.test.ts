import { describe, expect, it } from 'vitest';
import reducer, {
  addContextWorkspace,
  openContextProject,
  rememberProject,
  setContextOrg,
  setContextOrganizations,
  setContextProjects,
  setContextProjectsStatus,
  setContextWorkspace,
  setContextWorkspaces,
  type AppContextState,
} from './appContextSlice';

const O1 = { id: 'o1', name: 'One' };
const O2 = { id: 'o2', name: 'Two' };
const W1 = { id: 'w1', name: 'Work' };
const W2 = { id: 'w2', name: 'Other' };

function inScope(): AppContextState {
  let state = reducer(undefined, { type: '@@init' });
  state = reducer(state, setContextOrganizations([O1, O2]));
  state = reducer(state, setContextOrg('o2'));
  state = reducer(state, setContextWorkspaces([W1, W2]));
  state = reducer(state, setContextWorkspace('w2'));
  state = reducer(state, setContextProjects([{ id: 'p1', name: 'Atlas' }]));
  return state;
}

// Reviewer finding (MarinaLitueva): the catalog reducers used to pick a
// selection of their own — items[0] for organizations, kept-or-first for
// workspaces — so a re-read could move the scope before materialize moved it back.
describe('the catalog reducers keep or drop a selection, and never pick one', () => {
  it('a fresh organization list selects nothing', () => {
    const state = reducer(undefined, setContextOrganizations([O1, O2]));
    expect(state.orgs).toEqual([O1, O2]);
    expect(state.org).toBeNull();
  });

  it('a re-read that still lists the organization in scope leaves it, and what is under it, alone', () => {
    const state = reducer(inScope(), setContextOrganizations([O2, O1]));
    expect(state.org).toEqual(O2);
    expect(state.workspace).toEqual(W2);
    expect(state.projects).toHaveLength(1);
  });

  // Reviewer finding (coderabbit): a re-read that keeps the id but renames the
  // entity must not leave the old name in the chain and the shared properties.
  it('a re-read refreshes the name and count of the organization in scope', () => {
    const state = reducer(inScope(), setContextOrganizations([O1, { id: 'o2', name: 'Two, renamed', count: 4 }]));
    expect(state.org).toEqual({ id: 'o2', name: 'Two, renamed', count: 4 });
    expect(state.workspace).toEqual(W2);
  });

  it('an organization no longer on offer is dropped with everything under it', () => {
    const state = reducer(inScope(), setContextOrganizations([O1]));
    expect(state.org).toBeNull();
    expect(state.workspace).toBeNull();
    expect(state.workspaces).toEqual([]);
    expect(state.workspacesStatus).toBe('pending');
    expect(state.projects).toEqual([]);
  });

  it('a fresh workspace list selects nothing', () => {
    const state = reducer(undefined, setContextWorkspaces([W1, W2]));
    expect(state.workspace).toBeNull();
  });

  it('a workspace list that still has the one in scope keeps it', () => {
    const state = reducer(inScope(), setContextWorkspaces([W2]));
    expect(state.workspace).toEqual(W2);
    expect(state.projects).toHaveLength(1);
  });

  it('a re-read refreshes the name and count of the workspace in scope', () => {
    const state = reducer(inScope(), setContextWorkspaces([W1, { id: 'w2', name: 'Other, renamed', count: 2 }]));
    expect(state.workspace).toEqual({ id: 'w2', name: 'Other, renamed', count: 2 });
    expect(state.projects).toHaveLength(1);
  });

  it('a workspace no longer listed is dropped with its projects', () => {
    const state = reducer(inScope(), setContextWorkspaces([W1]));
    expect(state.workspace).toBeNull();
    expect(state.projects).toEqual([]);
  });
});

// Reviewer finding (vasylcf): the projects list had no status, so a workspace
// whose projects could not be read was asked about again on every pass.
describe('the projects catalog status', () => {
  it('is ready once a list has been written, whoever wrote it', () => {
    const state = reducer(inScope(), setContextProjects([]));
    expect(state.projectsStatus).toBe('ready');
  });

  it('is pending again when the workspace changes', () => {
    let state = reducer(inScope(), setContextProjectsStatus('failed'));
    state = reducer(state, setContextWorkspace('w1'));
    expect(state.projectsStatus).toBe('pending');
    expect(state.projects).toEqual([]);
  });

  // Reviewer finding (vasylcf): the other two ways out of a workspace reset it too.
  it('is pending again when the organization changes', () => {
    let state = reducer(inScope(), setContextProjectsStatus('failed'));
    state = reducer(state, setContextOrg('o1'));
    expect(state.projectsStatus).toBe('pending');
    expect(state.workspaces).toEqual([]);
    expect(state.workspacesStatus).toBe('pending');
  });

  it('is pending again when a workspace is added and entered', () => {
    let state = reducer(inScope(), setContextProjectsStatus('failed'));
    state = reducer(state, addContextWorkspace({ id: 'w3', name: 'New' }));
    expect(state.workspace).toEqual({ id: 'w3', name: 'New' });
    expect(state.projectsStatus).toBe('pending');
    expect(state.projects).toEqual([]);
  });
});

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
