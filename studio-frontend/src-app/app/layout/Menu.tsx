/**
 * Menu Component
 *
 * Side navigation menu displaying MFE extensions with presentation metadata.
 * Uses local shadcn/ui Sidebar components for proper styling and collapsible behavior.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  useFrontX,
  useMountedExtensions,
  FRONTX_ACTION_MOUNT_EXT,
  FRONTX_SCREEN_DOMAIN,
  type ScreenExtension,
} from '@gears-frontx/react';
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuIcon,
  SidebarHeader,
} from '@/app/components/ui/sidebar';
import { Icon } from '@iconify/react';
import { FrontXLogoIcon } from '@/app/icons/FrontXLogoIcon';

export interface MenuProps {
  children?: React.ReactNode;
}

export const Menu: React.FC<MenuProps> = ({ children }) => {
  const app = useFrontX();
  const { mfeRegistry } = app;

  // The menu is deliberately always compact: no expand/collapse affordance,
  // labels surface as tooltips (see SidebarMenuButton below).
  const collapsed = true;

  // Currently-mounted screen extension (subscribes to store changes; no polling).
  // Index 0 is meaningful because the host registers the screen domain with
  // ExclusiveMountStrategy in `bootstrap.ts` (single mount per domain).
  const mountedScreens = useMountedExtensions(FRONTX_SCREEN_DOMAIN);
  const mountedId = mountedScreens[0]?.id;

  const [extensions, setExtensions] = useState<ScreenExtension[]>([]);

  useEffect(() => {
    if (!mfeRegistry) return;

    const refresh = () => {
      const screenExts = mfeRegistry.getExtensionsForDomain(FRONTX_SCREEN_DOMAIN) as ScreenExtension[];
      const sorted = screenExts
        .sort((a, b) => (a.presentation.order ?? 999) - (b.presentation.order ?? 999));
      setExtensions(sorted);
    };

    refresh();
    const interval = setInterval(refresh, 500);
    return () => clearInterval(interval);
  }, [mfeRegistry]);

  const handleMenuItemClick = useCallback(
    async (extensionId: string) => {
      if (!mfeRegistry) return;
      await mfeRegistry.executeActionsChain({
        action: {
          type: FRONTX_ACTION_MOUNT_EXT,
          target: FRONTX_SCREEN_DOMAIN,
          payload: { subject: extensionId },
        },
      });
    },
    [mfeRegistry]
  );

  return (
    <Sidebar collapsed={collapsed}>
      {/* Logo/Brand area (non-interactive: the menu never expands) */}
      <SidebarHeader logo={<FrontXLogoIcon />} collapsed={collapsed} />

      {/* Menu items */}
      <SidebarContent>
        <SidebarMenu>
          {extensions.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              No screens yet. Add an MFE package by copying the <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">_blank-mfe</code> reference scaffold in <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">mfe_packages/</code>.
            </div>
          ) : (
            extensions.map((ext) => {
              const isActive = ext.id === mountedId;
              const pres = ext.presentation;
              return (
                <SidebarMenuItem key={ext.id}>
                  <SidebarMenuButton
                    isActive={isActive}
                    onClick={() => handleMenuItemClick(ext.id)}
                    tooltip={collapsed ? pres.label : undefined}
                  >
                    {pres.icon && (
                      <SidebarMenuIcon>
                        <Icon icon={pres.icon} className="w-4 h-4" />
                      </SidebarMenuIcon>
                    )}
                    <span>{pres.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })
          )}
        </SidebarMenu>
      </SidebarContent>

      {children}
    </Sidebar>
  );
};

Menu.displayName = 'Menu';
