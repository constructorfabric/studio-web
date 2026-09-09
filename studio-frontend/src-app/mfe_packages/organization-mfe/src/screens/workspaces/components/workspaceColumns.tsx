/** The columns of the workspaces table */

import React from "react";
import { Building2 } from "lucide-react";
import type { Tenant } from "@constructor-studio/mfe-shared";
import { NoData } from "./NoData";
import styles from "../WorkspacesScreen.module.css";

export interface WorkspaceColumn {
  key: string;
  label: string;
  className: string;
  render: (row: Tenant) => React.ReactNode;
}

export interface WorkspaceColumnLabels {
  workspace: string;
  projects: string;
  issues: string;
  access: string;
  configuration: string;
  updated: string;
  noData: string;
}

export interface WorkspaceColumnDeps {
  labels: WorkspaceColumnLabels;
  formatRelative: (value: string) => string;
  onOpen: (row: Tenant) => void;
}

// @cpt-dod:cpt-studiofrontend-dod-workspaces-screen-counts:p2
export function workspaceColumns({
  labels,
  formatRelative,
  onOpen,
}: WorkspaceColumnDeps): WorkspaceColumn[] {
  return [
    {
      key: "workspace",
      label: labels.workspace,
      className: styles.colName,
      render: (row) => (
        // @cpt-dod:cpt-studiofrontend-dod-workspaces-screen-row-opens:p1
        <button
          type="button"
          className={styles.nameButton}
          onClick={() => onOpen(row)}
        >
          <span className={styles.rowGlyph} aria-hidden>
            <Building2 size={16} strokeWidth={1.3} />
          </span>
          <span className={styles.name}>{row.name}</span>
        </button>
      ),
    },
    {
      key: "projects",
      label: labels.projects,
      className: styles.colProjects,
      render: (row) =>
        row.child_count === undefined ? (
          <NoData label={labels.noData} />
        ) : (
          <span className={styles.count}>{row.child_count}</span>
        ),
    },
    {
      key: "issues",
      label: labels.issues,
      className: styles.colIssues,
      render: () => <NoData label={labels.noData} />,
    },
    {
      key: "access",
      label: labels.access,
      className: styles.colAccess,
      render: () => <NoData label={labels.noData} />,
    },
    {
      key: "configuration",
      label: labels.configuration,
      className: styles.colConfiguration,
      render: () => <NoData label={labels.noData} />,
    },
    {
      key: "updated",
      label: labels.updated,
      className: styles.colUpdated,
      render: (row) =>
        row.updated_at ? (
          <span className={styles.updated}>{formatRelative(row.updated_at)}</span>
        ) : (
          <NoData label={labels.noData} />
        ),
    },
  ];
}
