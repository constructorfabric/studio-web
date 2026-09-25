// @vitest-environment node

/**
 * The stand switch (ADR-0031): `STUDIO_STAND` names the Studio the dev server
 * proxies to and signs in against, and the container's own variable names
 * replace any single value of it.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_STAND, STANDS, renderRuntimeEnv, resolveStand } from '../scripts/lib/stands';

describe('resolveStand', () => {
  it('is the dev stand when nothing is set', () => {
    const stand = resolveStand({});
    expect(stand.name).toBe(DEFAULT_STAND);
    expect(stand.url).toBe('https://studio-dev.cfabric.org');
    expect(stand.issuer).toBe('https://studio-dev.cfabric.org/auth/realms/studio');
    expect(stand.clientId).toBe('studio-portal');
  });

  it('names the stack on the machine as local', () => {
    const stand = resolveStand({ STUDIO_STAND: 'local' });
    expect(stand.name).toBe('local');
    expect(stand.url).toBe('http://127.0.0.1:8090');
    expect(stand.issuer).toBe('https://localhost:8443/realms/studio');
  });

  it('treats a blank name as unset', () => {
    expect(resolveStand({ STUDIO_STAND: '  ' }).name).toBe(DEFAULT_STAND);
  });

  it('refuses a stand it does not know and names the ones it does', () => {
    expect(() => resolveStand({ STUDIO_STAND: 'prod' })).toThrow(/STUDIO_STAND=prod/);
    expect(() => resolveStand({ STUDIO_STAND: 'prod' })).toThrow(new RegExp(Object.keys(STANDS).join(', ')));
  });

  it('replaces one value at a time with the variable the container knows it by', () => {
    const stand = resolveStand({
      STUDIO_STAND: 'local',
      STUDIO_BACKEND_URL: 'http://127.0.0.1:9090/',
    });
    expect(stand.url).toBe('http://127.0.0.1:9090');
    expect(stand.issuer).toBe(STANDS.local.issuer);

    const issuerOnly = resolveStand({ STUDIO_OIDC_ISSUER: 'https://idp.example/realms/x/' });
    expect(issuerOnly.url).toBe(STANDS.dev.url);
    expect(issuerOnly.issuer).toBe('https://idp.example/realms/x');

    expect(resolveStand({ STUDIO_OIDC_CLIENT_ID: 'other' }).clientId).toBe('other');
  });
});

describe('renderRuntimeEnv', () => {
  it('writes what docker/10-runtime-env.sh writes', () => {
    const script = renderRuntimeEnv(resolveStand({ STUDIO_STAND: 'local' }));
    expect(script).toBe(
      'window.__STUDIO_ENV__ = {"OIDC_ISSUER":"https://localhost:8443/realms/studio","OIDC_CLIENT_ID":"studio-portal"};\n',
    );
  });
});
