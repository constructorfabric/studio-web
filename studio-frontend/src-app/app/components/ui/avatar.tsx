/**
 * Avatar Component - Based on shadcn/ui avatar
 *
 * TODO: probably need to move to in @gears-frontx/ui-kit so the shell and
 * every MFE import one avatar. The ui kit has no avatar component, and an MFE
 * cannot reach `src-app/app` (separate package, separate build, own shadow root),
 * so people-mfe will carry a copy of this until the shared one exists.
 *
 * Behaviour mirrors AcvAvatar in the `react-kit` repo (packages/react-kit/src/
 * entries/avatar)
 */

import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

import { cn } from "@/app/lib/utils"

/**
 * The hue order IS the contract: an avatar's colour is a position in this list,
 * so inserting or reordering a hue repaints every avatar in the product. Matches
 * AcvAvatar's `colorNames` and the `avatar` colours in tailwind.config.ts.
 */
export const AVATAR_HUES = [
  "yellow",
  "orange",
  "blue",
  "mint",
  "brown",
  "grey",
  "pink",
  "turquoise",
  "purple",
  "magenta",
  "red",
  "green",
] as const

export type AvatarHue = (typeof AVATAR_HUES)[number]

const AVATAR_HUE_CLASSES: Record<AvatarHue, string> = {
  yellow: "bg-avatar-yellow",
  orange: "bg-avatar-orange",
  blue: "bg-avatar-blue",
  mint: "bg-avatar-mint",
  brown: "bg-avatar-brown",
  grey: "bg-avatar-grey",
  pink: "bg-avatar-pink",
  turquoise: "bg-avatar-turquoise",
  purple: "bg-avatar-purple",
  magenta: "bg-avatar-magenta",
  red: "bg-avatar-red",
  green: "bg-avatar-green",
}

/**
 * Sum of char codes modulo the palette size. Not a strong hash — it is the one
 * AcvAvatar uses, and matching it is worth more than distribution quality here:
 * the two implementations must agree on the colour for a given name.
 */
export function avatarHueFor(name: string): AvatarHue | undefined {
  if (!name) return undefined
  const lower = name.toLowerCase()
  let sum = 0
  for (let i = 0; i < lower.length; i++) sum += lower.charCodeAt(i)
  return AVATAR_HUES[sum % AVATAR_HUES.length]
}

/** First letters of the first two words, uppercased. Empty name yields "A". */
export function avatarInitials(name: string): string {
  if (!name) return "A"
  return name
    .split(" ")
    .map((part) => part[0]?.toUpperCase())
    .filter(Boolean)
    .join("")
    .slice(0, 2)
}

const Avatar = (
  {
    ref,
    className,
    ...props
  }: React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> & {
    ref?: React.Ref<React.ComponentRef<typeof AvatarPrimitive.Root>>;
  }
) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full",
      className
    )}
    {...props}
  />
)
Avatar.displayName = AvatarPrimitive.Root.displayName

const AvatarImage = (
  {
    ref,
    className,
    ...props
  }: React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image> & {
    ref?: React.Ref<React.ComponentRef<typeof AvatarPrimitive.Image>>;
  }
) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn("aspect-square h-full w-full", className)}
    {...props}
  />
)
AvatarImage.displayName = AvatarPrimitive.Image.displayName

const AvatarFallback = (
  {
    ref,
    name,
    background = "auto",
    children,
    className,
    ...props
  }: React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback> & {
    /** Resolves both the colour and, unless children are given, the initials. */
    name?: string;
    background?: "auto" | "inherit";
    ref?: React.Ref<React.ComponentRef<typeof AvatarPrimitive.Fallback>>;
  }
) => {
  const hue = background === "inherit" ? undefined : avatarHueFor(name ?? "")

  return (
    <AvatarPrimitive.Fallback
      ref={ref}
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full font-medium",
        // twMerge drops bg-muted when a hue class follows, both being bg colours.
        "bg-muted",
        hue && AVATAR_HUE_CLASSES[hue],
        hue && "text-avatar-foreground",
        className
      )}
      {...props}
    >
      {children ?? (name === undefined ? undefined : avatarInitials(name))}
    </AvatarPrimitive.Fallback>
  )
}
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName

export { Avatar, AvatarImage, AvatarFallback }
