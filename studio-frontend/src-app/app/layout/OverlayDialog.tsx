/**
 * OverlayDialog Component
 *
 * The frame any overlay extension opens in: a scrim over everything and a card
 * holding the overlay domain's slot. The shell owns the frame, the keyboard
 * affordances and the dismissal; the content is whichever MFE mounted into the
 * overlay domain — global search today.
 *
 * The shell does not know the card's size. The card shrink-wraps whatever the
 * mounted extension draws, and the only dimensions stated here are viewport
 * clamps — that is safety (nothing may render wider than the screen), not
 * design. A second overlay with a different footprint therefore needs no change
 * in this file: it states its own size in its own stylesheet.
 *
 * Placement stays the shell's single decision, not a per-extension knob:
 * overlays are centred in the viewport, so the product looks like one product.
 * (They used to open from the top — `items-start` plus a 7rem top margin.)
 *
 * TODO: replace this component with ui-kit's Dialog after adding changes
 * ui-kit's Dialog cannot host the slot as shipped: `DialogContent` forwards only
 * `container` to Base UI's Portal, and the Portal drops its whole subtree while
 * closed (`shouldRender = mounted || keepMounted`), taking the slot with it. Base
 * UI itself is fine — its Popup always renders and merely gets `hidden`, which is
 * the trick used here.
 */

import React, { useCallback, useEffect } from 'react';
import { X } from 'lucide-react';
import {
  useFrontX,
  useMountedExtensions,
  ExtensionDomainSlot,
  overlayDomain,
  FRONTX_ACTION_UNMOUNT_EXT,
} from '@gears-frontx/react';
import type { OverlayExtension } from './overlayExtension';

export const OverlayDialog: React.FC = () => {
  const app = useFrontX();
  // Visibility is derived, not stored: the dialog is open exactly while
  // something is mounted in the overlay domain. Deliberately NOT the
  // `layout/overlay` slice — the generic `Overlay` component already renders a
  // blurred full-screen veil off that same flag, so sharing it would stack two
  // overlays on one state.
  const mounted = useMountedExtensions(overlayDomain.id) as OverlayExtension[];
  const openExtension = mounted[0];
  const openExtensionId = openExtension?.id;
  const visible = Boolean(openExtensionId);
  const label = openExtension?.presentation?.label;

  const close = useCallback(async () => {
    if (!openExtensionId) return;
    await app.mfeRegistry?.executeActionsChain({
      action: {
        type: FRONTX_ACTION_UNMOUNT_EXT,
        target: overlayDomain.id,
        payload: { subject: openExtensionId },
      },
    });
  }, [app.mfeRegistry, openExtensionId]);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible, close]);

  return (
    <div
      className={visible ? 'fixed inset-0 z-modal flex items-center justify-center' : 'hidden'}
      aria-hidden={!visible}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => void close()}
        className="absolute inset-0 cursor-default bg-[rgb(15_18_24_/_0.48)]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative flex h-fit w-fit max-h-[calc(100vh-8rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg"
      >
        {app.mfeRegistry && (
          <ExtensionDomainSlot
            registry={app.mfeRegistry}
            domainId={overlayDomain.id}
            className="min-h-0 overflow-y-auto"
          />
        )}
        <button
          type="button"
          aria-label={label ? `Close ${label}` : 'Close'}
          title="Close"
          onClick={() => void close()}
          className="absolute right-4 top-4 grid size-7 place-items-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

OverlayDialog.displayName = 'OverlayDialog';
