import { describe, expect, it } from 'vitest';
import createReducer, { pickSource, resetWizard, setShareMode } from './createSlice';
import { sourceKey, type RepositoryPick } from '../model/projectDraft';

const WEB: RepositoryPick = {
  id: 'r1',
  fullPath: 'acme/web',
  cloneUrl: 'https://github.com/acme/web.git',
  connectionId: 'c-gh',
  shareMode: 'branch',
};
const API: RepositoryPick = { ...WEB, id: 'r2', fullPath: 'acme/api' };

const BOTH = createReducer(createReducer(undefined, pickSource(WEB)), pickSource(API));

describe('how a picked repository is shared', () => {
  it('starts as a commit to the branch', () => {
    expect(BOTH.draft.sources.map((pick) => pick.shareMode)).toEqual(['branch', 'branch']);
  });

  it('switches for the one repository it names', () => {
    const state = createReducer(
      BOTH,
      setShareMode({ key: sourceKey(API), shareMode: 'pull_request' })
    );

    expect(state.draft.sources.map((pick) => pick.shareMode)).toEqual(['branch', 'pull_request']);
  });

  it('ignores a repository that is not picked', () => {
    const state = createReducer(
      BOTH,
      setShareMode({ key: 'c-gh:unknown', shareMode: 'pull_request' })
    );

    expect(state.draft.sources).toBe(BOTH.draft.sources);
  });

  it('is forgotten with the pick: picked again, it is back on the branch', () => {
    const switched = createReducer(
      BOTH,
      setShareMode({ key: sourceKey(WEB), shareMode: 'pull_request' })
    );
    const again = [pickSource(WEB), pickSource(WEB)].reduce(createReducer, switched);

    expect(again.draft.sources.find((pick) => pick.id === 'r1')?.shareMode).toBe('branch');
  });

  it('is gone when the wizard is opened again', () => {
    expect(createReducer(BOTH, resetWizard()).draft.sources).toEqual([]);
  });
});
