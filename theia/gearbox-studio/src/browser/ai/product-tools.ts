// What the chat may do to a product, and how little of it is new.
//
// The tool does not write. It calls `ProductEditService.toggle`, the same entry
// point the catalogue's own control uses, and that method owns the policy: it
// refuses when no product is open, refuses when the description has unsaved
// changes rather than discarding them, renders the exact line it would write,
// and waits for a person to agree. So the chat gets no privilege the UI does not
// already have, and the preview stays where ADR
// `cpt-gearbox-adr-authoring-ownership-tiers` put it -- in front of the write,
// not behind it.
//
// One tool, deliberately. The demo asks whether a product can be configured by
// asking for it in words; adding a second verb before the first one is observed
// would be guessing at which verbs matter.

import { inject, injectable } from "@theia/core/shared/inversify";
import { createToolCallError } from "@theia/ai-core";
import type { ToolCallResult, ToolProvider, ToolRequest } from "@theia/ai-core";

import { CatalogueStore } from "../catalogue-store";
import { ProductEditService } from "../product-edit-service";

@injectable()
export class ProductGearTool implements ToolProvider {
  static ID = "gearbox_toggle_gear";

  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;

  getTool(): ToolRequest {
    return {
      id: ProductGearTool.ID,
      name: ProductGearTool.ID,
      description:
        "Add a gear to the open Gearbox product, or remove it if it is already selected. " +
        "The gear is named by its kebab-case id, e.g. `tenant-resolver`. A preview of the " +
        "exact line to be written is shown to the operator, who must agree before anything " +
        "is written; if they decline, nothing changes and this says so.",
      parameters: {
        type: "object",
        properties: {
          gear: {
            type: "string",
            description: "The kebab-case gear id, as the catalogue spells it.",
          },
        },
        required: ["gear"],
      },
      handler: async (argString: string): Promise<ToolCallResult> => {
        let gear: unknown;
        try {
          gear = (JSON.parse(argString || "{}") as { gear?: unknown }).gear;
        } catch {
          // `createToolCallError`, not prose. A bare string is a legal
          // `ToolCallResult` and `hasToolCallError` classifies it as a success,
          // so a malformed call would be reported to the model, and rendered in
          // the chat, as a tool that worked.
          return createToolCallError("The arguments were not valid JSON.");
        }
        if (typeof gear !== "string" || gear.trim() === "") {
          return createToolCallError("`gear` must be the gear's kebab-case id.");
        }

        // The source is read, never assumed. `use_gear` names both halves, and
        // the id alone does not fix the source -- so a constant here would write
        // a line naming a source the product may not declare. This is also the
        // argument the catalogue's own control passes, which is what makes "the
        // same entry point" true of the arguments and not only of the method.
        const source = this.catalogue.sourceOf(gear);
        if (source === undefined) {
          return createToolCallError(
            `The catalogue has no gear called \`${gear}\`, so there is no source to write ` +
              `for it. Check the id against the catalogue.`,
          );
        }

        const changed = await this.edits.toggle(gear, source);

        // Read after the await, not before. `toggle` re-establishes every fact
        // once the operator has answered and refuses an answer about a state
        // that has gone -- so on the refusal path the product may have changed
        // underneath, and a reading taken before the dialog would report the
        // gear as "still selected" just after someone removed it. The model's
        // next move would be to put it back.
        const selected = this.edits.inProduct(gear);
        if (!changed) {
          // Refused, cancelled, or impossible -- `toggle` has already told the
          // operator which, through the message service. Saying "no change" here
          // without inventing a reason is the honest report.
          return `The product was not changed. \`${gear}\` is ${
            selected ? "still selected" : "still not selected"
          }.`;
        }
        return selected
          ? `Added \`${gear}\` to the product.`
          : `Removed \`${gear}\` from the product.`;
      },
    };
  }
}
