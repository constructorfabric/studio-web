/**
 * Runtime environment for the portal.
 *
 * Resolution order: `window.__STUDIO_ENV__` (`/env.js`, written at container
 * start by docker/10-runtime-env.sh — the same image runs in every environment
 * without a rebuild — and served by the dev server for the stand it faces,
 * scripts/lib/stands.ts) wins over the build-time `VITE_*` variables, the
 * fallback for a build served without either. Both may be absent — callers
 * own defaults.
 */

export interface StudioRuntimeEnv {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  DISCORD_URL?: string;
}

declare global {
  interface Window {
    __STUDIO_ENV__?: StudioRuntimeEnv;
  }
}

function runtime(): StudioRuntimeEnv {
  return typeof window !== 'undefined' ? (window.__STUDIO_ENV__ ?? {}) : {};
}

export const env = {
  get oidcIssuer(): string | undefined {
    return runtime().OIDC_ISSUER || (import.meta.env.VITE_OIDC_ISSUER as string | undefined);
  },
  get oidcClientId(): string | undefined {
    return runtime().OIDC_CLIENT_ID || (import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined);
  },
  get discordUrl(): string | undefined {
    return runtime().DISCORD_URL || (import.meta.env.VITE_DISCORD_URL as string | undefined);
  },
};
