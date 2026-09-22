#!/usr/bin/env node

/**
 * CLI entry point for the MFE manifest generator.
 *
 * Usage: npx tsx scripts/generate-mfe-manifests.ts [--base-url <url> | --base-path <path>]
 */

import { join } from 'node:path';
import { ManifestGenerator } from './lib/manifest-generator.js';

function parseArgs(argv: string[]): { baseUrl: string | null; basePath: string | null } {
  const idx = argv.indexOf('--base-url');
  const baseUrl = idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : null;
  const pathIdx = argv.indexOf('--base-path');
  const basePath = pathIdx !== -1 && pathIdx + 1 < argv.length ? argv[pathIdx + 1] : null;
  if (baseUrl !== null && basePath !== null) {
    throw new Error('--base-url and --base-path are mutually exclusive');
  }
  return { baseUrl, basePath };
}

const { baseUrl, basePath } = parseArgs(process.argv.slice(2));

const MFE_PACKAGES_DIR = join(process.cwd(), 'src-app/mfe_packages');
const OUTPUT_FILE = join(process.cwd(), 'public/generated-mfe-manifests.json');
const MFE_MANIFEST_PATH = 'dist/mfe-manifest.json';

try {
  new ManifestGenerator(
    MFE_PACKAGES_DIR,
    OUTPUT_FILE,
    MFE_MANIFEST_PATH,
    baseUrl,
    basePath,
  ).run();
} catch (err) {
  console.error('Error generating MFE manifests:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
