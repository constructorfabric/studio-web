/**
 * Light theme for FrontX
 * CSS custom properties map following shadcn/ui variable naming convention.
 */
// @cpt-algo:cpt-frontx-algo-ui-libraries-choice-theme-propagation:p1

import type { ThemeConfig } from '@gears-frontx/react';

/**
 * Light theme ID
 */
export const LIGHT_THEME_ID = 'light' as const;

export const lightTheme: ThemeConfig = {
  id: LIGHT_THEME_ID,
  name: 'Light',
  variables: {
    // Shadcn color variables — values mirror @gears-frontx/ui-kit theme.css (Studio palette)
    '--background': 'hsl(210 40% 98%)',
    '--foreground': 'hsl(222.2 47.4% 11.2%)',
    '--card': 'hsl(0 0% 100%)',
    '--card-foreground': 'hsl(222.2 47.4% 11.2%)',
    '--popover': 'hsl(0 0% 100%)',
    '--popover-foreground': 'hsl(222.2 47.4% 11.2%)',
    '--primary': 'hsl(258 74.1% 62.2%)',
    '--primary-foreground': 'hsl(0 0% 100%)',
    '--secondary': 'hsl(210 40% 96.1%)',
    '--secondary-foreground': 'hsl(222.2 47.4% 11.2%)',
    '--muted': 'hsl(210 40% 96.1%)',
    '--muted-foreground': 'hsl(215.4 16.3% 46.9%)',
    '--accent': 'hsl(268.7 100% 95.5%)',
    '--accent-foreground': 'hsl(263.4 70% 50.4%)',
    '--destructive': 'hsl(346.8 77.2% 49.8%)',
    '--destructive-foreground': 'hsl(0 0% 100%)',
    '--border': 'hsl(214.3 31.8% 91.4%)',
    '--input': 'hsl(212.7 26.8% 83.9%)',
    '--ring': 'hsl(258.3 89.5% 66.3%)',

    // State colors
    '--error': 'hsl(346.8 77.2% 49.8%)',
    '--warning': 'hsl(32.1 94.6% 43.7%)',
    '--success': 'hsl(161.4 93.5% 30.4%)',
    '--info': 'hsl(200.4 98% 39.4%)',

    // Chart colors (OKLCH format, shadcn/ui light theme)
    '--chart-1': 'oklch(0.646 0.222 41.116)',
    '--chart-2': 'oklch(0.6 0.118 184.704)',
    '--chart-3': 'oklch(0.398 0.07 227.392)',
    '--chart-4': 'oklch(0.828 0.189 84.429)',
    '--chart-5': 'oklch(0.769 0.188 70.08)',

    // Left menu colors
    '--left-menu': 'hsl(210 40% 96.1%)',
    '--left-menu-foreground': 'hsl(215.4 16.3% 46.9%)',
    '--left-menu-hover': 'hsl(0 0% 100%)',
    '--left-menu-active': 'hsl(0 0% 100%)',
    '--left-menu-active-foreground': 'hsl(222.2 47.4% 11.2%)',
    '--left-menu-border': 'hsl(214.3 31.8% 91.4%)',

    '--avatar-yellow': 'hsl(31.3 100% 35.7%)',
    '--avatar-orange': 'hsl(17.1 100% 42%)',
    '--avatar-blue': 'hsl(219.1 66.5% 54.3%)',
    '--avatar-mint': 'hsl(160.2 59.5% 32.9%)',
    '--avatar-brown': 'hsl(21 32.8% 46.1%)',
    '--avatar-grey': 'hsl(60 0.5% 40.6%)',
    '--avatar-pink': 'hsl(339 74.1% 51.6%)',
    '--avatar-turquoise': 'hsl(187.3 59.8% 35.1%)',
    '--avatar-purple': 'hsl(278.9 100% 57.6%)',
    '--avatar-magenta': 'hsl(259 66.5% 54.3%)',
    '--avatar-red': 'hsl(347.1 92.7% 43.1%)',
    '--avatar-green': 'hsl(116.6 47.5% 35.9%)',
    '--avatar-foreground': 'hsl(0 0% 100%)',

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
