/**
 * Step 2 — pick the repository a modernization starts from.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-many-sources:p1
// @cpt-algo:cpt-studiofrontend-algo-project-create-repos:p2
import React from 'react';
import { Search, Lock, Eye } from 'lucide-react';
import {
  Checkbox,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@gears-frontx/ui-kit';
import { useAppDispatch, useAppSelector } from '@gears-frontx/react';
import { useProjectCreateText } from '../../../i18n';
import { useSourceConnections } from '../../../shared/useConnections';
import { useOrganization } from '../../../shared/organization';
import { useRepositories } from '../../../shared/useRepositories';
import { useDebounced } from '../../../shared/useDebounced';
import {
  CREATE_SLICE_KEY,
  pickSource,
  searchRepositories,
  selectConnection,
} from '../../../slices/createSlice';
import { MAX_SOURCES, repoKey, sourceKey } from '../../../model/projectDraft';
import type { RemoteRepoDto } from '../../../api/connectorTypes';
import styles from '../NewProjectWizard.module.css';

const RepositoryTable: React.FC<{ connectionId: string; orgId: string }> = ({
  connectionId,
  orgId,
}) => {
  const t = useProjectCreateText();
  const dispatch = useAppDispatch();
  const search = useAppSelector((state) => state[CREATE_SLICE_KEY].repoSearch);
  const sources = useAppSelector((state) => state[CREATE_SLICE_KEY].draft.sources);
  // @cpt-begin:cpt-studiofrontend-algo-project-create-repos:p2:inst-2
  const { repositories, loading, failed } = useRepositories(
    connectionId,
    orgId,
    useDebounced(search)
  );
  // @cpt-end:cpt-studiofrontend-algo-project-create-repos:p2:inst-2

  // Keys, not the array: a page holds up to 100 rows and the selection up to
  // 100 picks, so a linear scan per row is the one place this screen could get
  // quadratic.
  const pickedKeys = new Set(sources.map(sourceKey));
  const atCap = sources.length >= MAX_SOURCES;

  // @cpt-begin:cpt-studiofrontend-dod-project-create-many-sources:p1:inst-2
  const toggle = (repo: RemoteRepoDto): void => {
    dispatch(
      pickSource({
        id: repo.id,
        fullPath: repo.full_path,
        cloneUrl: repo.clone_url,
        connectionId,
      })
    );
  };
  // @cpt-end:cpt-studiofrontend-dod-project-create-many-sources:p1:inst-2

  return (
    <div className={styles.repoViewport}>
      <Input
        className={styles.repoSearch}
        type="search"
        value={search}
        icon={<Search size={16} strokeWidth={1.3} />}
        placeholder={t('search_placeholder')}
        onChange={(event) => dispatch(searchRepositories(event.target.value))}
        aria-label={t('search_placeholder')}
      />

      {loading ? (
        <div className={styles.repoRows}>
          <Skeleton className={styles.repoRowSkeleton} />
          <Skeleton className={styles.repoRowSkeleton} />
          <Skeleton className={styles.repoRowSkeleton} />
          <Skeleton className={styles.repoRowSkeleton} />
          <Skeleton className={styles.repoRowSkeleton} />
        </div>
      ) : failed ? (
        <p className={styles.placeholder}>{t('repos_error')}</p>
      ) : repositories.length === 0 ? (
        <p className={styles.placeholder}>
          {search.trim() ? t('repos_no_match') : t('repos_empty')}
        </p>
      ) : (
        <div className={styles.repoScroll}>
          <Table label={t('repos_region')} className={styles.repoTable}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className={styles.repoPickHead}>
                  <span className={styles.srOnly}>{t('col_pick')}</span>
                </TableHead>
                <TableHead scope="col">{t('col_repository')}</TableHead>
                <TableHead scope="col" className={styles.repoVisibilityHead}>
                  {t('col_visibility')}
                </TableHead>
                {/* @cpt-begin:cpt-studiofrontend-algo-project-create-repos:p2:inst-3 */}
                <TableHead scope="col" className={styles.repoUpdatedHead}>
                  {t('col_updated')}
                </TableHead>
                {/* @cpt-end:cpt-studiofrontend-algo-project-create-repos:p2:inst-3 */}
              </TableRow>
            </TableHeader>
            {/* @cpt-begin:cpt-studiofrontend-algo-project-create-repos:p2:inst-4 */}
            <TableBody>
            {repositories.map((repo) => {
              const picked = pickedKeys.has(repoKey(connectionId, repo.id));
              const blocked = atCap && !picked;
              const isPublic = repo.visibility === 'public';
              return (
                <TableRow
                  key={repo.id}
                  data-picked={picked ? '' : undefined}
                  aria-disabled={blocked || undefined}
                  onClick={blocked ? undefined : () => toggle(repo)}
                >
                  <TableCell>
                    <Checkbox
                      className={styles.repoCheckbox}
                      checked={picked}
                      disabled={blocked}
                      aria-label={repo.full_path}
                      onClick={(event) => event.preventDefault()}
                      onCheckedChange={() => toggle(repo)}
                    />
                  </TableCell>
                  <TableHead scope="row" className={styles.repoName}>
                    {repo.name}
                  </TableHead>
                  <TableCell className={styles.repoVisibility}>
                    <span className={styles.repoVisibilityInner}>
                      {isPublic ? (
                        <Eye size={12} strokeWidth={1.4} />
                      ) : (
                        <Lock size={12} strokeWidth={1.4} />
                      )}
                      {isPublic ? t('visibility_public') : t('visibility_private')}
                    </span>
                  </TableCell>
                  <TableCell className={styles.repoUpdated} title={t('no_data')} />
                </TableRow>
              );
            })}
          </TableBody>
            {/* @cpt-end:cpt-studiofrontend-algo-project-create-repos:p2:inst-4 */}
          </Table>
        </div>
      )}
    </div>
  );
};

RepositoryTable.displayName = 'RepositoryTable';

const Catalogue: React.FC<{ orgId: string }> = ({ orgId }) => {
  const t = useProjectCreateText();
  const dispatch = useAppDispatch();
  const chosen = useAppSelector((state) => state[CREATE_SLICE_KEY].connectionId);
  // @cpt-begin:cpt-studiofrontend-algo-project-create-repos:p2:inst-1
  const { connections, loading, failed, providerName } = useSourceConnections(orgId);
  // @cpt-end:cpt-studiofrontend-algo-project-create-repos:p2:inst-1

  if (loading) return <Skeleton className={styles.repoRowSkeleton} />;
  if (failed) return <p className={styles.placeholder}>{t('connections_error')}</p>;
  if (connections.length === 0) {
    return <p className={styles.placeholder}>{t('connections_empty')}</p>;
  }

  const active = connections.find((c) => c.id === chosen) ?? connections[0]!;

  return (
    <>
      <Tabs
        value={active.id}
        onValueChange={(value: string) => dispatch(selectConnection(value))}
      >
        <TabsList variant="line" className={styles.repoTabs}>
          {connections.map((connection) => (
            <TabsTrigger
              key={connection.id}
              value={connection.id}
              className={styles.repoTab}
            >
              {`${providerName(connection.provider)} · ${connection.label}`}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <RepositoryTable key={active.id} connectionId={active.id} orgId={orgId} />
    </>
  );
};

Catalogue.displayName = 'Catalogue';

export const RepositoriesStep: React.FC = () => {
  const t = useProjectCreateText();
  // The provider is the wizard root's; this is a context read, not a fetch.
  const { org, loading } = useOrganization();

  if (loading) return <Skeleton className={styles.repoRowSkeleton} />;
  if (!org) return <p className={styles.placeholder}>{t('error_no_org')}</p>;

  return <Catalogue orgId={org.id} />;
};

RepositoriesStep.displayName = 'RepositoriesStep';
