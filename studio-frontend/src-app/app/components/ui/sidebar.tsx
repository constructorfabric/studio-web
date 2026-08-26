/**
 * Sidebar Component - Based on shadcn/ui sidebar
 *
 * A surface and a column, nothing more: width, borders and placement belong to
 * the consumer. They used to live here, pinned to 232px with a 56px icon rail,
 * which is what a permanent left column needed — the navigation is a 320px
 * overlay drawer now (see layout/Menu.tsx), and a primitive that hardcodes one
 * layout cannot serve both.
 */

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/app/lib/utils"
import { Skeleton } from "@gears-frontx/ui-kit/skeleton"

const Sidebar = (
  {
    ref,
    collapsed = false,
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLElement> & {
    collapsed?: boolean;
    ref?: React.Ref<HTMLElement>;
  }
) => {
  return (
    <aside
      ref={ref}
      data-state={collapsed ? "collapsed" : "expanded"}
      data-collapsible={collapsed ? "icon" : ""}
      className={cn(
        "group flex flex-col",
        "bg-mainMenu text-mainMenu-foreground",
        className
      )}
      {...props}
    >
      {children}
    </aside>
  )
}
Sidebar.displayName = "Sidebar"

const SidebarContent = (
  {
    ref,
    className,
    ...props
  }: React.ComponentProps<"div"> & {
    ref?: React.Ref<HTMLDivElement>;
  }
) => (<div
  ref={ref}
  data-sidebar="content"
  className={cn(
    "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden p-2",
    className
  )}
  {...props}
/>)
SidebarContent.displayName = "SidebarContent"

const SidebarMenu = (
  {
    ref,
    className,
    ...props
  }: React.ComponentProps<"ul"> & {
    ref?: React.Ref<HTMLUListElement>;
  }
) => (<ul
  ref={ref}
  data-sidebar="menu"
  className={cn("flex w-full min-w-0 flex-col gap-1", className)}
  {...props}
/>)
SidebarMenu.displayName = "SidebarMenu"

const SidebarMenuItem = (
  {
    ref,
    className,
    ...props
  }: React.ComponentProps<"li"> & {
    ref?: React.Ref<HTMLLIElement>;
  }
) => (<li
  ref={ref}
  data-sidebar="menu-item"
  className={cn("group/menu-item relative", className)}
  {...props}
/>)
SidebarMenuItem.displayName = "SidebarMenuItem"

type SidebarMenuButtonVariant = "default" | "outline"
type SidebarMenuButtonSize = "default" | "sm" | "lg"
/** Which text role the button's label sits on. */
type SidebarMenuButtonTextRole = "body" | "label"

const SIDEBAR_MENU_BUTTON_TEXT_ROLE_CLASSES: Record<SidebarMenuButtonTextRole, string> = {
  body: "text-body",
  label: "text-label",
}

const SIDEBAR_MENU_BUTTON_BASE_CLASSES =
  "peer/menu-button group/menu-button flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left font-medium tracking-normal outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-[collapsible=icon]:!px-2.5 [&>span:last-child]:truncate [&>span:last-child]:overflow-hidden [&>svg]:shrink-0 text-mainMenu-foreground hover:bg-mainMenu-hover/65 hover:text-mainMenu-active-foreground data-[active=true]:bg-mainMenu-active data-[active=true]:text-mainMenu-active-foreground"

const SIDEBAR_MENU_BUTTON_VARIANT_CLASSES: Record<SidebarMenuButtonVariant, string> = {
  default: "",
  outline: "bg-background shadow-[0_0_0_1px_hsl(var(--border))] hover:bg-mainMenu-hover",
}

const SIDEBAR_MENU_BUTTON_SIZE_CLASSES: Record<SidebarMenuButtonSize, string> = {
  default: "h-[38px]",
  sm: "h-7",
  lg: "h-12 group-data-[collapsible=icon]:!p-0",
}

function sidebarMenuButtonVariants({
  variant = "default",
  size = "default",
  textRole = "body",
}: {
  variant?: SidebarMenuButtonVariant
  size?: SidebarMenuButtonSize
  textRole?: SidebarMenuButtonTextRole
}) {
  return cn(
    SIDEBAR_MENU_BUTTON_BASE_CLASSES,
    SIDEBAR_MENU_BUTTON_TEXT_ROLE_CLASSES[textRole],
    SIDEBAR_MENU_BUTTON_VARIANT_CLASSES[variant],
    SIDEBAR_MENU_BUTTON_SIZE_CLASSES[size]
  )
}

const SidebarMenuButton = (
  {
    ref,
    asChild = false,
    isActive = false,
    variant = "default",
    size = "default",
    textRole = "body",
    tooltip,
    className,
    ...props
  }: React.ComponentPropsWithoutRef<"button"> & {
    asChild?: boolean;
    isActive?: boolean;
    variant?: SidebarMenuButtonVariant;
    size?: SidebarMenuButtonSize;
    textRole?: SidebarMenuButtonTextRole;
    tooltip?: string;
    ref?: React.Ref<HTMLButtonElement>;
  }
) => {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      ref={ref}
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      title={tooltip}
      className={cn(sidebarMenuButtonVariants({ variant, size, textRole }), className)}
      {...props}
    />
  )
}
SidebarMenuButton.displayName = "SidebarMenuButton"

const SidebarMenuIcon = (
  {
    ref,
    className,
    ...props
  }: React.ComponentProps<"span"> & {
    ref?: React.Ref<HTMLSpanElement>;
  }
) => (<span
  ref={ref}
  data-sidebar="menu-icon"
  className={cn(
    "size-[18px] min-w-[18px] flex-shrink-0 [&>svg]:w-full [&>svg]:h-full",
    // Tinted with the brand accent when the enclosing button is the active
    // screen. Reads --primary directly: the menu used to carry its own
    // --left-menu-selected holding byte-identical values in every theme.
    "group-data-[active=true]/menu-button:text-primary",
    className
  )}
  {...props}
/>)
SidebarMenuIcon.displayName = "SidebarMenuIcon"

const SidebarMenuLabel = (
  {
    ref,
    className,
    ...props
  }: React.ComponentProps<"span"> & {
    ref?: React.Ref<HTMLSpanElement>;
  }
) => (<span
  ref={ref}
  className={cn(className)}
  {...props}
/>)
SidebarMenuLabel.displayName = "SidebarMenuLabel"

export interface SidebarHeaderProps extends React.ComponentProps<"div"> {
  logo?: React.ReactNode
  logoText?: React.ReactNode
  collapsed?: boolean
  onClick?: () => void
}

const SidebarHeader = (
  {
    ref,
    logo,
    logoText,
    collapsed = false,
    onClick,
    className,
    ...props
  }: SidebarHeaderProps & {
    ref?: React.Ref<HTMLDivElement>;
  }
) => {
  return (
    <div
      ref={ref}
      className={cn(
        // Same height and surface as the app header next to it, so the brand
        // row and the screen title sit on one baseline.
        "flex flex-col h-16 shrink-0 bg-background border-b border-mainMenu-border",
        className
      )}
      {...props}
    >
      <div className="flex items-center flex-1 px-2">
        {onClick ? (
          <SidebarMenuButton onClick={onClick} tooltip={collapsed ? "Expand menu" : "Collapse menu"}>
            {logo && <SidebarMenuIcon>{logo}</SidebarMenuIcon>}
            {logoText && (
              <SidebarMenuLabel className="[&>svg]:h-5 [&>svg]:w-auto">
                {logoText}
              </SidebarMenuLabel>
            )}
          </SidebarMenuButton>
        ) : (
          // Without a toggle handler the logo is pure branding — render it
          // outside any button so it exposes no phantom "Expand menu" control.
          <div className="flex items-center gap-2 px-2 py-2">
            {logo && <SidebarMenuIcon>{logo}</SidebarMenuIcon>}
            {logoText && (
              <SidebarMenuLabel className="[&>svg]:h-5 [&>svg]:w-auto">
                {logoText}
              </SidebarMenuLabel>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
SidebarHeader.displayName = "SidebarHeader"

/**
 * Stand-in rows for the menu while the screen list is still unknown — not empty,
 * unknown. Built from SidebarMenuButton so the row metrics are literally the ones
 * real items use and cannot drift apart.
 *
 * TODO: belongs in @gears-frontx/ui-kit alongside Sidebar itself
 */
const SidebarMenuSkeleton = (
  {
    count = 5,
    collapsed = false,
  }: {
    count?: number;
    collapsed?: boolean;
  }
) => (
  <>
    {Array.from({ length: count }, (_, row) => (
      <SidebarMenuItem key={row}>
        {/* Inert: presentational only, and out of the tab order. */}
        <SidebarMenuButton aria-hidden tabIndex={-1} className="pointer-events-none">
          <SidebarMenuIcon>
            <Skeleton className="h-full w-full" />
          </SidebarMenuIcon>
          {!collapsed && <Skeleton className="h-3 flex-1" />}
        </SidebarMenuButton>
      </SidebarMenuItem>
    ))}
  </>
)
SidebarMenuSkeleton.displayName = "SidebarMenuSkeleton"

/**
 * Bottom region of the sidebar — identity and the collapse toggle. Separated
 * from the scrolling menu by a rule, and never scrolls with it.
 */
const SidebarFooter = (
  {
    ref,
    className,
    ...props
  }: React.ComponentProps<"div"> & {
    ref?: React.Ref<HTMLDivElement>;
  }
) => (<div
  ref={ref}
  data-sidebar="footer"
  className={cn("mt-auto shrink-0 border-t border-mainMenu-border p-2", className)}
  {...props}
/>)
SidebarFooter.displayName = "SidebarFooter"

export {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuLabel,
  SidebarMenuIcon,
  SidebarMenuSkeleton,
  SidebarHeader,
  SidebarFooter,
}
