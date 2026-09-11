/** Rail Component — the navigation of the level in scope. */

// @cpt-dod:cpt-studiofrontend-dod-shell-levels-shell-draws:p1
// @cpt-dod:cpt-studiofrontend-dod-shell-levels-one-mount:p1
import React, { useCallback, useState } from 'react';
import {
  useAppSelector,
  useDomainExtensions,
  useMountedExtensions,
  eventBus,
  FRONTX_SCREEN_DOMAIN,
  type ScreenExtension,
} from '@gears-frontx/react';
import {
  Sidebar,
  SidebarProvider,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSkeleton,
} from '@gears-frontx/ui-kit/sidebar';
import { DynamicIcon, iconNames } from 'lucide-react/dynamic';
import {
  MFE_BOOTSTRAP_SLICE_KEY,
  type MfeBootstrapState,
} from '@/app/slices/mfeBootstrapSlice';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { resolveLevelMenu, sectionOf } from '@/app/mfe/screenLevels';
import { railIconName } from './railIcon';
import { useScreenLevel } from './useScreenLevel';
import styles from './Rail.module.css';

function isActiveItem(
  item: ScreenExtension,
  mountedId: string | undefined,
  mounted: ScreenExtension | undefined,
  section: string | null
): boolean {
  const itemSection = sectionOf(item);
  if (itemSection !== undefined && mounted && item.entry === mounted.entry) {
    return itemSection === section;
  }
  return item.id === mountedId;
}

export const Rail: React.FC = () => {
  const level = useScreenLevel();
  const registered = useDomainExtensions(FRONTX_SCREEN_DOMAIN) as ScreenExtension[];
  const items = resolveLevelMenu(registered, level);
  const mounted = useMountedExtensions(FRONTX_SCREEN_DOMAIN)[0] as ScreenExtension | undefined;
  const mountedId = mounted?.id;
  const section = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.section ?? null
  );

  const bootstrapStatus = useAppSelector(
    (state) =>
      (state[MFE_BOOTSTRAP_SLICE_KEY] as MfeBootstrapState | undefined)?.status ?? 'pending'
  );

  const [open, setOpen] = useState(false);

  const closeOnBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setOpen(false);
  }, []);

  // Naming the screen is all the rail does. Whether that means another section
  // of the mounted entry or leaving the project scope for a new mount is the
  // shell's call, in `appContextEffects` — the same path a slot of the top bar
  // takes, so the guard and the failure rollback are shared rather than copied.
  const choose = useCallback((chosen: ScreenExtension) => {
    setOpen(false);
    eventBus.emit('app/context/screen/requested', { extensionId: chosen.id });
  }, []);

  // Skeleton only while bootstrap is pending. A failed bootstrap leaves no
  // items, and the rail says nothing about it — `MfeScreenContainer` reports it
  // in the content area, where the screen would have been. A rail of one item
  // is not a rail either.
  if (items.length <= 1 && bootstrapStatus !== 'pending') return null;

  // Controlled `open` without `onOpenChange`: the kit's provider owns Cmd/Ctrl+B
  // and would otherwise flip the rail open from anywhere on the page.
  return (
    <SidebarProvider
      open={open}
      className={styles.provider}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={closeOnBlur}
      // Carried over from the deleted `Menu`, and local rather than a document
      // listener the way `OverlayDialog` does it: the rail is not a modal, so
      // Escape is only its business while the focus is inside it. Tabbing out
      // already collapses the panel; this is for collapsing without leaving.
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <Sidebar collapsible="icon" className={styles.panel}>
        <SidebarContent className={styles.content}>
          <SidebarMenu className={styles.menu}>
            {items.length === 0 ? (
              <SidebarMenuSkeleton />
            ) : (
              items.map((ext) => {
                const pres = ext.presentation;

                return (
                  <SidebarMenuItem key={ext.id}>
                    <SidebarMenuButton
                      className={styles.item}
                      isActive={isActiveItem(ext, mountedId, mounted, section)}
                      onClick={() => choose(ext)}
                    >
                      {(() => {
                        const icon = railIconName(pres.icon, iconNames);
                        return icon ? (
                          <span className={styles.glyph}>
                            <DynamicIcon name={icon} />
                          </span>
                        ) : null;
                      })()}
                      <span>{pres.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })
            )}
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  );
};

Rail.displayName = 'Rail';
