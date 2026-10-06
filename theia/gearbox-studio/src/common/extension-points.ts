// Which plugin implements which point, in one place.
//
// A host declares `extension_points` and a plugin declares the one it `implements`,
// both in the description, and **the join key is the GTS spec** -- the id plugin
// instances register under and the host selects by. Not the trait: two points
// can share one (the ledger's rate provider and bss-rate-provider's sources both
// implement `bss_ledger_sdk::RateProviderV1`), and only their specs differ.
//
// **One key function, for the reason `gearbox_ir::binding_key` exists.** The
// graph builder used to format a binding's node key inline and a diagnostic
// naming the same node would have formatted it again; two format strings for one
// convention is how a client ends up asking about something that is not there,
// silently. What a person reads is the trait, which `pointLabel` spells the way
// `ExtensionPointDecl::qualified()` does.

import type { ExtensionPointDecl } from "./generated/ExtensionPointDecl";
import type { GearDescriptor } from "./generated/GearDescriptor";
import type { PluginImpl } from "./generated/PluginImpl";

/** A point's identity: its full GTS spec id. */
export function pointKey(point: ExtensionPointDecl): string {
  return point.spec;
}

/** How a point reads: `authn_resolver_sdk::AuthNResolverPluginClient`. */
export function pointLabel(point: ExtensionPointDecl): string {
  return `${point.sdk_lib}::${point.trait_ident}`;
}

/** The spec's own segment, without the `PluginV1` base every spec shares -- what `implements` writes. */
export function specSegment(spec: string): string {
  const base = "cf.toolkit.plugins.plugin.v1~";
  return spec.startsWith(base) ? spec.slice(base.length) : spec;
}

/**
 * How the point a plugin implements reads: its host's trait once the catalogue has
 * joined it, the spec segment when no described gear declares it.
 */
export function implementsLabel(fill: PluginImpl): string {
  return fill.point ? fill.point.trait_ident : specSegment(fill.spec);
}

/** The points a gear expects an implementation for. */
export function pointsOf(host: GearDescriptor): readonly ExtensionPointDecl[] {
  return host.extension_points ?? [];
}

/**
 * Whether `plugin` implements one of `host`'s declared points.
 *
 * This is the predicate the Add Gear panel was missing. It offered every gear in
 * the catalogue that implements *any* point, so `types-registry` -- whose own panel
 * said "Extension points: none declared." -- could be given an authentication
 * plugin, and the closure preview then reported `oidc-authn-plugin` as a
 * "plugin of types-registry". The engine did not refuse it either: its check asks
 * whether *some* selected gear expects the point, not whether the host it was
 * listed under does.
 */
export function implementsPointOf(plugin: GearDescriptor, host: GearDescriptor): boolean {
  const implements_ = plugin.implements ?? undefined;
  if (implements_ === undefined) return false;
  return pointsOf(host).some((point) => pointKey(point) === implements_.spec);
}

/** The plugins in `rows` that are applicable to `host`, by point, id-sorted. */
export function pluginsByPoint(
  host: GearDescriptor,
  rows: readonly GearDescriptor[],
): { point: ExtensionPointDecl; plugins: GearDescriptor[] }[] {
  return pointsOf(host).map((point) => ({
    point,
    plugins: rows
      .filter((row) => {
        const implements_ = row.implements ?? undefined;
        return implements_ !== undefined && implements_.spec === pointKey(point);
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
  }));
}
