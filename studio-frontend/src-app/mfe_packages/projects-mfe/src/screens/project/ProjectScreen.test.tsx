import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_SECTIONS, type ProjectSection } from '../../slices/navSlice';

/** The header's actions belong to the open section (DoD `...-sources-connect-overlay`). */

const { nav, project, openSourcesConnect } = vi.hoisted(() => ({
  nav: { section: 'overview' as string },
  project: { current: { data: { id: 'p-1', name: 'Billing' } as unknown, isLoading: false, isError: false } },
  openSourcesConnect: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => ({ getTenant: () => ({}) }) },
  useApiQuery: () => project.current,
  useAppSelector: () => nav.section,
  useAppDispatch: () => vi.fn(),
  useMfeBridge: () => null,
}));

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useOrganization: () => ({ org: null, loading: false, failed: false }),
  useWorkspace: () => ({ workspace: null, loading: false, failed: false }),
}));

vi.mock('../../i18n', () => {
  const text = () => (key: string) => key;
  const loaded = () => ({ isLoaded: true, error: null });
  return {
    useProjectText: text,
    useSourcesText: text,
    useProjectScreenTranslations: loaded,
    useSourcesSectionTranslations: loaded,
  };
});

vi.mock('../../shared/useArtifacts', () => ({
  useArtifactCount: () => ({ total: 0, sources: [], loading: false, failed: false }),
}));
vi.mock('../../shared/useArtifactImport', () => ({ useArtifactImport: vi.fn() }));
vi.mock('../../shared/useSourcesSync', () => ({ useSourcesSync: vi.fn() }));
vi.mock('../../actions/sourcesConnectActions', () => ({ openSourcesConnect }));
vi.mock('./sections/ArtifactsSection', () => ({ ArtifactsSection: () => null }));
vi.mock('./sections/specs/SpecsSection', () => ({ SpecsSection: () => null }));
vi.mock('./sections/specs/SpecsActions', () => ({
  SpecsActions: ({ projectId, projectName }: { projectId: string; projectName: string }) => (
    <button type="button">{`check ${projectId} ${projectName}`}</button>
  ),
}));
vi.mock('./sections/sources/SourcesSection', () => ({ SourcesSection: () => null }));
vi.mock('./sections/PlaceholderSection', () => ({ PlaceholderSection: () => null }));
vi.mock('./upload/UploadDocumentsButton', () => ({
  UploadDocumentsButton: ({ projectId }: { projectId: string }) => (
    <button type="button">{`upload ${projectId}`}</button>
  ),
}));

import { ProjectScreen } from './ProjectScreen';

const connectSource = () => screen.queryByRole('button', { name: 'connect_source' });

beforeEach(() => {
  openSourcesConnect.mockClear();
  project.current = { data: { id: 'p-1', name: 'Billing' }, isLoading: false, isError: false };
});

describe('the project header', () => {
  it('offers Connect source in Sources, which opens the dialog', () => {
    nav.section = 'sources';
    render(<ProjectScreen projectId="p-1" />);

    fireEvent.click(connectSource()!);
    expect(openSourcesConnect).toHaveBeenCalledTimes(1);
  });

  it.each(PROJECT_SECTIONS.filter((section): section is ProjectSection => section !== 'sources'))(
    'offers no Connect source in %s',
    (section) => {
      nav.section = section;
      render(<ProjectScreen projectId="p-1" />);

      expect(connectSource()).toBeNull();
    }
  );

  it('offers Upload documents in Artifacts, for the open project', () => {
    nav.section = 'artifacts';
    render(<ProjectScreen projectId="p-1" />);

    expect(screen.getByRole('button', { name: 'upload p-1' })).toBeTruthy();
  });

  it('offers Check in Specs, for the open project', () => {
    nav.section = 'specs';
    render(<ProjectScreen projectId="p-1" />);

    expect(screen.getByRole('button', { name: 'check p-1 Billing' })).toBeTruthy();
    expect(connectSource()).toBeNull();
  });

  it('offers nothing while the project loads or when it cannot be read', () => {
    nav.section = 'sources';
    project.current = { data: undefined, isLoading: true, isError: false };
    const { unmount } = render(<ProjectScreen projectId="p-1" />);
    expect(connectSource()).toBeNull();
    unmount();

    project.current = { data: undefined, isLoading: false, isError: true };
    render(<ProjectScreen projectId="p-1" />);
    expect(connectSource()).toBeNull();
  });
});
