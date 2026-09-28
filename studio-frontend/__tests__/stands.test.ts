// @vitest-environment node

/**
 * The stand switch (ADR-0031): `STUDIO_STAND` names the Studio the dev server
 * proxies to and signs in against, and the container's own variable names
 * replace any single value of it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STAND, STANDS, renderRuntimeEnv, resolveStand, standProxy } from '../scripts/lib/stands';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

  it('names dev and test as the desktop does', () => {
    // theia/electron-app/environments.json is the desktop's copy of the table;
    // `local` differs there on purpose (see the comment on STANDS).
    const desktop: { id: string; studioUrl: string; issuer: string }[] = JSON.parse(
      readFileSync(path.resolve(HERE, '../../theia/electron-app/environments.json'), 'utf-8'),
    );
    for (const name of ['dev', 'test']) {
      const entry = desktop.find((e) => e.id === name);
      expect(entry, name).toBeDefined();
      expect(entry?.studioUrl).toBe(STANDS[name].url);
      expect(entry?.issuer).toBe(STANDS[name].issuer);
    }
  });
});

describe('standProxy', () => {
  it('rewrites /studio to the session route with the stand as origin, and leaves /cf alone', () => {
    const proxy = standProxy(resolveStand({ STUDIO_STAND: 'local' }));
    expect(proxy['/cf']).toEqual({ target: 'http://127.0.0.1:8090', changeOrigin: true });

    const studio = proxy['/studio'];
    expect(studio.target).toBe('http://127.0.0.1:8090');
    expect(studio.ws).toBe(true);
    expect(studio.headers).toEqual({ origin: 'http://127.0.0.1:8090' });
    expect(studio.rewrite?.('/studio/abc123/services?id=1')).toBe('/cf/studio-session/v1/ide/abc123/services?id=1');
  });
});

describe('renderRuntimeEnv', () => {
  it("serves the stand's issuer and client id as window.__STUDIO_ENV__", () => {
    const script = renderRuntimeEnv(resolveStand({ STUDIO_STAND: 'local' }));
    expect(script).toBe(
      'window.__STUDIO_ENV__ = {"OIDC_ISSUER":"https://localhost:8443/realms/studio","OIDC_CLIENT_ID":"studio-portal"};\n',
    );
  });

  it('carries the Discord invite when STUDIO_DISCORD_URL names one', () => {
    const script = renderRuntimeEnv(resolveStand({ STUDIO_DISCORD_URL: 'https://discord.gg/x' }));
    expect(script).toContain('"DISCORD_URL":"https://discord.gg/x"');
  });
});
