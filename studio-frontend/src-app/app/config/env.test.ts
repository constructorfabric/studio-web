import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './env';

describe('env', () => {
  afterEach(() => {
    delete window.__STUDIO_ENV__;
    vi.unstubAllEnvs();
  });

  it('returns undefined when neither runtime nor build-time value exists', () => {
    expect(env.oidcIssuer).toBeUndefined();
    expect(env.oidcClientId).toBeUndefined();
    expect(env.discordUrl).toBeUndefined();
  });

  it('falls back to VITE_* build-time variables', () => {
    vi.stubEnv('VITE_OIDC_ISSUER', 'https://idp.example/realms/x');
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'client-from-vite');

    expect(env.oidcIssuer).toBe('https://idp.example/realms/x');
    expect(env.oidcClientId).toBe('client-from-vite');
  });

  it('prefers window.__STUDIO_ENV__ over build-time variables', () => {
    vi.stubEnv('VITE_OIDC_ISSUER', 'https://build-time.example');
    window.__STUDIO_ENV__ = { OIDC_ISSUER: 'https://runtime.example' };

    expect(env.oidcIssuer).toBe('https://runtime.example');
  });

  it('treats an empty runtime value as absent (container omits empty vars)', () => {
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'fallback-client');
    window.__STUDIO_ENV__ = { OIDC_CLIENT_ID: '' };

    expect(env.oidcClientId).toBe('fallback-client');
  });
});
