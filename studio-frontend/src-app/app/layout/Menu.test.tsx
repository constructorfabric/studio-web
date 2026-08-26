import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const SCREEN_DOMAIN = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1';

const projects = {
  id: 'ext.projects',
  domain: SCREEN_DOMAIN,
  entry: 'entry.projects',
  presentation: { label: 'Projects', icon: 'lucide:folder-kanban', route: '/projects', order: 20 },
};
const people = {
  id: 'ext.people',
  domain: SCREEN_DOMAIN,
  entry: 'entry.people',
  presentation: { label: 'People', icon: 'lucide:users', route: '/people', order: 30 },
};
/** Order 100+ is the tenant band — the drawer rules a line before it. */
const organization = {
  id: 'ext.organization',
  domain: SCREEN_DOMAIN,
  entry: 'entry.organization',
  presentation: {
    label: 'My Organization',
    icon: 'material-symbols:domain',
    route: '/organization',
    order: 100,
  },
};

const { mockEventBus, mockRegistry, menuState, bootstrapState, registered, mounted } = vi.hoisted(
  () => ({
    mockEventBus: { emit: vi.fn() },
    mockRegistry: { getExtensionsForDomain: vi.fn(), executeActionsChain: vi.fn() },
    menuState: { collapsed: false, items: [], visible: true },
    bootstrapState: { status: 'ready' as 'pending' | 'ready' | 'failed' },
    registered: { value: [] as unknown[] },
    mounted: { value: [] as unknown[] },
  })
);

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFrontX: () => ({ mfeRegistry: mockRegistry }),
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      'layout/menu': menuState,
      'app/mfe-bootstrap': bootstrapState,
    }),
  useDomainExtensions: () => registered.value,
  useMountedExtensions: () => mounted.value,
  eventBus: mockEventBus,
}));

import { Menu } from './Menu';

describe('Menu (global navigation drawer)', () => {
  beforeEach(() => {
    // `collapsed: false` is the OPEN drawer — see Menu.tsx on why the closed
    // state rides on the framework's existing collapsed flag.
    menuState.collapsed = false;
    mounted.value = [projects];
    bootstrapState.status = 'ready';
    // Deliberately out of order: the drawer sorts by presentation.order, the
    // registry does not.
    registered.value = [organization, people, projects];
    mockRegistry.executeActionsChain.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('open and closed', () => {
    it('renders nothing while closed, reserving no space for itself', () => {
      menuState.collapsed = true;
      const { container } = render(<Menu />);
      expect(container.firstChild).toBeNull();
    });

    it('renders the panel and the brand when open', () => {
      render(<Menu />);
      expect(screen.getByText('Constructor Studio')).toBeTruthy();
    });

    // Two controls carry the label, in DOM order: the scrim, then the panel's
    // own close button. Both must close, so both are exercised.
    it.each([
      ['scrim', 0],
      ['panel close control', 1],
    ])('closes on the %s', (_name, index) => {
      render(<Menu />);
      const closers = screen.getAllByLabelText('Close global navigation');
      expect(closers.length).toBe(2);
      fireEvent.click(closers[index]);
      expect(mockEventBus.emit).toHaveBeenCalledWith('layout/menu/collapsed', { collapsed: true });
    });

    it('closes on Escape', () => {
      render(<Menu />);
      fireEvent.keyDown(screen.getAllByLabelText('Close global navigation')[0], { key: 'Escape' });
      expect(mockEventBus.emit).toHaveBeenCalledWith('layout/menu/collapsed', { collapsed: true });
    });
  });

  describe('screen items', () => {
    it('renders one item per screen extension, ordered by presentation.order', () => {
      render(<Menu />);
      const labels = screen
        .getAllByRole('button')
        .map((button) => button.textContent)
        .filter((text): text is string => Boolean(text));
      expect(labels.indexOf('Projects')).toBeLessThan(labels.indexOf('People'));
      expect(labels.indexOf('People')).toBeLessThan(labels.indexOf('My Organization'));
    });

    it('mounts the clicked screen into the screen domain', () => {
      render(<Menu />);
      fireEvent.click(screen.getByText('Projects'));
      expect(mockRegistry.executeActionsChain).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({ payload: { subject: 'ext.projects' } }),
        })
      );
    });

    it('leaves the project scope when a global area is chosen', async () => {
      render(<Menu />);
      fireEvent.click(screen.getByText('People'));
      // Choosing a global area means the session is no longer inside a project;
      // the shell announces that itself rather than waiting for an MFE.
      await vi.waitFor(() =>
        expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/project/closed')
      );
    });

    it('closes itself after a selection, since it covers the screen it mounts', async () => {
      render(<Menu />);
      fireEvent.click(screen.getByText('Projects'));
      await vi.waitFor(() =>
        expect(mockEventBus.emit).toHaveBeenCalledWith('layout/menu/collapsed', { collapsed: true })
      );
    });
  });

  describe('tenant band', () => {
    it('rules a separator where the order crosses into the tenant band', () => {
      const { container } = render(<Menu />);
      expect(container.querySelectorAll('[role="separator"]').length).toBe(1);
    });

    it('draws no separator when nothing sits in the tenant band', () => {
      registered.value = [projects, people];
      const { container } = render(<Menu />);
      expect(container.querySelectorAll('[role="separator"]').length).toBe(0);
    });
  });

  describe('empty states', () => {
    it('shows placeholder rows while the manifest is still in flight', () => {
      registered.value = [];
      bootstrapState.status = 'pending';
      render(<Menu />);
      // Unknown, not empty: the hint would otherwise flash and be replaced.
      expect(screen.queryByText(/No screens yet/)).toBeNull();
    });

    it('explains an empty registry once bootstrap has finished', () => {
      registered.value = [];
      bootstrapState.status = 'ready';
      render(<Menu />);
      expect(screen.getByText(/No screens yet/)).toBeTruthy();
    });

    it('reports a failed manifest fetch', () => {
      registered.value = [];
      bootstrapState.status = 'failed';
      render(<Menu />);
      expect(screen.getByText(/Screens could not be loaded/)).toBeTruthy();
    });
  });
});
