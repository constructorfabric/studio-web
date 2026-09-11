import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mockBootstrapMFE = vi.fn();
const mockUseFrontX = vi.fn();
const mockScreenDomain = { id: 'screen-domain' };
const mockEmit = vi.hoisted(() => vi.fn());

vi.mock('./bootstrap', () => ({
  bootstrapMFE: (...args: never[]) => mockBootstrapMFE(...args),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, never>>()),
  useFrontX: () => mockUseFrontX(),
  screenDomain: mockScreenDomain,
  eventBus: { on: vi.fn(), emit: mockEmit },
  ExtensionDomainSlot: ({
    registry,
    domainId,
    className,
    onAttached,
  }: {
    registry: { mfeRegistry: Record<string, never> } | null;
    domainId: string;
    className?: string;
    onAttached?: (root: Element) => void;
  }) => {
    // The real slot attaches the domain root and then reports it; the initial
    // mount hangs off that report, so the stub has to make it too.
    const report = (element: HTMLDivElement | null): void => {
      if (element) onAttached?.(element);
    };
    return (
      <div
        ref={report}
        data-testid="extension-domain-slot"
        data-registry-present={registry ? 'yes' : 'no'}
        data-domain-id={domainId}
        data-class-name={className}
      />
    );
  },
}));

describe('MfeScreenContainer', () => {
  let registry: {
    getMountedExtensions: ReturnType<typeof vi.fn>;
    getExtensionsForDomain: ReturnType<typeof vi.fn>;
    executeActionsChain: ReturnType<typeof vi.fn>;
  };
  let app: { mfeRegistry: typeof registry };

  beforeEach(() => {
    registry = {
      getMountedExtensions: vi.fn().mockReturnValue([]),
      getExtensionsForDomain: vi.fn().mockReturnValue([
        {
          id: 'people',
          presentation: { route: '/people', order: 30, level: 'organization' },
        },
        {
          id: 'organization',
          presentation: {
            route: '/organization',
            order: 100,
            level: 'organization',
            placement: 'settings',
          },
        },
        // The workspace level's screen: never the entry point of a session.
        { id: 'projects', presentation: { route: '/projects', order: 20, level: 'workspace' } },
      ]),
      executeActionsChain: vi.fn().mockResolvedValue(undefined),
    };
    app = { mfeRegistry: registry };
    mockUseFrontX.mockReturnValue(app);
    mockBootstrapMFE.mockReset();
    mockBootstrapMFE.mockResolvedValue(undefined);
    mockEmit.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing while bootstrap is pending', async () => {
    let resolveBootstrap: (() => void) | undefined;
    mockBootstrapMFE.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveBootstrap = resolve;
        }),
    );
    const { MfeScreenContainer } = await import('./MfeScreenContainer');

    render(<MfeScreenContainer />);

    expect(screen.queryByTestId('extension-domain-slot')).toBeNull();

    resolveBootstrap?.();
  });

  it('bootstraps the MFE runtime only once across re-renders', async () => {
    const { MfeScreenContainer } = await import('./MfeScreenContainer');

    const { rerender } = render(<MfeScreenContainer />);
    rerender(<MfeScreenContainer />);
    rerender(<MfeScreenContainer />);

    await waitFor(() => {
      expect(mockBootstrapMFE).toHaveBeenCalledTimes(1);
    });
    expect(mockBootstrapMFE).toHaveBeenCalledWith(app);
  });

  it('renders the screen-domain ExtensionDomainSlot after bootstrap succeeds', async () => {
    const { MfeScreenContainer } = await import('./MfeScreenContainer');

    render(<MfeScreenContainer />);

    await waitFor(() => {
      const slot = screen.getByTestId('extension-domain-slot');
      expect(slot.dataset.domainId).toBe(mockScreenDomain.id);
      expect(slot.dataset.registryPresent).toBe('yes');
      expect(slot.dataset.className).toContain('h-full');
    });
  });

  // Asking for the level rather than mounting a screen of its own choosing is
  // what keeps one way into a screen: which item the level opens on is
  // `resolveLevelMenu`'s to decide, and the section that item names is written
  // by the same handler every other navigation goes through.
  it('asks for the outermost level once the slot reports its root', async () => {
    const { MfeScreenContainer } = await import('./MfeScreenContainer');

    render(<MfeScreenContainer />);

    await waitFor(() => {
      expect(mockEmit).toHaveBeenCalledWith('app/context/level/requested', {
        level: 'organization',
      });
    });
  });

  // The sequence StrictMode produces: a mount starts against the root, the slot
  // detaches and re-attaches, and the doomed first mount is still in flight.
  // Without the release the guard in mountScreen swallows the next one and the
  // session opens on a blank screen with no active rail item.
  it('frees a doomed mount still in flight when a fresh root arrives', async () => {
    const { mountScreen, isMountingScreen } = await import('./mountScreen');
    registry.executeActionsChain.mockReturnValue(new Promise<void>(() => {}));
    void mountScreen(registry as never, {
      id: 'people',
      presentation: { route: '/people', order: 30, level: 'organization' },
    } as never);
    expect(isMountingScreen(registry as never)).toBe(true);

    const { MfeScreenContainer } = await import('./MfeScreenContainer');
    render(<MfeScreenContainer />);

    await waitFor(() => {
      expect(mockEmit).toHaveBeenCalledWith('app/context/level/requested', {
        level: 'organization',
      });
    });
    expect(isMountingScreen(registry as never)).toBe(false);
  });

  it('says the screens could not be loaded when bootstrap rejects', async () => {
    const error = new Error('boom');
    mockBootstrapMFE.mockRejectedValue(error);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { MfeScreenContainer } = await import('./MfeScreenContainer');
    render(<MfeScreenContainer />);

    // A blank content area is the one thing this must not be: the shell has no
    // other place left to report a manifest that did not load.
    const note = await screen.findByRole('alert');
    expect(note.textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByTestId('extension-domain-slot')).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('says nothing of the sort while bootstrap is still pending', async () => {
    mockBootstrapMFE.mockImplementation(() => new Promise<void>(() => {}));
    const { MfeScreenContainer } = await import('./MfeScreenContainer');

    render(<MfeScreenContainer />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('extension-domain-slot')).toBeNull();
  });
});
