/**
 * ContextSwitcher Component
 *
 * The top bar's second slot: what the session is currently inside, and a
 * dropdown to move sideways within it. One slot, two scopes — at `org` scope it
 * names the organization and lists the user's organizations; at `project` scope
 * it names the open project and lists projects, plus a way back up.
 *
 * The switcher renders state and emits events; it fetches nothing. Who owns
 * which half of that state is explained in slices/appContextSlice.ts.
 *
 * Icon colours sit on the wrapping span, never on `<Icon>` itself. @iconify/react
 * resolves an icon asynchronously and renders an unclassed `<span>` placeholder
 * until it has the data — a className handed to `Icon` is dropped for that
 * render, so the glyph inherits the trigger's `text-foreground` and comes out
 * dark instead of muted. A wrapper holds the colour through both states, which is
 * the same reason `SidebarMenuIcon` exists in components/ui/sidebar.tsx.
 */

import React, { useCallback } from 'react';
import { useAppSelector, eventBus } from '@gears-frontx/react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@gears-frontx/ui-kit/dropdown-menu';
import { Icon } from '@iconify/react';
import { Skeleton } from '@gears-frontx/ui-kit/skeleton';
import {
  APP_CONTEXT_SLICE_KEY,
  type AppContextState,
  type ContextEntity,
} from '@/app/slices/appContextSlice';

/** The 20px leading glyph naming the KIND of context, per the mockup's two variants. */
const SCOPE_ICON = {
  org: 'material-symbols:domain',
  project: 'material-symbols:folder',
} as const;

export const ContextSwitcher: React.FC = () => {
  const context = useAppSelector(
    (state) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined
  );

  const scope = context?.scope ?? 'org';
  const inProject = scope === 'project';
  const current: ContextEntity | null = (inProject ? context?.project : context?.org) ?? null;
  const options: ContextEntity[] = (inProject ? context?.projects : context?.orgs) ?? [];

  const pick = useCallback(
    (id: string) => {
      if (inProject) eventBus.emit('app/context/project/changed', { projectId: id });
      else eventBus.emit('app/context/org/changed', { orgId: id });
    },
    [inProject]
  );

  const leaveProject = useCallback(() => {
    eventBus.emit('app/context/project/closed');
  }, []);

  if (context?.loading && !current) {
    return <Skeleton className="h-5 w-32" />;
  }

  // Nothing resolved yet and nothing loading: the slot stays empty rather than
  // inventing a name for a context the backend has not confirmed.
  if (!current) return null;

  const label = (
    <>
      <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
        <Icon icon={SCOPE_ICON[scope]} className="size-5" />
      </span>
      <span className="truncate text-[16px] font-semibold leading-6 text-foreground">
        {current.name}
      </span>
    </>
  );

  // A single option and no way out is not a choice — render the name flat, with
  // no chevron promising a menu that would open empty.
  const hasMenu = options.length > 1 || inProject;

  if (!hasMenu) {
    return <span className="flex h-9 items-center gap-2 px-2.5">{label}</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-9 max-w-72 items-center gap-2 rounded-lg px-2.5 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
        {label}
        <span className="grid size-[18px] shrink-0 place-items-center text-muted-foreground">
          {/* The mockup labels this glyph `expand_more`, which is what Material
              Symbols called it originally; in Iconify's set that name is a
              deprecated alias (`hidden: true`) and `keyboard-arrow-down` is the
              live name for the same chevron. */}
          <Icon icon="material-symbols:keyboard-arrow-down" className="size-[18px]" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-56 rounded-lg">
        {options.map((option) => (
          <DropdownMenuItem key={option.id} onClick={() => pick(option.id)}>
            {option.name}
          </DropdownMenuItem>
        ))}
        {inProject && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={leaveProject}>All projects</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

ContextSwitcher.displayName = 'ContextSwitcher';
