/**
 * Which Studio the dev server talks to — the stand switch (ADR-0031).
 *
 * The portal reaches its backend through same-origin paths (`/cf/*` for the
 * gateway, `/studio/*` for an IDE session) and learns its IdP from
 * `window.__STUDIO_ENV__`. In a container nginx carries the paths to
 * BACKEND_HOST and `docker/10-runtime-env.sh` writes the env; in development
 * Vite does both, and this module decides *for which Studio*.
 *
 * `STUDIO_STAND` names one of the stands below, `dev` when unset. Any single
 * value can then be replaced with the variable the container knows it by:
 * `STUDIO_BACKEND_URL`, `STUDIO_OIDC_ISSUER`, `STUDIO_OIDC_CLIENT_ID` — and
 * `STUDIO_DISCORD_URL` adds the invite a stand's header links. Vite reads
 * them from the shell and from `.env` / `.env.local` (gitignored) next to
 * `vite.config.ts`; none of them reaches the bundle.
 */

import type { ProxyOptions } from 'vite';

export interface Stand {
  /** The name it was chosen by — for the log line, nothing else. */
  name: string;
  /** The origin `/cf` and `/studio` are proxied to. No trailing slash. */
  url: string;
  /** The realm the browser signs in against, as `OIDC_ISSUER`. No trailing slash. */
  issuer: string;
  clientId: string;
  /** The invite the header links, as `DISCORD_URL`; a stand may have none. */
  discordUrl?: string;
}

type StandEnv = Readonly<Record<string, string | undefined>>;

const CLIENT_ID = 'studio-portal';

/**
 * A shared stand publishes the gateway and its Keycloak behind one hostname —
 * `/cf` and `/auth`, as the Helm chart lays them out. The stack on the machine
 * publishes the backend and Keycloak on ports of their own, so `local` is two
 * addresses: the ones `docker-compose.yml` binds, and the same two a backend
 * started with `cargo run` answers on.
 *
 * `dev` and `test` are the addresses `theia/electron-app/environments.json`
 * holds for the desktop, and a test keeps the two files equal. `local` differs
 * there on purpose: a browser signs in at `https://localhost:8443`, the
 * hostname the compose Keycloak's certificate names, while the desktop's
 * backend reaches the same Keycloak on the plain-HTTP `:8088` the compose file
 * binds for a process on the host.
 */
export const STANDS: Readonly<Record<string, Readonly<Omit<Stand, 'name'>>>> = {
  dev: {
    url: 'https://studio-dev.cfabric.org',
    issuer: 'https://studio-dev.cfabric.org/auth/realms/studio',
    clientId: CLIENT_ID,
  },
  test: {
    url: 'https://studio-test.cfabric.org',
    issuer: 'https://studio-test.cfabric.org/auth/realms/studio',
    clientId: CLIENT_ID,
  },
  local: {
    url: 'http://127.0.0.1:8090',
    issuer: 'https://localhost:8443/realms/studio',
    clientId: CLIENT_ID,
  },
};

export const DEFAULT_STAND = 'dev';

function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Turn the environment into a stand. Throws on a name this checkout does not
 * know — at config load, before a dev server comes up pointed at nothing.
 */
export function resolveStand(env: StandEnv): Stand {
  const name = value(env.STUDIO_STAND) ?? DEFAULT_STAND;
  const known = STANDS[name];
  if (!known) {
    throw new Error(
      `STUDIO_STAND=${name} is not a stand this checkout knows; one of ${Object.keys(STANDS).join(', ')}`,
    );
  }
  return {
    name,
    url: withoutTrailingSlash(value(env.STUDIO_BACKEND_URL) ?? known.url),
    issuer: withoutTrailingSlash(value(env.STUDIO_OIDC_ISSUER) ?? known.issuer),
    clientId: value(env.STUDIO_OIDC_CLIENT_ID) ?? known.clientId,
    discordUrl: value(env.STUDIO_DISCORD_URL),
  };
}

/**
 * What nginx does with the two backend paths (`nginx.conf.template`), for the
 * dev server to do. `/cf/` goes to the backend as it is. `/studio/{id}/` is an
 * IDE session: nginx rewrites it to the backend's
 * `/cf/studio-session/v1/ide/{id}/` and carries the WebSocket under it, and so
 * does this — on a stand the Ingress sends `/cf` straight to the backend, and
 * `local` is a bare backend with no nginx in front. The session pod admits
 * only its own origin (`Origin` against `Host`, which is what nginx sends on
 * a stand), so that one path presents the stand's origin; `/cf` carries the
 * browser's headers as they are.
 *
 * Presenting it hides the browser's own `Origin` from the pod, so the proxy
 * makes the pod's comparison first, against the dev server's own host. The
 * session cookies are the browser's for every port of `localhost`, and
 * without this a page on any of them would reach the session as the stand
 * (#501).
 */
export function standProxy(stand: Stand): Record<string, ProxyOptions> {
  return {
    '/cf': { target: stand.url, changeOrigin: true },
    '/studio': {
      target: stand.url,
      changeOrigin: true,
      ws: true,
      headers: { origin: stand.url },
      bypass: (req) => (isOwnOrigin(req.headers.origin, req.headers.host) ? undefined : false),
      rewrite: (path) => path.replace(/^\/studio\//, '/cf/studio-session/v1/ide/'),
    },
  };
}

/** Absent (a navigation) or the dev server's own, as Theia's `WsOriginValidator` has it. */
function isOwnOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * The `/env.js` a container starts with, for the dev server to serve: the
 * `window.__STUDIO_ENV__` that `docker/10-runtime-env.sh` writes, with the
 * keys `src-app/app/config/env.ts` reads before the bundle runs.
 */
export function renderRuntimeEnv(stand: Stand): string {
  const runtimeEnv = { OIDC_ISSUER: stand.issuer, OIDC_CLIENT_ID: stand.clientId, DISCORD_URL: stand.discordUrl };
  return `window.__STUDIO_ENV__ = ${JSON.stringify(runtimeEnv)};\n`;
}
