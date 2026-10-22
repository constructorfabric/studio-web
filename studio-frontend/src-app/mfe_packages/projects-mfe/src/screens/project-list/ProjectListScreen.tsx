import React, { useState } from 'react';
import { Folder, Search } from 'lucide-react';
import {
  Button,
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Skeleton,
} from '@gears-frontx/ui-kit';
import { useMfeBridge } from '@gears-frontx/react';
import { useProjectListScreenTranslations, useProjectListText } from '../../i18n';
import { WorkspaceProjectsProvider } from '../../shared/workspaceProjects';
import { useProjectList } from '../../shared/useProjectList';
import { DEFAULT_SORT_OPTION, type ProjectSortOption } from '../../model/project';
import { openProjectWizard } from '../../actions/wizardActions';
import { SectionHeader } from '../../components/SectionHeader';
import { ProjectsTable } from './components/ProjectsTable';
import styles from './ProjectListScreen.module.css';


// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-no-workspace:p1
const ProjectList: React.FC = () => {
  const { isLoaded, error: translationsFailed } = useProjectListScreenTranslations();
  const t = useProjectListText();
  const bridge = useMfeBridge();
  const [query, setQuery] = useState('');

  const sort: ProjectSortOption = DEFAULT_SORT_OPTION;

  const { loading, failed, org, workspace, rows, total } = useProjectList(query, sort);
  const busy = (!isLoaded && !translationsFailed) || loading;

  const actions = () => (
    <Button
      size="sm"
      disabled={!workspace}
      title={workspace ? undefined : t('empty_no_workspace')}
      onClick={() => openProjectWizard(bridge)}
    >
      {t('new_project')}
    </Button>
  );

  return (
    <div className={styles.screen}>
      <SectionHeader title={t('title')} busy={busy} actions={actions()} />

      <section className={styles.body}>
        {/* TODO: DataGrid's text search replaces this row. */}
        <div className={styles.searchRow}>
          <div className={styles.searchBox}>
            <Input
              className={styles.search}
              type="search"
              value={query}
              icon={<Search size={16} strokeWidth={1.3} />}
              placeholder={t('search_placeholder')}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('search_placeholder')}
            />
          </div>
        </div>

        {busy ? (
          <div className={styles.rowsSkeleton}>
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
          </div>
        ) : failed || translationsFailed ? (
          <p className={styles.state}>
            {translationsFailed ? 'Could not load this screen.' : t('error_title')}
          </p>
        ) : (
          <ProjectsTable
            rows={rows}
            empty={
              total > 0 ? (
                <Empty className={styles.empty}>
                  <EmptyHeader>
                    <EmptyDescription>{t('empty_no_match')}</EmptyDescription>
                  </EmptyHeader>
                  <EmptyActions>
                    <Button variant="link" onClick={() => setQuery('')}>
                      {t('clear_search')}
                    </Button>
                  </EmptyActions>
                </Empty>
              ) : (
                <Empty className={styles.empty}>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Folder />
                    </EmptyMedia>
                    <EmptyTitle>{t('empty_title')}</EmptyTitle>
                    <EmptyDescription>
                      {!org
                        ? t('empty_no_org')
                        : !workspace
                          ? t('empty_no_workspace')
                          : t('empty_hint')}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )
            }
          />
        )}

        {!busy && !failed && !translationsFailed && rows.length > 0 ? (
          <footer className={styles.footer}>
            {workspace ? `${t('in_workspace')} ${workspace.name}` : ''}
          </footer>
        ) : null}
      </section>
    </div>
  );
};

export const ProjectListScreen: React.FC = () => (
  <WorkspaceProjectsProvider>
    <ProjectList />
  </WorkspaceProjectsProvider>
);

ProjectListScreen.displayName = 'ProjectListScreen';
