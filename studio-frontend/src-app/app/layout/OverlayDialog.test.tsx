import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const OVERLAY_DOMAIN = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.overlay.v1';

const { mockRegistry, mounted } = vi.hoisted(() => ({
  mockRegistry: { executeActionsChain: vi.fn() },
  mounted: { value: [] as { id: string; presentation?: { label?: string } }[] },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFrontX: () => ({ mfeRegistry: mockRegistry }),
  useMountedExtensions: () => mounted.value,
  // Stand-in for the real slot: this suite is about whether the slot is in the
  // tree and when, not about what the mounter does with it.
  ExtensionDomainSlot: () => <div data-testid="overlay-slot" />,
}));

import { OverlayDialog } from './OverlayDialog';

describe('OverlayDialog', () => {
  beforeEach(() => {
    mounted.value = [];
    mockRegistry.executeActionsChain.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  /**
   * The regression this suite exists for: the slot used to render only while the
   * dialog was visible, and visibility is derived from something being mounted.
   * The mounter had no element to attach to, so clicking search did nothing at
   * all — no error, no dialog.
   */
  it('keeps the overlay slot in the tree while closed, so the mounter has a container', () => {
    render(<OverlayDialog />);
    expect(screen.getByTestId('overlay-slot')).toBeTruthy();
  });

  it('hides the frame while nothing is mounted', () => {
    const { container } = render(<OverlayDialog />);
    expect((container.firstChild as HTMLElement).className).toContain('hidden');
    expect((container.firstChild as HTMLElement).getAttribute('aria-hidden')).toBe('true');
  });

  it('names the dialog after the mounted extension, not after search', () => {
    mounted.value = [
      { id: 'ext.search', presentation: { label: 'Search Constructor Studio' } },
    ];
    render(<OverlayDialog />);
    expect((screen.getByRole('dialog') as HTMLElement).getAttribute('aria-label')).toBe(
      'Search Constructor Studio'
    );
  });

  it('names the close control after the mounted extension too', () => {
    mounted.value = [{ id: 'ext.search', presentation: { label: 'Search Constructor Studio' } }];
    render(<OverlayDialog />);
    expect(screen.getByLabelText('Close Search Constructor Studio')).toBeTruthy();
  });

  /**
   * The frame shrink-wraps whatever mounted into it: an overlay MFE states its
   * own footprint in its own stylesheet. If a size ever reappears here, a second
   * overlay can no longer be a different size without editing the shell.
   */
  it('states no size of its own, only viewport clamps', () => {
    mounted.value = [{ id: 'ext.search', presentation: { label: 'Search' } }];
    render(<OverlayDialog />);
    const card = screen.getByRole('dialog') as HTMLElement;
    const sized = Array.from(card.classList).filter(
      (c) => /^[wh]-/.test(c) && !c.startsWith('w-fit') && !c.startsWith('h-fit')
    );
    expect(sized).toEqual([]);
    expect(card.getAttribute('style')).toBeNull();
  });

  describe('dismissal', () => {
    beforeEach(() => {
      mounted.value = [{ id: 'ext.search' }];
    });

    it('unmounts the open extension, naming it as the subject', async () => {
      render(<OverlayDialog />);
      fireEvent.click(screen.getByLabelText('Close'));
      await vi.waitFor(() =>
        expect(mockRegistry.executeActionsChain).toHaveBeenCalledWith(
          expect.objectContaining({
            action: expect.objectContaining({
              target: OVERLAY_DOMAIN,
              payload: { subject: 'ext.search' },
            }),
          })
        )
      );
    });

    it('closes on Escape', async () => {
      render(<OverlayDialog />);
      fireEvent.keyDown(document, { key: 'Escape' });
      await vi.waitFor(() => expect(mockRegistry.executeActionsChain).toHaveBeenCalled());
    });

    it('does nothing on Escape while closed', () => {
      mounted.value = [];
      render(<OverlayDialog />);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(mockRegistry.executeActionsChain).not.toHaveBeenCalled();
    });
  });
});
