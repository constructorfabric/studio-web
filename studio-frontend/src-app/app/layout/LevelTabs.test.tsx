import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const SCREEN_DOMAIN = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1';

const people = {
  id: 'ext.people',
  domain: SCREEN_DOMAIN,
  entry: 'entry.people',
  presentation: {
    label: 'People',
    icon: 'lucide:users',
    route: '/people',
    order: 30,
    level: 'organization',
  },
};
const connections = {
  id: 'ext.connections',
  domain: SCREEN_DOMAIN,
  entry: 'entry.connections',
  presentation: {
    label: 'Connections',
    icon: 'lucide:plug',
    route: '/connections',
    order: 40,
    level: 'organization',
  },
};
const settings = {
  id: 'ext.organization',
  domain: SCREEN_DOMAIN,
  entry: 'entry.organization',
  presentation: {
    label: 'Settings',
    icon: 'lucide:settings',
    route: '/organization',
    order: 100,
    level: 'organization',
    placement: 'settings',
  },
};
const projects = {
  id: 'ext.projects',
  domain: SCREEN_DOMAIN,
  entry: 'entry.projects',
  presentation: {
    label: 'Projects',
    icon: 'lucide:folder',
    route: '/projects',
    order: 20,
    level: 'workspace',
  },
};
const overview = {
  id: 'ext.project.overview',
  domain: SCREEN_DOMAIN,
  entry: 'entry.projects',
  presentation: {
    label: 'Overview',
    icon: 'lucide:layout-dashboard',
    route: '/projects/overview',
    order: 10,
    level: 'project',
    section: 'overview',
  },
};
const artifacts = {
  id: 'ext.project.artifacts',
  domain: SCREEN_DOMAIN,
  entry: 'entry.projects',
  presentation: {
    label: 'Artifacts',
    icon: 'lucide:file-text',
    route: '/projects/artifacts',
    order: 20,
    level: 'project',
    section: 'artifacts',
  },
};
const editor = {
  id: 'ext.space',
  domain: SCREEN_DOMAIN,
  entry: 'entry.space',
  presentation: {
    label: 'Editor',
    icon: 'lucide:file-code',
    route: '/space',
    order: 900,
    level: 'project',
    placement: 'hidden',
    parentSection: 'artifacts',
  },
};

const { mockEventBus, mockRegistry, bootstrapState, registered, mounted, level, section } =
  vi.hoisted(() => ({
    mockEventBus: { emit: vi.fn() },
    mockRegistry: { executeActionsChain: vi.fn() },
    bootstrapState: { status: 'ready' as 'pending' | 'ready' | 'failed' },
    registered: { value: [] as unknown[] },
    mounted: { value: [] as unknown[] },
    level: { value: 'organization' as 'organization' | 'workspace' | 'project' },
    section: { value: null as string | null },
  }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFrontX: () => ({ mfeRegistry: mockRegistry }),
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ 'app/mfe-bootstrap': bootstrapState, 'app/context': { section: section.value } }),
  useDomainExtensions: () => registered.value,
  eventBus: mockEventBus,
}));
vi.mock('@/app/mfe/domainOccupancy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/mfe/domainOccupancy')>()),
  useMountedExtensions: () => mounted.value,
}));

vi.mock('@/app/i18n/shellTranslations', () => ({ useShellText: () => (key: string) => key }));
vi.mock('./useScreenLevel', () => ({ useScreenLevel: () => level.value }));

import { LevelTabs } from './LevelTabs';

const tab = (name: string) => screen.getByRole('button', { name });

describe('LevelTabs (the level navigation)', () => {
  beforeEach(() => {
    level.value = 'organization';
    section.value = null;
    bootstrapState.status = 'ready';
    // Deliberately out of order: the tabs sort, the registry does not.
    registered.value = [settings, connections, people, projects];
    mounted.value = [people];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('lists the items of the level in scope, in order, settings last', () => {
    render(<LevelTabs />);
    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(['People', 'Connections', 'Settings']);
  });

  it('leaves out the items of another level', () => {
    render(<LevelTabs />);
    expect(screen.queryByText('Projects')).toBeNull();
  });

  it('is a navigation landmark', () => {
    render(<LevelTabs />);
    expect(screen.getByRole('navigation', { name: 'level_tabs' })).toBeTruthy();
  });

  // The tabs name the screen and stop there: leaving the project scope and the
  // mount itself belong to the shell, and are covered in appContextEffects.
  it('names the chosen screen to the shell', () => {
    render(<LevelTabs />);
    fireEvent.click(tab('Connections'));
    expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/screen/requested', {
      extensionId: 'ext.connections',
    });
  });

  it('mounts nothing itself', () => {
    render(<LevelTabs />);
    fireEvent.click(tab('Connections'));
    expect(mockRegistry.executeActionsChain).not.toHaveBeenCalled();
  });

  it('marks the mounted screen as the current page', () => {
    render(<LevelTabs />);
    expect(tab('People').getAttribute('aria-current')).toBe('page');
    expect(tab('Connections').getAttribute('aria-current')).toBeNull();
  });

  it('draws the row at a level with a single tab', () => {
    level.value = 'workspace';
    mounted.value = [projects];
    render(<LevelTabs />);
    expect(tab('Projects').getAttribute('aria-current')).toBe('page');
  });

  describe('sections of one screen', () => {
    beforeEach(() => {
      level.value = 'project';
      registered.value = [overview, artifacts, editor, people];
      mounted.value = [overview];
      section.value = 'overview';
    });

    // Same event for a section as for any other item: telling them apart is
    // the shell's job, since only it knows what is mounted right now.
    it('names the section the same way as any other item', () => {
      render(<LevelTabs />);
      fireEvent.click(tab('Artifacts'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/screen/requested', {
        extensionId: 'ext.project.artifacts',
      });
    });

    it('does not decide by itself that the project is being left', () => {
      render(<LevelTabs />);
      fireEvent.click(tab('Artifacts'));
      expect(mockEventBus.emit).not.toHaveBeenCalledWith('app/context/project/closed');
    });

    it('marks the active tab by the section, since every item shares one entry', () => {
      section.value = 'artifacts';
      render(<LevelTabs />);
      expect(tab('Artifacts').getAttribute('aria-current')).toBe('page');
      expect(tab('Overview').getAttribute('aria-current')).toBeNull();
    });

    it('keeps a hidden screen out of the row', () => {
      render(<LevelTabs />);
      expect(screen.queryByText('Editor')).toBeNull();
    });

    it('marks the section a mounted hidden screen belongs to', () => {
      mounted.value = [editor];
      section.value = null;
      render(<LevelTabs />);
      expect(tab('Artifacts').getAttribute('aria-current')).toBe('page');
      expect(tab('Overview').getAttribute('aria-current')).toBeNull();
    });
  });

  it('holds a placeholder while the manifest is still in flight', () => {
    registered.value = [];
    bootstrapState.status = 'pending';
    const { container } = render(<LevelTabs />);
    // Unknown, not empty: an empty row would claim the level has no sections.
    expect(container.firstChild).not.toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('is absent once a failed bootstrap leaves no items', () => {
    registered.value = [];
    bootstrapState.status = 'failed';
    const { container } = render(<LevelTabs />);
    expect(container.firstChild).toBeNull();
  });
});
