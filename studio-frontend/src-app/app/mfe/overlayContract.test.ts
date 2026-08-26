/**
 * Guards the registration of every extension in the generated aggregate.
 *
 * Why this is worth a test of its own: `bootstrapMFE` registers packages in a
 * plain loop with no per-package try/catch, and `MfeScreenContainer` renders the
 * screen domain's slot only after that promise resolves. So ONE unregisterable
 * extension anywhere in the aggregate means no screen slot at all — while the
 * drawer still lists every extension that registered before the failure. The
 * symptom is a healthy-looking menu whose every click mounts into nothing, with
 * a single console error as the only clue.
 *
 * This is not hypothetical: moving search to the overlay domain under the bare
 * base extension type produced exactly that, because GTS refuses to register an
 * instance whose type has no schema and no schema exists for the base extension
 * type. Hence `extension_overlay.v1.json`, and hence this test.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  overlayDomain,
  screenDomain,
  gtsPlugin,
  themeSchema,
  languageSchema,
  extensionScreenSchema,
  type JSONSchema,
  type MfeEntryMF,
  type Extension,
} from '@gears-frontx/react';
// Not re-exported by @gears-frontx/react — this is the contract check
// `registerExtension` runs after the type-system register succeeds.
import { validateContract } from '@gears-frontx/mfes';
import extensionOverlaySchemaJson from './schemas/extension_overlay.v1.json';
import sharedPropertyContextProjectSchemaJson from './schemas/shared_property_context_project.v1.json';
import sharedPropertyContextOrganizationSchemaJson from './schemas/shared_property_context_organization.v1.json';
import sharedPropertySessionProfileSchemaJson from './schemas/shared_property_session_user_profile.v1.json';
import { STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT } from './contextActions';

/**
 * The GTS id grammar, as far as this test needs it: every `~`-separated segment
 * carries exactly five dot-separated parts, and the leading segment has one more
 * for its `gts.` prefix.
 *
 * Spelled out here rather than imported from @globaltypesystem/gts-ts, which is
 * only a transitive dependency — and worth spelling out anyway, because an id
 * that breaks this rule does not report itself as malformed. GTS derives an
 * instance's schema by trimming the last segment off a *valid* id; an invalid one
 * yields no schema id at all, and the failure surfaces as "No schema found for
 * instance", which reads like a missing schema rather than a bad name.
 */
function isWellFormedGtsId(id: string): boolean {
  return id
    .replace(/~$/, '')
    .split('~')
    .every((segment, index) => segment.split('.').length === (index === 0 ? 6 : 5));
}

type PresentedExtension = Extension & {
  presentation?: { label?: string; route?: string; order?: number };
};

interface ManifestConfig {
  manifest: { id: string };
  entries: MfeEntryMF[];
  extensions?: PresentedExtension[];
}

const manifests: ManifestConfig[] = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../public/generated-mfe-manifests.json'), 'utf8')
);

const extensions = manifests.flatMap((config) => config.extensions ?? []);
const entriesById = new Map(
  manifests.flatMap((config) => config.entries).map((entry) => [entry.id, entry])
);

// Exactly what main.tsx registers before constructing the app. If this list and
// main.tsx's ever diverge, this test passes while the browser fails — keep them
// in step.
gtsPlugin.registerSchema(themeSchema);
gtsPlugin.registerSchema(languageSchema);
gtsPlugin.registerSchema(extensionScreenSchema);
gtsPlugin.registerSchema(extensionOverlaySchemaJson as JSONSchema);
gtsPlugin.registerSchema(sharedPropertyContextProjectSchemaJson as JSONSchema);
gtsPlugin.registerSchema(sharedPropertyContextOrganizationSchemaJson as JSONSchema);
gtsPlugin.registerSchema(sharedPropertySessionProfileSchemaJson as JSONSchema);

describe('generated MFE manifest', () => {
  it('was generated — an empty aggregate means `npm run generate:mfe-manifests` was skipped', () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it('gives every declaration a well-formed GTS id', () => {
    // Every ~-separated segment needs exactly five dot-separated parts. A
    // four-part leaf (`constructor_studio.overlays.search.v1`) invalidates the
    // whole id, and the failure surfaces as "No schema found for instance".
    const ids = manifests.flatMap((config) => [
      config.manifest.id,
      ...config.entries.map((entry) => entry.id),
      ...(config.extensions ?? []).map((extension) => extension.id),
    ]);
    expect(ids.filter((id) => !isWellFormedGtsId(id))).toEqual([]);
  });

  it('gives every declared property and action a well-formed GTS id', () => {
    // The same rule, on the ids an entry REFERS to — and this side fails later
    // and louder: a malformed property id registers fine, then throws inside
    // `updateSharedProperty` during `bootstrapMFE`, leaving no screen slot at
    // all. Which is how a four-part `…context.project.v1~` leaf got written once.
    const referenced = manifests.flatMap((config) =>
      config.entries.flatMap((entry) => [
        ...(entry.requiredProperties ?? []),
        ...(entry.optionalProperties ?? []),
        ...(entry.actions ?? []),
        ...(entry.domainActions ?? []),
      ])
    );
    expect(referenced.filter((id) => !isWellFormedGtsId(id))).toEqual([]);
  });

  it('registers every extension with the type system', () => {
    // Same order bootstrapMFE uses: manifest, entries, then extensions.
    for (const config of manifests) {
      gtsPlugin.register(config.manifest);
      for (const entry of config.entries) gtsPlugin.register(entry);
    }
    for (const extension of extensions) {
      const name = extension.presentation?.label ?? extension.id;
      expect(
        () => gtsPlugin.register(extension),
        `type-system register failed for "${name}" — bootstrapMFE would reject and no screen slot would render`
      ).not.toThrow();
    }
  });

  describe('global search', () => {
    const searchExtension = extensions.find(
      (ext) => ext.domain === overlayDomain.id && ext.presentation?.route === '/search'
    );

    it('is contributed to the overlay domain, claiming the /search route', () => {
      expect(searchExtension).toBeDefined();
    });

    it('carries the derived overlay type, which is what has a schema', () => {
      expect(searchExtension!.id).toContain('frontx.screensets.layout.overlay.v1~');
    });

    it('satisfies the overlay domain contract, so registration admits it', () => {
      const entry = entriesById.get(searchExtension!.entry);
      expect(entry).toBeDefined();
      const result = validateContract(entry!, overlayDomain, gtsPlugin);
      // Surface the reason rather than a bare `false`.
      expect(result.errors ?? []).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('is no longer a screen, so it cannot appear in the drawer', () => {
      const asScreen = extensions.find(
        (ext) => ext.domain === screenDomain.id && ext.presentation?.route === '/search'
      );
      expect(asScreen).toBeUndefined();
    });
  });

  describe('selected-project property', () => {
    /**
     * What `updateSharedProperty` validates: it appends a runtime segment to the
     * property id and registers the result as an instance, so a rejected value
     * throws at the publisher rather than at the subscriber.
     */
    const publish = (value: unknown): (() => void) => () =>
      gtsPlugin.register({
        id: `${STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT}frontx.mfes.comm.runtime.v1`,
        value,
      } as never);

    it('is declared by projects-mfe, which is what makes the switcher able to steer it', () => {
      const entries = manifests.flatMap((config) => config.entries);
      const declaring = entries.filter((entry) =>
        (entry.requiredProperties ?? []).includes(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT)
      );
      expect(declaring.map((entry) => entry.id)).toEqual([
        expect.stringContaining('constructor_studio.projects.mfe.main'),
      ]);
    });

    it('admits a tenant id', () => {
      expect(publish('9f0c1a2b-0000-0000-0000-0000000000aa')).not.toThrow();
    });

    it('admits null — organization scope is a published value, not an absent one', () => {
      // bootstrapMFE seeds exactly this; forbidding it kills the slot at startup.
      expect(publish(null)).not.toThrow();
    });

    it('rejects a value that is neither, so a wrong publish fails at the publisher', () => {
      expect(publish(42)).toThrow();
      expect(publish('')).toThrow();
    });
  });

  describe('drawer order bands', () => {
    const screens = extensions.filter((ext) => ext.domain === screenDomain.id);

    it('puts every working area below the tenant band', () => {
      const working = screens.filter((ext) => (ext.presentation?.order ?? 999) < 100);
      expect(working.map((ext) => ext.presentation?.label).sort()).toEqual([
        'Connections',
        'Kits',
        'People',
        'Projects',
      ]);
    });

    it('puts My Organization in the tenant band, which is what rules the separator', () => {
      const tenant = screens.filter((ext) => (ext.presentation?.order ?? 999) >= 100);
      expect(tenant.map((ext) => ext.presentation?.label)).toEqual(['My Organization']);
    });
  });
});
