// @cpt-dod:cpt-frontx-dod-mfe-isolation-mf-vite-plugin:p1

/**
 * Assembles public/generated-mfe-manifests.json from every package under
 * src-app/mfe_packages/ that carries an mfe.json.
 *
 * Lives beside mfe-tools.ts rather than in the CLI script so it can be
 * imported by a test without the script's argv parsing running on import.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Raw JSON shape types (what we read from the enriched mfe-manifest.json on disk)
// ---------------------------------------------------------------------------

interface RawMetaData {
  name: string;
  type: string;
  buildInfo: { buildVersion: string; buildName: string };
  remoteEntry: { name: string; path: string; type: string };
  globalName: string;
  publicPath: string;
}

interface RawShared {
  name: string;
  version: string;
  chunkPath: string;
  unwrapKey: string | null;
}

interface RawExposeAssets {
  js: { async: string[]; sync: string[] };
  css: { async: string[]; sync: string[] };
}

interface RawEntry {
  id: string;
  requiredProperties: string[];
  optionalProperties?: string[];
  actions: string[];
  domainActions: string[];
  manifest: string;
  exposedModule: string;
  exposeAssets: RawExposeAssets;
}

interface RawExtension {
  id: string;
  domain: string;
  entry: string;
  presentation?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RawSchema {
  $id?: string;
  [key: string]: unknown;
}

interface RawDomain {
  id: string;
  sharedProperties: string[];
  actions: string[];
  extensionsActions: string[];
  defaultActionTimeout: number;
  lifecycleStages: string[];
  extensionsLifecycleStages: string[];
}

interface RawManifest {
  id: string;
  name: string;
  remoteEntry: string;
  metaData: RawMetaData;
  shared: RawShared[];
}

/** Enriched mfe-manifest.json shape produced by the frontx-mf-gts Vite plugin. */
interface RawEnrichedMfeJson {
  manifest: RawManifest;
  domains?: RawDomain[];
  entries: RawEntry[];
  extensions: RawExtension[];
  schemas?: RawSchema[];
}

/**
 * An entry as declared in a package's own mfe.json, read before we know
 * whether the package is federated. This is the frame entry's actual shape
 * (ADR-0021): a federated entry's remaining fields (`manifest`,
 * `exposedModule`, `exposeAssets`, declared on `RawEntry`) live in the
 * enriched mfe-manifest.json instead and are read only once enrichment
 * confirms the package is federated.
 */
interface RawDeclaredEntry {
  id: string;
  requiredProperties: string[];
  optionalProperties?: string[];
  actions: string[];
  domainActions: string[];
  urlProperty: string;
}

/** A package's own mfe.json, read before we know whether it is federated. */
interface RawMfeJson {
  manifest?: RawManifest;
  devUrl?: string;
  entries?: RawDeclaredEntry[];
  domains?: RawDomain[];
  extensions?: unknown[];
  schemas?: unknown[];
}

/**
 * The Module Federation entry subtype. An entry id that does not start with
 * this descends from `entry.v1~` by some other route — today an iframe entry
 * (ADR-0021) — and carries no remote to enrich from.
 */
const FRONTX_MFE_ENTRY_MF = 'gts.frontx.mfes.mfe.entry.v1~frontx.mfes.mfe.entry_mf.v1~';

function isFederatedEntry(entry: { id: string }): boolean {
  return entry.id.startsWith(FRONTX_MFE_ENTRY_MF);
}

// ---------------------------------------------------------------------------
// Output shape types (mirror the SDK MfManifest / MfeEntryMF types; kept
// local so the script has no dependency on @gears-frontx packages at run time)
// ---------------------------------------------------------------------------

interface OutMfManifestShared {
  name: string;
  version: string;
  chunkPath: string;
  unwrapKey: string | null;
}

interface OutMfManifest {
  id: string;
  name: string;
  metaData: {
    name: string;
    type: string;
    buildInfo: { buildVersion: string; buildName: string };
    remoteEntry: { name: string; path: string; type: string };
    globalName: string;
    publicPath: string;
  };
  shared: OutMfManifestShared[];
}

interface OutMfManifestAssets {
  js: { async: string[]; sync: string[] };
  css: { async: string[]; sync: string[] };
}

interface OutMfeEntryMF {
  id: string;
  requiredProperties: string[];
  optionalProperties?: string[];
  actions: string[];
  domainActions: string[];
  manifest: OutMfManifest;
  exposedModule: string;
  exposeAssets: OutMfManifestAssets;
}

interface OutMfeEntryFrame {
  id: string;
  requiredProperties: string[];
  actions: string[];
  domainActions: string[];
  urlProperty: string;
  publicPath: string;
  optionalProperties?: string[];
}

interface OutMfeManifestConfig {
  manifest?: OutMfManifest;
  domains?: RawDomain[];
  entries: Array<OutMfeEntryMF | OutMfeEntryFrame>;
  extensions?: unknown[];
  schemas?: unknown[];
}

// ---------------------------------------------------------------------------
// ManifestGenerator — class-based implementation
// ---------------------------------------------------------------------------

// @cpt-begin:cpt-frontx-dod-mfe-isolation-mf-vite-plugin:p1:inst-2
export class ManifestGenerator {
  private readonly mfePackagesDir: string;
  private readonly outputFile: string;
  private readonly globalBaseUrl: string | null;
  private readonly globalBasePath: string | null;
  private readonly mfeManifestPath: string;

  // Packages to skip (hidden dirs, non-MFE directories)
  private static readonly EXCLUDED = new Set(['.git', '.DS_Store']);

  constructor(
    mfePackagesDir: string,
    outputFile: string,
    mfeManifestPath: string,
    globalBaseUrl: string | null,
    globalBasePath: string | null,
  ) {
    this.mfePackagesDir = mfePackagesDir;
    this.outputFile = outputFile;
    this.mfeManifestPath = mfeManifestPath;
    this.globalBaseUrl = globalBaseUrl;
    this.globalBasePath = globalBasePath;
  }

  run(): void {
    // A shell-only seed (no `add mfe` applied yet, or every MFE removed)
    // never creates `src-app/mfe_packages/`. That is a valid, working
    // topology — not an error — so this degrades to an empty manifest set
    // instead of throwing ENOENT, matching the guard convention already used
    // by the sibling scanner in scripts/lib/mfe-tools.ts (getMFEPackages).
    if (!existsSync(this.mfePackagesDir)) {
      console.log(
        `No MFE packages directory found at ${this.mfePackagesDir} — writing empty manifest set.`,
      );
    }

    const packageDirs = this.discoverPackages();
    console.log(`Found ${packageDirs.length} MFE package(s):`);
    packageDirs.forEach((p) => console.log(`  - ${p}`));

    const configs = packageDirs.map((dir) => this.processPackage(dir));
    const output = this.renderOutputFile(configs);
    writeFileSync(this.outputFile, output, 'utf-8');
    console.log(`\nGenerated ${this.outputFile}`);
  }

  private discoverPackages(): string[] {
    if (!existsSync(this.mfePackagesDir)) {
      return [];
    }
    return readdirSync(this.mfePackagesDir).filter((dir) => {
      if (ManifestGenerator.EXCLUDED.has(dir) || dir.startsWith('.')) {
        return false;
      }
      const pkgPath = join(this.mfePackagesDir, dir);
      return existsSync(join(pkgPath, 'mfe.json'));
    });
  }

  private processPackage(packageDir: string): OutMfeManifestConfig {
    const pkgPath = join(this.mfePackagesDir, packageDir);
    let rawMfeJson: RawMfeJson;
    try {
      rawMfeJson = JSON.parse(readFileSync(join(pkgPath, 'mfe.json'), 'utf-8')) as RawMfeJson;
    } catch (err) {
      throw new Error(`[${packageDir}] Cannot parse mfe.json: ${String(err)}`);
    }

    // A package is either federated or framed, never a mixture of the two
    // (ADR-0021) — the branch below is chosen once per package, not per
    // entry. A package whose every entry is a frame has no build output to
    // read: no remote entry, no expose assets, no mf-manifest.json. All it
    // needs resolving is the address its page is served from.
    //
    // A package that declares no entries at all takes the federated path, so
    // the familiar "build the MFE first" error still reaches whoever forgot
    // to build, rather than a package silently coming out empty.
    const declaredEntries = rawMfeJson.entries ?? [];
    const federatedEntries = declaredEntries.filter(isFederatedEntry);
    if (declaredEntries.length > 0 && federatedEntries.length === 0) {
      return this.processFramePackage(packageDir, { ...rawMfeJson, entries: declaredEntries });
    }
    if (federatedEntries.length > 0 && federatedEntries.length < declaredEntries.length) {
      // Left uncaught, this package would take the federated path below and
      // fail deep inside buildEntries with "has no exposeAssets" on the frame
      // entry — a message that sends the reader off to rebuild a package that
      // has nothing to build. Naming the real cause here, before either path
      // is taken, is cheaper than letting them find that out.
      const frameEntry = declaredEntries.find((entry) => !isFederatedEntry(entry))!;
      throw new Error(
        `[${packageDir}] mixes a federated entry with a frame entry ("${frameEntry.id}"). ` +
          `A package is either federated or framed, never both (ADR-0021) — move the frame ` +
          `entry into a package of its own.`
      );
    }

    const mfeJson = this.readEnrichedMfeJson(pkgPath, packageDir);
    const publicPath = this.resolvePublicPath(mfeJson, packageDir);

    const outManifest = this.buildManifest(mfeJson.manifest, publicPath);
    const outEntries = this.buildEntries(mfeJson.entries, outManifest, packageDir);

    return {
      manifest: outManifest,
      ...(mfeJson.domains !== undefined && { domains: mfeJson.domains }),
      entries: outEntries,
      extensions: mfeJson.extensions,
      ...(mfeJson.schemas !== undefined && { schemas: mfeJson.schemas }),
    };
  }

  /**
   * A frame package: `--base-path` wins as it does for a remote, and the
   * package's declared development address answers otherwise. The address
   * lands on each entry rather than on a manifest, because a frame package
   * has no manifest to put it on. `domains`, `extensions` and `schemas` are
   * a package's own to declare either way, so they pass through exactly as
   * they do on the federated branch.
   */
  private processFramePackage(
    packageDir: string,
    mfeJson: RawMfeJson & { entries: RawDeclaredEntry[] }
  ): OutMfeManifestConfig {
    const publicPath = this.resolveFramePublicPath(packageDir, mfeJson.devUrl);
    return {
      ...(mfeJson.domains !== undefined && { domains: mfeJson.domains }),
      entries: mfeJson.entries.map((entry) => ({ ...entry, publicPath })),
      ...(mfeJson.extensions !== undefined && { extensions: mfeJson.extensions }),
      ...(mfeJson.schemas !== undefined && { schemas: mfeJson.schemas }),
    };
  }

  private resolveFramePublicPath(packageDir: string, devUrl: string | undefined): string {
    if (this.globalBaseUrl !== null) {
      return this.globalBaseUrl.endsWith('/') ? this.globalBaseUrl : `${this.globalBaseUrl}/`;
    }
    if (this.globalBasePath !== null) {
      const root = this.globalBasePath.replace(/\/+$/, '');
      return `${root}/${packageDir}/`;
    }
    if (!devUrl) {
      throw new Error(
        `[${packageDir}] a frame package needs a "devUrl" in mfe.json, ` +
          `or a --base-path/--base-url to be served from.`
      );
    }
    return devUrl.endsWith('/') ? devUrl : `${devUrl}/`;
  }

  private readEnrichedMfeJson(pkgPath: string, packageDir: string): RawEnrichedMfeJson {
    const manifestFilePath = join(pkgPath, this.mfeManifestPath);
    if (!existsSync(manifestFilePath)) {
      throw new Error(
        `[${packageDir}] ${this.mfeManifestPath} not found. ` +
          `Build the MFE package first and ensure the frontxMfGts plugin is configured in vite.config.ts.`
      );
    }
    let mfeJson: RawEnrichedMfeJson;
    try {
      mfeJson = JSON.parse(readFileSync(manifestFilePath, 'utf-8')) as RawEnrichedMfeJson;
    } catch (err) {
      throw new Error(`[${packageDir}] Cannot parse ${this.mfeManifestPath}: ${String(err)}`);
    }
    if (!mfeJson.manifest?.metaData) {
      throw new Error(
        `[${packageDir}] ${this.mfeManifestPath} is missing manifest.metaData. ` +
          `Build the MFE package first and ensure the frontxMfGts plugin is configured in vite.config.ts.`
      );
    }
    return mfeJson;
  }

  /**
   * Resolve publicPath for this MFE.
   * Priority:
   *   1. --base-url CLI flag (global override for all packages)
   *   2. publicPath from enriched mfe-manifest.json manifest.metaData (set by plugin) —
   *      ONLY when it is a concrete, already-resolved value
   *   3. Origin from mfe-manifest.json manifest.remoteEntry URL (per-package default)
   *   4. "/" as final fallback
   */
  private resolvePublicPath(
    mfeJson: RawEnrichedMfeJson,
    packageDir: string
  ): string {
    if (this.globalBaseUrl !== null) {
      return this.globalBaseUrl.endsWith('/')
        ? this.globalBaseUrl
        : `${this.globalBaseUrl}/`;
    }

    // Production images serve every remote from the same origin as the host.
    // Keep the hostname out of the image so the exact same artifact can run in
    // dev, test and prod; bootstrap resolves this root-relative path against
    // window.location.origin at runtime.
    if (this.globalBasePath !== null) {
      const root = this.globalBasePath.replace(/\/+$/, '');
      return `${root}/${packageDir}/`;
    }

    // Use publicPath from enriched manifest (set by the plugin from mfe-manifest.json).
    //
    // "auto" (and its normalized "auto/" form) is Module Federation's own
    // build-time placeholder meaning "resolve at runtime from wherever the
    // remoteEntry/manifest was actually served" — it is NEVER a usable base
    // URL on its own. This is the DEFAULT publicPath value MF emits whenever
    // an MFE's vite.config.ts does not set `federation({ ... publicPath })`
    // explicitly (true for every MFE in src-app/mfe_packages/ today). Treating
    // it as already-resolved (as a naive `!== '/'` truthy check would) writes
    // the literal string "auto/" into generated-mfe-manifests.json, which the
    // runtime handler (MfeHandlerMF) then concatenates onto every chunk
    // filename — producing a same-origin relative URL that Vite's SPA
    // fallback answers with a 200 index.html instead of a 404, masking the
    // failure as a silent no-op mount.
    const manifestPublicPath = mfeJson.manifest.metaData.publicPath;
    const isUnresolvedAutoPlaceholder =
      manifestPublicPath === 'auto' || manifestPublicPath === 'auto/';
    if (
      manifestPublicPath &&
      manifestPublicPath !== '/' &&
      !isUnresolvedAutoPlaceholder
    ) {
      return manifestPublicPath.endsWith('/')
        ? manifestPublicPath
        : `${manifestPublicPath}/`;
    }

    // Fall back to mfe-manifest.json manifest.remoteEntry origin.
    const remoteEntry = mfeJson.manifest.remoteEntry;
    if (remoteEntry) {
      try {
        const url = new URL(remoteEntry);
        return `${url.origin}/`;
      } catch {
        console.warn(
          `[${packageDir}] Cannot parse remoteEntry URL "${remoteEntry}", defaulting publicPath to "/"`
        );
      }
    }

    return '/';
  }

  private buildManifest(rawManifest: RawManifest, publicPath: string): OutMfManifest {
    return {
      id: rawManifest.id,
      name: rawManifest.name,
      metaData: {
        name: rawManifest.metaData.name,
        type: rawManifest.metaData.type,
        buildInfo: {
          buildVersion: rawManifest.metaData.buildInfo.buildVersion,
          buildName: rawManifest.metaData.buildInfo.buildName,
        },
        remoteEntry: {
          name: rawManifest.metaData.remoteEntry.name,
          path: rawManifest.metaData.remoteEntry.path,
          type: rawManifest.metaData.remoteEntry.type,
        },
        globalName: rawManifest.metaData.globalName,
        // Inject resolved publicPath — overrides the "/" placeholder from the build
        publicPath,
      },
      shared: rawManifest.shared.map((s) => ({
        name: s.name,
        version: s.version,
        chunkPath: s.chunkPath,
        unwrapKey: s.unwrapKey,
      })),
    };
  }

  private buildEntries(
    entries: RawEntry[],
    outManifest: OutMfManifest,
    packageDir: string
  ): OutMfeEntryMF[] {
    return entries.map((entry) => {
      if (!entry.exposeAssets) {
        throw new Error(
          `[${packageDir}] Entry "${entry.id}" has no exposeAssets. ` +
            `This usually means the manifest was not enriched by the build plugin. ` +
            `Rebuild the MFE package and ensure the frontxMfGts plugin is configured.`
        );
      }

      const out: OutMfeEntryMF = {
        id: entry.id,
        requiredProperties: entry.requiredProperties,
        actions: entry.actions,
        domainActions: entry.domainActions,
        manifest: outManifest,
        exposedModule: entry.exposedModule,
        exposeAssets: {
          js: {
            async: entry.exposeAssets.js.async,
            sync: entry.exposeAssets.js.sync,
          },
          css: {
            async: entry.exposeAssets.css.async,
            sync: entry.exposeAssets.css.sync,
          },
        },
      };

      if (entry.optionalProperties !== undefined) {
        out.optionalProperties = entry.optionalProperties;
      }

      return out;
    });
  }

  private renderOutputFile(configs: OutMfeManifestConfig[]): string {
    return JSON.stringify(configs, null, 2) + '\n';
  }
}
// @cpt-end:cpt-frontx-dod-mfe-isolation-mf-vite-plugin:p1:inst-2
