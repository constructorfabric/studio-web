import {
  AccountsApiService,
  CHILDREN_PAGE_LIMIT,
  type Page,
  type Tenant,
} from '@constructor-studio/mfe-shared';
import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import { apiRegistry, useApiQuery } from '@gears-frontx/react';
import {
  OrganizationProvider,
  WorkspaceProvider,
  type OrganizationRef,
  type WorkspaceRef,
  useOrganization,
  useWorkspace,
} from '@constructor-studio/mfe-shared';

/** The projects of the workspace in scope — one request, one flat list. */

export interface WorkspaceProjects {
  org: OrganizationRef | null;
  workspace: WorkspaceRef | null;
  projects: Tenant[];
  loading: boolean;
  failed: boolean;
}

const EMPTY: WorkspaceProjects = {
  org: null,
  workspace: null,
  projects: [],
  loading: true,
  failed: false,
};

const ProjectsContext = createContext<WorkspaceProjects>(EMPTY);

export function useWorkspaceProjects(): WorkspaceProjects {
  return useContext(ProjectsContext);
}

function warnIfTruncated(workspaceId: string, page: Page<Tenant>): void {
  if (!page.page_info?.next_cursor) return;
  console.warn(
    `[projects-mfe] workspace ${workspaceId} has more than ${CHILDREN_PAGE_LIMIT} projects; ` +
      'only the first page is shown.'
  );
}

// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-list-root:p1
const WithWorkspace: React.FC<{
  org: OrganizationRef | null;
  workspace: WorkspaceRef;
  children: ReactNode;
}> = ({ org, workspace, children }) => {
  const accounts = apiRegistry.getService(AccountsApiService);
  const { data, isLoading, isError } = useApiQuery(
    accounts.getProjects({ parentId: workspace.id })
  );

  const value = useMemo<WorkspaceProjects>(() => {
    if (data) warnIfTruncated(workspace.id, data);
    return {
      org,
      workspace,
      projects: data?.items ?? [],
      loading: isLoading,
      failed: isError,
    };
  }, [org, workspace, data, isLoading, isError]);

  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
};

const ForWorkspace: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { org, loading: orgLoading, failed } = useOrganization();
  const { workspace, loading: workspaceLoading } = useWorkspace();

  if (!workspace) {
    return (
      <ProjectsContext.Provider
        value={{ ...EMPTY, org, loading: orgLoading || workspaceLoading, failed }}
      >
        {children}
      </ProjectsContext.Provider>
    );
  }
  return (
    <WithWorkspace org={org} workspace={workspace}>
      {children}
    </WithWorkspace>
  );
};

export const WorkspaceProjectsProvider: React.FC<{ children: ReactNode }> = ({ children }) => (
  <ForWorkspace>{children}</ForWorkspace>
);

export const StudioScopeProvider: React.FC<{ children: ReactNode }> = ({ children }) => (
  <OrganizationProvider>
    <WorkspaceProvider>{children}</WorkspaceProvider>
  </OrganizationProvider>
);
