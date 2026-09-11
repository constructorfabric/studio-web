import React, { useState } from 'react';
import { Skeleton } from '@gears-frontx/ui-kit';
import { useProjectListScreenTranslations, useProjectListText } from '../../i18n';
import { WorkspaceProjectsProvider } from '../../shared/workspaceProjects';
import { useProjectList } from '../../shared/useProjectList';
import { DEFAULT_SORT_OPTION, type ProjectSortOption } from '../../model/project';
import { ProjectsToolbar } from './components/ProjectsToolbar';
import { ProjectsTable } from './components/ProjectsTable';
import styles from './ProjectListScreen.module.css';


const ProjectList: React.FC = () => {
  const { isLoaded, error: translationsFailed } = useProjectListScreenTranslations();
  const t = useProjectListText();
  const [query, setQuery] = useState('');

  const sort: ProjectSortOption = DEFAULT_SORT_OPTION;

  const { loading, failed, org, workspace, rows } = useProjectList(query, sort);
  const busy = (!isLoaded && !translationsFailed) || loading;

  return (
    <div className={styles.screen}>
      <ProjectsToolbar
        query={query}
        onQueryChange={setQuery}
        busy={busy}
        hasWorkspace={!!workspace}
      />

      <section className={styles.card}>
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
        ) : rows.length === 0 ? (
          <div className={styles.state}>
            <p className={styles.stateTitle}>{t('empty_title')}</p>
            <p className={styles.stateHint}>
              {!org ? t('empty_no_org') : !workspace ? t('empty_no_workspace') : t('empty_hint')}
            </p>
          </div>
        ) : (
          <ProjectsTable rows={rows} />
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
