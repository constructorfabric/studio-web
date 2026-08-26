import React, { useState } from 'react';
import { Skeleton } from '@gears-frontx/ui-kit';
import { useProjectListScreenTranslations, useProjectListText } from '../../i18n';
import { ProjectTreeProvider } from '../../shared/projectTree';
import { useProjectList } from '../../shared/useProjectList';
import { DEFAULT_SORT_OPTION, type ProjectSortOption } from '../../model/project';
import { ProjectsToolbar } from './components/ProjectsToolbar';
import { ProjectsTable } from './components/ProjectsTable';
import styles from './ProjectListScreen.module.css';


const ProjectList: React.FC = () => {
  const { isLoaded, error: translationsFailed } = useProjectListScreenTranslations();
  const t = useProjectListText();
  const [query, setQuery] = useState('');
  /**
   * Fixed while the sort is out of the UI. It still orders the rows the fetch
   * returns, so restoring the control is a `useState` here plus the props back on
   * `ProjectsToolbar` and `ProjectsTable`.
   */
  const sort: ProjectSortOption = DEFAULT_SORT_OPTION;

  const { loading, failed, org, rows, toggle } = useProjectList(query, sort);
  const busy = (!isLoaded && !translationsFailed) || loading;

  return (
    <div className={styles.screen}>
      <ProjectsToolbar query={query} onQueryChange={setQuery} busy={busy} />

      {/* No row count: the tree only knows the projects whose branch the user
          has opened, so any number here would be a number of "loaded so far"
          dressed up as a total. */}
      <section className={styles.card}>
        {busy ? (
          <div className={styles.rowsSkeleton}>
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
          </div>
        ) : failed || translationsFailed ? (
          /*
           * `error_title` is itself one of the strings that failed to load when
           * `translationsFailed` is what got us here, so `t` would render the
           * key. The literal is the last resort for exactly that case — a
           * chunk that never arrived — and never shows while the dictionary is
           * intact.
           */
          <p className={styles.state}>
            {translationsFailed ? 'Could not load this screen.' : t('error_title')}
          </p>
        ) : rows.length === 0 ? (
          <div className={styles.state}>
            <p className={styles.stateTitle}>{t('empty_title')}</p>
            <p className={styles.stateHint}>{org ? t('empty_hint') : t('empty_no_org')}</p>
          </div>
        ) : (
          <ProjectsTable rows={rows} onToggle={toggle} />
        )}

        {!busy && !failed && !translationsFailed && rows.length > 0 ? (
          <footer className={styles.footer}>{org ? `${t('in_org')} ${org.name}` : ''}</footer>
        ) : null}
      </section>
    </div>
  );
};

export const ProjectListScreen: React.FC = () => (
  <ProjectTreeProvider>
    <ProjectList />
  </ProjectTreeProvider>
);

ProjectListScreen.displayName = 'ProjectListScreen';
