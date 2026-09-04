import type { ScreenText } from '../../../i18n';
import type { RepoImport } from '../../../slices/artifactSyncSlice';

/** One line per repository that did not come through, in the member's language. */
export function repoImportLine(t: ScreenText, repo: RepoImport): string {
  const reason =
    repo.reason === null
      ? ''
      : repo.reason.kind === 'i18n'
        ? t(repo.reason.key)
        : repo.reason.text;
  return t('artifacts_repo_failed', { repo: repo.repo, reason });
}

export function notComeThrough(repo: RepoImport): boolean {
  return repo.status === 'failed' || repo.status === 'lost' || repo.status === 'unsyncable';
}
