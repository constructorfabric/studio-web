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
  '@gears-frontx/routing',
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
      name: 'connectionsMfe',
      filename: 'remoteEntry.js',
      exposes: {
        './lifecycle': './src/lifecycle.tsx',
        './overlayLifecycle': './src/overlayLifecycle.tsx',
      },
      // Empty shared config — MF 2.0's shared dep mechanism is bypassed.
      // Shared deps are externalized via rollupOptions.external and provided
      // at runtime by the handler's bare-specifier rewriting.
      shared: {},
      // mf-manifest.json must be generated alongside remoteEntry.js so that
      // MfeHandlerMF can discover expose chunk paths without regex-parsing the bundle.
      manifest: true,
      // The one stylesheet goes to every entry. Without this the plugin credits
      // only an entry whose own chunk imports CSS — see projects-mfe, whose
      // Connect source dialog mounted with no styles at all.
      bundleAllCSS: true,
    }),
    frontxMfGts(),
  ],
  build: {
    target: 'esnext',
    modulePreload: false,
    /** Default Vite prod behavior; MfeHandlerMF integration test asserts compatibility. */
    minify: true,
    /*
     * OFF, and not a preference — the same trap projects-mfe documents. With
     * two exposes Rollup lifts the components they share into a common chunk
     * and emits that chunk's CSS as a third file, which `mf-manifest.json`
     * attributes to neither expose; `exposeAssets.css` misses it and the
     * handler never injects it into the shadow root. Here the shared chunk was
     * named after `connectActions` and carried every ui-kit component rule, so
     * both screens lost them at once: the search magnifier fell out of its
     * field and sat above it, the inputs lost their border, and the Select
     * trigger lost its width.
     *
     * It only became reachable when this MFE gained its second entry — with
     * one expose there was nothing to hoist, which is why the template ships
     * `true` and gets away with it.
     */
    cssCodeSplit: false,
    rollupOptions: {
      // Preserve bare specifiers for shared deps in the output chunks.
      // The handler rewrites these to blob URLs at runtime.
      external: sharedDeps,
    },
  },
});
