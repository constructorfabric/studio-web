/** The organization's workspaces */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiRegistry,
  useApiQuery,
  useMfeBridge,
  useSharedProperty,
} from "@gears-frontx/react";
import { Button, Skeleton } from "@gears-frontx/ui-kit";
import {
  useOrganization,
  AccountsApiService,
  STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
  type OrganizationRef,
  type Tenant,
} from "@constructor-studio/mfe-shared";
import { requestWorkspace } from "../../actions/workspaceActions";
import { useWorkspacesScreenTranslations, useWorkspacesText } from "../../i18n";
import { WorkspacesToolbar } from "./components/WorkspacesToolbar";
import { WorkspacesTable } from "./components/WorkspacesTable";
import styles from "./WorkspacesScreen.module.css";

// @cpt-dod:cpt-studiofrontend-dod-workspaces-screen-level:p1
const WorkspaceList: React.FC<{
  organization: OrganizationRef;
  translationsPending: boolean;
}> = ({ organization, translationsPending }) => {
  const bridge = useMfeBridge();
  const accounts = apiRegistry.getService(AccountsApiService);
  const t = useWorkspacesText();
  const [query, setQuery] = useState("");
  const { data, isLoading, isError, refetch } = useApiQuery(
    accounts.getWorkspaces({ organizationId: organization.id }),
    { staleTime: 0 },
  );

  const scopedWorkspace = useSharedProperty(
    STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
  );
  const seenScoped = useRef(false);
  useEffect(() => {
    if (!seenScoped.current) {
      seenScoped.current = true;
      return;
    }
    void refetch();
  }, [scopedWorkspace, refetch]);

  const all = data?.items ?? [];

  const projectTotal = useMemo(
    () => all.reduce((sum, row) => sum + (row.child_count ?? 0), 0),
    [all],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((row) => row.name.toLowerCase().includes(needle));
  }, [all, query]);

  // @cpt-dod:cpt-studiofrontend-dod-workspaces-screen-row-opens:p1
  const open = useCallback(
    (row: Tenant) => {
      requestWorkspace(bridge, { id: row.id, name: row.name });
    },
    [bridge],
  );

  const pending = translationsPending || (isLoading && all.length === 0);

  return (
    <div className={styles.screen}>
      <WorkspacesToolbar
        query={query}
        onQueryChange={setQuery}
        busy={pending}
        canCreate
        total={all.length}
        projectTotal={projectTotal}
      />

      <div className={styles.panel}>
        {pending ? (
          <div className={styles.loading}>
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
          </div>
        ) : (
          <>
            {isError && (
              <div className={styles.stateBlock}>
                <p className={styles.error}>{t("error_title")}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.retry}
                  onClick={() => void refetch()}
                >
                  {t("retry")}
                </Button>
              </div>
            )}
            <WorkspacesTable
              rows={rows}
              total={rows.length}
              emptyMessage={t(query.trim() ? "empty_search" : "empty_none")}
              onOpen={open}
            />
          </>
        )}
      </div>
    </div>
  );
};

WorkspaceList.displayName = "WorkspaceList";

export const WorkspacesScreen: React.FC = () => {
  const { isLoaded, error: translationsFailed } =
    useWorkspacesScreenTranslations();
  const t = useWorkspacesText();
  const { org, loading } = useOrganization();
  const translationsPending = !isLoaded && !translationsFailed;

  if (!org) {
    return (
      <div className={styles.screen} data-state="no-organization">
        <WorkspacesToolbar
          query=""
          onQueryChange={() => {}}
          busy={loading || translationsPending}
          canCreate={false}
        />
        <p className={styles.note}>
          {loading ? t("resolving_org") : t("no_org")}
        </p>
      </div>
    );
  }

  return (
    <WorkspaceList
      organization={org}
      translationsPending={translationsPending}
    />
  );
};

WorkspacesScreen.displayName = "WorkspacesScreen";
