import React from "react";
import { Button } from "@gears-frontx/ui-kit";
import { useMfeBridge } from "@gears-frontx/react";
import { openWorkspaceForm } from "../../../actions/overlayActions";
import { SectionHeader, type ScreenText } from "@constructor-studio/mfe-shared";
import { useWorkspacesText } from "../../../i18n";

interface WorkspacesHeaderProps {
  busy: boolean;
  canCreate: boolean;
  total?: number;
  projectTotal?: number;
}

function totalsLine(t: ScreenText, total?: number, projectTotal?: number): string | undefined {
  if (total === undefined || projectTotal === undefined) return undefined;
  return `${t.count("totals_workspaces", total)} · ${t.count("totals_projects", projectTotal)}`;
}

export const WorkspacesHeader: React.FC<WorkspacesHeaderProps> = ({
  busy,
  canCreate,
  total,
  projectTotal,
}) => {
  const bridge = useMfeBridge();
  const t = useWorkspacesText();
  const totals = busy ? undefined : totalsLine(t, total, projectTotal);

  return (
    <SectionHeader
      title={t("title")}
      busy={busy}
      description={totals}
      actions={
        // @cpt-dod:cpt-studiofrontend-dod-workspaces-screen-create-moves:p1
        <Button
          size="sm"
          disabled={!canCreate}
          title={canCreate ? undefined : t("new_workspace_no_org")}
          onClick={() => openWorkspaceForm(bridge)}
        >
          {t("new_workspace")}
        </Button>
      }
    />
  );
};

WorkspacesHeader.displayName = "WorkspacesHeader";
