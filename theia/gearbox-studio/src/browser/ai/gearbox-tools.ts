// What the chat may ask Gearbox, and what it may not.
//
// Eight tools, all of them reads. The one verb that writes stays where
// `product-tools.ts` put it, and for the reason ADR
// `cpt-gearbox-adr-authoring-ownership-tiers` gives: a write is previewed and
// agreed to by a person, through the same dialog the panel's own control uses. `applyGenerate` is deliberately absent -- `planGenerate` is its
// preview half, and a chat that could apply would be a second way to write with
// only one of them gated.
//
// **Two rules inherited from `product-tools.ts`, both load-bearing.**
//
// A malformed call returns `createToolCallError`, never prose. A bare string is
// a legal `ToolCallResult` and `hasToolCallError` classifies it as a success, so
// an error phrased as a sentence is reported to the model, and rendered in the
// chat, as a tool that worked.
//
// Every read is taken when the handler runs, never cached across one. The
// product changes underneath: a dialog can be answered, and since
// `DescriptionWatchService` a plain editor save re-resolves with no dialog and
// no chat involvement at all.
//
// **Everything is capped.** `gearbox-snapshot` explains why; the short version
// is that a catalogue of several hundred gears would spend the context window
// before the question got asked.

import { inject, injectable } from "@theia/core/shared/inversify";
import { createToolCallError } from "@theia/ai-core";
import type { ToolCallResult, ToolProvider, ToolRequest } from "@theia/ai-core";

import { GearboxService } from "../../common/protocol";
import type { ProductEdit } from "../../common/generated";
import { CatalogueStore } from "../catalogue-store";
import { ProductEditService } from "../product-edit-service";
import { ProductStore } from "../product-store";
import { SelectionService } from "../shell/selection-service";
import { effectiveConfigOf } from "../inspector/effective-config";
import { explainDiagnostic } from "./generated/diagnostic-catalogue";
import {
  LIST_CAP,
  diagnosticsSnapshot,
  gearList,
  productSnapshot,
  selectionSnapshot,
  topologySnapshot,
} from "./gearbox-snapshot";

/** Parse a tool's argument string, or say why it could not be parsed. */
function parseArgs(argString: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(argString || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** A tool's result, as JSON the model can read without parsing prose. */
function json(value: unknown): string {
  return JSON.stringify(value, undefined, 1);
}

/**
 * The services every tool reads from.
 *
 * One base class rather than eight copies of the same five `@inject` lines. The
 * tools are separate classes because `ToolProvider` is bound one at a time and a
 * tool that could not be bound alone could not be withheld alone either.
 */
@injectable()
abstract class GearboxTool implements ToolProvider {
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  @inject(GearboxService) protected readonly service!: GearboxService;

  abstract getTool(): ToolRequest;

  /** The open product's path, or the sentence explaining why there is none. */
  protected openPath(): string | { error: string } {
    const path = this.products.current.open?.path;
    if (path === undefined) {
      return { error: "No product is open, so there is nothing to answer about." };
    }
    return path;
  }

  /** The catalogue row for a gear id, found the way `selected` finds one. */
  protected rowForGear(gear: string): ReturnType<CatalogueStore["row"]> {
    for (const row of this.catalogue.current.rows) {
      if (row.kind === "projected" && row.gear.id === gear) return row;
    }
    return undefined;
  }
}

@injectable()
export class GetSelectionTool extends GearboxTool {
  static ID = "gearbox_get_selection";

  getTool(): ToolRequest {
    return {
      id: GetSelectionTool.ID,
      name: GetSelectionTool.ID,
      description:
        "What the operator has selected in Studio right now: a gear, an application, a " +
        "binding, or a catalogue row that has not been projected yet. Returns `kind: " +
        '"none"` when nothing is selected.',
      parameters: { type: "object", properties: {} },
      handler: async (): Promise<ToolCallResult> =>
        json(selectionSnapshot(this.selection.current, (key) => this.catalogue.row(key))),
    };
  }
}

@injectable()
export class GetProductTool extends GearboxTool {
  static ID = "gearbox_get_product";

  getTool(): ToolRequest {
    return {
      id: GetProductTool.ID,
      name: GetProductTool.ID,
      description:
        "The open product: its id, the profile being shown, the profile family, the " +
        "generated-crate layout directory, and the resolution's lock hash. `resolved: " +
        "false` means nothing has resolved yet, which is not the same as an error.",
      parameters: { type: "object", properties: {} },
      handler: async (): Promise<ToolCallResult> => json(productSnapshot(this.products.current)),
    };
  }
}

@injectable()
export class ListGearsTool extends GearboxTool {
  static ID = "gearbox_list_gears";

  getTool(): ToolRequest {
    return {
      id: ListGearsTool.ID,
      name: ListGearsTool.ID,
      description:
        "Gears in the catalogue, as ids and names only. `selectedDirectly` means named as a " +
        "top-level gear, which a plugin never is -- use `gearbox_get_gear` for real " +
        "membership. Filter by substring; the list is " +
        "capped and reports how many it omitted. Use `gearbox_get_gear` for one gear's " +
        "detail rather than raising the limit.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description: "Substring matched against id, display name and category.",
          },
          limit: {
            type: "number",
            description: `How many to return. Default and maximum ${LIST_CAP}.`,
          },
        },
      },
      handler: async (argString: string): Promise<ToolCallResult> => {
        const args = parseArgs(argString);
        if (args === undefined) return createToolCallError("The arguments were not valid JSON.");
        const filter = typeof args.filter === "string" ? args.filter : undefined;
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.min(Math.trunc(args.limit), LIST_CAP)
            : LIST_CAP;
        return json(
          gearList(
            this.catalogue.current.rows,
            (gear) => this.edits.inProduct(gear),
            filter,
            limit,
          ),
        );
      },
    };
  }
}

@injectable()
export class GetGearTool extends GearboxTool {
  static ID = "gearbox_get_gear";

  getTool(): ToolRequest {
    return {
      id: GetGearTool.ID,
      name: GetGearTool.ID,
      description:
        "One gear in full: what it declares, the Cargo features it offers, the features " +
        "this product selected, and its effective configuration with each value's " +
        "provenance (`explicit` set by the description, `derived` decided by the resolver, " +
        "`default` the gear's own). For whether it is part of the product, read " +
        "`in_resolution` with `included_because` (the resolver's own reasons: `selected`, " +
        "`colocated_by`, `plugin_of`) and `declared_as_plugin_of` -- a gear absent from this " +
        "profile's resolution may still be declared by the description for another profile. " +
        "`selected_directly` means only 'named as a top-level gear', which a plugin never is.",
      parameters: {
        type: "object",
        properties: {
          gear: { type: "string", description: "The kebab-case gear id." },
        },
        required: ["gear"],
      },
      handler: async (argString: string): Promise<ToolCallResult> => {
        const args = parseArgs(argString);
        if (args === undefined) return createToolCallError("The arguments were not valid JSON.");
        const gear = args.gear;
        if (typeof gear !== "string" || gear.trim() === "") {
          return createToolCallError("`gear` must be the gear's kebab-case id.");
        }
        const row = this.rowForGear(gear);
        if (row === undefined || row.kind !== "projected") {
          return createToolCallError(
            `The catalogue has no projected gear called \`${gear}\`. Use ` +
              `\`${ListGearsTool.ID}\` to find the id the catalogue spells.`,
          );
        }
        const descriptor = row.gear;
        const state = this.products.current;
        const selected = state.intent?.selected_gears?.find((entry) => entry.gear === gear);
        const resolved = state.resolution?.product?.gears?.[gear];
        // **Why the gear is, or is not, in this resolution.** `inProduct` answers
        // only "named directly as a top-level gear", which is what the
        // catalogue's toggle needs and is a trap for a question about a plugin:
        // a live pass watched the agent report, correctly from what it was
        // told, that the description "simply doesn't reference" a gear the
        // description references as `plugin(..., profiles = ["prod"])`. The
        // resolver already records the real answer -- `selected_by` for a gear
        // that is in, and the intent's plugin entries for one that is not --
        // so the fix is to pass it on rather than to summarise it as a boolean.
        const pluginOf = (state.intent?.selected_gears ?? [])
          .flatMap((host) =>
            (host.plugins ?? [])
              .filter((plugin) => plugin.gear === gear)
              .map((plugin) => ({
                host: host.gear,
                // Empty means every profile, which is the opposite of "no
                // profile" and is exactly the distinction a question about one
                // profile turns on.
                profiles: plugin.profiles?.length ? plugin.profiles : "all",
              })),
          );
        return json({
          id: descriptor.id,
          display_name: descriptor.display_name,
          category: descriptor.category ?? null,
          description: descriptor.description ?? null,
          visibility: descriptor.visibility,
          source: this.catalogue.sourceOf(gear),
          selected_directly: this.edits.inProduct(gear),
          in_resolution: resolved !== undefined,
          included_because: resolved?.selected_by ?? [],
          declared_as_plugin_of: pluginOf,
          // Both lists, because the curated one is what a description chose to
          // offer and the projected one is what the crate actually has; a gear
          // nobody has curated still has features worth naming.
          cargo_features: descriptor.cargo_features ?? null,
          available_features: descriptor.available_features ?? [],
          selected_features: resolved?.selected_features ?? [],
          config: effectiveConfigOf(
            { edits: this.edits, products: this.products },
            gear,
            selected?.config ?? {},
          ),
        });
      },
    };
  }
}

@injectable()
export class GetDiagnosticsTool extends GearboxTool {
  static ID = "gearbox_get_diagnostics";

  getTool(): ToolRequest {
    return {
      id: GetDiagnosticsTool.ID,
      name: GetDiagnosticsTool.ID,
      description:
        "Every diagnostic the last resolution and the catalogue load reported, worst " +
        "severity first. Each carries its code, message, the node it is about, and its " +
        "per-occurrence remedy. For what a code means in general, use " +
        "`gearbox_explain_diagnostic`.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Return only occurrences of this code, e.g. `GBX0307`.",
          },
        },
      },
      handler: async (argString: string): Promise<ToolCallResult> => {
        const args = parseArgs(argString);
        if (args === undefined) return createToolCallError("The arguments were not valid JSON.");
        const snapshot = diagnosticsSnapshot(this.products.current, this.catalogue.current);
        const code = typeof args.code === "string" ? args.code.trim().toUpperCase() : undefined;
        if (code === undefined || code === "") return json(snapshot);
        const items = snapshot.items.filter((item) => item.code === code);
        return json({ items, total: items.length, omitted: 0, errors: snapshot.errors });
      },
    };
  }
}

@injectable()
export class ExplainDiagnosticTool extends GearboxTool {
  static ID = "gearbox_explain_diagnostic";

  getTool(): ToolRequest {
    return {
      id: ExplainDiagnosticTool.ID,
      name: ExplainDiagnosticTool.ID,
      description:
        "What a diagnostic code means in general, from the engine's own catalogue: its " +
        "title, default severity, domain, and the prose that defines it. Always use this " +
        "rather than recalling what a code means.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "The code, e.g. `GBX0410`." },
        },
        required: ["code"],
      },
      handler: async (argString: string): Promise<ToolCallResult> => {
        const args = parseArgs(argString);
        if (args === undefined) return createToolCallError("The arguments were not valid JSON.");
        const code = args.code;
        if (typeof code !== "string" || code.trim() === "") {
          return createToolCallError("`code` must be a diagnostic code such as `GBX0410`.");
        }
        const found = explainDiagnostic(code);
        if (found === undefined) {
          // Not an error: a lock or transcript from a newer build can name a
          // code this one has never declared, and saying so is the true answer.
          return json({
            code: code.trim().toUpperCase(),
            known: false,
            why: "This build's catalogue does not declare that code.",
          });
        }
        return json({ known: true, ...found });
      },
    };
  }
}

@injectable()
export class ResolvePreviewTool extends GearboxTool {
  static ID = "gearbox_resolve_preview";

  getTool(): ToolRequest {
    return {
      id: ResolvePreviewTool.ID,
      name: ResolvePreviewTool.ID,
      description:
        "What the product would become. Applies the proposed addition and edits to the " +
        "description in memory and resolves that; nothing is written and the lock is not " +
        "touched. Returns the resulting topology and diagnostics. To actually change the " +
        "product, use `gearbox_toggle_gear`, which asks the operator first.",
      parameters: {
        type: "object",
        properties: {
          add_gear: {
            type: "string",
            description: "A gear id to add before resolving. Its source is looked up.",
          },
          profile: {
            type: "string",
            description: "Resolve for this profile instead of the one on screen.",
          },
        },
      },
      handler: async (argString: string): Promise<ToolCallResult> => {
        const args = parseArgs(argString);
        if (args === undefined) return createToolCallError("The arguments were not valid JSON.");
        const path = this.openPath();
        if (typeof path !== "string") return createToolCallError(path.error);

        let add: { gear: string; source: string } | undefined;
        const gear = args.add_gear;
        if (typeof gear === "string" && gear.trim() !== "") {
          // The source is read, never assumed: `use_gear` names both halves and
          // the id alone does not fix the source, so a constant here would
          // preview a product nobody is going to write.
          const source = this.catalogue.sourceOf(gear);
          if (source === undefined) {
            return createToolCallError(
              `The catalogue has no gear called \`${gear}\`, so there is no source to ` +
                `record for it.`,
            );
          }
          add = { gear, source };
        }

        const profile =
          typeof args.profile === "string" && args.profile.trim() !== ""
            ? args.profile
            : this.products.current.profile;
        const edits: readonly ProductEdit[] = this.edits.draftEdits(path);
        const result = await this.service.resolvePreview({
          path,
          ...(profile === undefined ? {} : { profile }),
          ...(add === undefined ? {} : { add }),
          // The unapplied draft is part of the proposal: previewing without it
          // would answer about a product the operator has already moved past.
          ...(edits.length === 0 ? {} : { edits }),
        });

        const product = result.product;
        return json({
          written: false,
          profile,
          added: add?.gear ?? null,
          resolved: product != null,
          topology:
            product == null
              ? null
              : topologySnapshot({ ...this.products.current, resolution: result }),
          diagnostics: (result.diagnostics ?? []).map((diagnostic) => ({
            code: diagnostic.code,
            severity: diagnostic.severity,
            message: diagnostic.message,
          })),
        });
      },
    };
  }
}

@injectable()
export class GeneratePreviewTool extends GearboxTool {
  static ID = "gearbox_generate_preview";

  getTool(): ToolRequest {
    return {
      id: GeneratePreviewTool.ID,
      name: GeneratePreviewTool.ID,
      description:
        "What generation would write: one line per file, with the action (`create`, " +
        "`update`, `unchanged`, `conflict`, `kept`), who owns it, and what kind it is. " +
        "Nothing is written. File contents are not included; the operator reads those in " +
        "the Generate panel's diff editor.",
      parameters: {
        type: "object",
        properties: {
          profile: {
            type: "string",
            description: "Plan for this profile instead of the one on screen.",
          },
        },
      },
      handler: async (argString: string): Promise<ToolCallResult> => {
        const args = parseArgs(argString);
        if (args === undefined) return createToolCallError("The arguments were not valid JSON.");
        const path = this.openPath();
        if (typeof path !== "string") return createToolCallError(path.error);
        const profile =
          typeof args.profile === "string" && args.profile.trim() !== ""
            ? args.profile
            : this.products.current.profile;
        // No `out`: the engine's default is the tree the CLI writes, and Studio
        // sending its own would put the plan somewhere the panel does not look.
        const plan = await this.service.planGenerate(path, profile);
        return json({
          written: false,
          out_root: plan.out_root,
          overridden_templates: plan.overridden_templates ?? [],
          files: plan.plans.slice(0, LIST_CAP).map((file) => ({
            path: file.path,
            action: file.action,
            ownership: file.ownership,
            kind: file.kind,
          })),
          total_files: plan.plans.length,
          omitted: Math.max(0, plan.plans.length - LIST_CAP),
          diagnostics: (plan.diagnostics ?? []).map((diagnostic) => ({
            code: diagnostic.code,
            severity: diagnostic.severity,
            message: diagnostic.message,
          })),
        });
      },
    };
  }
}

/** Every tool this file contributes, in the order the agent should learn them. */
export const GEARBOX_TOOLS = [
  GetSelectionTool,
  GetProductTool,
  ListGearsTool,
  GetGearTool,
  GetDiagnosticsTool,
  ExplainDiagnosticTool,
  ResolvePreviewTool,
  GeneratePreviewTool,
] as const;
