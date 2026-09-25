import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import path from 'path';
import { renderRuntimeEnv, resolveStand, type Stand } from './scripts/lib/stands';

/**
 * The dev server stands in for the container (ADR-0031): what nginx and
 * `docker/10-runtime-env.sh` do for a deployed portal — carry the backend
 * paths to a backend, and tell the bundle which IdP to sign in against — Vite
 * does here for the stand `STUDIO_STAND` names (`scripts/lib/stands.ts`).
 */
function standProxy(stand: Stand): Record<string, ProxyOptions> {
  return {
    // The gateway. nginx.conf.template mirrors this as `location /cf/`.
    '/cf': { target: stand.url, changeOrigin: true },
    // An IDE session: the portal frames `/studio/{id}/` and Theia opens its
    // WebSocket under it (ADR-0021). The session pod admits only its own
    // origin — `Origin` against `Host`, which is what nginx sends on a stand —
    // so the proxy presents the stand's origin, not this dev server's.
    '/studio': { target: stand.url, changeOrigin: true, ws: true, headers: { origin: stand.url } },
  };
}

function standRuntimeEnv(stand: Stand): Plugin {
  return {
    name: 'studio-stand-runtime-env',
    apply: 'serve',
    configureServer(server) {
      // Registered ahead of Vite's own middlewares, so this answers before the
      // placeholder in public/env.js — which stays, for `vite build`.
      server.middlewares.use('/env.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(renderRuntimeEnv(stand));
      });
      const printUrls = server.printUrls.bind(server);
      server.printUrls = () => {
        printUrls();
        server.config.logger.info(`  ➜  Stand:   ${stand.name} → ${stand.url} (issuer ${stand.issuer})`);
      };
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  // STUDIO_* from the shell and from .env / .env.local; `envPrefix` stays
  // VITE_, so none of it reaches the bundle. Only the dev server has a stand:
  // a build is pointed at one by the container it ends up in.
  const stand = command === 'serve' ? resolveStand(loadEnv(mode, __dirname, 'STUDIO_')) : null;

  return {
    server: {
      port: 5173,
      proxy: stand ? standProxy(stand) : undefined,
    },
    plugins: [
      react(),
      ...(stand ? [standRuntimeEnv(stand)] : []),
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
      alias: {
        '@': path.resolve(__dirname, './src-app'),
      },
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
