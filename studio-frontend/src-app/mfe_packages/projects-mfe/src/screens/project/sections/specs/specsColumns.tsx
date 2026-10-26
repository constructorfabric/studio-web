import React, { createContext, useContext } from 'react';
import type { DataGridTableColumn } from '@gears-frontx/ui-kit';
import { FilePenLine, FileText } from 'lucide-react';
import type { DocumentTypeDto } from '../../../../api/documentTypes';
import type { SpecRow } from '../../../../model/specRows';
import { useSpecsText } from '../../../../i18n';
import { TypeCell } from './TypeCell';
import styles from './SpecsTable.module.css';

/** What a cell needs beyond its row. The cells read it here, so the columns stay one array for the grid's life. */
export interface SpecsCells {
  projectId: string;
  workspaceId: string;
  /** #689's `snapshot.types`: what the Type menu offers. */
  types: readonly DocumentTypeDto[];
  /** The themed root the Type menu portals into. */
  container: HTMLElement | null;
  open: (row: SpecRow) => void;
}

export const SpecsCellsContext = createContext<SpecsCells | null>(null);

function useCells(): SpecsCells {
  const cells = useContext(SpecsCellsContext);
  if (!cells) throw new Error('A Specs cell rendered outside SpecsCellsContext');
  return cells;
}

interface CellProps {
  item: SpecRow;
}

const DocumentCell: React.FC<CellProps> = ({ item }) => {
  const { open } = useCells();
  const name = (
    <>
      <span className={styles.icon} aria-hidden="true">
        {item.origin === 'authored' ? (
          <FilePenLine size={16} strokeWidth={1.3} />
        ) : (
          <FileText size={16} strokeWidth={1.3} />
        )}
      </span>
      <span className={styles.name}>{item.name}</span>
    </>
  );
  // A file whose repository is not known has no checkout to open it from.
  if (!item.open) return <span className={styles.document}>{name}</span>;
  return (
    <button type="button" className={`${styles.document} ${styles.open}`} onClick={() => open(item)}>
      {name}
    </button>
  );
};

const TypeColumnCell: React.FC<CellProps> = ({ item }) => {
  const { types, projectId, workspaceId, container } = useCells();
  return (
    <TypeCell
      row={item}
      types={types}
      projectId={projectId}
      workspaceId={workspaceId}
      container={container}
    />
  );
};

const ReviewCell: React.FC<CellProps> = ({ item: { review } }) => {
  const t = useSpecsText();
  switch (review.kind) {
    case 'needs_type':
      return <span className={styles.muted}>{t('review_needs_type')}</span>;
    case 'check_needed':
      return <span>{t('review_check_needed')}</span>;
    case 'findings':
      return <span className={styles.findings}>{t.count('review_findings', review.count)}</span>;
    case 'clean':
      return <span className={styles.clean}>{t.count('review_findings', 0)}</span>;
    case 'unknown':
      return <span className={styles.muted}>—</span>;
  }
};

const SourceCell: React.FC<CellProps> = ({ item: { source } }) => {
  const t = useSpecsText();
  switch (source.kind) {
    case 'repository':
      return (
        <span className={styles.source}>
          {source.fullPath}
          {source.folder && <span className={styles.muted}>{` / ${source.folder}`}</span>}
        </span>
      );
    case 'studio':
      return <span>{t('source_studio')}</span>;
    case 'gone':
      return <span className={styles.muted}>{t('source_gone')}</span>;
    case 'unknown':
      return <span className={styles.muted}>—</span>;
  }
};

/** The ids are #689's order keys (`SORT_KEYS` in `model/specRows.ts`), which the order plugin hands to `load`. */
export function specsColumns(t: ReturnType<typeof useSpecsText>): DataGridTableColumn<SpecRow>[] {
  return [
    { id: 'document', label: t('col_document'), component: DocumentCell },
    { id: 'type', label: t('col_type'), component: TypeColumnCell, width: 240 },
    { id: 'review', label: t('col_review'), component: ReviewCell, width: 140 },
    { id: 'source', label: t('col_source'), component: SourceCell },
  ];
}
