import React, { useMemo } from "react";
import { useFormatters } from "@gears-frontx/react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@gears-frontx/ui-kit";
import type { Tenant } from "@constructor-studio/mfe-shared";
import { useWorkspacesText } from "../../../i18n";
import { workspaceColumns } from "./workspaceColumns";
import styles from "../WorkspacesScreen.module.css";

interface WorkspacesTableProps {
  rows: readonly Tenant[];
  total: number;
  emptyMessage: string;
  onOpen: (row: Tenant) => void;
}

export const WorkspacesTable: React.FC<WorkspacesTableProps> = ({
  rows,
  total,
  emptyMessage,
  onOpen,
}) => {
  const { formatRelative } = useFormatters();
  const t = useWorkspacesText();

  const columns = useMemo(
    () =>
      workspaceColumns({
        labels: {
          workspace: t("col_workspace"),
          projects: t("col_projects"),
          issues: t("col_issues"),
          access: t("col_access"),
          configuration: t("col_configuration"),
          updated: t("col_updated"),
          noData: t("no_data"),
        },
        formatRelative,
        onOpen,
      }),
    [t, formatRelative, onOpen],
  );

  return (
    <>
      <Table label={t("table_label")} className={styles.table}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column.key} className={column.className}>
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className={styles.emptyCell}>
                {emptyMessage}
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
          {t(total === 1 ? "range_one" : "range_many", {
            from: rows.length === 0 ? 0 : 1,
            to: rows.length,
            total,
          })}
        </span>
      </div>
    </>
  );
};

WorkspacesTable.displayName = "WorkspacesTable";
