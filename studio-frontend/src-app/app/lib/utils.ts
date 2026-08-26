import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * Named text roles added to Tailwind's fontSize scale in tailwind.config.ts.
 * They must be listed here too: tailwind-merge classifies classes by name, and
 * `text-<word>` is indistinguishable from a text colour to it. Left untaught it
 * drops a genuine colour as "conflicting" with a role, and lets a role and a
 * built-in size (text-sm) coexist so that stylesheet order silently decides.
 * Keep in sync with `theme.extend.fontSize`.
 */
const TEXT_ROLES = ["body", "heading-1", "label"] as const

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TEXT_ROLES] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
