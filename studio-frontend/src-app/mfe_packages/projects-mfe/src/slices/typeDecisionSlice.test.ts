import { describe, expect, it } from 'vitest';
import { closeProject, openProject } from './navSlice';
import reducer, { decisionSettled, decisionStarted } from './typeDecisionSlice';

describe('type decisions in flight', () => {
  it('holds each binding once while its decision is sent, and lets it go when it settles', () => {
    let state = reducer(undefined, decisionStarted('b-1'));
    state = reducer(state, decisionStarted('b-2'));
    state = reducer(state, decisionStarted('b-1'));
    expect(state.pending).toEqual(['b-1', 'b-2']);
    expect(reducer(state, decisionSettled('b-1')).pending).toEqual(['b-2']);
  });

  it('forgets them with the project', () => {
    const state = reducer(undefined, decisionStarted('b-1'));
    expect(reducer(state, openProject('p-2')).pending).toEqual([]);
    expect(reducer(state, closeProject()).pending).toEqual([]);
  });
});
