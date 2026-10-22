import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The list's header and search (DoD `...-workspace-scope-no-workspace`). */

const { list, queries, bridge, openProjectWizard } = vi.hoisted(() => ({
  list: {
    current: {
      loading: false,
      failed: false,
      org: { id: 'org-1', name: 'Acme' } as unknown,
      workspace: { id: 'ws-1', name: 'Platform' } as unknown,
      rows: [] as unknown[],
      total: 0,
    },
  },
  queries: [] as string[],
  bridge: { id: 'bridge' },
  openProjectWizard: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useMfeBridge: () => bridge,
}));

vi.mock('../../i18n', () => ({
  useProjectListText: () => (key: string) => key,
  useProjectListScreenTranslations: () => ({ isLoaded: true, error: null }),
}));

vi.mock('../../shared/useProjectList', () => ({
  useProjectList: (query: string) => {
    queries.push(query);
    return list.current;
  },
}));
vi.mock('../../shared/workspaceProjects', () => ({
  WorkspaceProjectsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../actions/wizardActions', () => ({ openProjectWizard }));
vi.mock('./components/ProjectsTable', () => ({
  ProjectsTable: ({ empty }: { empty: React.ReactNode }) => <div>{empty}</div>,
}));

import { ProjectListScreen } from './ProjectListScreen';

const newProject = () => screen.getByRole('button', { name: 'new_project' }) as HTMLButtonElement;
const search = () => screen.getByRole('searchbox', { name: 'search_placeholder' }) as HTMLInputElement;
const lastQuery = () => queries[queries.length - 1];

beforeEach(() => {
  queries.length = 0;
  openProjectWizard.mockClear();
  list.current = { ...list.current, workspace: { id: 'ws-1', name: 'Platform' }, rows: [], total: 0 };
});

describe('the projects list header', () => {
  it('disables New project and says why while no workspace is current', () => {
    list.current = { ...list.current, workspace: null };
    render(<ProjectListScreen />);

    expect(newProject().disabled).toBe(true);
    expect(newProject().getAttribute('title')).toBe('empty_no_workspace');
  });

  it('opens the wizard from New project', () => {
    render(<ProjectListScreen />);

    expect(newProject().getAttribute('title')).toBeNull();
    fireEvent.click(newProject());
    expect(openProjectWizard).toHaveBeenCalledWith(bridge);
  });
});

describe('the projects list search', () => {
  it('narrows the list by the query, and Clear search empties it', () => {
    list.current = { ...list.current, rows: [], total: 2 };
    render(<ProjectListScreen />);

    fireEvent.change(search(), { target: { value: 'bil' } });
    expect(lastQuery()).toBe('bil');

    fireEvent.click(screen.getByRole('button', { name: 'clear_search' }));
    expect(lastQuery()).toBe('');
    expect(search().value).toBe('');
  });
});
