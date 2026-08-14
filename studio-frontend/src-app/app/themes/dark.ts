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
    '--background': '222.9 28% 4.9%',
    '--foreground': '220 20% 97.1%',
    '--card': '218.8 33.3% 10%',
    '--card-foreground': '220 20% 97.1%',
    '--popover': '222.4 30.9% 10.8%',
    '--popover-foreground': '220 20% 97.1%',
    '--primary': '258.9 68.4% 59%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '217.2 32.6% 17.5%',
    '--secondary-foreground': '210 40% 98%',
    '--muted': '217.2 32.6% 17.5%',
    '--muted-foreground': '220 13.4% 60.6%',
    '--accent': '261.2 72.6% 22.9%',
    '--accent-foreground': '251.4 91.3% 95.5%',
    '--destructive': '349.7 65.8% 52.9%',
    '--destructive-foreground': '0 0% 100%',
    '--border': '218.2 24.4% 17.6%',
    '--input': '219.3 23.2% 24.5%',
    '--ring': '258.9 68.4% 59%',

    // State colors
    '--error': '349.7 65.8% 52.9%',
    '--warning': '43.3 96.4% 56.3%',
    '--success': '158.1 64.4% 51.6%',
    '--info': '187.9 85.7% 53.3%',

    // Chart colors (OKLCH format, shadcn/ui dark theme)
    '--chart-1': 'oklch(0.488 0.243 264.376)',
    '--chart-2': 'oklch(0.696 0.17 162.48)',
    '--chart-3': 'oklch(0.769 0.188 70.08)',
    '--chart-4': 'oklch(0.627 0.265 303.9)',
    '--chart-5': 'oklch(0.645 0.246 16.439)',

    // Left menu colors
    '--left-menu': '220 27.3% 6.5%',
    '--left-menu-foreground': '220 13.4% 60.6%',
    '--left-menu-hover': '220.7 37.8% 14.5%',
    '--left-menu-selected': '258.9 68.4% 59%',
    '--left-menu-border': '218.2 24.4% 17.6%',

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
