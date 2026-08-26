/**
 * Dracula theme for FrontX
 * Based on the classic Dracula color scheme
 * CSS custom properties map following shadcn/ui variable naming convention.
 */
// @cpt-algo:cpt-frontx-algo-ui-libraries-choice-theme-propagation:p1

import type { ThemeConfig } from '@gears-frontx/react';

/**
 * Dracula theme ID
 */
export const DRACULA_THEME_ID = 'dracula' as const;

/**
 * Dracula color palette
 * Official Dracula colors: https://draculatheme.com/contribute
 */
const dracula = {
  purple: 'hsl(265 89% 78%)',       // #bd93f9
  comment: 'hsl(225 27% 51%)',      // #6272a4
  pink: 'hsl(326 100% 74%)',        // #ff79c6
  background: 'hsl(231 15% 18%)',   // #282a36
  foreground: 'hsl(60 30% 96%)',    // #f8f8f2
  currentLine: 'hsl(232 14% 31%)',  // #44475a
  red: 'hsl(0 100% 67%)',           // #ff5555
  yellow: 'hsl(65 92% 76%)',        // #f1fa8c
  green: 'hsl(135 94% 65%)',        // #50fa7b
  cyan: 'hsl(191 97% 77%)',         // #8be9fd
  backgroundDark: 'hsl(231 15% 14%)', // darker variant
};

export const draculaTheme: ThemeConfig = {
  id: DRACULA_THEME_ID,
  name: 'Dracula',
  variables: {
    // Shadcn color variables
    '--background': dracula.background,
    '--foreground': dracula.foreground,
    '--card': dracula.background,
    '--card-foreground': dracula.foreground,
    '--popover': dracula.background,
    '--popover-foreground': dracula.foreground,
    '--primary': dracula.purple,
    '--primary-foreground': dracula.background,
    '--secondary': dracula.comment,
    '--secondary-foreground': dracula.foreground,
    '--muted': dracula.currentLine,
    '--muted-foreground': dracula.foreground,
    '--accent': dracula.pink,
    '--accent-foreground': dracula.background,
    '--destructive': dracula.red,
    '--destructive-foreground': dracula.foreground,
    '--border': dracula.currentLine,
    '--input': dracula.currentLine,
    '--ring': dracula.purple,

    // State colors
    '--error': dracula.red,
    '--warning': dracula.yellow,
    '--success': dracula.green,
    '--info': dracula.cyan,

    // Chart colors (OKLCH format, Dracula-inspired palette)
    '--chart-1': 'oklch(0.714 0.203 313.26)',
    '--chart-2': 'oklch(0.799 0.194 145.19)',
    '--chart-3': 'oklch(0.821 0.173 85.29)',
    '--chart-4': 'oklch(0.71 0.191 349.76)',
    '--chart-5': 'oklch(0.822 0.131 194.77)',

    // Left menu colors
    '--left-menu': dracula.backgroundDark,
    '--left-menu-foreground': dracula.comment,
    '--left-menu-hover': dracula.currentLine,
    '--left-menu-active': dracula.currentLine,
    '--left-menu-active-foreground': dracula.foreground,
    '--left-menu-border': dracula.currentLine,

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
    '--shadow-sm': '0 1px 2px 0 rgba(0, 0, 0, 0.4)',
    '--shadow-md': '0 4px 6px -1px rgba(0, 0, 0, 0.5)',
    '--shadow-lg': '0 10px 15px -3px rgba(0, 0, 0, 0.6)',
    '--shadow-xl': '0 20px 25px -5px rgba(0, 0, 0, 0.7)',

    // Transitions
    '--transition-fast': '150ms',
    '--transition-base': '200ms',
    '--transition-slow': '300ms',
    '--transition-slower': '500ms',
  },
};
