// @vitest-environment node

/**
 * Characterises the manifest generator before it learns about frame entries
 * (ADR-0021). A federated package must come out of this refactor unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManifestGenerator } from '../../scripts/lib/manifest-generator';

let root: string;

function writePackage(name: string, mfeJson: unknown, enriched?: unknown): void {
  const dir = join(root, 'packages', name);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'mfe.json'), JSON.stringify(mfeJson));
  if (enriched !== undefined) {
    writeFileSync(join(dir, 'dist', 'mfe-manifest.json'), JSON.stringify(enriched));
  }
}

function generate(basePath: string | null = null): Array<Record<string, unknown>> {
  const out = join(root, 'out.json');
  new ManifestGenerator(join(root, 'packages'), out, 'dist/mfe-manifest.json', null, basePath).run();
  return JSON.parse(readFileSync(out, 'utf-8')) as Array<Record<string, unknown>>;
}

const MF_ENTRY_ID =
  'gts.frontx.mfes.mfe.entry.v1~frontx.mfes.mfe.entry_mf.v1~acme.demo.mfe.main.v1';

/**
 * The package's own mfe.json. A real one declares its entries here too — the
 * generator reads them to tell a federated package from a frame package.
 */
const mfJson = {
  manifest: { id: 'gts.frontx.mfes.mfe.mf_manifest.v1~acme.demo.mfe.manifest.v1' },
  entries: [{ id: MF_ENTRY_ID }],
};

const mfEnriched = {
  manifest: {
    id: 'gts.frontx.mfes.mfe.mf_manifest.v1~acme.demo.mfe.manifest.v1',
    name: 'demo',
    remoteEntry: 'http://localhost:3011/assets/remoteEntry.js',
    metaData: {
      name: 'demo',
      type: 'app',
      buildInfo: { buildVersion: '1', buildName: 'demo' },
      remoteEntry: { name: 'remoteEntry.js', path: 'assets', type: 'module' },
      globalName: 'demo',
      publicPath: 'auto',
    },
    shared: [],
  },
  entries: [
    {
      id: MF_ENTRY_ID,
      requiredProperties: [],
      actions: [],
      domainActions: [],
      exposedModule: './lifecycle',
      exposeAssets: { js: { sync: ['a.js'], async: [] }, css: { sync: [], async: [] } },
    },
  ],
  extensions: [],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mfe-manifests-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ManifestGenerator', () => {
  it('emits a federated package with its remote entry and expose assets', () => {
    writePackage('demo-mfe', mfJson, mfEnriched);

    const [config] = generate();

    expect(config.manifest).toMatchObject({ id: mfEnriched.manifest.id });
    expect(config.entries).toHaveLength(1);
    expect((config.entries as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: MF_ENTRY_ID,
      exposedModule: './lifecycle',
    });
  });

  it('resolves a production public path from --base-path', () => {
    writePackage('demo-mfe', mfJson, mfEnriched);

    const [config] = generate('/mfes');

    const manifest = config.manifest as { metaData: { publicPath: string } };
    expect(manifest.metaData.publicPath).toBe('/mfes/demo-mfe/');
  });

  it("carries a federated package's own domains through untouched", () => {
    const domains = [
      {
        id: 'gts.frontx.mfes.mfe.domain.v1~acme.demo.mfe.settings.v1~',
        sharedProperties: [],
        actions: [],
        extensionsActions: [],
        defaultActionTimeout: 5000,
        lifecycleStages: [],
        extensionsLifecycleStages: [],
      },
    ];
    writePackage('demo-mfe', mfJson, { ...mfEnriched, domains });

    const [config] = generate();

    expect(config.domains).toEqual(domains);
  });

  const IFRAME_ENTRY_ID =
    'gts.frontx.mfes.mfe.entry.v1~constructor_studio.mfes.mfe.entry_iframe.v1~acme.demo.mfe.frame.v1';

  const framePackage = {
    devUrl: 'http://localhost:3080/',
    entries: [
      {
        id: IFRAME_ENTRY_ID,
        requiredProperties: [],
        actions: [],
        domainActions: [],
        urlProperty: 'gts.frontx.mfes.comm.shared_property.v1~acme.demo.frame_url.v1~',
      },
    ],
    extensions: [],
  };

  it('accepts a frame package with no build manifest at all', () => {
    writePackage('frame-mfe', framePackage);

    const [config] = generate();

    expect(config.manifest).toBeUndefined();
    expect((config.entries as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: IFRAME_ENTRY_ID,
      urlProperty: 'gts.frontx.mfes.comm.shared_property.v1~acme.demo.frame_url.v1~',
      publicPath: 'http://localhost:3080/',
    });
  });

  it('serves a frame package from /mfes in a production image', () => {
    writePackage('frame-mfe', framePackage);

    const [config] = generate('/mfes');

    expect((config.entries as Array<Record<string, unknown>>)[0]).toMatchObject({
      publicPath: '/mfes/frame-mfe/',
    });
  });

  it('still refuses a federated package whose build manifest is missing', () => {
    writePackage('demo-mfe', mfJson);

    expect(() => generate()).toThrow(/mfe-manifest\.json not found/);
  });

  it('refuses a package that mixes a federated entry with a frame entry', () => {
    // No enriched dist/mfe-manifest.json is written: the mixture is caught
    // where the branch is chosen, before the federated path ever goes
    // looking for a build to read.
    writePackage('mixed-mfe', {
      manifest: mfJson.manifest,
      entries: [
        { id: MF_ENTRY_ID },
        {
          id: IFRAME_ENTRY_ID,
          requiredProperties: [],
          actions: [],
          domainActions: [],
          urlProperty: 'gts.frontx.mfes.comm.shared_property.v1~acme.demo.frame_url.v1~',
        },
      ],
    });

    expect(() => generate()).toThrow(/mixes a federated entry with a frame entry/);
  });
});
