/**
 * Header Component — the global top bar.
 *
 * One 56px row across the whole viewport, above everything the MFEs draw. It
 * carries what used to be spread between a permanent left column and a screen
 * title: the control that opens the navigation drawer, the product name, the
 * context the session is in, and the session's own affordances (search, inbox,
 * identity) on the right.
 *
 * The screen title left with the left column. A mounted MFE owns its whole
 * area now, heading included, so the shell no longer titles it.
 */

import React, { useCallback } from 'react';
import {
  useFrontX,
  useDomainExtensions,
  eventBus,
  overlayDomain,
  FRONTX_ACTION_MOUNT_EXT,
} from '@gears-frontx/react';
import { Separator } from '@gears-frontx/ui-kit/separator';
import { Button } from '@gears-frontx/ui-kit/button';
import { Icon } from '@iconify/react';
import { cn } from '@/app/lib/utils';
import type { OverlayExtension } from './overlayExtension';
import { ContextSwitcher } from './ContextSwitcher';
import { UserMenu } from './UserMenu';

export interface HeaderProps {
  children?: React.ReactNode;
}

/**
 * One 36px round control in the right-hand cluster.
 *
 * The kit's Button carries the geometry through its own tokens: `size="default"`
 * is `--control-height-md` (36px) and, with an `icon` and no children, it gets
 * `data-icon-only` → `aspect-ratio: 1`, so it is square without a width being
 * stated here. `variant="ghost"` also sets `color: var(--muted-foreground)` on
 * the button, which is what makes the glyph muted — the icon body paints from
 * `currentColor`, so the colour comes from the control rather than from a class
 * on the icon.
 */
const IconPill: React.FC<{
  icon: string;
  label: string;
  /** Draws the unread indicator over the icon's top-right corner. */
  unread?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}> = ({ icon, label, unread = false, disabled = false, onClick }) => (
  <span className="relative inline-flex">
    <Button
      variant="ghost"
      aria-label={label}
      title={label}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      icon={<Icon icon={icon} />}
      className={cn(
        'rounded-full [--button-bg:var(--muted)] [--icon-size-sm:1.125rem]',
        disabled
          ? 'cursor-default [--button-fg:color-mix(in_oklab,var(--muted-foreground)_55%,transparent)]'
          : 'hover:[--button-fg:var(--foreground)]'
      )}
    />
    {unread && (
      // 6px dot in an 8px optical box, overlapping the icon corner, with a
      // hairline in the button's own surface colour so it reads as separate
      // from the glyph rather than part of it. Outside the Button on purpose:
      // children would turn off its icon-only squaring.
      <span className="pointer-events-none absolute right-0.5 top-px grid size-2 place-items-center">
        <span className="size-1.5 rounded-full bg-primary ring-1 ring-muted/50" />
      </span>
    )}
  </span>
);

export const Header: React.FC<HeaderProps> = ({ children }) => {
  const { mfeRegistry } = useFrontX();

  // Registry-driven, like the drawer: the shell mounts whichever overlay
  // extension claims the route, so no MFE id is written into the shell.
  const overlayExtensions = useDomainExtensions(overlayDomain.id) as OverlayExtension[];
  const searchExtension = overlayExtensions.find((ext) => ext.presentation?.route === '/search');
  // TODO: inbox is planned as a full-screen screen-domain MFE, not an overlay
  const inboxExtension = overlayExtensions.find((ext) => ext.presentation?.route === '/inbox');

  const openDrawer = useCallback(() => {
    // `collapsed` is the drawer's closed state — see Menu.tsx.
    eventBus.emit('layout/menu/collapsed', { collapsed: false });
  }, []);

  // Mounting is all it takes: OverlayDialog derives its own visibility from
  // whether the overlay domain has something mounted.
  const openOverlayExtension = useCallback(
    async (extensionId: string) => {
      if (!mfeRegistry) return;
      await mfeRegistry.executeActionsChain({
        action: {
          type: FRONTX_ACTION_MOUNT_EXT,
          target: overlayDomain.id,
          payload: { subject: extensionId },
        },
      });
    },
    [mfeRegistry]
  );

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-border bg-card pl-2 pr-4">
      {/* 40px with a 20px glyph is exactly the kit's `lg`: --control-height-lg
          and, at that size, --icon-size-md. Only the corner radius differs from
          the kit's default. */}
      <Button
        variant="ghost"
        size="lg"
        aria-label="Open global navigation"
        onClick={openDrawer}
        icon={<Icon icon="material-symbols:menu" />}
        className="rounded-lg hover:[--button-bg:var(--muted)] hover:[--button-fg:var(--foreground)]"
      />

      <span className="ml-3 whitespace-nowrap text-[16px] font-semibold leading-6 text-foreground">
        Constructor Studio
      </span>

      {/* align-self: stretch on the kit's vertical separator makes this the
          full 56px rule the mockup draws, without pinning a height here. */}
      <Separator orientation="vertical" className="ml-4" />

      <div className="ml-6 min-w-0">
        <ContextSwitcher />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* Whoever claims the route names and draws its own control — rename the
            MFE and the tooltip follows. The literals below name the *place*, and
            only ever show while nothing claims it. */}
        <IconPill
          icon={searchExtension?.presentation?.icon ?? 'material-symbols:search'}
          label={searchExtension?.presentation?.label ?? 'Search'}
          disabled={!searchExtension}
          onClick={
            searchExtension ? () => void openOverlayExtension(searchExtension.id) : undefined
          }
        />
        {/* No inbox MFE is registered yet, so this stays inert and lights up as
            soon as one claims the /inbox route.
            TODO: drive `unread` from the inbox MFE's own state once it exists —
            a hardcoded dot would claim messages nobody has. */}
        <IconPill
          icon={inboxExtension?.presentation?.icon ?? 'material-symbols:inbox'}
          label={inboxExtension?.presentation?.label ?? 'Inbox'}
          disabled={!inboxExtension}
          onClick={inboxExtension ? () => void openOverlayExtension(inboxExtension.id) : undefined}
        />
        <UserMenu />
      </div>

      {children}
    </header>
  );
};

Header.displayName = 'Header';
