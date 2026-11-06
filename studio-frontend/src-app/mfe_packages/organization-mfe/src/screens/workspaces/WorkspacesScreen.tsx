/** The organization's workspaces */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiRegistry,
  useApiQuery,
  useMfeBridge,
  useSharedProperty,
} from "@gears-frontx/react";
import { Folder, Search } from "lucide-react";
import {
  Button,
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Skeleton,
} from "@gears-frontx/ui-kit";
import {
  useOrganization,
  AccountsApiService,
  STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
  type OrganizationRef,
  type Tenant,
} from "@constructor-studio/mfe-shared";
import { requestWorkspace } from "../../actions/workspaceActions";
import { useWorkspacesScreenTranslations, useWorkspacesText } from "../../i18n";
import { WorkspacesHeader } from "./components/WorkspacesHeader";
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
  // `staleTime: 0` is what makes the `refetch()` below reach the network, and
  // is not an accidental opt-out of the shared 30s default. There are two
  // caches, and this number is handed to both: react-query's, whose staleness
  // `refetch()` does override, and the one inside `descriptor.fetch`
  // (`SharedFetchCache`, also 30s), which it does not — `queryFn` calls into it
  // on every refetch and only `staleTime <= 0` counts an entry as stale there.
  // Raise this and creating a workspace stops adding a row for up to 30s: the
  // effect still calls `refetch()`, and no request is made.
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

  const all = useMemo(() => data?.items ?? [], [data]);

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
      requestWorkspace(bridge, { id: row.id, name: row.name }, organization.id);
    },
    [bridge, organization.id],
  );

  const pending = translationsPending || (isLoading && all.length === 0);

  return (
    <div className={styles.screen}>
      <WorkspacesHeader
        busy={pending}
        canCreate
        total={all.length}
        projectTotal={projectTotal}
      />

      <div className={styles.body}>
        {/* TODO: DataGrid's text search replaces this row. */}
        <div className={styles.searchRow}>
          <div className={styles.searchBox}>
            <Input
              className={styles.search}
              type="search"
              value={query}
              icon={<Search size={16} strokeWidth={1.3} />}
              placeholder={t("search_placeholder")}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("search_placeholder")}
            />
          </div>
        </div>

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
              // The organization's count, not the search's: the caption reads
              // "1-2 of 10", and passing `rows` would make it say "1-2 of 2".
              total={all.length}
              empty={
                query.trim() ? (
                  <Empty className={styles.empty}>
                    <EmptyHeader>
                      <EmptyDescription>{t("empty_search")}</EmptyDescription>
                    </EmptyHeader>
                    <EmptyActions>
                      <Button variant="link" onClick={() => setQuery("")}>
                        {t("clear_search")}
                      </Button>
                    </EmptyActions>
                  </Empty>
                ) : isError ? null : (
                  <Empty className={styles.empty}>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Folder />
                      </EmptyMedia>
                      <EmptyTitle>{t("empty_title")}</EmptyTitle>
                      <EmptyDescription>{t("empty_hint")}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )
              }
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
        <WorkspacesHeader
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
