/**
 * ESLint configuration for studio-frontend: the host app and its MFE packages
 * (`src-app/`) and the shell's own library (`src/`). The FrontX packages come
 * from npm (#946) and are not linted here.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // Global ignores
  {
    ignores: [
      'dist/**',
      '**/dist/**',
      'dist-lib/**', // tsup output of the template's own library build
      '**/.__mf__temp/**',
      '**/coverage/**',
      'node_modules/**',
      '*.config.*',
      '**/*.config.*',
      '**/*.cjs',
      'scripts/**',
    ],
  },

  // Base JS + TypeScript
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // L0 BASE: Universal rules for all TS/TSX files
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2020,
        ...globals.node,
      },
    },
    plugins: {
      'unused-imports': unusedImports,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false },
      ],
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-wrapper-object-types': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
      'no-var': 'error',
      'no-empty-pattern': 'error',
    },
  },

  // React hooks
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules, 'react-hooks/exhaustive-deps': 'error' },
  },

  // Additional ignores
  {
    ignores: [
      '**/dist/**', // All dist directories are build artifacts
      '**/*.__mf__temp/**', // Module Federation generated temp files
      '**/.__mf__temp/**', // Module Federation generated temp files (dot-prefixed)
      'scripts/**',
      '**/.vitepress/**',
      '.dependency-cruiser.cjs',
    ],
  },

  // ============ @gears-frontx/frontx-template-shell (package root, src/) ============
  // Allow unknown/object types: build utilities (mf-gts.ts AST transforms, lazy-import-transform)
  // use unknown for dynamic module shapes and generic AST node types — architecturally required.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  // Layout components: Allow unknown types for API registry type assertions
  {
    files: ['src-app/layout/**/*.tsx', 'src-app/layout/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        // Keep flux/lodash rules but remove TSUnknownKeyword restriction
        {
          selector: "CallExpression[callee.name='dispatch'] > MemberExpression[object.name='store']",
          message: 'FLUX VIOLATION: Components must not call store.dispatch directly. Use actions instead.',
        },
      ],
    },
  },

  // MFE packages: Each MFE is fully self-contained — no imports from host or other MFEs
  {
    files: ['src-app/mfe_packages/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../app/*', '../../app/**'],
              message:
                'MFE VIOLATION: MFE packages cannot import from the host app. MFEs must be self-contained.',
            },
            {
              group: ['../*-mfe/*', '../*-mfe/**', '../_*/*', '../_*/**'],
              message:
                'MFE VIOLATION: MFE packages cannot import from other MFE packages. Each MFE must be self-contained.',
            },
            {
              group: ['@gears-frontx/ui-kit/toast'],
              message:
                "MFE VIOLATION: an MFE shows a toast with useNotify from mfe-shared. The kit's toast in an MFE realm is dropped silently.",
            },
            {
              group: ['@gears-frontx/ui-kit'],
              importNames: ['toast', 'Toaster', 'useToastManager', 'createToastManager'],
              message:
                "MFE VIOLATION: an MFE shows a toast with useNotify from mfe-shared. The kit's toast in an MFE realm is dropped silently.",
            },
          ],
        },
      ],
    },
  },

  // App: Layer enforcement for src-app/app/** (must use @gears-frontx/react, not L1/L2 packages)
  {
    files: ['src-app/app/**/*.{ts,tsx}'],
    rules: {
      // Use @typescript-eslint rule to catch TypeScript-specific imports (import type, side-effect imports)
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@gears-frontx/framework', '@gears-frontx/framework/*'],
              message:
                'LAYER VIOLATION: App-layer code must import from @gears-frontx/react, not directly from @gears-frontx/framework (Layer 2).',
            },
            {
              group: ['@gears-frontx/state', '@gears-frontx/state/*'],
              message:
                'LAYER VIOLATION: App-layer code must import from @gears-frontx/react, not directly from @gears-frontx/state (Layer 1).',
            },
            {
              group: ['@gears-frontx/api', '@gears-frontx/api/*'],
              message:
                'LAYER VIOLATION: App-layer code must import from @gears-frontx/react, not directly from @gears-frontx/api (Layer 1).',
            },
            {
              group: ['@gears-frontx/i18n', '@gears-frontx/i18n/*'],
              message:
                'LAYER VIOLATION: App-layer code must import from @gears-frontx/react, not directly from @gears-frontx/i18n (Layer 1).',
            },
            {
              group: ['@gears-frontx/mfes', '@gears-frontx/mfes/*', '@gears-frontx/gts-plugin', '@gears-frontx/gts-plugin/*'],
              message:
                'LAYER VIOLATION: App-layer code must import from @gears-frontx/react, not directly from @gears-frontx/mfes (Layer 1).',
            },
            // Redux term bans - use FrontX state terms instead
            {
              group: ['react-redux'],
              importNames: ['useDispatch'],
              message:
                'REDUX VIOLATION: Do not use useDispatch from react-redux. Use useAppDispatch from @gears-frontx/react instead.',
            },
            {
              group: ['react-redux'],
              importNames: ['useSelector'],
              message:
                'REDUX VIOLATION: Do not use useSelector from react-redux. Use useAppSelector from @gears-frontx/react instead.',
            },
          ],
        },
      ],
    },
  },

  // App: Studio should only be imported via FrontXProvider (auto-detection)
  // Only App.tsx variants are allowed to import StudioOverlay directly
  {
    files: ['src-app/**/*'],
    ignores: [
      'src-app/app/App.tsx', // Monorepo demo app - renders StudioOverlay
      'src-app/app/App.no-uikit.tsx', // --uikit none variant - renders StudioOverlay
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@gears-frontx/studio', '@gears-frontx/studio/**'],
              message:
                'STUDIO VIOLATION: Studio should not be imported directly in app code. FrontXProvider auto-detects and loads Studio in development mode.',
            },
          ],
        },
      ],
    },
  },
];
