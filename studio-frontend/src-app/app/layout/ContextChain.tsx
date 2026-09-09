/** ContextChain Component — the path to the level in scope. */

// @cpt-dod:cpt-studiofrontend-dod-shell-levels-chain:p1
// @cpt-dod:cpt-studiofrontend-dod-shell-levels-workspace-level:p1
// @cpt-dod:cpt-studiofrontend-dod-shell-levels-counts:p2
import React, { useCallback } from 'react';
import { useAppSelector, eventBus } from '@gears-frontx/react';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from '@gears-frontx/ui-kit/breadcrumb';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@gears-frontx/ui-kit/dropdown-menu';
import {
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@gears-frontx/ui-kit/item';
import { Skeleton } from '@gears-frontx/ui-kit/skeleton';
import { ArrowRight, Building2, ChevronDown, Folder, FolderOpen } from 'lucide-react';
import {
  APP_CONTEXT_SLICE_KEY,
  type AppContextState,
  type ContextEntity,
} from '@/app/slices/appContextSlice';
import { levelAtLeast, type ScreenLevel } from '@/app/mfe/screenLevels';
import { useScreenLevel } from './useScreenLevel';

interface ChainSlot {
  level: ScreenLevel;
  caps: string;
  current: ContextEntity;
  options: ContextEntity[];
  countNoun?: 'workspace' | 'project';
  Icon: typeof Building2;
  pick: (id: string) => void;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const pickOrg = (id: string) => eventBus.emit('app/context/org/changed', { orgId: id });
const pickWorkspace = (id: string) =>
  eventBus.emit('app/context/workspace/changed', { workspaceId: id });
const pickProject = (id: string) =>
  eventBus.emit('app/context/project/changed', { projectId: id });

// @cpt-begin:cpt-studiofrontend-algo-shell-levels-path:p1:inst-1
// @cpt-begin:cpt-studiofrontend-algo-shell-levels-path:p1:inst-2
function slotsOf(level: ScreenLevel, context: AppContextState | undefined): ChainSlot[] {
  if (!context?.org) return [];

  const slots: ChainSlot[] = [
    {
      level: 'organization',
      caps: 'Organization',
      current: context.org,
      options: context.orgs ?? [],
      countNoun: 'workspace',
      Icon: Building2,
      pick: pickOrg,
    },
  ];

  if (levelAtLeast(level, 'workspace') && context.workspace) {
    slots.push({
      level: 'workspace',
      caps: 'Workspace',
      current: context.workspace,
      options: context.workspaces ?? [],
      countNoun: 'project',
      Icon: FolderOpen,
      pick: pickWorkspace,
    });
  }

  if (levelAtLeast(level, 'project') && context.project) {
    slots.push({
      level: 'project',
      caps: 'Project',
      current: context.project,
      options: context.projects ?? [],
      Icon: Folder,
      pick: pickProject,
    });
  }

  return slots;
}
// @cpt-end:cpt-studiofrontend-algo-shell-levels-path:p1:inst-2
// @cpt-end:cpt-studiofrontend-algo-shell-levels-path:p1:inst-1

// TODO: 10/14 and 12/16 are the prototype's sizes written out, because the kit
// ramp bottoms out at meta 12/16 and has no eyebrow role. Replace both with
// roles once the ramp has them.
const SlotLabel: React.FC<{ slot: ChainSlot; isCurrent: boolean; hasMenu: boolean }> = ({
  slot,
  isCurrent,
  hasMenu,
}) => (
  <span
    data-current={isCurrent || undefined}
    className="flex h-full w-full min-w-0 flex-col justify-center gap-0.5 rounded-lg border border-transparent
    px-2 transition-colors data-[current]:border-[color-mix(in_oklab,var(--border)_80%,transparent)]
    data-[current]:bg-[color-mix(in_oklab,var(--muted)_20%,transparent)]"
  >
    <span
      aria-hidden="true"
      className="w-full truncate font-mono text-[10px] font-normal uppercase leading-[14px] text-muted-foreground"
    >
      {slot.caps}
    </span>
    <span className="flex w-full min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate text-[12px] leading-4 text-foreground [font-weight:var(--text-label-weight)]">
        {slot.current.name}
      </span>
      {hasMenu && (
        <ChevronDown
          className="size-3.5 shrink-0 text-muted-foreground"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      )}
    </span>
  </span>
);

const SLOT_CLASS =
  'flex h-14 w-48 shrink-0 items-stretch px-1 py-1.5 text-left no-underline hover:!no-underline';

const Slot: React.FC<{ slot: ChainSlot; isCurrent: boolean }> = ({ slot, isCurrent }) => {
  const enter = useCallback(() => {
    eventBus.emit('app/context/level/requested', { level: slot.level });
  }, [slot.level]);

  const onPick = useCallback(
    (id: string) => {
      slot.pick(id);
      if (!isCurrent) enter();
    },
    [slot, isCurrent, enter]
  );

  const current = isCurrent ? ('page' as const) : undefined;

  if (slot.options.length < 2) {
    return (
      <BreadcrumbLink
        render={isCurrent ? <span /> : <button type="button" onClick={enter} />}
        aria-current={current}
        aria-label={`${slot.caps}: ${slot.current.name}`}
        className={SLOT_CLASS}
      >
        <SlotLabel slot={slot} isCurrent={isCurrent} hasMenu={false} />
      </BreadcrumbLink>
    );
  }

  return (
    <DropdownMenu>
      <BreadcrumbLink
        render={<DropdownMenuTrigger />}
        aria-current={current}
        aria-label={`${slot.caps}: ${slot.current.name}, switch`}
        className={`${SLOT_CLASS} focus-visible:ring-2 focus-visible:ring-ring [&>span]:hover:bg-muted`}
      >
        <SlotLabel slot={slot} isCurrent={isCurrent} hasMenu />
      </BreadcrumbLink>
      {/* TODO: the popup radius is the kit's own --radius-lg written out */}
      <DropdownMenuContent
        align="start"
        className="!min-w-72 [--radius-md:calc(var(--radius-lg)+4px)] [--radius-sm:var(--radius-lg)] [--space-1:var(--space-2)]"
      >
        <DropdownMenuRadioGroup value={slot.current.id} onValueChange={onPick}>
          {slot.options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick>
              <ItemMedia variant="icon" className="text-muted-foreground">
                <slot.Icon strokeWidth={1.5} aria-hidden="true" />
              </ItemMedia>
              {/* The popup's --space-1 remap inherits down to this gap. */}
              <ItemContent className="!gap-0">
                {/* ItemTitle declares ellipsis but is a fit-content flex box, so it
                    never truncates; block + auto width makes its own rule apply. */}
                <ItemTitle className="!block !w-auto text-label">{option.name}</ItemTitle>
                {slot.countNoun !== undefined && option.count !== undefined && (
                  <ItemDescription>{pluralize(option.count, slot.countNoun)}</ItemDescription>
                )}
              </ItemContent>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const ContextChain: React.FC = () => {
  const context = useAppSelector(
    (state) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined
  );
  const level = useScreenLevel();

  const slots = slotsOf(level, context);
  if (slots.length === 0) {
    return context?.loading ? <Skeleton className="h-9 w-40" /> : null;
  }

  return (
    <Breadcrumb>
      {/* @cpt-begin:cpt-studiofrontend-algo-shell-levels-path:p1:inst-3 */}
      <BreadcrumbList className="flex-nowrap gap-0">
        {slots.map((slot, index) => (
          <React.Fragment key={slot.level}>
            {index > 0 && (
              <BreadcrumbSeparator className="w-8 shrink-0 justify-center">
                <ArrowRight strokeWidth={1.5} />
              </BreadcrumbSeparator>
            )}
            <BreadcrumbItem>
              <Slot slot={slot} isCurrent={slot.level === level} />
            </BreadcrumbItem>
          </React.Fragment>
        ))}
      </BreadcrumbList>
      {/* @cpt-end:cpt-studiofrontend-algo-shell-levels-path:p1:inst-3 */}
    </Breadcrumb>
  );
};

ContextChain.displayName = 'ContextChain';
