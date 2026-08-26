import React from 'react';
import { ChevronDown } from 'lucide-react';
import { TableHead } from '@gears-frontx/ui-kit';
import { useProjectListText } from '../../../i18n';
import styles from '../ProjectListScreen.module.css';

/**
 * A column header that can carry the sort indicator.
 *
 * Not mounted anywhere at the moment — kept, like `SortSelect`, until it is
 * settled whether the list gets a user-facing sort. The 16px slot is always
 * reserved so the label does not shift when the sort moves between columns, and
 * the direction goes in the accessible name because the glyph is `aria-hidden`.
 */
export const SortableHead: React.FC<{
  className: string;
  label: string;
  active: boolean;
  direction: 'asc' | 'desc';
}> = ({ className, label, active, direction }) => {
  const t = useProjectListText();

  return (
  <TableHead
    className={className}
    aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
  >
    <span className={styles.headLabel}>
      {label}
      <span className={styles.sortSlot} data-active={active} data-direction={direction} aria-hidden>
        {active ? <ChevronDown size={12} strokeWidth={1.4} /> : null}
      </span>
      {active ? (
        <span className={styles.srOnly}>{t(`sort_direction_${direction}`)}</span>
      ) : null}
    </span>
  </TableHead>
  );
};

SortableHead.displayName = 'SortableHead';
