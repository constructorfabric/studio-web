/**
 * Menu Component — the global navigation drawer.
 *
 * A 320px panel that opens over the content, top bar included, rather than the
 * permanent column it used to be. Consequences of that change, all deliberate:
 *
 * - No collapsed rail. A drawer is open or closed; there is no third state, so
 *   the icons-only width and its toggle row are gone.
 * - No identity footer. Sign-out cannot live inside a panel that is closed most
 *   of the time — it moved to the top bar (see UserMenu.tsx).
 * - Selecting an item closes the drawer, because the drawer covers the very
 *   screen the selection mounts.
 *
 * Open/closed rides on the framework's `layout/menu` slice, reusing its
 * `collapsed` flag: `collapsed === true` means the drawer is closed. That keeps
 * the existing `layout/menu/collapsed` event as the one channel anything in the
 * app — an MFE included — can open or close the drawer through, instead of
 * inventing a second one. main.tsx sets it closed at boot, since the slice's own
 * default is the open state a permanent column wanted.
 *
 * The item list is still registry-driven: whatever registers in the screen
 * domain appears, ordered by `presentation.order`.
 */

import React, { useCallback, useMemo } from 'react';
import {
  useFrontX,
  useAppSelector,
  useDomainExtensions,
  useMountedExtensions,
  eventBus,
  FRONTX_ACTION_MOUNT_EXT,
  FRONTX_SCREEN_DOMAIN,
  type ScreenExtension,
  type MenuState,
} from '@gears-frontx/react';
import { Separator } from '@gears-frontx/ui-kit/separator';
import { Button } from '@gears-frontx/ui-kit/button';
import {
  MFE_BOOTSTRAP_SLICE_KEY,
  type MfeBootstrapState,
} from '@/app/slices/mfeBootstrapSlice';
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuIcon,
  SidebarMenuSkeleton,
} from '@/app/components/ui/sidebar';
import { Icon } from '@iconify/react';

export interface MenuProps {
  children?: React.ReactNode;
}

/**
 * Where the drawer's rule goes. `presentation.order` is a flat sort key — the
 * screen extension schema has no notion of groups — so the shell reads a band
 * out of it: below 100 are the working areas, 100 and above is the tenant level
 * (My Organization). The rule is drawn at the crossing. Recorded in
 * docs/adr/0008 so the next person does not have to infer it from a magic
 * number in an MFE manifest.
 */
const TENANT_ORDER_BAND = 100;

export const Menu: React.FC<MenuProps> = ({ children }) => {
  const app = useFrontX();
  const { mfeRegistry } = app;

  const collapsed = useAppSelector(
    (state) => (state['layout/menu'] as MenuState | undefined)?.collapsed ?? true
  );
  const open = !collapsed;

  const bootstrapStatus = useAppSelector(
    (state) => (state[MFE_BOOTSTRAP_SLICE_KEY] as MfeBootstrapState | undefined)?.status ?? 'pending'
  );

  // Index 0 is meaningful because the host registers the screen domain with
  // ExclusiveMountStrategy in `bootstrap.ts` (single mount per domain).
  const mountedScreens = useMountedExtensions(FRONTX_SCREEN_DOMAIN);
  const mountedId = mountedScreens[0]?.id;

  // Subscribed, not polled: `useDomainExtensions` reads the registry and
  // re-renders on store changes, and the store does change once bootstrap flips
  // its status — which happens after every extension is registered.
  const registered = useDomainExtensions(FRONTX_SCREEN_DOMAIN) as ScreenExtension[];
  const extensions = useMemo(
    () =>
      [...registered].sort(
        (a, b) => (a.presentation.order ?? 999) - (b.presentation.order ?? 999)
      ),
    [registered]
  );

  const close = useCallback(() => {
    eventBus.emit('layout/menu/collapsed', { collapsed: true });
  }, []);

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
      // Choosing a global area means the session is no longer inside a project.
      // The shell knows this without being told by any MFE.
      eventBus.emit('app/context/project/closed');
      close();
    },
    [close, mfeRegistry]
  );

  if (!open) return null;

  return (
    <>
      {/* Scrim covers everything to the right of the panel — the panel itself
          stays at full brightness, as drawn. */}
      <button
        type="button"
        aria-label="Close global navigation"
        onClick={close}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
        className="fixed inset-y-0 right-0 left-80 z-modal cursor-default bg-[rgb(15_18_24_/_0.48)]"
      />

      <Sidebar
        // Over the top bar too: the drawer is the whole navigation, not a
        // column beside it.
        className="fixed inset-y-0 left-0 z-modal w-80 border border-border bg-card shadow-lg"
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      >
        {/* The panel's own header. Not SidebarHeader: that primitive puts its
            logo slot inside an 18px icon box, which would squash the 40px close
            control the mockup puts where the burger was. */}
        <div className="flex h-14 shrink-0 items-center border-b border-border px-[7px]">
          {/* Same control as the top bar's burger, in the place it occupied —
              40px with a 20px glyph, which is the kit's `lg`. */}
          <Button
            variant="ghost"
            size="lg"
            aria-label="Close global navigation"
            onClick={close}
            icon={<Icon icon="material-symbols:close" />}
            className="rounded-lg hover:[--button-bg:var(--muted)] hover:[--button-fg:var(--foreground)]"
          />
          <span className="ml-3 whitespace-nowrap text-[16px] font-semibold leading-6 text-foreground">
            Constructor Studio
          </span>
        </div>

        <SidebarContent className="gap-0 px-[11px] pt-[14px]">
          <SidebarMenu className="gap-1.5">
            {extensions.length === 0 ? (
              // While the manifest is in flight the screen list is not empty —
              // it is unknown. Showing the "no screens" hint here is what made
              // the menu flash a paragraph and then replace it with items.
              bootstrapStatus === 'pending' ? (
                <SidebarMenuSkeleton />
              ) : (
                <div className="px-2.5 py-4 text-label text-muted-foreground">
                  {bootstrapStatus === 'failed'
                    ? 'Screens could not be loaded. Check the console for the manifest error.'
                    : 'No screens yet. Add an MFE package by copying the _blank-mfe reference scaffold in mfe_packages/.'}
                </div>
              )
            ) : (
              extensions.map((ext, index) => {
                const isActive = ext.id === mountedId;
                const pres = ext.presentation;
                const order = pres.order ?? 999;
                const previousOrder = extensions[index - 1]?.presentation.order ?? 999;
                const startsTenantBand =
                  index > 0 && order >= TENANT_ORDER_BAND && previousOrder < TENANT_ORDER_BAND;

                return (
                  <React.Fragment key={ext.id}>
                    {startsTenantBand && <Separator className="mb-[13px] mt-1.5" />}
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={isActive}
                        onClick={() => handleMenuItemClick(ext.id)}
                      >
                        {pres.icon && (
                          <SidebarMenuIcon>
                            {/* Size comes from SidebarMenuIcon's box (18px). */}
                            <Icon icon={pres.icon} />
                          </SidebarMenuIcon>
                        )}
                        <span>{pres.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </React.Fragment>
                );
              })
            )}
          </SidebarMenu>
        </SidebarContent>

        {children}
      </Sidebar>
    </>
  );
};

Menu.displayName = 'Menu';
