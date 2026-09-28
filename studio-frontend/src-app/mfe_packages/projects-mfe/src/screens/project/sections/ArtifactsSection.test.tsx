import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/** The page on screen stays a page that exists. */

const { artifacts } = vi.hoisted(() => ({ artifacts: { total: 40, offsets: [] as number[] } }));

vi.mock('@gears-frontx/react', () => ({
  useFormatters: () => ({ formatRelative: () => '' }),
  useMfeBridge: () => ({}),
}));
vi.mock('@constructor-studio/mfe-shared', () => ({
  useOrganization: () => ({ org: { id: 'org-1', name: 'Acme' } }),
  useWorkspace: () => ({ workspace: null }),
}));
vi.mock('../../../i18n', () => ({
  useProjectText: () => (key: string, params?: object) =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}));
vi.mock('../../../shared/useArtifactImport', () => ({
  useArtifactImport: () => ({ canSync: false, start: () => {} }),
  useProjectImport: () => ({ phase: 'idle', repos: [] }),
}));
vi.mock('../../../shared/useArtifacts', () => ({
  ARTIFACTS_PAGE_SIZE: 18,
  useArtifacts: (_projectId: string, query: { offset: number }) => {
    artifacts.offsets.push(query.offset);
    return {
      rows: [],
      total: artifacts.total,
      projectTotal: artifacts.total,
      repositoryTotal: null,
      repositoryTotalFailed: false,
      repositories: [],
      sources: [],
      loading: false,
      refreshing: false,
      failed: false,
      refetch: () => {},
    };
  },
}));

import { ArtifactsSection } from './ArtifactsSection';

const pageButton = (index: number) =>
  screen.getByRole('button', { name: `artifacts_page {"index":${index}}` });
const requestedOffset = () => artifacts.offsets[artifacts.offsets.length - 1];

describe('artifacts section', () => {
  it('moves back to the last page when the total shrinks under the page on screen', () => {
    const { rerender } = render(<ArtifactsSection projectId="p1" />);
    fireEvent.click(pageButton(3));
    expect(requestedOffset()).toBe(36);

    artifacts.total = 20;
    rerender(<ArtifactsSection projectId="p1" />);
    expect(requestedOffset()).toBe(18);
    expect(pageButton(2).getAttribute('aria-current')).toBe('page');
  });
});
