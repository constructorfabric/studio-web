import React from 'react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@gears-frontx/ui-kit';
import {
  FileText,
  GitBranch,
  GitMerge,
  MessageSquare,
  MoreHorizontal,
} from 'lucide-react';
import type { ArtifactKind } from '../../../api/artifactTypes';
import type { ArtifactRow } from '../../../model/artifact';
import styles from './ArtifactsSection.module.css';

const KIND_ICON: Record<ArtifactKind, React.ReactNode> = {
  repo: <GitBranch size={16} strokeWidth={1.3} />,
  file: <FileText size={16} strokeWidth={1.3} />,
  issue: <MessageSquare size={16} strokeWidth={1.3} />,
  pullRequest: <GitMerge size={16} strokeWidth={1.3} />,
};

export interface ArtifactColumnLabels {
  name: string;
  repository: string;
  path: string;
  sync: string;
  updated: string;
  ingested: string;
  provenance: Record<string, string>;
  actions: (name: string) => string;
  open: string;
  copyLink: string;
}

export interface ArtifactColumn {
  key: string;
  label: string;
  className: string;
  sorted?: boolean;
  render: (row: ArtifactRow) => React.ReactNode;
}

export interface ArtifactColumnDeps {
  labels: ArtifactColumnLabels;
  formatRelative: (value: number) => string;
  container?: HTMLElement | null;
}

const RowMenu: React.FC<{
  row: ArtifactRow;
  labels: ArtifactColumnLabels;
  container?: HTMLElement | null;
}> = ({ row, labels, container }) => (
  <div className={styles.actionsCell}>
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={styles.actionsButton}
            aria-label={labels.actions(row.name)}
            disabled={row.url === null}
            icon={<MoreHorizontal size={16} strokeWidth={1.5} />}
          />
        }
      />
      <DropdownMenuContent align="end" container={container ?? undefined}>
        <DropdownMenuItem
          onClick={() => {
            if (row.url) window.open(row.url, '_blank', 'noopener,noreferrer');
          }}
        >
          {labels.open}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            if (row.url) void navigator.clipboard?.writeText(row.url);
          }}
        >
          {labels.copyLink}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);

RowMenu.displayName = 'RowMenu';

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-table:p1
// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-updated:p1
export function artifactColumns({
  labels,
  formatRelative,
  container,
}: ArtifactColumnDeps): ArtifactColumn[] {
  return [
    {
      key: 'name',
      label: labels.name,
      className: styles.colName,
      render: (row) => (
        <span className={styles.nameCell}>
          {row.kind !== null && (
            <span className={styles.kindIcon} aria-hidden="true">
              {KIND_ICON[row.kind]}
            </span>
          )}
          <span className={styles.nameText}>{row.name}</span>
        </span>
      ),
    },
    {
      key: 'repository',
      label: labels.repository,
      className: styles.colRepository,
      render: (row) => <span className={styles.truncate}>{row.repository}</span>,
    },
    {
      key: 'path',
      label: labels.path,
      className: styles.colPath,
      render: (row) => <span className={styles.truncate}>{row.path}</span>,
    },
    {
      key: 'sync',
      label: labels.sync,
      className: styles.colSync,
      // TODO: plain text until ui-kit carries a plain status badge again (0.4
      // dropped Badge's `shape="plain"`/`dot`).
      render: () => labels.ingested,
    },
    {
      key: 'updated',
      label: labels.updated,
      className: styles.colUpdated,
      sorted: true,
      render: (row) =>
        row.updatedAt !== null
          ? formatRelative(row.updatedAt)
          : row.provenance
            ? labels.provenance[row.provenance]
            : '',
    },
    {
      key: 'actions',
      label: '',
      className: styles.colActions,
      render: (row) => <RowMenu row={row} labels={labels} container={container} />,
    },
  ];
}
