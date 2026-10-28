// Studio's own settings, declared the way Theia declares settings.
//
// **Why a schema and not a panel.** The obvious reading of "Studio needs a field
// for the API key" is a widget with an input in it. That would have been a second
// settings surface: one to build, one to style, one to teach, and one that every
// later setting has to be added to by hand. Theia already has a settings editor,
// and it renders whatever a `PreferenceContribution` declares -- so the whole of
// this file is the field, and the next setting is one more entry below.
//
// **Why our own namespace was necessary.** The Anthropic key already exists as
// `ai-features.anthropic.AnthropicApiKey`, and it is unreachable:
// `hide-ai-preferences-contribution.js` stamps `hidden: true` on every key
// starting `ai-features.`, because upstream expects the AI Configuration view --
// which lives in `@theia/ai-ide`, the package ADR-0011 does not install -- to
// replace them. That filter is a literal `startsWith`, so `gearbox.*` is
// untouched and renders normally. `settings/api-key-service.ts` is what carries a
// value from here to there.
//
// **Clear text, said out loud.** A preference is stored in
// `~/.theia/settings.json`. `scope: User` is the part that matters: it makes the
// key unwritable into a workspace or folder `.theia/settings.json`, which are the
// files that get committed. The description says the rest, because a masked input
// hides a value from a shoulder, not from a file.

import type { interfaces } from "@theia/core/shared/inversify";
import { PreferenceProxyFactory } from "@theia/core/lib/common/preferences/injectable-preference-proxy";
import { PreferenceContribution } from "@theia/core/lib/common/preferences/preference-schema";
import type { PreferenceSchema } from "@theia/core/lib/common/preferences/preference-schema";
import type { PreferenceProxy } from "@theia/core/lib/common/preferences/preference-proxy";
import { PreferenceScope } from "@theia/core/lib/common/preferences/preference-scope";
import type { PreferenceService } from "@theia/core/lib/common/preferences/preference-service";

/** The Anthropic key the chat agent's model is selected with. */
export const GEARBOX_API_KEY = "gearbox.ai.apiKey";

/** Present plugins beneath their compatible extension points in both catalogue surfaces. */
export const GEARBOX_GROUP_PLUGINS = "gearbox.catalogue.groupPlugins";

/** This machine's own gear checkouts, opened beside the workspace's (Configure Sources). */
export const GEARBOX_SOURCE_ROOTS = "gearbox.sourceRoots";

/** The gears repository Configure Sources offers to clone. */
export const GEARBOX_SOURCE_REPOSITORY = "gearbox.defaultSourceRepository";

/**
 * Marks a property whose value is a secret.
 *
 * On `typeDetails` -- the schema's documented "metadata intended for custom
 * renderers" -- rather than on the preference id, so the masked renderer in
 * `settings/secret-preference-renderer.ts` covers the next secret without being
 * edited.
 */
export interface GearboxSecretDetail {
  readonly gearboxSecret: true;
}

export const gearboxPreferenceSchema: PreferenceSchema = {
  properties: {
    [GEARBOX_GROUP_PLUGINS]: {
      type: "boolean", default: true, scope: PreferenceScope.User,
      description: "Group catalogue plugins under compatible gears and extension points.",
    },
    // **Where this machine's checkouts are, which only this machine knows.** The
    // window's folder and the corpus Studio lists stay the usual way to the
    // gears; these are for a machine with its own checkout, or no Studio server.
    [GEARBOX_SOURCE_ROOTS]: {
      type: "array",
      items: { type: "string" },
      default: [],
      scope: PreferenceScope.User,
      markdownDescription:
        "Local gears checkouts the catalogue also reads, as absolute paths -- usually one " +
        "checkout of `gears-rust`. Run **Gearbox: Configure Sources** to choose or clone one.",
    },
    [GEARBOX_SOURCE_REPOSITORY]: {
      type: "string",
      default: "https://github.com/constructorfabric/gears-rust",
      scope: PreferenceScope.User,
      markdownDescription: "The gears repository **Gearbox: Configure Sources** offers to clone.",
    },
    [GEARBOX_API_KEY]: {
      type: "string",
      default: "",
      // User scope, and this is the security control rather than the masking:
      // a workspace or folder settings file is committable, and a key written
      // into one leaves the machine. The schema refuses that outright
      // (`PreferenceSchemaService.isValidInScope`).
      scope: PreferenceScope.User,
      typeDetails: { gearboxSecret: true } satisfies GearboxSecretDetail,
      markdownDescription:
        "Anthropic API key for the Gearbox chat. **Stored in clear text** in your user " +
        "`settings.json`, like every other preference. Set `ANTHROPIC_API_KEY` in the " +
        "environment Studio's backend starts in to supply the key without writing it to a " +
        "file; a key set here takes precedence over that variable, and clearing this field " +
        "falls back to it.",
    },
  },
};

/** The typed view of the schema above. One line per property. */
export interface GearboxConfiguration {
  [GEARBOX_GROUP_PLUGINS]: boolean;
  [GEARBOX_SOURCE_ROOTS]: string[];
  [GEARBOX_SOURCE_REPOSITORY]: string;
  [GEARBOX_API_KEY]: string;
}

/** The typed accessor, for code that reads settings rather than watching them. */
export const GearboxPreferences = Symbol("GearboxPreferences");
export type GearboxPreferences = PreferenceProxy<GearboxConfiguration>;

/**
 * Register the schema, and the proxy that reads it.
 *
 * `PreferenceProxyFactory` rather than `createPreferenceProxy`, which is
 * deprecated since 1.23 and still what most of Theia's own packages call.
 */
export function bindGearboxPreferences(bind: interfaces.Bind): void {
  bind(GearboxPreferences)
    .toDynamicValue(({ container }) =>
      container.get<PreferenceProxyFactory>(PreferenceProxyFactory)(gearboxPreferenceSchema),
    )
    .inSingletonScope();
  bind(PreferenceContribution).toConstantValue({ schema: gearboxPreferenceSchema });
}

/** The configured checkouts, without blanks. Read in the browser, where settings are. */
export function configuredSourceRoots(preferences: Pick<PreferenceService, "get">): string[] {
  return preferences
    .get<string[]>(GEARBOX_SOURCE_ROOTS, [])
    .filter((root) => typeof root === "string" && root.trim() !== "");
}
