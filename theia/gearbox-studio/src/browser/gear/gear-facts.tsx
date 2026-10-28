// What a gear is, for whichever surface is showing one.
//
// **Extracted rather than copied, and the docs row is the reason.** `GearDocs`
// drags `adrLabel` with it -- the rule that a nine-ADR gear is listed as
// `ADR 001` rather than as a filename that wraps to three lines -- and a second
// copy of that rule in another file is how the two come to disagree about the
// same gear.
//
// **Only the parts two surfaces want.** The Inspector's capabilities, extension
// points, `provides` and GTS types stay in the Inspector: those are facts about
// the gear in the *catalogue*, and the settings pane is answering about one
// object in one product. What both need is the same three things -- what it is
// called, what it is for, and where to read more -- plus, for the pane, why it
// is here at all.

import React from "@theia/core/shared/react";

import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import type { InclusionReason } from "../../common/generated/InclusionReason";
import type { Maturity } from "../../common/generated/Maturity";
import { describeInclusion } from "../product/inclusion";
import { RevealLink } from "../reveal-link";
import type { RevealService } from "../reveal-service";

/** What each level below `stable` says, as the tooltip and the screen-reader text. */
const MATURITY_MEANS: Record<Exclude<Maturity, "stable">, string> = {
  experimental: "experimental: its API and behaviour may change freely",
  preview: "preview: usable, but not declared stable",
  deprecated: "deprecated: still available, not for new products",
};

/**
 * The gear's maturity, shown only below `stable`.
 *
 * Nothing for `stable`: a badge on every settled gear would be the noise that
 * hides the ones that are not. One component for the catalogue row, the Add
 * Gear list and the heading, so the three cannot say it three ways.
 */
export function MaturityBadge({ maturity }: { readonly maturity: Maturity }): React.ReactElement | null {
  if (maturity === "stable") return null;
  return (
    <span
      className={`gbx-badge gbx-maturity gbx-maturity-${maturity}`}
      data-maturity={maturity}
      title={MATURITY_MEANS[maturity]}
    >
      {maturity}
    </span>
  );
}

/**
 * The display name with the id beside it.
 *
 * The markup the Inspector's detail block has always emitted, so that a claim
 * reading `.gbx-detail-title` keeps matching wherever a gear is named.
 */
export function GearHeading({
  id,
  descriptor,
}: {
  readonly id: string;
  readonly descriptor?: GearDescriptor;
}): React.ReactElement {
  return (
    <div className="gbx-detail-title">
      {descriptor?.display_name || id} <span className="gbx-id">{id}</span>
    </div>
  );
}

/** What the gear is for, in the author's own words. */
export function GearBlurb({
  descriptor,
}: {
  readonly descriptor?: GearDescriptor;
}): React.ReactElement {
  return (
    <div className="gbx-kv">
      <span>description</span>
      <span>{descriptor?.description ?? "—"}</span>
    </div>
  );
}

/**
 * The gear's own documents, as links the opener handles.
 *
 * Renders nothing at all when the descriptor declares none: an empty `docs` row
 * is a row saying "this gear has no documentation", which is a different claim
 * from "none was declared here".
 */
export function GearDocs({
  descriptor,
  reveals,
}: {
  readonly descriptor?: GearDescriptor;
  readonly reveals: RevealService;
}): React.ReactElement | null {
  const docs = descriptor?.docs;
  if (!descriptor || !docs) return null;
  const adrs = docs.adr ?? [];
  if (!docs.prd && !docs.design && adrs.length === 0) return null;
  const link = (label: string, target: string | null | undefined): React.ReactNode =>
    target === null || target === undefined ? undefined : (
      <RevealLink
        key={target}
        reveals={reveals}
        source={descriptor.source}
        target={target}
        label={label}
      />
    );
  return (
    <div className="gbx-kv">
      <span>docs</span>
      <span className="gbx-links">
        {link("PRD", docs.prd)}
        {link("DESIGN", docs.design)}
        {adrs.map((adr) => link(adrLabel(adr), adr))}
      </span>
    </div>
  );
}

/**
 * Every reason this gear is in the product, as sentences.
 *
 * A co-located reason additionally *goes* to the gear it names -- saying which
 * gear requires this one is only half an answer if reaching it means finding it
 * again in the tree. The other two kinds are statements, so they are text.
 */
export function InclusionReasons({
  reasons,
  onSelectGear,
}: {
  readonly reasons: readonly InclusionReason[];
  readonly onSelectGear?: (id: string) => void;
}): React.ReactElement | null {
  if (reasons.length === 0) return null;
  return (
    <div className="gbx-kv">
      <span>included because</span>
      <span>
        {reasons.map((reason, index) => (
          <span className="gbx-leaf-why" key={index} data-inclusion={reason.reason}>
            {reason.reason === "colocated_by" && onSelectGear !== undefined ? (
              <button
                type="button"
                className="gbx-choice"
                data-inclusion-gear={reason.gear}
                onClick={() => onSelectGear(reason.gear)}
              >
                {describeInclusion(reason)}
              </button>
            ) : (
              describeInclusion(reason)
            )}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * `ADR 001` rather than `001-provider-compatibility-and-performance.md`.
 *
 * `cluster` has nine ADRs and `types-registry` fifteen, with names long enough
 * that the full filenames wrapped to three lines and read as a paragraph rather
 * than as a list. The number is the part anyone actually cites; the filename
 * stays in the link's tooltip.
 */
export function adrLabel(target: string): string {
  const file = basename(target);
  const numbered = /^(\d+)/.exec(file);
  return numbered ? `ADR ${numbered[1]}` : file.replace(/\.md$/, "");
}

export function basename(target: string): string {
  const parts = target.split("/");
  return parts[parts.length - 1] ?? target;
}
