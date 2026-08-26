// @cpt-dod:cpt-frontx-dod-mfe-isolation-mf-vite-plugin:p1
// @cpt-flow:cpt-frontx-flow-mfe-isolation-build-v2:p2
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { frontxMfGts } from '@gears-frontx/frontx-template-shell/build/mf-gts';

const sharedDeps = [
  'react',
  'react-dom',
  '@gears-frontx/react',
  '@gears-frontx/framework',
  '@gears-frontx/state',
  '@gears-frontx/mfes',
  '@gears-frontx/gts-plugin',
  '@gears-frontx/api',
  '@gears-frontx/i18n',
  '@tanstack/react-query',
  '@reduxjs/toolkit',
  'react-redux',
];

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'projectsMfe',
      filename: 'remoteEntry.js',
      exposes: {
        './lifecycle': './src/lifecycle.tsx',
        // Second entry, not a second MFE: the New project wizard mounts into
        // the shell's overlay domain while the screen entry stays mounted
        // behind the scrim, and one lifecycle singleton cannot hold two roots.
        './wizardLifecycle': './src/wizardLifecycle.tsx',
      },
      // Empty shared config — MF 2.0's shared dep mechanism is bypassed.
      // Shared deps are externalized via rollupOptions.external and provided
      // at runtime by the handler's bare-specifier rewriting.
      shared: {},
      // mf-manifest.json must be generated alongside remoteEntry.js so that
      // MfeHandlerMF can discover expose chunk paths without regex-parsing the bundle.
      manifest: true,
    }),
    frontxMfGts(),
  ],
  build: {
    target: 'esnext',
    modulePreload: false,
    /** Default Vite prod behavior; MfeHandlerMF integration test asserts compatibility. */
    minify: true,
    /*
     * OFF, and not a preference. With two exposes Rollup lifts the components
     * they share into a common chunk and emits that chunk's CSS as a third
     * file — and `mf-manifest.json` attributes it to neither expose, so
     * `exposeAssets.css` misses it and the handler never injects it into the
     * shadow root. The visible symptom was the projects toolbar losing the
     * ui-kit Input's `_wrap_`/`_icon_` rules: the search magnifier fell out of
     * the field and sat above it.
     *
     * One bundle per expose costs each entry the other's styles — some tens of
     * kilobytes inside one MFE — which is cheaper than teaching the manifest
     * enricher to walk the chunk graph, and cheaper than the class of bug it
     * removes.
     */
    cssCodeSplit: false,
    rollupOptions: {
      // Preserve bare specifiers for shared deps in the output chunks.
      // The handler rewrites these to blob URLs at runtime.
      external: sharedDeps,
    },
  },
});
