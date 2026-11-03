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

export default {
  darkMode: ['class'],
  content: [
    './index.html',
    // Host app chrome (layout, menu, studio, components/ui). MFE packages
    // under src-app/mfe_packages/* build their own CSS and are intentionally
    // excluded here (scanning their node_modules/dist OOMs the host).
    './src-app/app/**/*.{js,ts,jsx,tsx}',
    './src/**/*.{js,ts,jsx,tsx}',
    // The dev panel (@gears-frontx/studio): the stylesheet it injects leaves out
    // some of its classes, the menus' max-height and the switch track among them.
    './node_modules/@gears-frontx/studio/dist/**/*.js',
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
        warning: 'var(--warning)',
        success: 'var(--success)',
        info: 'var(--info)',
      },
      fontFamily: {
        // Resolved from the themed token, like every other value here — so a
        // theme can rebrand the family and nothing else has to change.
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
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
        'heading-2': [
          'var(--text-heading-2-size)',
          { lineHeight: 'var(--text-heading-2-line-height)' },
        ],
        label: ['var(--text-label-size)', { lineHeight: 'var(--text-label-line-height)' }],
        meta: ['var(--text-meta-size)', { lineHeight: 'var(--text-meta-line-height)' }],
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
