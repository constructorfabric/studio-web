import type { Config } from 'tailwindcss';
import tailwindcssAnimate from 'tailwindcss-animate';

/**
 * Theme tokens hold WHOLE colours (`--border: hsl(214.3 31.8% 91.4%)`), not the
 * bare HSL triplets shadcn's older convention used. That is what lets a
 * @gears-frontx/ui-kit component — whose CSS writes `var(--popover)` directly —
 * paint correctly inside the shell, instead of receiving three numbers CSS
 * cannot resolve as a colour. Consequence for this file: colours are referenced
 * as `var(--x)`, never `hsl(var(--x))`. See docs/adr/0007.
 */

/**
 * A colour that still honours Tailwind's `/NN` opacity modifier. Whole colours
 * have no channel slot, so alpha is applied by mixing towards transparent.
 */
const mixable = (token: string) =>
  `color-mix(in oklab, var(${token}) calc(<alpha-value> * 100%), transparent)`;

export default {
  darkMode: ['class'],
  content: [
    './index.html',
    // Host app chrome (layout, menu, studio, components/ui). MFE packages
    // under src-app/mfe_packages/* build their own CSS and are intentionally
    // excluded here (scanning their node_modules/dist OOMs the host).
    './src-app/app/**/*.{js,ts,jsx,tsx}',
    './src/**/*.{js,ts,jsx,tsx}',
    // Workspace package sources + built output (e.g. @gears-frontx/react UI)
    './packages/*/src/**/*.{js,ts,jsx,tsx}',
    './packages/*/dist/**/*.{js,mjs}',
  ],
  safelist: [
    // RTL utilities used in package components
    'rtl:flex-row-reverse',
    'rtl:rotate-180',
    'rtl:-translate-x-4',
    'ms-auto',  // Direction-aware margin (margin-inline-start: auto)
    // Data attribute + RTL combos for Switch
    'data-[state=checked]:ltr:translate-x-4',
    'data-[state=checked]:rtl:-translate-x-4',
    // ARIA invalid state for form elements
    'aria-[invalid=true]:ring-2',
    'aria-[invalid=true]:ring-destructive/30',
    'aria-[invalid=true]:border-destructive',
    // Calendar cell size CSS variable
    '[--cell-size:2.75rem]',
    'md:[--cell-size:3rem]',
  ],
  theme: {
    extend: {
      colors: {
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        error: 'var(--error)',
        warning: 'var(--warning)',
        success: 'var(--success)',
        info: 'var(--info)',
        // The only colours here that honour an opacity modifier: the menu's
        // hover surface is the raised surface at partial opacity, which needs
        // `bg-mainMenu-hover/65` to resolve. Tokens are whole colours now, and a
        // whole colour has no channel slot to inject alpha into — so the
        // modifier goes through color-mix instead of `hsl(... / <alpha-value>)`.
        // Tailwind substitutes <alpha-value> literally (1 when no modifier is
        // written), so the unmodified form stays fully opaque. The rest of the
        // palette omits the slot; extend the same way if that is ever needed.
        mainMenu: {
          DEFAULT: mixable('--left-menu'),
          foreground: mixable('--left-menu-foreground'),
          hover: mixable('--left-menu-hover'),
          active: {
            DEFAULT: mixable('--left-menu-active'),
            foreground: mixable('--left-menu-active-foreground'),
          },
          border: mixable('--left-menu-border'),
        },
        // Categorical palette an avatar picks from deterministically by name.
        // The hue names and their order are the contract — the index an avatar
        // resolves to is a position in that order, so reordering repaints every
        // avatar in the product. Keep in step with AVATAR_HUES in ui/avatar.tsx.
        avatar: {
          yellow: 'var(--avatar-yellow)',
          orange: 'var(--avatar-orange)',
          blue: 'var(--avatar-blue)',
          mint: 'var(--avatar-mint)',
          brown: 'var(--avatar-brown)',
          grey: 'var(--avatar-grey)',
          pink: 'var(--avatar-pink)',
          turquoise: 'var(--avatar-turquoise)',
          purple: 'var(--avatar-purple)',
          magenta: 'var(--avatar-magenta)',
          red: 'var(--avatar-red)',
          green: 'var(--avatar-green)',
          foreground: 'var(--avatar-foreground)',
        },
      },
      fontFamily: {
        // Resolved from the themed token, like every other value here — so a
        // theme can rebrand the family and nothing else has to change.
        sans: 'var(--font-sans)',
      },
      fontSize: {
        // Named text roles, mirroring ui-kit's ramp. Each carries the role's
        // line-height with it, so size and leading can never drift apart at a
        // call site. Only the roles the shell renders live here.
        body: ['var(--text-body-size)', { lineHeight: 'var(--text-body-line-height)' }],
        'heading-1': [
          'var(--text-heading-1-size)',
          { lineHeight: 'var(--text-heading-1-line-height)' },
        ],
        label: ['var(--text-label-size)', { lineHeight: 'var(--text-label-line-height)' }],
      },
      spacing: {
        xs: 'var(--spacing-xs)',
        sm: 'var(--spacing-sm)',
        md: 'var(--spacing-md)',
        lg: 'var(--spacing-lg)',
        xl: 'var(--spacing-xl)',
        '2xl': 'var(--spacing-2xl)',
        '3xl': 'var(--spacing-3xl)',
      },
      borderRadius: {
        none: '0',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        full: '9999px',
      },
      zIndex: {
        dropdown: '1000',
        sticky: '1020',
        fixed: '1030',
        modal: '1040',
        popover: '1050',
        tooltip: '1060',
      },
      transitionDuration: {
        fast: '150ms',
        base: '200ms',
        slow: '300ms',
        slower: '500ms',
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
