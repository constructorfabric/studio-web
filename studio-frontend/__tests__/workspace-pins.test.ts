// Every workspace pins the shared runtime packages exactly as the root does.
// `npm ls` showing one version of each is what keeps one framework runtime per
// page (framework allows one `build()`); a pin missed in one MFE during a bump
// installs a nested copy that no other test notices (#946).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACES = path.join(ROOT, 'src-app', 'mfe_packages');
/** The root package itself, linked into the workspaces through `overrides`: not a pin. */
const SELF = '@gears-frontx/frontx-template-shell';
const SHARED_RUNTIME = /^(@gears-frontx\/|@tanstack\/react-query$|@reduxjs\/toolkit$|react-redux$)/;

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest;
}

function pinsOf(manifest: Manifest): Map<string, string> {
  const declared = { ...manifest.devDependencies, ...manifest.dependencies };
  return new Map(Object.entries(declared).filter(([name]) => SHARED_RUNTIME.test(name) && name !== SELF));
}

const rootPins = pinsOf(readManifest(ROOT));
const workspaces = readdirSync(WORKSPACES)
  .map((entry) => path.join(WORKSPACES, entry))
  .filter((dir) => existsSync(path.join(dir, 'package.json')));

describe('workspace pins', () => {
  it('reads the root pins and the workspaces', () => {
    expect(rootPins.get('@gears-frontx/framework')).toBeDefined();
    expect(workspaces.length).toBeGreaterThan(0);
  });

  it.each(workspaces.map((dir) => [path.basename(dir), dir]))(
    '%s pins every shared runtime package as the root does',
    (_name, dir) => {
      const manifest = readManifest(dir);
      for (const [name, version] of pinsOf(manifest)) {
        expect(rootPins.get(name), `${manifest.name}: ${name} is not pinned at the root`).toBeDefined();
        expect(version, `${manifest.name}: ${name}`).toBe(rootPins.get(name));
      }
    }
  );
});
