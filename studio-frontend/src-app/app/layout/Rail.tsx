/**
 * Rail Component — the navigation of the level in scope.
 *
 * A permanent icon-width column that expands over the content on hover or
 * focus, rather than a drawer that has to be opened before anything can be
 * reached. Its items are the screen extensions of the level the session is at,
 * so it is empty — and absent — at a level whose only screen is the level
 * itself.
 *
 * Same shape as `ProjectRail` in projects-mfe, which this replaces: the kit's
 * `Sidebar collapsible="icon"` carries the icon width and the labels, and its
 * styles are carried over verbatim in Rail.module.css. No tooltips: the panel
 * expands on hover, which is where the label belongs.
 */

// @cpt-dod:cpt-studiofrontend-dod-shell-levels-shell-draws:p1
// @cpt-dod:cpt-studiofrontend-dod-shell-levels-one-mount:p1
import React, { useCallback, useState } from 'react';
import {
  useFrontX,
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
import { mountScreen } from '@/app/mfe/mountScreen';
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
  const { mfeRegistry } = useFrontX();
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
  const [mounting, setMounting] = useState(false);

  const closeOnBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setOpen(false);
  }, []);

  const choose = useCallback(
    async (chosen: ScreenExtension) => {
      if (!mfeRegistry || mounting) return;
      setOpen(false);

      if (mounted && chosen.entry === mounted.entry) {
        const chosenSection = sectionOf(chosen) ?? null;
        eventBus.emit('app/context/project/section', { section: chosenSection });
        return;
      }

      // Leave the project scope first: closing it nulls the section, and
      // mountScreen sets the chosen one — the other order wipes it again.
      eventBus.emit('app/context/project/closed');
      setMounting(true);
      try {
        await mountScreen(mfeRegistry, chosen);
      } finally {
        setMounting(false);
      }
    },
    [mfeRegistry, mounting, mounted]
  );

  // Skeleton only while bootstrap is pending; a failed bootstrap is reported by
  // the screen container, and a rail of one item is not a rail.
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
                      onClick={() => void choose(ext)}
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
