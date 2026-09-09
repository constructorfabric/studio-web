import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const SCREEN_DOMAIN = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1';

const people = {
  id: 'ext.people',
  domain: SCREEN_DOMAIN,
  entry: 'entry.people',
  presentation: {
    label: 'People',
    icon: 'material-symbols:group',
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
    icon: 'material-symbols:extension',
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
    label: 'Organization settings',
    icon: 'material-symbols:settings',
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
    icon: 'material-symbols:folder',
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

const { mockEventBus, mockRegistry, bootstrapState, registered, mounted, level, section } =
  vi.hoisted(
  () => ({
    mockEventBus: { emit: vi.fn() },
    mockRegistry: { executeActionsChain: vi.fn() },
    bootstrapState: { status: 'ready' as 'pending' | 'ready' | 'failed' },
    registered: { value: [] as unknown[] },
    mounted: { value: [] as unknown[] },
    level: { value: 'organization' as 'organization' | 'workspace' | 'project' },
    section: { value: null as string | null },
  })
);

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFrontX: () => ({ mfeRegistry: mockRegistry }),
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ 'app/mfe-bootstrap': bootstrapState, 'app/context': { section: section.value } }),
  useDomainExtensions: () => registered.value,
  useMountedExtensions: () => mounted.value,
  eventBus: mockEventBus,
}));

vi.mock('./useScreenLevel', () => ({ useScreenLevel: () => level.value }));

import { Rail } from './Rail';

// The kit's Sidebar asks whether the viewport is mobile; jsdom has no
// matchMedia, so it gets a desktop answer here.
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

describe('Rail (the level navigation)', () => {
  beforeEach(() => {
    level.value = 'organization';
    section.value = null;
    bootstrapState.status = 'ready';
    // Deliberately out of order: the rail sorts, the registry does not.
    registered.value = [settings, connections, people, projects];
    mounted.value = [people];
    mockRegistry.executeActionsChain.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('lists the items of the level in scope, in order', () => {
    render(<Rail />);
    const labels = screen
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((text): text is string => Boolean(text));
    expect(labels.indexOf('People')).toBeLessThan(labels.indexOf('Connections'));
    expect(labels.indexOf('Connections')).toBeLessThan(labels.indexOf('Organization settings'));
  });

  it('leaves out the items of another level', () => {
    render(<Rail />);
    expect(screen.queryByText('Projects')).toBeNull();
  });

  it('draws no rule between the items: one gap, whatever the placement', () => {
    const { container } = render(<Rail />);
    expect(container.querySelectorAll('[data-orientation]').length).toBe(0);
  });

  it('mounts the chosen screen into the screen domain', () => {
    render(<Rail />);
    fireEvent.click(screen.getByText('Connections'));
    expect(mockRegistry.executeActionsChain).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({ payload: { subject: 'ext.connections' } }),
      })
    );
  });

  it('leaves the project scope when an area of this level is chosen', async () => {
    render(<Rail />);
    fireEvent.click(screen.getByText('Connections'));
    await vi.waitFor(() =>
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/project/closed')
    );
  });

  it('marks the mounted screen as the active item', () => {
    render(<Rail />);
    expect(screen.getByText('People').closest('[data-active]')).toBeTruthy();
    expect(screen.getByText('Connections').closest('[data-active]')).toBeNull();
  });

  it('is absent at a level with a single item, whose screen is the level itself', () => {
    level.value = 'workspace';
    const { container } = render(<Rail />);
    expect(container.firstChild).toBeNull();
  });

  describe('sections of one screen', () => {
    beforeEach(() => {
      level.value = 'project';
      registered.value = [overview, artifacts, people];
      mounted.value = [overview];
      section.value = 'overview';
    });

    it('relays the section instead of mounting the screen again', () => {
      render(<Rail />);
      fireEvent.click(screen.getByText('Artifacts'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/project/section', {
        section: 'artifacts',
      });
      expect(mockRegistry.executeActionsChain).not.toHaveBeenCalled();
    });

    it('does not leave the project when a section of it is chosen', () => {
      render(<Rail />);
      fireEvent.click(screen.getByText('Artifacts'));
      expect(mockEventBus.emit).not.toHaveBeenCalledWith('app/context/project/closed');
    });

    it('marks the active item by the section, since every item shares one entry', () => {
      section.value = 'artifacts';
      render(<Rail />);
      expect(screen.getByText('Artifacts').closest('[data-active]')).toBeTruthy();
      expect(screen.getByText('Overview').closest('[data-active]')).toBeNull();
    });

  });

  it('holds placeholder rows while the manifest is still in flight', () => {
    registered.value = [];
    bootstrapState.status = 'pending';
    const { container } = render(<Rail />);
    // Unknown, not empty: an empty rail would claim the level has no areas.
    expect(container.firstChild).not.toBeNull();
    expect(screen.queryByText('People')).toBeNull();
  });
});
