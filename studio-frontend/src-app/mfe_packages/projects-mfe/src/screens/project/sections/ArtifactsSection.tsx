import React from 'react';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@gears-frontx/ui-kit';
import { useFormatters } from '@gears-frontx/react';
import { useOrganization, useWorkspace } from '@constructor-studio/mfe-shared';
import { Search } from 'lucide-react';
import { useProjectText } from '../../../i18n';
import type { ProjectSource } from '../../../api/types';
import { ARTIFACTS_PAGE_SIZE, useArtifacts } from '../../../shared/useArtifacts';
import { useArtifactImport, useProjectImport } from '../../../shared/useArtifactImport';
import { useThemedRoot } from '../../../shared/useThemedRoot';
import { artifactColumns } from './artifactColumns';
import { ArtifactsTable } from './ArtifactsTable';
import { notComeThrough, repoImportLine } from './repoImportText';
import styles from './ArtifactsSection.module.css';
import frame from '../ProjectScreen.module.css';

const ALL_REPOSITORIES = '__all__';

const SEARCH_SETTLE_MS = 300;

const SyncNow: React.FC<{
  projectId: string;
  orgId: string;
  workspaceId: string | null;
  sources: readonly ProjectSource[];
}> = ({ projectId, orgId, workspaceId, sources }) => {
  const t = useProjectText();
  const { canSync, start } = useArtifactImport({
    projectId,
    orgId,
    workspaceId,
    sources,
    artifactCount: 0,
    artifactsRead: true,
  });
  if (!canSync) return null;
  return (
    <Button variant="outline" size="sm" className={styles.retry} onClick={start}>
      {t('artifacts_sync_now')}
    </Button>
  );
};

SyncNow.displayName = 'SyncNow';

interface ArtifactsSectionProps {
  projectId: string;
}

export const ArtifactsSection: React.FC<ArtifactsSectionProps> = ({ projectId }) => {
  const t = useProjectText();
  const { formatRelative } = useFormatters();
  const importState = useProjectImport(projectId);
  const { org } = useOrganization();
  const { workspace } = useWorkspace();

  const [repository, setRepository] = React.useState<string | null>(null);
  const [typed, setTyped] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  const [container, findThemedRoot] = useThemedRoot();

  React.useEffect(() => {
    if (typed === search) return;
    const timer = setTimeout(() => {
      setSearch(typed);
      setOffset(0);
    }, SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [typed, search]);

  const { rows, total, projectTotal, repositories, sources, loading, failed, refetch } =
    useArtifacts(projectId, { repo: repository, search, offset });

  React.useEffect(() => {
    if (total > 0 && offset >= total) {
      const lastPage = Math.ceil(total / ARTIFACTS_PAGE_SIZE) - 1;
      setOffset(lastPage * ARTIFACTS_PAGE_SIZE);
    }
  }, [total, offset]);

  const chosen = React.useMemo(
    () => repositories.find((entry) => entry.id === repository) ?? null,
    [repositories, repository]
  );

  const columns = React.useMemo(
    () =>
      artifactColumns({
        formatRelative,
        container,
        labels: {
          actions: (name: string) => t('artifacts_row_actions', { name }),
          open: t('artifacts_row_open'),
          copyLink: t('artifacts_row_copy_link'),
          name: t('artifacts_col_name'),
          repository: t('artifacts_col_repository'),
          path: t('artifacts_col_path'),
          sync: t('artifacts_col_sync'),
          updated: t('artifacts_col_updated'),
          ingested: t('artifacts_sync_ingested'),
          provenance: {
            checkout: t('artifacts_from_checkout'),
            tree: t('artifacts_from_tree'),
            upload: t('artifacts_from_upload'),
            repository: t('artifacts_from_repository'),
          },
        },
      }),
    [t, formatRelative, container]
  );

  if (loading) {
    return (
      <div className={styles.section}>
        <Skeleton className={styles.stripSkeleton} />
        <Skeleton className={styles.tableSkeleton} />
      </div>
    );
  }

  if (failed) {
    return (
      <div className={`${styles.section} ${styles.stateBlock}`}>
        <p className={styles.error} role="alert">
          {t('artifacts_read_failed')}
        </p>
        <Button variant="outline" size="sm" className={styles.retry} onClick={refetch}>
          {t('artifacts_retry')}
        </Button>
      </div>
    );
  }
  if (projectTotal === 0) {
    const running = importState.phase === 'running';
    const failedImport = importState.phase === 'failed';
    const messageKey =
      sources.length === 0
        ? 'artifacts_no_sources'
        : running
          ? 'artifacts_importing'
          : failedImport
            ? 'artifacts_import_failed'
            : 'artifacts_not_synced';
    return (
      <div className={`${styles.section} ${styles.stateBlock}`}>
        <p className={failedImport ? styles.error : styles.empty}>{t(messageKey)}</p>
        {org && !running && (
          <SyncNow
            projectId={projectId}
            orgId={org.id}
            workspaceId={workspace?.id ?? null}
            sources={sources}
          />
        )}
        {importState.repos.filter(notComeThrough).map((repo) => (
          <p key={repo.repo} className={`${frame.repoFailure} ${styles.repoLine}`}>
            {repoImportLine(t, repo)}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div ref={findThemedRoot} className={styles.section}>
      <header className={styles.strip}>
        <p className={styles.totals}>
          {chosen === null ? (
            <>
              {t(projectTotal === 1 ? 'artifacts_count_one' : 'artifacts_count_many', {
                count: projectTotal,
              })}
              <span className={styles.totalsDivider}>·</span>
              {t(
                repositories.length === 1
                  ? 'artifacts_repos_count_one'
                  : 'artifacts_repos_count_many',
                { count: repositories.length }
              )}
            </>
          ) : (
            t('artifacts_in_repository', { total, repo: chosen.name })
          )}
          {importState.phase === 'running' && (
            <>
              <span className={styles.totalsDivider}>·</span>
              <span className={styles.importing}>{t('artifacts_importing_short')}</span>
            </>
          )}
        </p>
        <div className={styles.controls}>
          {repositories.length > 1 && (
            <Select
              value={repository ?? ALL_REPOSITORIES}
              onValueChange={(next: string | null) => {
                setRepository(!next || next === ALL_REPOSITORIES ? null : next);
                setOffset(0);
              }}
            >
              <SelectTrigger
                size="sm"
                className={styles.repoFilter}
                aria-label={t('artifacts_col_repository')}
              >
                <SelectValue>
                  {(selected: unknown) => (
                    <span className={styles.truncate}>
                      {!selected || selected === ALL_REPOSITORIES
                        ? t('artifacts_all_repositories', { count: repositories.length })
                        : (repositories.find((entry) => entry.id === selected)?.name ??
                          String(selected))}
                    </span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className={styles.repoOptions} container={container ?? undefined}>
                <SelectItem value={ALL_REPOSITORIES}>
                  <span className={styles.truncate}>
                    {t('artifacts_all_repositories', { count: repositories.length })}
                  </span>
                </SelectItem>
                {repositories.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    <span className={styles.truncate} title={entry.name}>
                      {entry.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input
            className={styles.search}
            type="search"
            value={typed}
            icon={<Search size={16} strokeWidth={1.3} />}
            placeholder={t('artifacts_search')}
            onChange={(event) => setTyped(event.target.value)}
            aria-label={t('artifacts_search')}
          />
        </div>
      </header>
      <ArtifactsTable
        rows={rows}
        columns={columns}
        offset={offset}
        total={total}
        pageSize={ARTIFACTS_PAGE_SIZE}
        onOffsetChange={setOffset}
        labels={{
          table: t('section_artifacts'),
          emptyMessage: t('artifacts_no_matches'),
          previous: t('artifacts_prev_page'),
          next: t('artifacts_next_page'),
          sortedNewest: t('artifacts_sorted_newest'),
          range: (from: number, to: number, count: number) =>
            t(count === 1 ? 'artifacts_range_one' : 'artifacts_range', {
              from,
              to,
              total: count,
            }),
          page: (index: number) => t('artifacts_page', { index }),
        }}
      />
    </div>
  );
};

ArtifactsSection.displayName = 'ArtifactsSection';
