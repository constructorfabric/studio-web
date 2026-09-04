import React from 'react';
import {
  Button,
  Pagination,
  PaginationContent,
  PaginationItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@gears-frontx/ui-kit';
import { ArrowDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ArtifactRow } from '../../../model/artifact';
import type { ArtifactColumn } from './artifactColumns';
import styles from './ArtifactsSection.module.css';

export interface ArtifactsTableLabels {
  table: string;
  emptyMessage: string;
  previous: string;
  next: string;
  sortedNewest: string;
  range: (from: number, to: number, total: number) => string;
  page: (index: number) => string;
}

interface ArtifactsTableProps {
  rows: readonly ArtifactRow[];
  columns: readonly ArtifactColumn[];
  labels: ArtifactsTableLabels;
  offset: number;
  total: number;
  pageSize: number;
  onOffsetChange: (offset: number) => void;
}

const MAX_PAGES_SHOWN = 4;

function pageWindow(current: number, count: number): number[] {
  if (count <= MAX_PAGES_SHOWN) return Array.from({ length: count }, (_, i) => i);
  const half = Math.floor(MAX_PAGES_SHOWN / 2);
  const start = Math.min(Math.max(0, current - half), count - MAX_PAGES_SHOWN);
  return Array.from({ length: MAX_PAGES_SHOWN }, (_, i) => start + i);
}

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-table:p1
// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-page:p1
export const ArtifactsTable: React.FC<ArtifactsTableProps> = ({
  rows,
  columns,
  labels,
  offset,
  total,
  pageSize,
  onOffsetChange,
}) => {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.floor(offset / pageSize), pageCount - 1);

  return (
    <>
      <Table label={labels.table} density="compact" className={styles.table}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column.key} className={column.className}>
                {column.sorted ? (
                  <span className={styles.sortMark} title={labels.sortedNewest}>
                    {column.label}
                    <ArrowDown size={14} strokeWidth={1.5} aria-hidden="true" />
                  </span>
                ) : (
                  column.label
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className={styles.emptyCell}>
                {labels.emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                {columns.map((column) => (
                  <TableCell key={column.key} className={column.className}>
                    {column.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className={styles.footer}>
        <span className={styles.range}>
          {labels.range(total === 0 ? 0 : offset + 1, offset + rows.length, total)}
        </span>
        <Pagination className={styles.pagination}>
          <PaginationContent>
            <PaginationItem>
              <Button
                variant="ghost"
                size="sm"
                className={styles.pageStep}
                aria-label={labels.previous}
                disabled={current === 0}
                onClick={() => onOffsetChange((current - 1) * pageSize)}
                icon={<ChevronLeft size={16} strokeWidth={1.5} />}
              />
            </PaginationItem>
            {pageWindow(current, pageCount).map((index) => (
              <PaginationItem key={index}>
                <Button
                  variant={index === current ? 'secondary' : 'ghost'}
                  size="sm"
                  className={styles.pageNumber}
                  aria-label={labels.page(index + 1)}
                  aria-current={index === current ? 'page' : undefined}
                  onClick={() => onOffsetChange(index * pageSize)}
                >
                  {index + 1}
                </Button>
              </PaginationItem>
            ))}
            <PaginationItem>
              <Button
                variant="ghost"
                size="sm"
                className={styles.pageStep}
                aria-label={labels.next}
                disabled={current >= pageCount - 1}
                onClick={() => onOffsetChange((current + 1) * pageSize)}
                icon={<ChevronRight size={16} strokeWidth={1.5} />}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </>
  );
};

ArtifactsTable.displayName = 'ArtifactsTable';
