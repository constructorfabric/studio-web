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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import { type RemoteRepoDto, useOrganization } from '@constructor-studio/mfe-shared';
import { useRepositories } from '../../../shared/useRepositories';
import { useDebounced } from '../../../shared/useDebounced';
import {
  CREATE_SLICE_KEY,
  pickSource,
  searchRepositories,
  selectConnection,
  setShareMode,
} from '../../../slices/createSlice';
import {
  MAX_SOURCES,
  repoKey,
  sourceKey,
  supportsPullRequests,
  type RepositoryPick,
  type ShareMode,
} from '../../../model/projectDraft';
import { useThemedRoot } from '../../../shared/useThemedRoot';
import styles from '../NewProjectWizard.module.css';

const SHARE_MODES: readonly { value: ShareMode; labelKey: string }[] = [
  { value: 'branch', labelKey: 'share_branch' },
  { value: 'pull_request', labelKey: 'share_pull_request' },
];

/**
 * How a picked repository's shared edits land: on the project's branch, or
 * through a pull request. Lives on the row so the choice is made where the
 * repository is picked; the row toggles on click, so the control keeps its
 * clicks — the portalled list included, since React bubbles through portals.
 */
const ShareModeSelect: React.FC<{
  pick: RepositoryPick;
  pullRequests: boolean;
  container: HTMLElement | null;
}> = ({ pick, pullRequests, container }) => {
  const t = useProjectCreateText();
  const dispatch = useAppDispatch();

  return (
    <span className={styles.repoShareInner} onClick={(event) => event.stopPropagation()}>
      <Select
        value={pick.shareMode}
        onValueChange={(next: string | null) => {
          if (!next) return;
          dispatch(setShareMode({ key: sourceKey(pick), shareMode: next as ShareMode }));
        }}
      >
        <SelectTrigger
          size="sm"
          className={styles.repoShareTrigger}
          aria-label={t('share_label', { repo: pick.fullPath })}
        >
          <SelectValue>
            {(selected: unknown) =>
              t(selected === 'pull_request' ? 'share_pull_request' : 'share_branch')
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent container={container ?? undefined}>
          {SHARE_MODES.map((mode) => {
            const unavailable = mode.value === 'pull_request' && !pullRequests;
            return (
              <SelectItem
                key={mode.value}
                value={mode.value}
                disabled={unavailable}
              >
                {unavailable
                  ? `${t(mode.labelKey)} · ${t('share_github_only')}`
                  : t(mode.labelKey)}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </span>
  );
};

ShareModeSelect.displayName = 'ShareModeSelect';

const RepositoryTable: React.FC<{ connectionId: string; provider: string; orgId: string }> = ({
  connectionId,
  provider,
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
  const picks = new Map(sources.map((pick) => [sourceKey(pick), pick]));
  const pullRequests = supportsPullRequests(provider);
  const [container, findThemedRoot] = useThemedRoot();
  const atCap = sources.length >= MAX_SOURCES;

  // @cpt-begin:cpt-studiofrontend-dod-project-create-many-sources:p1:inst-2
  const toggle = (repo: RemoteRepoDto): void => {
    dispatch(
      pickSource({
        id: repo.id,
        fullPath: repo.full_path,
        cloneUrl: repo.clone_url,
        connectionId,
        shareMode: 'branch',
      })
    );
  };
  // @cpt-end:cpt-studiofrontend-dod-project-create-many-sources:p1:inst-2

  return (
    <div ref={findThemedRoot} className={styles.repoViewport}>
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
                <TableHead scope="col" className={styles.repoShareHead}>
                  {t('col_share')}
                </TableHead>
              </TableRow>
            </TableHeader>
            {/* @cpt-begin:cpt-studiofrontend-algo-project-create-repos:p2:inst-4 */}
            <TableBody>
            {repositories.map((repo) => {
              const pick = picks.get(repoKey(connectionId, repo.id));
              const picked = pick !== undefined;
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
                  <TableCell className={styles.repoShare}>
                    {pick ? (
                      <ShareModeSelect
                        pick={pick}
                        pullRequests={pullRequests}
                        container={container}
                      />
                    ) : null}
                  </TableCell>
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
      <RepositoryTable
        key={active.id}
        connectionId={active.id}
        provider={active.provider}
        orgId={orgId}
      />
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
