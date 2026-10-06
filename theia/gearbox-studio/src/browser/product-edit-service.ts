// Adding a gear to the open product, and everything that has to be true first.
//
// A service rather than a handler in the catalogue widget: the policy here is not
// about rendering, and there are four separate reasons to refuse before anything
// is written. Keeping them in the widget would mean the next widget that wants to
// edit a description reimplements the checks, and the checks are the substance.
//
// The order is deliberate:
//
//   1. a product must be open, or there is nothing to add to;
//   2. the description must not have unsaved changes in the editor -- see below;
//   3. the engine must agree the edit is possible, which is the dry run;
//   4. the person must agree, which is the preview.
//
// **The unsaved-buffer check is the one worth arguing for.** If a person has
// `product.gdl` open and modified, writing under them destroys their edit -- which
// is precisely the failure ADR `cpt-gearbox-adr-authoring-ownership-tiers` exists
// to prevent, and worse than the one it worries about, because the tool would be
// the author of the loss. Saving on their behalf is not the answer either: that
// commits an edit they had not finished. So this refuses and says which file.
//
// **The checks run twice, and the second time is not paranoia.** Steps 1 to 3
// establish facts; step 4 waits for a person, for as long as they like. Nothing
// keeps the world still in between -- a profile switch, a re-resolve, a close or
// an editor going dirty all happen while the dialog is up. So every fact is
// re-established after the dialog returns, and the dry run is re-run and
// compared: an answer about a state that has gone is refused rather than applied
// to whatever is there now.
//
// Config, features and profile scalars accumulate in a per-product draft and
// commit through `applyEdits` once (Apply), so the preview dialog is not one
// blur away from every field.

import { ConfirmDialog, ConfirmDialogProps } from "@theia/core/lib/browser";
import { Emitter, Event } from "@theia/core/lib/common/event";
import type { Message } from "@theia/core/shared/@lumino/messaging";
import { MessageService } from "@theia/core/lib/common/message-service";

import { hasUnsavedEdits } from "./shell/unsaved";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import type { ClusterPrimitive } from "../common/generated/ClusterPrimitive";
import type { ConfigValue } from "../common/generated/ConfigValue";
import type { EditGearResult } from "../common/generated/EditGearResult";
import type { PluginTarget } from "../common/generated/PluginTarget";
import type { ProductEdit } from "../common/generated/ProductEdit";
import type { ResolveResult } from "../common/generated/ResolveResult";
import { GearboxService } from "../common/protocol";
import { isEngineGone, isOutcomeUnknown } from "./engine-failure";
import { ProductStore } from "./product-store";
import { ProductSessionService } from "./shell/product-session-service";
import { identityOf, type ContextIdentity } from "./shell/screens";
import { EngineConnectionService } from "./shell/engine-connection-service";
import { StudioContextService } from "./shell/studio-context-service";

/**
 * A resolution preview, or the engine's reason for not producing one.
 *
 * Two kinds of failure end up in a configurator, and they belong in different
 * places: one is about a *field* -- an unknown key, a value that will not parse
 * -- and one is about the whole proposal. Carrying the reason lets the panel put
 * the second where the second belongs, instead of attaching a whole-proposal
 * failure to whichever row was edited last.
 */
/**
 * What a write attempt came to.
 *
 * Three answers rather than two, because the middle one used to be reported as a
 * failure: `unchanged` is the engine saying the description already contains the
 * edit, which is the ordinary idempotent case *and* what a person finds after a
 * write whose answer never arrived. A caller that cannot tell it from a refusal
 * cannot drop a draft that is already saved.
 */
export type EditOutcome = "written" | "unchanged" | "refused";

export type ResolutionPreview =
  | { readonly ok: true; readonly resolution: ResolveResult }
  | { readonly ok: false; readonly reason: string };

/**
 * What `createProduct` achieved: nothing (`false`), the file written but the
 * product not opened (`"created"` -- the open has already said why), or both.
 */
export type CreateOutcome = false | "created" | "opened";

@injectable()
export class ProductEditService {
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(ProductStore) protected readonly product!: ProductStore;
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(MonacoTextModelService) protected readonly models!: MonacoTextModelService;
  @inject(MessageService) protected readonly messages!: MessageService;
  // Read only, and only to know which subject a caller composed for.
  @inject(StudioContextService) protected readonly contexts!: StudioContextService;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;

  /** Queued edits for the open product path, awaiting Apply or Discard. */
  protected drafts = new Map<string, ProductEdit[]>();
  protected readonly onDraftChangedEmitter = new Emitter<void>();
  readonly onDraftChanged: Event<void> = this.onDraftChangedEmitter.event;

  /**
   * Bumped whenever the draft is dropped, so a control can be remounted from the
   * saved intent.
   *
   * **One counter, here, because there is one draft.** The Inspector and the
   * Product view each kept a private `editEpoch` and each bumped its own on
   * Discard -- while `hasDraft()` is product-wide, so both panels showed
   * `Apply changes` / `Discard` for a draft either of them could have queued.
   * Discarding through one panel therefore remounted that panel's inputs and left
   * the other panel's showing text the file did not contain: the interface
   * asserting that an edit was dropped while displaying it. A React input whose
   * `value` prop is unchanged between two renders is not rewritten, so the DOM
   * keeps whatever the person typed -- which is why the remount is needed at all,
   * and why it cannot be per-panel.
   */
  get epoch(): number {
    return this.draftEpoch;
  }

  protected draftEpoch = 0;

  /** Whether the open product names this gear directly. */
  inProduct(gear: string): boolean {
    return this.product.current.intent?.selected_gears.some((entry) => entry.gear === gear) ?? false;
  }

  /** Whether an edit is possible at all right now. */
  get editable(): boolean {
    return this.product.current.open !== undefined;
  }

  /** Whether the open product has unapplied draft edits. */
  hasDraft(path?: string): boolean {
    const target = path ?? this.product.current.open?.path;
    if (target === undefined) return false;
    return (this.drafts.get(target)?.length ?? 0) > 0;
  }

  /** The queued edits for a path (open product when omitted). */
  draftEdits(path?: string): readonly ProductEdit[] {
    const target = path ?? this.product.current.open?.path;
    if (target === undefined) return [];
    return this.drafts.get(target) ?? [];
  }

  /**
   * Queue one edit into the open product's draft.
   *
   * Replaces an earlier draft that targets the same config key, feature list, or
   * profile field. Secret-like config keys are refused here so the form never
   * holds a value the engine will reject on Apply.
   */
  queueDraft(edit: ProductEdit): boolean {
    const open = this.product.current.open;
    if (open === undefined) {
      this.messages.warn("Open a product before editing it.");
      return false;
    }
    // Narrowed by type, exactly as `refuses_as_literal_secret` narrows it in the
    // engine: a bool or a number cannot carry a credential, so a `mtls_key`
    // checkbox is no longer refused for a reason that never applied to it. The
    // two must agree -- this one is UX, the engine's is the rule.
    if (
      (edit.kind === "set_config" || edit.kind === "set_plugin_config") &&
      typeof edit.value === "string" &&
      isSecretConfigKey(edit.key)
    ) {
      this.messages.error(
        `refusing to write config key \`${edit.key}\`: names like this are for external secret references`,
      );
      return false;
    }
    const next = mergeDraft(this.drafts.get(open.path) ?? [], edit);
    this.drafts.set(open.path, next);
    this.onDraftChangedEmitter.fire();
    return true;
  }

  /**
   * Drop the draft for the open product and restore widgets from the store.
   *
   * Returns whether there was anything to discard.
   */
  discardDraft(path?: string): boolean {
    const target = path ?? this.product.current.open?.path;
    if (target === undefined) return false;
    const had = this.drafts.delete(target);
    // Bumped and fired unconditionally, even with nothing to drop. A caller that
    // relied on the return value to decide whether to re-render had to know
    // whether a draft existed, which is this service's business; and a Discard
    // that renders nothing looks broken whether or not it had work to do.
    this.draftEpoch += 1;
    this.onDraftChangedEmitter.fire();
    return had;
  }

  /**
   * Dry-run the draft once, confirm once, write once via `applyEdits`.
   */
  /**
   * Remove a gear, or one connection under it, after a preview and a confirmation.
   *
   * Structural, so it is written on its own rather than queued: a draft holds
   * config and profile edits, which describe entries that still exist. Mixing a
   * removal into that batch is refused by the engine anyway, because removing an
   * entry moves the ones the other edits address.
   *
   * Draft edits aimed at what is being removed go with it, and the confirmation
   * says how many, because agreeing to a removal is not agreeing to silently
   * lose unrelated typing.
   */
  async removeComposition(gear: string, entryIndex?: number): Promise<boolean> {
    const state = this.product.current;
    const open = state.open;
    if (!open) return false;
    const plugin =
      entryIndex === undefined
        ? undefined
        : state.intent?.selected_gears
            .find(g => g.gear === gear)
            ?.plugins?.find(p => p.entry_index === entryIndex);
    if (entryIndex !== undefined && !plugin) return false;
    const operation: ProductEdit =
      plugin && entryIndex !== undefined
        ? { kind: "remove_plugin", target: { gear, plugin: plugin.gear, entry_index: entryIndex } }
        : { kind: "remove_gear", gear };
    const affected = (edit: ProductEdit): boolean =>
      "target" in edit
        ? edit.target.gear === gear &&
          (entryIndex === undefined || edit.target.entry_index === entryIndex)
        : "gear" in edit && edit.gear === gear && entryIndex === undefined;
    const count = this.draftEdits().filter(affected).length;
    let before: string | undefined;
    const ok = "written" === (await this.applyDescriptionEdit({
      title: "Remove from product",
      ok: "Remove",
      path: open.path,
      label: open.label,
      summary:
        `Remove ${plugin?.gear ?? gear}${plugin ? ` from ${gear}` : ""}.` +
        (count > 0 ? ` ${count} pending change(s) to it will be discarded.` : ""),
      targets: [operation],
      dryRun: async () => {
        const preview = await this.service.applyEdits(open.path, [operation], true);
        before = preview.before;
        return preview;
      },
      commit: () => this.service.applyEdits(open.path, [operation], false, before),
      log: "remove composition entry",
    }));
    if (ok) {
      // What is left addresses entries after the removed one, which have all
      // moved up by one. Rebased here rather than dropped, so configuring two
      // connections and then removing a third does not lose the other two.
      const remaining = (this.drafts.get(open.path) ?? []).filter(edit => !affected(edit));
      this.drafts.set(
        open.path,
        remaining.map(edit => {
          if (!("target" in edit) || entryIndex === undefined) return edit;
          if (edit.target.gear !== gear || edit.target.entry_index < entryIndex) return edit;
          return { ...edit, target: { ...edit.target, entry_index: edit.target.entry_index - 1 } };
        }),
      );
      this.onDraftChangedEmitter.fire();
    }
    return ok;
  }

  async applyDraft(): Promise<boolean> {
    const open = this.product.current.open;
    if (open === undefined) return false;
    const edits = this.drafts.get(open.path) ?? [];
    if (edits.length === 0) {
      this.messages.info("Nothing to change.");
      return false;
    }
    let approvedBefore: string | undefined;
    const touched = profilesTouchedBy(edits);
    const outcome = await this.applyDescriptionEdit({
      title: "Apply changes",
      ok: "Apply",
      // **The profiles are named, and only when there are any.** A draft mixes
      // edits that are profile-scoped (a profile field, a connection's scope)
      // with ones that are not (a gear's config and features are facts about the
      // product under every profile). Naming the profile being *viewed* would
      // read as "this applies to dev", which for most of a draft is false; so
      // what is named is what the batch actually touches, and nothing when it
      // touches none.
      summary:
        `${edits.length} edit${edits.length === 1 ? "" : "s"} on ${this.productName(open.label)}` +
        (touched.length > 0 ? ` · profiles: ${touched.join(", ")}` : ""),
      path: open.path,
      label: open.label,
      targets: edits,
      dryRun: async () => { const preview = await this.service.applyEdits(open.path, edits, true); approvedBefore = preview.before; return preview; },
      commit: () => this.service.applyEdits(open.path, edits, false, approvedBefore),
      log: `apply ${edits.length} draft edit(s)`,
    });
    if (outcome === "refused") return false;
    // **Both remaining answers end the draft, and the reason they do is the
    // same.** `written` means the file now says it; `unchanged` means the file
    // already said it -- which is what a person finds after a write whose answer
    // never came back, with the change on disk and the panel still offering to
    // make it. Keeping the draft in that case left one way out, Discard, for an
    // edit that had been saved; and a person who pressed Apply again got the
    // same "nothing to change" for ever.
    //
    // **Exactly the edits that were sent, and not the draft as it now stands.**
    // `edits` was captured before the dry run, and what the engine was asked
    // about -- twice, and then committed -- is that list. Everything after it
    // takes real time: a dry run, a confirmation somebody reads, and the commit
    // itself. An edit queued in that window was never previewed, never sent and
    // never written, and `drafts.delete` threw it away with the ones that were.
    // `mergeDraft` keeps untouched entries by reference, so identity is the right
    // test -- and an edit that re-touched the same slot is a *new* object, which
    // is correct: the newer value has not been written either.
    const remaining = (this.drafts.get(open.path) ?? []).filter((edit) => !edits.includes(edit));
    if (remaining.length === 0) this.drafts.delete(open.path);
    else this.drafts.set(open.path, remaining);
    // Same remount as a discard: the controls now have to read the saved
    // intent, which is what the write just changed.
    this.draftEpoch += 1;
    this.onDraftChangedEmitter.fire();
    if (outcome === "unchanged") {
      this.messages.info(
        `${this.productName(open.label)} already contains ` +
          `${edits.length === 1 ? "this change" : "these changes"}.` +
          (remaining.length === 0
            ? " The draft is cleared."
            : ` ${remaining.length} later change${remaining.length === 1 ? "" : "s"} ` +
              `${remaining.length === 1 ? "is" : "are"} still pending.`),
      );
      // The description on disk is the answer, so make the panel show it. Not
      // a repeat of the write -- nothing is sent but a read.
      await this.product.reload();
      // Nothing was written *by this call*, and saying otherwise would be a
      // claim about an operation nobody observed.
      return false;
    }
    return true;
  }

  /**
   * Say what went wrong, and record it when it was the engine going away.
   *
   * **The inconsistency this closes was observed, not imagined.** A preview
   * refused with `the engine is not initialized` while the panel's header still
   * read `resolved` -- which is honest on its own terms, because that word is
   * about the last resolution and not about the process -- and every button that
   * asks `EngineConnectionService.isConnected` went on looking healthy. The
   * failed call is itself proof the engine is down, so it is recorded where the
   * rest of the application already looks.
   *
   * This does not explain *why* the engine went away, and does not pretend to.
   */
  protected reportFailure(error: unknown): void {
    this.noteEngine(error);
    this.messages.error(failureText(error));
  }

  protected noteEngine(error: unknown): void {
    if (isEngineGone(error)) this.engine.markDisconnected("the engine stopped");
  }

  /**
   * Record a failed write against the product, and say whether it may have landed.
   *
   * **The two are not the same failure and must not look the same.** A write
   * that never left -- `the engine is not initialized`, thrown before anything
   * was sent -- changed nothing, and the draft that produced it is still a
   * pending change. A write that went out and was never answered may be on disk
   * already: measured against a real engine, with the file changed and the panel
   * still showing the text from before it. That one makes the draft
   * unverifiable rather than pending, and the description has to be re-read
   * before anything decides what is left to do.
   */
  protected noteWriteFailure(error: unknown): void {
    this.noteEngine(error);
    if (isOutcomeUnknown(error)) {
      this.product.markStale(
        `${messageOf(error)} — the change may already be saved; reconnect and re-read ` +
          `before applying it again`,
        true,
      );
    } else if (isEngineGone(error)) {
      this.product.markStale(messageOf(error), false);
    }
  }

  /**
   * Queue one provider option, or clear it.
   *
   * Addressed by where the binding is written, and the position comes from the
   * intent rather than from this side's idea of the order: `ClusterScopeIntent`
   * carries it, because a scope bound twice in one profile is reported and
   * skipped, which makes the intent's array shorter than the file's list.
   */
  setProviderOption(
    scope: string,
    entryIndex: number,
    primitive: ClusterPrimitive,
    key: string,
    value: ConfigValue | undefined,
  ): boolean {
    return this.queueDraft({
      kind: "set_provider_option",
      scope,
      entry_index: entryIndex,
      primitive,
      key,
      value: value ?? null,
    });
  }

  /** The option values for one binding, saved text overlaid with the draft. */
  draftProviderOptions(
    entryIndex: number,
    primitive: ClusterPrimitive,
    saved: Readonly<Record<string, unknown>>,
  ): Map<string, ConfigValue> {
    const out = new Map<string, ConfigValue>();
    for (const [key, value] of Object.entries(saved)) {
      if (isConfigValue(value)) out.set(key, value);
    }
    for (const edit of this.draftEdits()) {
      if (edit.kind !== "set_provider_option") continue;
      if (edit.entry_index !== entryIndex || edit.primitive !== primitive) continue;
      if (edit.value === null) out.delete(edit.key);
      else out.set(edit.key, edit.value);
    }
    return out;
  }

  /** Whether this option of this binding has an unapplied edit. */
  providerOptionDrafted(entryIndex: number, primitive: ClusterPrimitive, key: string): boolean {
    return this.draftEdits().some(
      (edit) =>
        edit.kind === "set_provider_option" &&
        edit.entry_index === entryIndex &&
        edit.primitive === primitive &&
        edit.key === key,
    );
  }

  /** Saved config overlaid with draft set_config edits for `gear`. */
  draftConfig(gear: string, saved: Readonly<Record<string, unknown>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(saved)) {
      out[key] = String(value);
    }
    for (const edit of this.draftEdits()) {
      if (edit.kind !== "set_config" || edit.gear !== gear) continue;
      if (edit.value == null) delete out[edit.key];
      // `String(...)` for the same reason the saved side above uses it: this map
      // feeds the untyped text rows, and a typed control reads the edit itself.
      else out[edit.key] = String(edit.value);
    }
    return out;
  }

  /**
   * The same overlay as [`draftConfig`], but keeping the values' types.
   *
   * Typed controls need the value, not its spelling: a checkbox cannot read
   * `"true"` back as checked without guessing, and guessing is how `"false"`
   * becomes a truthy string. Non-scalars are dropped rather than coerced -- they
   * have no typed control, and the text rows still show them.
   */
  draftConfigValues(
    gear: string,
    saved: Readonly<Record<string, unknown>>,
  ): Map<string, ConfigValue> {
    const out = new Map<string, ConfigValue>();
    const keep = (key: string, value: unknown): void => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        out.set(key, value);
      }
    };
    for (const [key, value] of Object.entries(saved)) keep(key, value);
    for (const edit of this.draftEdits()) {
      if (edit.kind !== "set_config" || edit.gear !== gear) continue;
      if (edit.value == null) out.delete(edit.key);
      else keep(edit.key, edit.value);
    }
    return out;
  }

  /**
   * Whether one control's value is a draft rather than what the file says.
   *
   * Per control, because the `Apply changes` / `Discard` pair is one per product
   * and sits in the header: a person who has typed in two panels needs to see
   * *where* the unapplied edits are, and a single `modified` badge cannot say.
   */
  isDraftedConfig(gear: string, key: string): boolean {
    return this.draftEdits().some(
      (edit) => edit.kind === "set_config" && edit.gear === gear && edit.key === key,
    );
  }

  /**
   * What the draft says about one config key, if it says anything.
   *
   * `"removed"` matters and is not the same as "no draft": a reset queues
   * `set_config` with no value, which is how the wire spells removing a key, and
   * a caller asking "is this value the description's?" has to answer *no* for a
   * key the draft is about to take out. Without this distinction the reset
   * control stayed on screen after being clicked, offering to reset a value that
   * was already on its way out.
   */
  draftConfigState(gear: string, key: string): "set" | "removed" | undefined {
    let state: "set" | "removed" | undefined;
    for (const edit of this.draftEdits()) {
      if (edit.kind !== "set_config" || edit.gear !== gear || edit.key !== key) continue;
      state = edit.value === null ? "removed" : "set";
    }
    return state;
  }

  /** Whether this gear's feature list is a draft. */
  isDraftedFeatures(gear: string): boolean {
    return this.draftEdits().some((edit) => edit.kind === "set_features" && edit.gear === gear);
  }

  /** Whether this profile field is a draft. */
  isDraftedProfileField(profile: string, field: string): boolean {
    return this.draftEdits().some(
      (edit) =>
        edit.kind === "set_profile_field" && edit.profile === profile && edit.field === field,
    );
  }

  /** Saved features overlaid with the latest draft set_features for `gear`. */
  draftFeatures(gear: string, saved: readonly string[]): string[] {
    let features = [...saved];
    for (const edit of this.draftEdits()) {
      if (edit.kind === "set_features" && edit.gear === gear) {
        features = [...edit.features];
      }
    }
    return features;
  }

  /** Saved profile field overlaid with draft set_profile_field. */
  draftProfileField(
    profile: string,
    field: string,
    saved: string | undefined,
  ): string | undefined {
    let value = saved;
    for (const edit of this.draftEdits()) {
      if (edit.kind === "set_profile_field" && edit.profile === profile && edit.field === field) {
        value = edit.value ?? undefined;
      }
    }
    return value;
  }

  /**
   * Refuse when the caller composed its proposal for a subject that is no longer
   * the one open.
   *
   * **`commitAddGear` is the path this exists for.** It resolves its target from
   * `this.product.current.open` at the moment it commits and has no re-check of
   * its own, so a proposal staged against one product and applied after another
   * was opened is written to the second -- silently, and with the first
   * product's gear in it.
   *
   * `applyDescriptionEdit` is a different case and was never open in the same
   * way: its post-dialog check already refuses when `open?.path` is not the path
   * it previewed, which covers both a different product and no product at all.
   * What this adds there is a refusal *before* the confirmation dialog, and a
   * reason that says what actually happened rather than "the product changed
   * while the preview was open".
   *
   * Checked at entry *and* again immediately before the write, because the
   * sequence between them contains a person: dry run, confirmation, commit. One
   * check at the top cannot see a context that moved while the dialog was up.
   *
   * A message rather than a thrown error, like every other refusal here: the
   * cause is always something the person can act on. `undefined` means a caller
   * with no subject of its own, which is not a licence -- the paths that need
   * one pass it.
   *
   * Public, for the one caller that must ask *before* calling anything else
   * here: `CreateGearWidget.create` scaffolds a crate to disk and only then
   * edits the description, so the refusal has to be reachable ahead of the first
   * write rather than only inside the second.
   */
  ownsSubject(owner: ContextIdentity | undefined): boolean {
    if (owner === undefined) return true;
    if (identityOf(this.contexts.current) === owner) return true;
    this.messages.error(
      `That was composed for a product which is no longer open, so nothing was written. ` +
        `Open it again to finish the change.`,
    );
    return false;
  }

  /**
   * Dry-run the configurator's whole proposal, and return the text it would write.
   *
   * **One batch, because the proposal is one edit.** This used to dry-run
   * `addGear` alone, and it could not do otherwise: `applyEdits` reads the file,
   * and the staged features, config and plugins are about a gear the file does
   * not name yet -- so the panel's "What will be written" showed the `use_gear`
   * line and nothing else, while the commit wrote twice. With
   * `ProductEdit::AddGear` in the batch the engine folds the whole proposal onto
   * the same text and hands back its `after`, so the preview *is* the
   * serialization rather than a client's account of one.
   *
   * Returns `undefined` when the edit is refused or impossible; the caller shows
   * the engine's reason via the message service already fired here.
   */
  async previewStagedAdd(
    edits: readonly ProductEdit[],
    owner?: ContextIdentity,
  ): Promise<StagedPreview> {
    if (!this.ownsSubject(owner)) {
      return { ok: false, reason: "This proposal belongs to a product that is no longer open." };
    }
    const open = this.product.current.open;
    if (open === undefined) {
      return { ok: false, reason: "Open a product before adding gears to it." };
    }
    if (this.isDirty(open.path)) {
      return {
        ok: false,
        reason:
          `${open.label} has unsaved changes. Save or revert them first — ` +
          `writing now would discard your edit.`,
      };
    }
    try {
      return { ok: true, preview: await this.service.applyEdits(open.path, [...edits], true) };
    } catch (error) {
      // **Recorded, not announced.** A dry run is a question, and the answer
      // belongs to the window that asked it. Raising a global notification here
      // said the same thing twice — and cost the dialog its Escape key, because
      // Theia gives Escape to a visible toast before the dialog underneath it:
      // one press per toast, and only then the dialog. That is the whole of
      // "Escape did not close it and Cancel did".
      this.noteEngine(error);
      return { ok: false, reason: messageOf(error) };
    }
  }

  /**
   * Resolve the product as it *would* be with this gear and these edits.
   *
   * Answers the question the configurator exists for -- which gears the closure
   * pulls in, which applications change, which bindings stop being local -- before
   * anything is written. Nothing is written: the engine applies the edits to the
   * text in memory and resolves that.
   *
   * The dirty-buffer refusal of the write paths deliberately does **not** apply.
   * Reading a stale file to answer a hypothetical costs nothing, and refusing here
   * would blank the panel for the whole time an editor is open -- exactly when a
   * person most wants to see what their change does.
   *
   * Failure returns `undefined` and says nothing: this runs on every keystroke's
   * debounce, and a message toast per failed preview would be noise. The panel
   * reports it in place.
   */
  async previewResolution(edits: readonly ProductEdit[]): Promise<ResolutionPreview> {
    const open = this.product.current.open;
    if (open === undefined) {
      return { ok: false, reason: "Open a product to see what adding this would change." };
    }
    if (edits.length === 0) {
      return { ok: false, reason: "Nothing is staged yet, so there is nothing to resolve." };
    }
    try {
      return { ok: true, resolution: await this.service.resolvePreview({
        path: open.path,
        profile: this.product.current.profile,
        // **The same array the dry run and the write get, and no `add`.** The
        // separate `add: { gear, source }` parameter was a second description of
        // the proposal, and the two disagreed the moment a proposal stopped being
        // a top-level addition: a plugin is attached with `add_plugin`, while the
        // preview went on asking what would happen if it were added as a gear --
        // so the panel showed "1 gear joins the closure" beside its own refusal
        // to add it that way. `ProductEdit::AddGear` is expressible as an edit,
        // so one array says everything and the engine folds it in order.
        edits: [...edits],
      }) };
    } catch (error) {
      // **The reason travels, and the toast still does not.** Returning
      // `undefined` left the panel to invent "Could not resolve the product with
      // this gear added", which says nothing a person can act on -- while the
      // engine had said exactly what was wrong. The no-toast rule is unchanged:
      // this runs on every keystroke's debounce, and a message per failed
      // preview would be noise.
      this.noteEngine(error);
      return { ok: false, reason: messageOf(error) };
    }
  }

  /**
   * Commit the configurator's proposal: **one** `applyEdits`, one write.
   *
   * The configurator is the confirmation UI, so there is no second modal -- the
   * dry run the panel already showed is the preview ADR
   * `cpt-gearbox-adr-authoring-ownership-tiers` requires.
   *
   * This used to be `addGear` and then a second `applyEdits`, which left a window
   * where the description named a gear nobody had configured: if the second call
   * failed -- a refused config key, a dirty buffer arriving between the two --
   * the product was half-edited and the panel had already closed. The fold in
   * `apply_product_edits` fails the whole batch on any refusal, so the atomicity
   * was always available; what was missing was a way to put the addition *in* the
   * batch.
   */
  async commitAddGear(
    gear: string,
    edits: readonly ProductEdit[],
    owner?: ContextIdentity,
    expectedBefore?: string,
  ): Promise<boolean> {
    if (!this.ownsSubject(owner)) return false;
    const open = this.product.current.open;
    if (open === undefined) {
      this.messages.warn("Open a product before adding gears to it.");
      return false;
    }
    if (this.isDirty(open.path)) {
      this.messages.error(
        `${open.label} has unsaved changes. Save or revert them first — ` +
          `writing now would discard your edit.`,
      );
      return false;
    }

    let preview: EditGearResult;
    try {
      preview = await this.service.applyEdits(open.path, [...edits], true);
    } catch (error) {
      this.reportFailure(error);
      return false;
    }
    if (!preview.changed) {
      this.messages.info(`${this.productName(open.label)} already names ${gear}.`);
      return false;
    }

    // Again, immediately before the write. The dry run above is a round trip to
    // the engine, and a product can be closed or switched while it is in flight
    // -- which is the whole reason one check at the top is not enough.
    if (!this.ownsSubject(owner)) return false;
    // eslint-disable-next-line no-console
    console.info(`Gearbox: writing add ${gear} to ${open.path}`, new Error("write path").stack);
    try {
      await this.service.applyEdits(open.path, [...edits], false, expectedBefore ?? preview.before);
    } catch (error) {
      this.reportFailure(error);
      await this.product.reload();
      return false;
    }

    await this.product.reload();
    // Adding appends, so nothing a draft already addresses moves: every
    // `entry_index` in it still names the entry it named. The document snapshot
    // the batch is checked against is taken fresh at Apply, not held here.
    return true;
  }

  /**
   * Apply a batch to a named product, with the full gates.
   *
   * For a caller that is not editing the *open* product: `Create Gear` finishes
   * by declaring the new folder as a source of the product it was started from
   * and adding the gear, and that product is named rather than assumed -- the
   * panel it runs in has no product session of its own.
   *
   * Everything else is the ordinary path: dry run, preview, confirmation, write,
   * and the dirty-buffer refusal, because a description with unsaved changes is
   * the one case where writing destroys work (ADR
   * `cpt-gearbox-adr-authoring-ownership-tiers`, §9.2 refusal 2).
   */
  async applyProductEdits(
    target: { path: string; label: string },
    edits: readonly ProductEdit[],
    owner?: ContextIdentity,
  ): Promise<boolean> {
    if (edits.length === 0) return false;
    if (!this.ownsSubject(owner)) return false;
    return "written" === (await this.applyDescriptionEdit({
      title: "Add to product",
      ok: "Add",
      summary: `${edits.length} edit${edits.length === 1 ? "" : "s"} on ${target.label}`,
      path: target.path,
      label: target.label,
      targets: edits,
      dryRun: () => this.service.applyEdits(target.path, [...edits], true),
      commit: () => this.service.applyEdits(target.path, [...edits], false),
      log: `apply ${edits.length} edit(s) to ${target.path}`,
    }));
  }

  /**
   * Add or remove `gear`, asking first.
   *
   * Returns whether the description changed, so a caller can avoid a needless
   * reload -- and so "nothing happened" is distinguishable from "you cancelled".
   */
  async toggle(gear: string, source: string): Promise<boolean> {
    const open = this.product.current.open;
    if (open === undefined) {
      this.messages.warn("Open a product before adding gears to it.");
      return false;
    }

    if (this.isDirty(open.path)) {
      this.messages.error(
        `${open.label} has unsaved changes. Save or revert them first — ` +
          `writing now would discard your edit.`,
      );
      return false;
    }

    const add = !this.inProduct(gear);
    let preview: EditGearResult;
    try {
      preview = add
        ? await this.service.addGear(open.path, gear, source, true)
        : await this.service.removeGear(open.path, gear, true);
    } catch (error) {
      // The engine's refusals carry their own reasons -- a `gears` list built by a
      // helper, a path outside the workspace -- and they are more useful than
      // anything this could invent.
      this.reportFailure(error);
      return false;
    }

    if (!preview.changed) {
      this.messages.info(
        add
          ? `${this.productName(open.label)} already names ${gear}.`
          : `${this.productName(open.label)} does not name ${gear}.`,
      );
      return false;
    }

    // Captured before the dialog, compared after it. See the header.
    const at = this.product.revision;
    if (!(await this.confirm(add, gear, this.productName(open.label), preview))) {
      return false;
    }
    if (!(await this.stillTrue(at, open.path, gear, source, add, preview))) {
      return false;
    }

    try {
      if (add) {
        await this.service.addGear(open.path, gear, source, false);
      } else {
        await this.service.removeGear(open.path, gear, false);
      }
    } catch (error) {
      this.reportFailure(error);
      return false;
    }

    // Re-read and re-resolve: the description changed, so every answer on screen
    // is about the previous one until this finishes.
    await this.product.reload();
    return true;
  }

  async createProduct(params: {
    path: string;
    id: string;
    name: string;
    version: string;
    sources: ReadonlyArray<{ id: string; at: string }>;
    profileKind: string;
    profileId: string;
    cloneFrom?: string;
    rebaseRelativePaths?: boolean;
  }, owner?: ContextIdentity): Promise<CreateOutcome> {
    // **What this does and does not protect, since it differs from the others.**
    // There is no target product to get wrong: the path is absolute and chosen
    // in the wizard. What the check refuses is a wizard whose launch context has
    // moved on completing a write the person has stopped expecting -- the same
    // belt-and-braces as the edit paths, for the case where the shell failed to
    // withdraw it. Withdrawal ordinarily closes it first, which is why this is a
    // second barrier rather than the only one.
    if (!this.ownsSubject(owner)) return false;
    let preview: EditGearResult;
    try {
      preview = await this.service.createProduct({ ...params, dryRun: true });
    } catch (error) {
      this.reportFailure(error);
      return false;
    }
    // **Compared against what the dialog showed, not what the wizard's pane
    // showed.** The pane is refreshed on a debounce, so for a moment after a
    // keystroke it still held the previous answer -- "Choose a destination",
    // say -- and a Create pressed then was refused after the person confirmed,
    // with a warning about a dialog that had not changed at all. What a person
    // agreed to is the text in the dialog; that is the one a change is measured
    // from.
    const confirmed = preview.after;
    if (!(await this.confirmCreate(params.name, preview))) return false;
    try {
      preview = await this.service.createProduct({ ...params, dryRun: true });
    } catch (error) {
      this.reportFailure(error);
      return false;
    }
    if (preview.after !== confirmed) {
      this.messages.warn("The preview changed while the dialog was open. Try again.");
      return false;
    }
    // Again, because the dialog above is a person taking their time.
    if (!this.ownsSubject(owner)) return false;
    // eslint-disable-next-line no-console
    console.info(`Gearbox: writing create ${params.path}`, new Error("write path").stack);
    try {
      await this.service.createProduct({ ...params, dryRun: false });
    } catch (error) {
      this.reportFailure(error);
      return false;
    }
    await this.product.ensureDiscovered();
    // **Open it by the reference discovery minted, not by one built here.**
    // `ProductRef.label` is a repository-relative path by contract, and passing
    // `params.name` put a display name in that slot -- so the shell header read
    // the name until the product was closed and reopened, then read the path,
    // and the catalogue's Add/Remove dialogs inherited whichever it happened to
    // be. Discovery has just run, so the correct reference is already in hand;
    // the fallback keeps the open working if it has not caught up.
    const discovered = this.product.current.products.find((ref) => ref.path === params.path);
    // **Written is not the same as opened**, and the caller acts on the
    // difference: it shows the product only if there is one to show. Answering
    // `true` either way made the wizard ask for the Product view with no product
    // open -- a command with no enabled handler, thrown into the console -- after
    // the open had already said why it refused.
    const opened = await this.session.open(
      discovered ?? { path: params.path, label: params.name },
    );
    return opened ? "opened" : "created";
  }

  async addProfile(
    kind: string,
    id: string,
    fields: ReadonlyArray<{ name: string; value: string }>,
  ): Promise<boolean> {
    const open = this.product.current.open;
    if (open === undefined) return false;
    return "written" === (await this.applyDescriptionEdit({
      title: "Add profile",
      ok: "Add",
      summary: `profile ${id}`,
      path: open.path,
      label: open.label,
      dryRun: () => this.service.addProfile(open.path, kind, id, fields, true),
      commit: () => this.service.addProfile(open.path, kind, id, fields, false),
      log: `add profile ${id}`,
    }));
  }

  async removeProfile(id: string): Promise<boolean> {
    const open = this.product.current.open;
    if (open === undefined) return false;
    return "written" === (await this.applyDescriptionEdit({
      title: "Remove profile",
      ok: "Remove",
      summary: `profile ${id}`,
      path: open.path,
      label: open.label,
      dryRun: () => this.service.removeProfile(open.path, id, true),
      commit: () => this.service.removeProfile(open.path, id, false),
      log: `remove profile ${id}`,
    }));
  }

  /**
   * The open product as a person names it, for prose that is about the product.
   *
   * **Not for prose about the file.** "X has unsaved changes. Save or revert
   * them first" has to help somebody find an editor tab, and the path does that
   * where a display name does not -- so those messages keep `label`, which is a
   * repository-relative path by `ProductRef`'s contract. This is for the
   * sentences that name the thing being changed.
   */
  protected productName(fallback: string): string {
    return this.product.current.intent?.display_name ?? fallback;
  }

  protected async applyDescriptionEdit(args: {
    title: string;
    ok: string;
    summary: string;
    path: string;
    label: string;
    dryRun: () => Promise<EditGearResult>;
    commit: () => Promise<EditGearResult>;
    log: string;
    /** The edits this preview is of, named in the dialog. See `describeEdit`. */
    targets?: readonly ProductEdit[];
  }): Promise<EditOutcome> {
    if (this.isDirty(args.path)) {
      this.messages.error(
        `${args.label} has unsaved changes. Save or revert them first — writing now would discard your edit.`,
      );
      return "refused";
    }
    let preview: EditGearResult;
    try {
      preview = await args.dryRun();
    } catch (error) {
      this.reportFailure(error);
      return "refused";
    }
    if (!preview.changed) {
      // **Not a refusal, and the caller has to be able to tell.** The engine
      // answering `changed: false` means the description already says this --
      // the ordinary idempotent case, and also the state a write of unknown fate
      // leaves behind. A draft in that state was reported as pending for ever:
      // the only way out was Discard, for a change that had been saved. See
      // `applyDraft`, which is the caller that can say something useful about it.
      return "unchanged";
    }
    const at = this.product.revision;
    if (!(await this.confirmEdit(args.title, args.ok, args.summary, preview, args.targets ?? [])))
      return "refused";
    const open = this.product.current.open;
    if (this.product.revision !== at || open?.path !== args.path || this.isDirty(args.path)) {
      this.messages.warn("Nothing was written: the product changed while the preview was open.");
      return "refused";
    }
    let again: EditGearResult;
    try {
      again = await args.dryRun();
    } catch (error) {
      this.reportFailure(error);
      return "refused";
    }
    if (!again.changed || again.after !== preview.after) {
      this.messages.warn("Nothing was written: the description on disk is not the one previewed.");
      // `unchanged` when the second dry run says the file already contains it:
      // between the preview and the confirmation somebody -- or the engine,
      // finishing a write nobody heard about -- got there first.
      return again.changed ? "refused" : "unchanged";
    }
    // eslint-disable-next-line no-console
    console.info(`Gearbox: writing ${args.log} to ${args.path}`, new Error("write path").stack);
    try {
      await args.commit();
    } catch (error) {
      // **The write half, not the read half.** `reportFailure` says what went
      // wrong; this also records whether what went wrong leaves the description
      // in a state nobody knows.
      this.noteWriteFailure(error);
      this.messages.error(messageOf(error));
      return "refused";
    }
    await this.product.reload();
    return "written";
  }

  protected async confirmEdit(
    title: string,
    ok: string,
    summary: string,
    preview: EditGearResult,
    targets: readonly ProductEdit[] = [],
  ): Promise<boolean> {
    const body = document.createElement("div");
    const head = document.createElement("div");
    head.textContent = summary;
    body.appendChild(head);
    // Between the count and the diff: what each of those edits is *for*. See
    // `describeEdit` for why a diff of one file is not enough on its own.
    if (targets.length > 0) {
      const list = document.createElement("ul");
      list.className = "gbx-edit-targets";
      for (const edit of targets) {
        const item = document.createElement("li");
        item.dataset.editTarget = edit.kind;
        item.textContent = describeEdit(edit);
        list.appendChild(item);
      }
      body.appendChild(list);
    }
    const diff = document.createElement("pre");
    diff.className = "gbx-edit-preview";
    diff.textContent = this.diffText(preview);
    body.appendChild(diff);
    return (
      (await new EditPreviewDialog({ title, msg: body, ok, cancel: "Cancel" }).open()) === true
    );
  }

  protected async confirmCreate(name: string, preview: EditGearResult): Promise<boolean> {
    const body = document.createElement("div");
    body.textContent = `Create ${name}:`;
    const pre = document.createElement("pre");
    pre.className = "gbx-create-preview";
    pre.textContent = preview.after;
    body.appendChild(pre);
    return (
      (await new EditPreviewDialog({
        title: "Create product",
        msg: body,
        ok: "Create",
        cancel: "Cancel",
      }).open()) === true
    );
  }

  protected diffText(preview: EditGearResult): string {
    return diffText(preview);
  }

  /**
   * Whether everything the preview assumed is still true.
   *
   * Four things, and each of them has a different way of going wrong while a
   * modal dialog is up:
   *
   *   - the **store's revision**, which changes on a re-read, a re-resolve, a
   *     profile switch and a close. A preview computed before any of those is an
   *     answer about a product that is no longer the one on screen.
   *   - the **open product**, by path, because it may now be a different one.
   *   - the **buffer**, because an editor can go dirty while the dialog waits,
   *     and writing then is the loss the first check exists to prevent.
   *   - the **dry run**, re-run and compared byte for byte. This is the one that
   *     catches a change made outside Studio: the same edit against a file that
   *     someone else has since altered produces different text, and applying the
   *     old intention to the new file is how surgery becomes damage.
   *
   * There is a specific hazard behind all of this and it is worth naming, because
   * it is not hypothetical. `DialogOverlayService` binds Enter on
   * **`document.body`** (`@theia/core/lib/browser/dialogs.js:82`), so while this
   * dialog is open *any* Enter anywhere in the application accepts it. A keystroke
   * meant for something else can therefore answer a question the person has
   * forgotten is on screen. `EditPreviewDialog` below takes that away; this makes
   * a late answer harmless even if some other path finds its way to one.
   */
  protected async stillTrue(
    at: number,
    path: string,
    gear: string,
    source: string,
    add: boolean,
    preview: EditGearResult,
  ): Promise<boolean> {
    const stale = (why: string): false => {
      this.messages.warn(
        `Nothing was written: ${why}. The preview described a state that has changed, ` +
          `so ${add ? "adding" : "removing"} ${gear} was not applied. Try again.`,
      );
      return false;
    };

    if (this.product.revision !== at) {
      return stale("the product was re-read while the preview was open");
    }
    const open = this.product.current.open;
    if (open === undefined || open.path !== path) {
      return stale("the product was closed or replaced while the preview was open");
    }
    if (this.isDirty(path)) {
      return stale("the description now has unsaved changes in the editor");
    }

    let again: EditGearResult;
    try {
      again = add
        ? await this.service.addGear(path, gear, source, true)
        : await this.service.removeGear(path, gear, true);
    } catch (error) {
      this.reportFailure(error);
      return false;
    }
    if (!again.changed || again.after !== preview.after) {
      return stale("the description on disk is not the one the preview was computed from");
    }

    // Only reached when the write is about to happen for real. Logged rather than
    // silent because a write to a description nobody asked for is the one defect
    // in this application whose cause has not been found, and a stack trace at the
    // moment of the write is the evidence that would name it. `console.info` and
    // not `debug`: the test harness collects info and above.
    // eslint-disable-next-line no-console
    console.info(
      `Gearbox: writing ${add ? "add" : "remove"} ${gear} to ${path}`,
      new Error("write path").stack,
    );
    return true;
  }

  /** Whether the file is open in an editor with unsaved changes. */
  protected isDirty(path: string): boolean {
    return hasUnsavedEdits(this.models, path);
  }

  /**
   * The preview, as the lines that change.
   *
   * A line diff computed here purely to be shown: both sides came from the engine
   * in the same response, and nothing is decided from this. The edit is one line
   * by construction, so a full diff algorithm would be machinery for a result
   * that fits on one screen.
   */
  protected async confirm(
    add: boolean,
    gear: string,
    label: string,
    preview: EditGearResult,
  ): Promise<boolean> {
    const body = document.createElement("div");
    const summary = document.createElement("div");
    summary.textContent = `${add ? "Add" : "Remove"} ${gear} ${add ? "to" : "from"} ${label}:`;
    body.appendChild(summary);

    const diff = document.createElement("pre");
    diff.className = "gbx-edit-preview";
    diff.textContent = this.diffText(preview);
    body.appendChild(diff);

    return (
      (await new EditPreviewDialog({
        title: add ? "Add gear to product" : "Remove gear from product",
        msg: body,
        ok: add ? "Add" : "Remove",
        cancel: "Cancel",
      }).open()) === true
    );
  }
}

/**
 * A confirmation that a stray Enter cannot answer.
 *
 * Theia's `DialogOverlayService` adds its Enter listener to **`document.body`**
 * (`@theia/core/lib/browser/dialogs.js:82`) and `AbstractDialog.handleEnter`
 * accepts unless the event came from a textarea. Together with
 * `onActivateRequest` focusing the accept button, that makes Enter -- pressed
 * anywhere, for any reason, by anything -- write to a description.
 *
 * That is the right default for "Do you want to reload?" and the wrong one for a
 * dialog whose Yes edits a file. So:
 *
 *   - `handleEnter` no longer accepts. A focused button still activates on Enter,
 *     natively, because that is what a button does -- so the keyboard path to Yes
 *     survives and only the *ambient* one is gone.
 *   - the **cancel** button takes the initial focus, so that path leads to No.
 *
 * Escape is untouched: cancelling on a stray keystroke costs a person one click.
 */
class EditPreviewDialog extends ConfirmDialog {
  constructor(props: ConfirmDialogProps) {
    super(props);
    // **Named, so that "this is the confirmation" is answerable.** Adding a gear
    // is a modal dialog now and it shows what would be written, so `a
    // .dialogBlock containing a preview` no longer tells the two apart -- and
    // the claim that a catalogue `+` opens the configurator rather than writing
    // immediately depends on telling them apart.
    this.node.classList.add("gbx-edit-confirm");
  }

  protected override handleEnter(): boolean {
    return false;
  }

  protected override onActivateRequest(msg: Message): void {
    // `AbstractDialog.onActivateRequest` focuses `acceptButton`; skipping it and
    // going to the base of *that* is what puts focus on cancel instead. Falls
    // back to the accept button only if there is no cancel button to focus,
    // which would mean a dialog with one control and nothing to protect.
    if (this.closeButton !== undefined) {
      this.closeButton.focus();
      return;
    }
    super.onActivateRequest(msg);
  }
}

/**
 * What one queued edit targets, in words, for the confirmation dialog.
 *
 * **The diff alone does not say.** The preview body was the summary line plus
 * the engine's diff, and the diff is a diff of one file: changing
 * `cargo_profile` on the `local` profile showed `+ , cargo_profile =
 * "release"),` and nothing else. A person looking at the `prod` profile on
 * screen -- the switcher is per screen, the draft is per product -- had no way
 * to tell from the dialog which profile the line belonged to, which is the one
 * thing the confirmation exists to establish.
 *
 * Every arm reads fields the edit already carries, so this costs no round trip.
 */
function describeEdit(edit: ProductEdit): string {
  switch (edit.kind) {
    case "add_gear":
      return `add gear \`${edit.gear}\` from \`${edit.source}\``;
    case "remove_gear":
      return `remove gear \`${edit.gear}\``;
    case "add_source":
      return `add source \`${edit.id}\` at \`${edit.at}\``;
    case "remove_source":
      return `remove source \`${edit.id}\``;
    case "set_config":
      return edit.value === null
        ? `gear \`${edit.gear}\`: clear config \`${edit.key}\``
        : `gear \`${edit.gear}\`: config \`${edit.key}\` = ${JSON.stringify(edit.value)}`;
    case "set_features":
      return `gear \`${edit.gear}\`: features = [${edit.features.join(", ")}]`;
    case "set_provider_option":
      return edit.value === null
        ? `cluster \`${edit.scope}\`/${edit.primitive}: clear option \`${edit.key}\``
        : `cluster \`${edit.scope}\`/${edit.primitive}: \`${edit.key}\` = ` +
            `${JSON.stringify(edit.value)}`;
    case "add_plugin":
      return `gear \`${edit.gear}\`: add plugin \`${edit.plugin}\``;
    case "add_plugin_selection":
      return (
        `gear \`${edit.gear}\`: add plugin \`${edit.plugin}\` for ` +
        `${edit.profiles.join(", ") || "all profiles"}`
      );
    case "remove_plugin":
      return `gear \`${edit.target.gear}\`: remove ${describeConnection(edit.target)}`;
    case "set_plugin_config":
      return (
        `gear \`${edit.target.gear}\`, ${describeConnection(edit.target)}: ` +
        `${edit.key} = ${JSON.stringify(edit.value)}`
      );
    case "set_plugin_profiles":
      return (
        `gear \`${edit.target.gear}\`, ${describeConnection(edit.target)}: ` +
        `profiles = ${edit.profiles.join(", ") || "all profiles"}`
      );
    case "set_plugins":
      return `gear \`${edit.gear}\`: plugins = [${edit.plugins.join(", ")}]`;
    case "set_profile_field":
      return edit.value === null
        ? `profile \`${edit.profile}\`: clear \`${edit.field}\``
        : `profile \`${edit.profile}\`: \`${edit.field}\` = ${JSON.stringify(edit.value)}`;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The refusal, with the reason the engine attached to it.
 *
 * **"could not be edited" is the envelope, not the answer.** The engine puts why
 * in `data.diagnostics` -- the code, the message, what to do -- and this used to
 * show only the envelope, so an edit refused for a parse error, a stale address
 * or a secret-looking key all read as the same sentence with nothing to act on.
 * Two at most: a toast is not the Validation screen, and the first one is almost
 * always the one that matters.
 */
function failureText(error: unknown): string {
  const data = (error as { data?: unknown } | undefined)?.data;
  const list = (data as { diagnostics?: unknown } | undefined)?.diagnostics;
  if (!Array.isArray(list) || list.length === 0) return messageOf(error);
  const reasons = (list as Array<{ code?: string; message?: string; help?: string }>)
    .slice(0, 2)
    .map((d) => {
      const head = [d.code, d.message].filter((part) => part !== undefined && part !== "").join(" ");
      return d.help ? `${head} (${d.help})` : head;
    })
    .filter((line) => line !== "");
  return reasons.length === 0 ? messageOf(error) : `${messageOf(error)}: ${reasons.join("; ")}`;
}

/**
 * The lines that change, for a preview to show.
 *
 * A free function because three surfaces want it and one of them holds this
 * service by composition rather than by inheritance: the Add Gear dialog could
 * not call the `protected` method, so it showed `preview.after` -- the entire
 * `product.gdl`, comments and all -- for a change of one line.
 *
 * **A set difference, not an LCS diff, and that is worth knowing before reusing
 * it.** Identical lines are dropped wherever they appear, so a line moved rather
 * than changed shows as neither; duplicate lines collapse; and every line is
 * trimmed, so indentation is lost. That is honest for the edits this makes --
 * one entry, one key, one profile list -- and would not be for a refactor.
 */
export function diffText(preview: EditGearResult): string {
  const before = preview.before.split("\n");
  const after = preview.after.split("\n");
  const added = after.filter((line) => !before.includes(line));
  const removed = before.filter((line) => !after.includes(line));
  return [
    ...removed.map((line) => `- ${line.trim()}`),
    ...added.map((line) => `+ ${line.trim()}`),
  ].join("\n");
}

/**
 * What a dry run answered: the text it would write, or why it could not.
 *
 * The same shape `previewResolution` already returns, and for the same reason —
 * a preview's failure is information for whoever asked, not an event for the
 * whole application.
 */
export type StagedPreview =
  | { readonly ok: true; readonly preview: EditGearResult }
  | { readonly ok: false; readonly reason: string };

/** Mirror of `gearbox_gdl::edit::is_secret_config_key` for draft-time refusal. */
export function isSecretConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  const exact = ["password", "secret", "token", "key", "credential"];
  if (exact.includes(lower)) return true;
  return ["_password", "_secret", "_token", "_key", "_credential"].some((suffix) =>
    lower.endsWith(suffix),
  );
}

/**
 * Every profile a batch names, in order, without repeats.
 *
 * `set_profile_field` names one directly. A connection's scope names each
 * profile it is narrowed to -- and an empty scope names none, because "every
 * profile" is the absence of a restriction rather than a list of them.
 */
function profilesTouchedBy(edits: readonly ProductEdit[]): string[] {
  const seen = new Set<string>();
  for (const edit of edits) {
    if (edit.kind === "set_profile_field") seen.add(edit.profile);
    if (edit.kind === "set_plugin_profiles" || edit.kind === "add_plugin_selection") {
      for (const profile of edit.profiles) seen.add(profile);
    }
  }
  return [...seen];
}

/**
 * How one connection is named in a confirmation.
 *
 * Both the implementation and which entry of it: a host may hold the same plugin
 * twice for different profiles, and "remove `static-authn-plugin`" would not say
 * which of them a person is agreeing to.
 */
function describeConnection(target: PluginTarget): string {
  return `plugin \`${target.plugin}\` (connection ${target.entry_index + 1})`;
}

/** Replace an earlier draft that targets the same slot; append otherwise. */
function mergeDraft(existing: ProductEdit[], edit: ProductEdit): ProductEdit[] {
  const sameSlot = (other: ProductEdit): boolean => {
    // One connection's one key, or one connection's scope: the same slot a
    // second time replaces the first, exactly as it does for a gear's config.
    if ("target" in edit && "target" in other && edit.kind === other.kind) {
      return (
        edit.target.gear === other.target.gear &&
        edit.target.entry_index === other.target.entry_index &&
        (!("key" in edit) || ("key" in other && edit.key === other.key))
      );
    }
    if (edit.kind === "set_config" && other.kind === "set_config") {
      return other.gear === edit.gear && other.key === edit.key;
    }
    if (edit.kind === "set_features" && other.kind === "set_features") {
      return other.gear === edit.gear;
    }
    if (edit.kind === "set_profile_field" && other.kind === "set_profile_field") {
      return other.profile === edit.profile && other.field === edit.field;
    }
    // One option of one binding. The address is the written position rather than
    // the scope name: two `cluster_profile(...)` entries can share a name for
    // disjoint deployment profiles, so the name alone would merge two different
    // bindings' edits into one.
    if (edit.kind === "set_provider_option" && other.kind === "set_provider_option") {
      return (
        other.entry_index === edit.entry_index &&
        other.primitive === edit.primitive &&
        other.key === edit.key
      );
    }
    return false;
  };
  const without = existing.filter((other) => !sameSlot(other));
  without.push(edit);
  return without;
}
/**
 * Whether a saved option value is one a control can render and write back.
 *
 * A provider's options are `serde_json::Value` on the wire, so a nested object
 * or a list can be in there -- and a control that turned one into a string
 * would rewrite it on the next Apply. Those keep their written text and are
 * shown as-is, which is the treatment an undeclared gear config key already
 * gets.
 */
function isConfigValue(value: unknown): value is ConfigValue {
  return (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );
}

