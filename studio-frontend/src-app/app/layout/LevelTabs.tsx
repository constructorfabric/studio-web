/** LevelTabs Component  */

// @cpt-dod:cpt-studiofrontend-dod-shell-levels-shell-draws:p1
// @cpt-dod:cpt-studiofrontend-dod-shell-levels-one-mount:p1
import React, { useCallback } from 'react';
import {
  useAppSelector,
  useDomainExtensions,
  eventBus,
  FRONTX_SCREEN_DOMAIN,
} from '@gears-frontx/react';
import { useMountedExtensions } from '@/app/mfe/domainOccupancy';
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from '@gears-frontx/ui-kit/navigation-menu';
import { Skeleton } from '@gears-frontx/ui-kit/skeleton';
import { DynamicIcon, iconNames } from 'lucide-react/dynamic';
import {
  MFE_BOOTSTRAP_SLICE_KEY,
  type MfeBootstrapState,
} from '@/app/slices/mfeBootstrapSlice';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { parentSectionOf, resolveLevelMenu, sectionOf, type StudioScreenExtension } from '@/app/mfe/screenLevels';
import { useShellText } from '@/app/i18n/shellTranslations';
import { levelIconName } from './levelIcon';
import { useScreenLevel } from './useScreenLevel';
import styles from './LevelTabs.module.css';

function isActiveItem(
  item: StudioScreenExtension,
  mounted: StudioScreenExtension | undefined,
  section: string | null
): boolean {
  const itemSection = sectionOf(item);
  // A hidden screen (the editor) names the section it belongs to.
  const parent = mounted && parentSectionOf(mounted);
  if (parent !== undefined) return itemSection === parent;
  if (itemSection !== undefined && mounted && item.entry === mounted.entry) {
    return itemSection === section;
  }
  return item.id === mounted?.id;
}

export const LevelTabs: React.FC = () => {
  const t = useShellText();
  const level = useScreenLevel();
  const registered = useDomainExtensions(FRONTX_SCREEN_DOMAIN) as StudioScreenExtension[];
  const items = resolveLevelMenu(registered, level);
  const mounted = useMountedExtensions(FRONTX_SCREEN_DOMAIN)[0] as StudioScreenExtension | undefined;
  const section = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.section ?? null
  );
  const bootstrapStatus = useAppSelector(
    (state) =>
      (state[MFE_BOOTSTRAP_SLICE_KEY] as MfeBootstrapState | undefined)?.status ?? 'pending'
  );

  const choose = useCallback((chosen: StudioScreenExtension) => {
    eventBus.emit('app/context/screen/requested', { extensionId: chosen.id });
  }, []);

  if (items.length === 0) {
    return bootstrapStatus === 'pending' ? (
      <div className={styles.row} aria-hidden="true">
        <Skeleton className={styles.pending} />
      </div>
    ) : null;
  }

  return (
    <NavigationMenu aria-label={t('level_tabs')} className={styles.row}>
      <NavigationMenuList className={styles.list}>
        {items.map((ext) => {
          const icon = levelIconName(ext.presentation.icon, iconNames);
          return (
            <NavigationMenuItem key={ext.id}>
              <NavigationMenuLink
                size="compact"
                active={isActiveItem(ext, mounted, section)}
                render={<button type="button" onClick={() => choose(ext)} />}
                className={styles.tab}
              >
                {icon && <DynamicIcon name={icon} className={styles.glyph} aria-hidden="true" />}
                {ext.presentation?.label}
              </NavigationMenuLink>
            </NavigationMenuItem>
          );
        })}
      </NavigationMenuList>
    </NavigationMenu>
  );
};

LevelTabs.displayName = 'LevelTabs';
