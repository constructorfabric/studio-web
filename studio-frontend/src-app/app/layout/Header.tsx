/** Header Component — the global top bar. */

import React, { useCallback, useState } from 'react';
import {
  useFrontX,
  useDomainExtensions,
  overlayDomain,
  FRONTX_ACTION_MOUNT_EXT,
} from '@gears-frontx/react';
import { Button } from '@gears-frontx/ui-kit/button';
import { Icon } from '@iconify/react';
import { cn } from '@/app/lib/utils';
import type { OverlayExtension } from './overlayExtension';
import { ContextChain } from './ContextChain';
import { UserMenu } from './UserMenu';

export interface HeaderProps {
  children?: React.ReactNode;
}

const IconPill: React.FC<{
  icon: string;
  label: string;
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
      <span className="pointer-events-none absolute right-0.5 top-px grid size-2 place-items-center">
        <span className="size-1.5 rounded-full bg-primary ring-1 ring-muted/50" />
      </span>
    )}
  </span>
);

export const Header: React.FC<HeaderProps> = ({ children }) => {
  const { mfeRegistry } = useFrontX();

  const overlayExtensions = useDomainExtensions(overlayDomain.id) as OverlayExtension[];
  const searchExtension = overlayExtensions.find((ext) => ext.presentation?.route === '/search');
  // TODO: inbox is planned as a full-screen screen-domain MFE, not an overlay
  const inboxExtension = overlayExtensions.find((ext) => ext.presentation?.route === '/inbox');

  const [mounting, setMounting] = useState(false);

  const openOverlayExtension = useCallback(
    async (extensionId: string) => {
      if (!mfeRegistry || mounting) return;
      setMounting(true);
      try {
        await mfeRegistry.executeActionsChain({
          action: {
            type: FRONTX_ACTION_MOUNT_EXT,
            target: overlayDomain.id,
            payload: { subject: extensionId },
          },
        });
      } finally {
        setMounting(false);
      }
    },
    [mfeRegistry, mounting]
  );

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-border bg-card pr-4">
      <img
        src="/brand/constructor-weave.svg"
        alt=""
        width={32}
        height={32}
        className="ml-2 size-8 shrink-0"
      />

      <span className="ml-2 whitespace-nowrap text-body font-semibold text-foreground">
        Constructor Studio
      </span>

      <div className="ml-xl flex min-w-0 items-center">
        <ContextChain />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <IconPill
          icon={searchExtension?.presentation?.icon ?? 'material-symbols:search'}
          label={searchExtension?.presentation?.label ?? 'Search'}
          disabled={!searchExtension}
          onClick={
            searchExtension ? () => void openOverlayExtension(searchExtension.id) : undefined
          }
        />
          {/*TODO: drive `unread` from the inbox MFE's own state once it exists —
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
