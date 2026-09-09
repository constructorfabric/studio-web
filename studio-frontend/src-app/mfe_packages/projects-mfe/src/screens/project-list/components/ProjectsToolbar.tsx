import React from 'react';
import { Search } from 'lucide-react';
import { Button, Input, Skeleton } from '@gears-frontx/ui-kit';
import { useProjectListText } from '../../../i18n';
import { useMfeBridge } from '@gears-frontx/react';
import { openProjectWizard } from '../../../actions/wizardActions';
import styles from '../ProjectListScreen.module.css';

interface ProjectsToolbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  busy: boolean;
  hasWorkspace: boolean;
}

// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-no-workspace:p1
export const ProjectsToolbar: React.FC<ProjectsToolbarProps> = ({
  query,
  onQueryChange,
  busy,
  hasWorkspace,
}) => {
  const t = useProjectListText();
  const bridge = useMfeBridge();

  return (
  <div className={styles.toolbar} role="toolbar" aria-label={t('toolbar_label')}>
    <h1 className={styles.title}>
      {busy ? <Skeleton className={styles.titleSkeleton} /> : t('title')}
    </h1>

    <div className={styles.controls}>
      <Input
        className={styles.search}
        type="search"
        value={query}
        icon={<Search size={16} strokeWidth={1.3} />}
        placeholder={t('search_placeholder')}
        onChange={(event) => onQueryChange(event.target.value)}
        aria-label={t('search_placeholder')}
      />
      <Button
        size="sm"
        disabled={!hasWorkspace}
        title={hasWorkspace ? undefined : t('empty_no_workspace')}
        onClick={() => openProjectWizard(bridge)}
      >
        {t('new_project')}
      </Button>
    </div>
  </div>
  );
};

ProjectsToolbar.displayName = 'ProjectsToolbar';
