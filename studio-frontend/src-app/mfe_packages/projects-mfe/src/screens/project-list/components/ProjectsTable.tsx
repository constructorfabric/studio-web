import { Tenant } from '@constructor-studio/mfe-shared';
import React from 'react';
import { FileSpreadsheet } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@gears-frontx/ui-kit';
import { useFormatters } from '@gears-frontx/react';
import { requestOpenProject } from '../../../actions/projectsActions';
import { useMfeBridge } from '@gears-frontx/react';
import { useWorkspaceProjects } from '../../../shared/workspaceProjects';
import { useProjectConfig } from '../../../shared/useProjectConfig';
import { useProjectListText } from '../../../i18n';
import { NoData } from './NoData';
import { OwnerInline } from './OwnerInline';
import { ProjectStatusInline } from './StatusInline';
import styles from '../ProjectListScreen.module.css';

interface ProjectsTableProps {
  rows: readonly Tenant[];
}

/**
 * One row. Every row is a project: the list is rooted at a workspace, and the
 * tenant type registry puts nothing else under one — so there are no container
 * rows, no chevrons and no indentation left to draw.
 */
const ProjectRow: React.FC<{ project: Tenant }> = ({ project }) => {
  const t = useProjectListText();
  const state = useProjectConfig(project.id);
  const { formatRelative } = useFormatters();
  const bridge = useMfeBridge();
  const { projects } = useWorkspaceProjects();

  const open = (): void => {
    const siblings = projects.map((sibling) => ({ id: sibling.id, name: sibling.name }));
    requestOpenProject({ id: project.id, name: project.name }, siblings, bridge);
  };

  return (
    <TableRow>
      <TableCell className={styles.colProject}>
        <button type="button" className={styles.nameButton} onClick={open}>
          <span className={styles.rowGlyph} aria-hidden>
            <FileSpreadsheet size={16} strokeWidth={1.3} />
          </span>
          <span className={styles.name}>{project.name}</span>
        </button>
      </TableCell>
      <TableCell className={styles.colStatus}>
        <ProjectStatusInline tenant={project} state={state} />
      </TableCell>
      <TableCell className={styles.colIssues}>
        {/* Findings/Signals have no portfolio rollup — see `issueSummary`. */}
        <NoData label={t('no_data')} />
      </TableCell>
      <TableCell className={styles.colMovement}>
        <NoData label={t('no_data')} />
      </TableCell>
      <TableCell className={styles.colOwner}>
        <OwnerInline state={state} />
      </TableCell>
      <TableCell className={styles.colUpdated}>
        <span className={styles.updated}>{formatRelative(project.updated_at)}</span>
      </TableCell>
    </TableRow>
  );
};

ProjectRow.displayName = 'ProjectRow';

/**
 * The mockup's Projects Portfolio table: Project, Status, Issues, 7-day
 * movement, Owner, Updated.
 */
export const ProjectsTable: React.FC<ProjectsTableProps> = ({ rows }) => {
  const t = useProjectListText();

  return (
    <Table label={t('title')} className={styles.table}>
      <TableHeader>
        <TableRow>
          <TableHead className={styles.colProject}>{t('col_project')}</TableHead>
          <TableHead className={styles.colStatus}>{t('col_status')}</TableHead>
          <TableHead className={styles.colIssues}>{t('col_issues')}</TableHead>
          <TableHead className={styles.colMovement}>{t('col_movement')}</TableHead>
          <TableHead className={styles.colOwner}>{t('col_owner')}</TableHead>
          <TableHead className={styles.colUpdated}>{t('col_updated')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((project) => (
          <ProjectRow key={project.id} project={project} />
        ))}
      </TableBody>
    </Table>
  );
};

ProjectsTable.displayName = 'ProjectsTable';
