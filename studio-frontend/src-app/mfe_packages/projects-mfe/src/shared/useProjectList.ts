import { Tenant } from '@constructor-studio/mfe-shared';
/**
 * The rows the list screen draws: the current workspace's projects, narrowed by
 * the toolbar's search and ordered by its sort.
 */

import { useMemo } from 'react';
import { tenantComparator, type ProjectSortOption } from '../model/project';
import { useWorkspaceProjects } from './workspaceProjects';

export interface ProjectListView {
  rows: Tenant[];
  loading: boolean;
  failed: boolean;
  org: ReturnType<typeof useWorkspaceProjects>['org'];
  workspace: ReturnType<typeof useWorkspaceProjects>['workspace'];
}

export function useProjectList(query: string, sort: ProjectSortOption): ProjectListView {
  const { loading, failed, org, workspace, projects } = useWorkspaceProjects();

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? projects.filter((project) => project.name.toLowerCase().includes(needle))
      : projects;
    return [...matched].sort(tenantComparator(sort));
  }, [projects, query, sort]);

  return { rows, loading, failed, org, workspace };
}
