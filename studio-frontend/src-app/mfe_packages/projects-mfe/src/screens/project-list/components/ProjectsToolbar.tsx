import React from 'react';
import { Search } from 'lucide-react';
import { Button, Input, Skeleton } from '@gears-frontx/ui-kit';
import { useProjectListText } from '../../../i18n';
import { useBridge } from '../../../shared/bridge';
import { openProjectWizard } from '../../../actions/wizardActions';
import styles from '../ProjectListScreen.module.css';

interface ProjectsToolbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  busy: boolean;
}

/**
 * The mockup's Portfolio Header: the page title and every control that acts on
 * the list, on one line above the table.
 *
 * It is deliberately not a strip inside the card. The design's own note on the
 * component is that the list's controls "live in the shared portfolio header and
 * persist when representation changes" — they belong to the screen, not to the
 * table, and a second representation (the workspace view) would reuse this row
 * unchanged.
 *
 * Controls from the mockup that are absent rather than disabled: the severity
 * filter and the Issues sort both act on issue counts, which no endpoint serves;
 * the view toggle waits for the second representation to exist. The sort chip is
 * out for now too — `SortSelect` is kept and the list still orders by
 * `DEFAULT_SORT_OPTION`, so putting it back is this row plus two props.
 */
export const ProjectsToolbar: React.FC<ProjectsToolbarProps> = ({
  query,
  onQueryChange,
  busy,
}) => {
  const t = useProjectListText();
  const bridge = useBridge();

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
      <Button size="sm" onClick={() => openProjectWizard(bridge)}>
        {t('new_project')}
      </Button>
    </div>
  </div>
  );
};

ProjectsToolbar.displayName = 'ProjectsToolbar';
