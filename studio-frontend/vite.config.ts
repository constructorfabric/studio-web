import { defineConfig, loadEnv, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import path from 'path';
import { renderRuntimeEnv, resolveStand, standProxy, type Stand } from './scripts/lib/stands';

/**
 * The dev server stands in for the container (ADR-0031): what nginx and
 * `docker/10-runtime-env.sh` do for a deployed portal — carry the backend
 * paths to a backend, and tell the bundle which IdP to sign in against — Vite
 * does here for the stand `STUDIO_STAND` names (`scripts/lib/stands.ts`). The
 * proxy is `standProxy`; this plugin is the `/env.js`, served ahead of the
 * placeholder in `public/env.js` — which stays, for `vite build`.
 *
 * `vite preview` gets both as well: Vite resolves it as `serve` and hands it
 * `server.proxy`, so a built bundle previewed here faces the same stand the
 * dev server would, with the issuer to match rather than the placeholder's
 * none.
 */
function standRuntimeEnv(stand: Stand, shadowed: string[]): Plugin {
  const serve = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use('/env.js', (_req, res) => {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(renderRuntimeEnv(stand));
    });
    const printUrls = server.printUrls.bind(server);
    server.printUrls = () => {
      printUrls();
      server.config.logger.info(`  ➜  Stand:   ${stand.name} → ${stand.url} (issuer ${stand.issuer})`);
      if (shadowed.length) {
        server.config.logger.warn(
          `  ➜  ${shadowed.join(', ')} set but not read: /env.js carries the stand's issuer and client id`,
        );
      }
    };
  };
  return { name: 'studio-stand-runtime-env', apply: 'serve', configureServer: serve, configurePreviewServer: serve };
}

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  // STUDIO_* from the shell and from .env / .env.local; `envPrefix` stays
  // VITE_, so none of it reaches the bundle. A server has a stand — the dev
  // server, and preview; a build is pointed at one by the container it ends
  // up in. A VITE_OIDC_* value would reach the bundle only to be shadowed by
  // /env.js, so the server says when it sees one.
  const stand = command === 'serve' ? resolveStand(loadEnv(mode, __dirname, 'STUDIO_')) : null;
  const shadowed = stand ? Object.keys(loadEnv(mode, __dirname, 'VITE_OIDC_')) : [];

  return {
    server: {
      port: 5173,
      proxy: stand ? standProxy(stand) : undefined,
    },
    plugins: [
      react(),
      ...(stand ? [standRuntimeEnv(stand, shadowed)] : []),
      federation({
        name: 'host',
        shared: {
          react: { singleton: true, requiredVersion: '^19.0.0' },
          'react-dom': { singleton: true, requiredVersion: '^19.0.0' },
          // Same React Query instance as the host when remotes use federation scope;
          // separately mounted MFEs still receive the host QueryClient via runtime mount context.
          '@tanstack/react-query': {
            singleton: true,
            requiredVersion: '^5.90.0',
          },
        },
      }),
    ],
    resolve: {
      alias: [
        { find: '@', replacement: path.resolve(__dirname, './src-app') },
        // Every entry of use-sync-external-store (shim, with-selector, both)
        // is served by ESM on React 19's own hook. Bundled as CommonJS it
        // blanks the portal; see src-app/app/lib/syncExternalStore.ts.
        {
          find: /^use-sync-external-store(\/shim)?(\/index|\/with-selector)?(\.js)?$/,
          replacement: path.resolve(__dirname, './src-app/app/lib/syncExternalStore.ts'),
        },
      ],
      dedupe: ['@gears-frontx/api', '@gears-frontx/framework', '@gears-frontx/react'],
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react/jsx-runtime', '@globaltypesystem/gts-ts'],
    },
    build: {
      target: 'esnext',
      rollupOptions: {
        output: {
          manualChunks(id) {
            // Split node_modules into vendor chunks
            if (id.includes('node_modules')) {
              // Split React and React DOM separately
              if (id.includes('react-dom')) {
                return 'vendor-react-dom';
              }
              if (id.includes('react/') || id.includes('react\\')) {
                return 'vendor-react';
              }

              // Split large charting library
              if (id.includes('recharts')) {
                return 'vendor-recharts';
              }

              // Split date libraries
              if (id.includes('date-fns') || id.includes('react-day-picker')) {
                return 'vendor-dates';
              }

              // Split carousel library
              if (id.includes('embla-carousel')) {
                return 'vendor-embla';
              }

              // Split drawer library
              if (id.includes('vaul')) {
                return 'vendor-vaul';
              }

              // Split OTP library
              if (id.includes('input-otp')) {
                return 'vendor-input-otp';
              }

              // Split form libraries (react-hook-form + zod + resolvers)
              if (id.includes('react-hook-form') || id.includes('zod') || id.includes('@hookform')) {
                return 'vendor-forms';
              }

              // Split Radix UI primitives (they're relatively small individually but many)
              if (id.includes('@radix-ui')) {
                return 'vendor-radix';
              }

              // Split other large utilities
              if (id.includes('lodash')) {
                return 'vendor-lodash';
              }

              // All other node_modules go to vendor chunk
              return 'vendor';
            }

            // Split framework and react packages into separate chunk
            if (id.includes('@gears-frontx/framework') || id.includes('@gears-frontx/react')) {
              return 'frontx-core';
            }
            // Split React and React DOM
            if (id.includes('react') || id.includes('react-dom')) {
              return 'react';
            }
          },
        },
      },
      // Increase chunk size warning limit or disable it
      chunkSizeWarningLimit: 500,
    },
  };
});
