import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const OVERLAY_DOMAIN = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.overlay.v1';

/** Overlay extensions declare presentation too; the shell matches on the route. */
const searchOverlay = {
  id: 'ext.search.overlay',
  domain: OVERLAY_DOMAIN,
  entry: 'entry.search',
  presentation: {
    label: 'Search Constructor Studio',
    icon: 'material-symbols:search',
    route: '/search',
  },
};

const { mockEventBus, mockDispatch, mockRegistry, overlayExtensions } = vi.hoisted(() => ({
  mockEventBus: { emit: vi.fn() },
  mockDispatch: vi.fn(),
  mockRegistry: { executeActionsChain: vi.fn() },
  overlayExtensions: { value: [] as unknown[] },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFrontX: () => ({ mfeRegistry: mockRegistry }),
  useAppDispatch: () => mockDispatch,
  useAppSelector: () => undefined,
  useDomainExtensions: () => overlayExtensions.value,
  eventBus: mockEventBus,
}));

// The right-hand cluster is covered by its own suites; the top bar's job here is
// composition, so identity is stubbed out to keep this focused.
vi.mock('./UserMenu', () => ({ UserMenu: () => <div data-testid="user-menu" /> }));
vi.mock('./ContextSwitcher', () => ({
  ContextSwitcher: () => <div data-testid="context-switcher" />,
}));

import { Header } from './Header';

describe('Header (global top bar)', () => {
  beforeEach(() => {
    overlayExtensions.value = [];
    mockRegistry.executeActionsChain.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('names the product', () => {
    render(<Header />);
    expect(screen.getByText('Constructor Studio')).toBeTruthy();
  });

  it('opens the navigation drawer from the burger', () => {
    render(<Header />);
    fireEvent.click(screen.getByLabelText('Open global navigation'));
    // `collapsed: false` is the open drawer — see Menu.tsx.
    expect(mockEventBus.emit).toHaveBeenCalledWith('layout/menu/collapsed', { collapsed: false });
  });

  it('no longer titles the mounted screen — the MFE owns its own heading', () => {
    render(<Header />);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('carries the context slot and the identity control', () => {
    render(<Header />);
    expect(screen.getByTestId('context-switcher')).toBeTruthy();
    expect(screen.getByTestId('user-menu')).toBeTruthy();
  });

  describe('search', () => {
    it('is inert while no overlay extension claims the route', () => {
      render(<Header />);
      // 'Search' is the shell naming the empty place, not the MFE's own label.
      const button = screen.getByLabelText('Search');
      // aria-disabled rather than the native attribute: the kit dims a natively
      // disabled button to 42% opacity, which turned the muted circle into a
      // different colour instead of the same control in another state.
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.hasAttribute('disabled')).toBe(false);
      fireEvent.click(button);
      expect(mockRegistry.executeActionsChain).not.toHaveBeenCalled();
    });

    it('takes its name from the extension that claims the route, not from the shell', () => {
      overlayExtensions.value = [searchOverlay];
      render(<Header />);
      // Renaming search-mfe renames this control; nothing here restates its name.
      expect(screen.getByLabelText('Search Constructor Studio')).toBeTruthy();
      expect(screen.queryByLabelText('Search')).toBeNull();
    });

    it('mounts the extension that claims /search into the overlay domain', async () => {
      overlayExtensions.value = [searchOverlay];
      render(<Header />);
      fireEvent.click(screen.getByLabelText('Search Constructor Studio'));
      await vi.waitFor(() =>
        expect(mockRegistry.executeActionsChain).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              target: OVERLAY_DOMAIN,
              payload: { subject: 'ext.search.overlay' },
            }),
          })
        )
      );
    });
  });

  describe('inbox', () => {
    it('is present but inert: the shell holds the place, the MFE does not exist yet', () => {
      render(<Header />);
      const button = screen.getByLabelText('Inbox');
      expect(button.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(button);
      expect(mockRegistry.executeActionsChain).not.toHaveBeenCalled();
    });

    it('keeps the same circle as search, so an unavailable state is not a different colour', () => {
      render(<Header />);
      const inbox = screen.getByLabelText('Inbox');
      const search = screen.getByLabelText('Search');
      // Both carry the surface knob; only the glyph colour differs by state.
      for (const button of [inbox, search]) {
        expect(button.className).toContain('[--button-bg:var(--muted)]');
        expect(button.hasAttribute('disabled')).toBe(false);
      }
    });

    it('claims no unread messages while there is no inbox to count them', () => {
      const { container } = render(<Header />);
      // A hardcoded indicator would announce messages nobody has.
      expect(container.querySelector('.bg-primary')).toBeNull();
    });
  });
});
