import React from "react";
import { Search } from "lucide-react";
import { Button, Input, Skeleton } from "@gears-frontx/ui-kit";
import { useMfeBridge } from "@gears-frontx/react";
import { openWorkspaceForm } from "../../../actions/overlayActions";
import { useWorkspacesText, type ScreenText } from "../../../i18n";
import styles from "../WorkspacesScreen.module.css";

interface WorkspacesToolbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  busy: boolean;
  canCreate: boolean;
  total?: number;
  projectTotal?: number;
}

function totalsLine(t: ScreenText, total: number, projectTotal: number): string {
  const workspaces = t(total === 1 ? "totals_workspaces_one" : "totals_workspaces_many", {
    count: total,
  });
  const projects = t(
    projectTotal === 1 ? "totals_projects_one" : "totals_projects_many",
    { count: projectTotal },
  );
  return `${workspaces} · ${projects}`;
}

export const WorkspacesToolbar: React.FC<WorkspacesToolbarProps> = ({
  query,
  onQueryChange,
  busy,
  canCreate,
  total,
  projectTotal,
}) => {
  const bridge = useMfeBridge();
  const t = useWorkspacesText();

  return (
    <div
      className={styles.toolbar}
      role="toolbar"
      aria-label={t("toolbar_label")}
    >
      <div className={styles.heading}>
        <h1 className={styles.title}>
          {busy ? <Skeleton className={styles.titleSkeleton} /> : t("title")}
        </h1>
        {!busy && total !== undefined && projectTotal !== undefined && (
          <p className={styles.totals}>{totalsLine(t, total, projectTotal)}</p>
        )}
      </div>

      <div className={styles.controls}>
        <Input
          className={styles.search}
          type="search"
          value={query}
          icon={<Search size={16} strokeWidth={1.3} />}
          placeholder={t("search_placeholder")}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-label={t("search_placeholder")}
        />
        {/* @cpt-dod:cpt-studiofrontend-dod-workspaces-screen-create-moves:p1 */}
        <Button
          size="sm"
          disabled={!canCreate}
          title={canCreate ? undefined : t("new_workspace_no_org")}
          onClick={() => openWorkspaceForm(bridge)}
        >
          {t("new_workspace")}
        </Button>
      </div>
    </div>
  );
};

WorkspacesToolbar.displayName = "WorkspacesToolbar";
