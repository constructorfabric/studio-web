/**
 * Default theme for FrontX
 * Based on original PoC design with light color scheme
 * CSS custom properties map following shadcn/ui variable naming convention.
 */
// @cpt-algo:cpt-frontx-algo-ui-libraries-choice-theme-propagation:p1

import type { ThemeConfig } from '@gears-frontx/react';

/**
 * Default theme ID
 */
export const DEFAULT_THEME_ID = 'default' as const;

export const defaultTheme: ThemeConfig = {
  id: DEFAULT_THEME_ID,
  name: 'Default',
  default: true,
  variables: {
    // Shadcn color variables — values mirror @gears-frontx/ui-kit theme.css (Studio palette)
    '--background': '210 40% 98%',
    '--foreground': '222.2 47.4% 11.2%',
    '--card': '0 0% 100%',
    '--card-foreground': '222.2 47.4% 11.2%',
    '--popover': '0 0% 100%',
    '--popover-foreground': '222.2 47.4% 11.2%',
    '--primary': '258 74.1% 62.2%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '210 40% 96.1%',
    '--secondary-foreground': '222.2 47.4% 11.2%',
    '--muted': '210 40% 96.1%',
    '--muted-foreground': '215.4 16.3% 46.9%',
    '--accent': '268.7 100% 95.5%',
    '--accent-foreground': '263.4 70% 50.4%',
    '--destructive': '346.8 77.2% 49.8%',
    '--destructive-foreground': '0 0% 100%',
    '--border': '214.3 31.8% 91.4%',
    '--input': '212.7 26.8% 83.9%',
    '--ring': '258.3 89.5% 66.3%',

    // State colors
    '--error': '346.8 77.2% 49.8%',
    '--warning': '32.1 94.6% 43.7%',
    '--success': '161.4 93.5% 30.4%',
    '--info': '200.4 98% 39.4%',

    // Chart colors (OKLCH format, shadcn/ui light theme)
    '--chart-1': 'oklch(0.646 0.222 41.116)',
    '--chart-2': 'oklch(0.6 0.118 184.704)',
    '--chart-3': 'oklch(0.398 0.07 227.392)',
    '--chart-4': 'oklch(0.828 0.189 84.429)',
    '--chart-5': 'oklch(0.769 0.188 70.08)',

    // Left menu colors
    '--left-menu': '210 40% 96.1%',
    '--left-menu-foreground': '215.4 16.3% 46.9%',
    '--left-menu-hover': '0 0% 100%',
    '--left-menu-selected': '258 74.1% 62.2%',
    '--left-menu-border': '214.3 31.8% 91.4%',

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
    '--shadow-sm': '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
    '--shadow-md': '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
    '--shadow-lg': '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
    '--shadow-xl': '0 20px 25px -5px rgba(0, 0, 0, 0.1)',

    // Transitions
    '--transition-fast': '150ms',
    '--transition-base': '200ms',
    '--transition-slow': '300ms',
    '--transition-slower': '500ms',
  },
};
