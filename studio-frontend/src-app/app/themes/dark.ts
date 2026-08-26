/**
 * Dark theme for FrontX
 * CSS custom properties map following shadcn/ui variable naming convention.
 */
// @cpt-algo:cpt-frontx-algo-ui-libraries-choice-theme-propagation:p1

import type { ThemeConfig } from '@gears-frontx/react';

/**
 * Dark theme ID
 */
export const DARK_THEME_ID = 'dark' as const;

export const darkTheme: ThemeConfig = {
  id: DARK_THEME_ID,
  name: 'Dark',
  variables: {
    // Shadcn color variables — values mirror @gears-frontx/ui-kit theme.css (Studio palette)
    '--background': 'hsl(222.9 28% 4.9%)',
    '--foreground': 'hsl(220 20% 97.1%)',
    '--card': 'hsl(218.8 33.3% 10%)',
    '--card-foreground': 'hsl(220 20% 97.1%)',
    '--popover': 'hsl(222.4 30.9% 10.8%)',
    '--popover-foreground': 'hsl(220 20% 97.1%)',
    '--primary': 'hsl(258.9 68.4% 59%)',
    '--primary-foreground': 'hsl(0 0% 100%)',
    '--secondary': 'hsl(217.2 32.6% 17.5%)',
    '--secondary-foreground': 'hsl(210 40% 98%)',
    '--muted': 'hsl(217.2 32.6% 17.5%)',
    '--muted-foreground': 'hsl(220 13.4% 60.6%)',
    '--accent': 'hsl(261.2 72.6% 22.9%)',
    '--accent-foreground': 'hsl(251.4 91.3% 95.5%)',
    '--destructive': 'hsl(349.7 65.8% 52.9%)',
    '--destructive-foreground': 'hsl(0 0% 100%)',
    '--border': 'hsl(218.2 24.4% 17.6%)',
    '--input': 'hsl(219.3 23.2% 24.5%)',
    '--ring': 'hsl(258.9 68.4% 59%)',

    // State colors
    '--error': 'hsl(349.7 65.8% 52.9%)',
    '--warning': 'hsl(43.3 96.4% 56.3%)',
    '--success': 'hsl(158.1 64.4% 51.6%)',
    '--info': 'hsl(187.9 85.7% 53.3%)',

    // Chart colors (OKLCH format, shadcn/ui dark theme)
    '--chart-1': 'oklch(0.488 0.243 264.376)',
    '--chart-2': 'oklch(0.696 0.17 162.48)',
    '--chart-3': 'oklch(0.769 0.188 70.08)',
    '--chart-4': 'oklch(0.627 0.265 303.9)',
    '--chart-5': 'oklch(0.645 0.246 16.439)',

    // Left menu colors
    '--left-menu': 'hsl(220 27.3% 6.5%)',
    '--left-menu-foreground': 'hsl(220 13.4% 60.6%)',
    '--left-menu-hover': 'hsl(220.7 37.8% 14.5%)',
    '--left-menu-active': 'hsl(220.7 37.8% 14.5%)',
    '--left-menu-active-foreground': 'hsl(220 20% 97.1%)',
    '--left-menu-border': 'hsl(218.2 24.4% 17.6%)',

    // Avatar palette: 12 categorical hues an avatar picks deterministically
    // from a name, plus the inverted glyph colour for the initials on top.
    // Values are @constructor/globals' decoration-{hue}-strong pairs, so the
    // eventual move of this component into ui-kit keeps the same colours.
    '--avatar-yellow': 'hsl(40 100% 42.4%)',
    '--avatar-orange': 'hsl(24.6 99.1% 55.1%)',
    '--avatar-blue': 'hsl(223.6 90.4% 71.4%)',
    '--avatar-mint': 'hsl(160 85.3% 40%)',
    '--avatar-brown': 'hsl(21.6 39.3% 62.5%)',
    '--avatar-grey': 'hsl(0 0% 60.8%)',
    '--avatar-pink': 'hsl(338.8 100% 71.2%)',
    '--avatar-turquoise': 'hsl(186.1 85.4% 40.4%)',
    '--avatar-purple': 'hsl(278.8 100% 73.9%)',
    '--avatar-magenta': 'hsl(260.5 90.2% 72%)',
    '--avatar-red': 'hsl(4.3 100% 69.8%)',
    '--avatar-green': 'hsl(119 53.2% 46.1%)',
    '--avatar-foreground': 'hsl(0 0% 6.7%)',

    // Typography — see default.ts for why the token mirrors ui-kit's name.
    '--font-sans': "'Inter Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    '--text-body-size': '0.9375rem',
    '--text-body-line-height': '1.25rem',
    '--text-heading-1-size': '1.25rem',
    '--text-heading-1-line-height': '1.75rem',
    '--text-label-size': '0.8125rem',
    '--text-label-line-height': '1rem',

    // Spacing
    '--spacing-xs': '0.25rem',
    '--spacing-sm': '0.5rem',
    '--spacing-md': '1rem',
    '--spacing-lg': '1.5rem',
    '--spacing-xl': '2rem',
    '--spacing-2xl': '3rem',
    '--spacing-3xl': '4rem',

    // Border radius
    '--radius-none': '0',
    '--radius-sm': '0.125rem',
    '--radius-md': '0.25rem',
    '--radius-lg': '0.5rem',
    '--radius-xl': '1rem',
    '--radius-full': '9999px',

    // Shadows
    '--shadow-sm': '0 1px 2px 0 rgba(0, 0, 0, 0.3)',
    '--shadow-md': '0 4px 6px -1px rgba(0, 0, 0, 0.4)',
    '--shadow-lg': '0 10px 15px -3px rgba(0, 0, 0, 0.5)',
    '--shadow-xl': '0 20px 25px -5px rgba(0, 0, 0, 0.6)',

    // Transitions
    '--transition-fast': '150ms',
    '--transition-base': '200ms',
    '--transition-slow': '300ms',
    '--transition-slower': '500ms',
  },
};
