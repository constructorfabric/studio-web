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
 * `STUDIO_BACKEND_URL`, `STUDIO_OIDC_ISSUER`, `STUDIO_OIDC_CLIENT_ID`. Vite
 * reads all four from the shell and from `.env` / `.env.local` (gitignored)
 * next to `vite.config.ts`; none of them reaches the bundle.
 */

export interface Stand {
  /** The name it was chosen by — for the log line, nothing else. */
  name: string;
  /** The origin `/cf` and `/studio` are proxied to. No trailing slash. */
  url: string;
  /** The realm the browser signs in against, as `OIDC_ISSUER`. No trailing slash. */
  issuer: string;
  clientId: string;
}

export type StandEnv = Readonly<Record<string, string | undefined>>;

const CLIENT_ID = 'studio-portal';

/**
 * A shared stand publishes the gateway and its Keycloak behind one hostname —
 * `/cf` and `/auth`, as the Helm chart lays them out. The stack on the machine
 * publishes the backend and Keycloak on ports of their own, so `local` is two
 * addresses: the ones `docker-compose.yml` binds, and the same two a backend
 * started with `cargo run` answers on. The list mirrors
 * `theia/electron-app/environments.json`, which is the desktop's copy of it.
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
  };
}

/**
 * The `/env.js` a container starts with, for the dev server to serve: the
 * same `window.__STUDIO_ENV__` that `docker/10-runtime-env.sh` writes, read
 * by `src-app/app/config/env.ts` before the bundle runs.
 */
export function renderRuntimeEnv(stand: Stand): string {
  const runtimeEnv = { OIDC_ISSUER: stand.issuer, OIDC_CLIENT_ID: stand.clientId };
  return `window.__STUDIO_ENV__ = ${JSON.stringify(runtimeEnv)};\n`;
}
