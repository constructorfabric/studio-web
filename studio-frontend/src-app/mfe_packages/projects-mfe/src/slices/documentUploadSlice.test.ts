import { describe, expect, it } from 'vitest';
import type { UploadEntry } from '../model/documentUpload';
import { closeProject, openProject, selectSection } from './navSlice';
import reducer, {
  uploadAdded,
  uploadAdding,
  uploadDismissed,
  uploadPicked,
  uploadRead,
  uploadRefused,
  uploadRemoved,
  uploadRetitled,
  uploadTyped,
  uploadTypedAll,
} from './documentUploadSlice';

function picked(id: string, overrides: Partial<UploadEntry> = {}): UploadEntry {
  return {
    id,
    section: 'specs',
    fileName: `${id}.md`,
    size: 10,
    title: `${id}.md`,
    typeKey: null,
    content: null,
    status: 'reading',
    problem: null,
    message: null,
    documentId: null,
    ...overrides,
  };
}

const pick = (...entries: UploadEntry[]) =>
  reducer(undefined, uploadPicked({ section: 'specs', entries, batchError: null }));
const read = (id: string, existingTitles: string[] = []) =>
  uploadRead({ id, read: { content: '# Text' }, existingTitles });
const statuses = (state: ReturnType<typeof reducer>) =>
  state.entries.map(({ id, status, problem }) => [id, status, problem]);

describe('the upload panel', () => {
  it('holds a pick refused as a whole as its reason alone', () => {
    const state = reducer(
      undefined,
      uploadPicked({ section: 'specs', entries: [], batchError: 'too_many' })
    );
    expect(state).toEqual({ entries: [], batchErrors: { specs: 'too_many' } });
  });

  it('readies a file once read, or holds what is wrong with it', () => {
    let state = pick(picked('a'), picked('b'));
    state = reducer(state, read('a'));
    state = reducer(state, uploadRead({ id: 'b', read: { problem: 'encoding' }, existingTitles: [] }));
    expect(statuses(state)).toEqual([
      ['a', 'ready', null],
      ['b', 'error', 'encoding'],
    ]);
    expect(state.entries[0].content).toBe('# Text');
  });

  it('asks the second of two same names, or a used one, for another', () => {
    let state = pick(picked('a', { title: 'README.md' }), picked('b', { title: 'readme.md' }), picked('c'));
    state = reducer(state, read('a'));
    state = reducer(state, read('b'));
    state = reducer(state, read('c', ['C.md']));
    expect(statuses(state)).toEqual([
      ['a', 'ready', null],
      ['b', 'error', 'taken'],
      ['c', 'error', 'taken'],
    ]);
  });

  it('keeps a row stopped by its name while the name is typed', () => {
    let state = pick(picked('a'));
    state = reducer(state, read('a', ['a.md']));
    state = reducer(state, uploadRetitled({ id: 'a', title: 'other.md' }));
    expect(state.entries[0]).toMatchObject({ title: 'other.md', status: 'error', problem: 'taken' });
  });

  it('types one row, or every row that can still be sent', () => {
    let state = pick(picked('a'), picked('b'), picked('c'), picked('d'));
    state = reducer(state, read('a'));
    state = reducer(state, uploadRead({ id: 'b', read: { problem: 'size' }, existingTitles: [] }));
    state = reducer(state, read('c'));
    state = reducer(state, uploadAdding(['c']));
    state = reducer(state, uploadTypedAll({ section: 'specs', typeKey: 'prd' }));
    expect(state.entries.map((entry) => entry.typeKey)).toEqual(['prd', null, null, 'prd']);
    state = reducer(state, uploadTyped({ id: 'a', typeKey: 'adr' }));
    expect(state.entries[0].typeKey).toBe('adr');
  });

  it('moves a row through adding to added, or back to a refusal', () => {
    let state = pick(picked('a'), picked('b'));
    state = reducer(state, read('a'));
    state = reducer(state, read('b'));
    state = reducer(state, uploadAdding(['a', 'b']));
    state = reducer(state, uploadAdded({ id: 'a', documentId: 'doc-1' }));
    state = reducer(state, uploadRefused({ id: 'b', problem: 'refused', message: 'Too large' }));
    expect(statuses(state)).toEqual([
      ['a', 'added', null],
      ['b', 'error', 'refused'],
    ]);
    expect(state.entries[0]).toMatchObject({ documentId: 'doc-1', content: null });
    expect(state.entries[1].message).toBe('Too large');

    state = reducer(state, uploadAdding(['b']));
    expect(state.entries[1]).toMatchObject({ status: 'adding', problem: null, message: null });
  });

  it('removes a row unless it is being sent', () => {
    let state = pick(picked('a'), picked('b'));
    state = reducer(state, uploadAdding(['b']));
    state = reducer(state, uploadRemoved('a'));
    state = reducer(state, uploadRemoved('b'));
    expect(state.entries.map((entry) => entry.id)).toEqual(['b']);
  });

  it('ignores a row it no longer holds', () => {
    const state = reducer(pick(picked('a')), uploadDismissed('specs'));
    expect(reducer(state, uploadAdded({ id: 'a', documentId: 'doc-1' }))).toEqual(state);
    expect(reducer(state, read('a'))).toEqual(state);
  });

  it('is emptied by Dismiss and by another project', () => {
    const state = reducer(
      pick(picked('a')),
      uploadPicked({ section: 'specs', entries: [], batchError: 'too_large' })
    );
    const empty = { entries: [], batchErrors: {} };
    expect(reducer(state, uploadDismissed('specs'))).toEqual(empty);
    expect(reducer(state, openProject('p-2'))).toEqual(empty);
    expect(reducer(state, closeProject())).toEqual(empty);
  });
});

describe("each section's panel", () => {
  const both = () => {
    let state = pick(picked('s1'), picked('s2'));
    state = reducer(
      state,
      uploadPicked({ section: 'sources', entries: [picked('o1', { section: 'sources' })], batchError: null })
    );
    for (const id of ['s1', 's2', 'o1']) state = reducer(state, read(id));
    return state;
  };
  const ids = (state: ReturnType<typeof reducer>) => state.entries.map((entry) => entry.id);

  it('keeps its files when the member moves to another section', () => {
    const state = both();
    expect(reducer(state, selectSection('artifacts'))).toEqual(state);
  });

  it('is dismissed alone', () => {
    expect(ids(reducer(both(), uploadDismissed('specs')))).toEqual(['o1']);
  });

  it('types only its own files', () => {
    const state = reducer(both(), uploadTypedAll({ section: 'sources', typeKey: 'adr' }));
    expect(state.entries.map((entry) => entry.typeKey)).toEqual([null, null, 'adr']);
  });

  it("keeps its own refusal of a pick, which another section's pick does not clear", () => {
    let state = reducer(both(), uploadPicked({ section: 'specs', entries: [], batchError: 'too_many' }));
    state = reducer(state, uploadPicked({ section: 'sources', entries: [], batchError: null }));
    expect(state.batchErrors).toEqual({ specs: 'too_many' });
    state = reducer(state, uploadPicked({ section: 'specs', entries: [], batchError: null }));
    expect(state.batchErrors).toEqual({});
  });

  it("checks a name against every section's files", () => {
    let state = both();
    state = reducer(
      state,
      uploadPicked({ section: 'sources', entries: [picked('o2', { section: 'sources', title: 's1.md' })], batchError: null })
    );
    state = reducer(state, read('o2'));
    expect(state.entries.find((entry) => entry.id === 'o2')).toMatchObject({ status: 'error', problem: 'taken' });
  });
});
