import React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@gears-frontx/ui-kit';
import { SORT_OPTIONS, type ProjectSortOption } from '../../../model/project';
import { useProjectListText } from '../../../i18n';
import styles from '../ProjectListScreen.module.css';

interface SortSelectProps {
  value: ProjectSortOption;
  onChange: (value: ProjectSortOption) => void;
  container: HTMLElement | null;
}

/** The toolbar's sort control  */

export const SortSelect: React.FC<SortSelectProps> = ({ value, onChange, container }) => {
  const t = useProjectListText();

  return (
  <Select value={value} onValueChange={(next) => onChange(next as ProjectSortOption)}>
    <SelectTrigger variant="filter" size="sm" className={styles.sort} aria-label={t('sort_label')}>
      <span className={styles.sortPrefix}>{t('sort_prefix')}</span>
      <SelectValue>{(selected) => t(`sort_${String(selected)}`)}</SelectValue>
    </SelectTrigger>
    <SelectContent container={container ?? undefined} align="end">
      {SORT_OPTIONS.map((option) => (
        <SelectItem key={option} value={option}>
          {t(`sort_${option}`)}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
  );
};

SortSelect.displayName = 'SortSelect';
