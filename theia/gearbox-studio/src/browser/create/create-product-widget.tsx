// Create or clone a product description — a screen, not a chain of modals.
//
// ADR-0010: a preview is not optional. The right pane shows the exact
// `product.gdl` the engine would write; Create commits only that text.
// ADR-0013 amendment: Blank / Clone Local / Clone Git; clone stamps version
// honestly and does not rewrite sources.

import { Message, ReactWidget } from "@theia/core/lib/browser";
import { CommandRegistry } from "@theia/core/lib/common";

import { SHOW_PRODUCT } from "../shell/session-command-ids";
import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";
import { FileDialogService } from "@theia/filesystem/lib/browser";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { GearboxService, type CloneCandidate } from "../../common/protocol";
import { CatalogueStore } from "../catalogue-store";
import { ProductEditService } from "../product-edit-service";
import { repaintNow } from "../widgets/repaint";
import { EngineConnectionService } from "../shell/engine-connection-service";
import { ProductSessionService } from "../shell/product-session-service";
import type { ContextIdentity, OwnedWidget } from "../shell/screens";
import { destinationAfterIdChange, pendingPreview, suggestedProductPath } from "./destination";
import { corpusOffer, corpusSourceDecl, type CorpusCopy, type CorpusOffer } from "./corpus-source";

export type CreateMode = "blank" | "clone-local" | "clone-git";

/**
 * Where a Clone Git attempt has got to.
 *
 * `reviewing` is the state that did not exist: the old flow went from a URL
 * straight to a write, so "this repository has no product in it" was found out
 * after Create had been pressed. `creating` is not a state here -- a create
 * failure returns to `reviewing` carrying its reason, because the checkout is
 * still good and a person fixes a field and asks again. Only the clone failing
 * is terminal, and then there is nothing to retry against.
 */
export type CloneState =
  | { readonly status: "idle" }
  | { readonly status: "cloning"; readonly url: string }
  | {
      readonly status: "reviewing";
      readonly attemptId: string;
      readonly candidates: readonly CloneCandidate[];
      /** Which candidate the preview is of. Empty only if the clone had none. */
      readonly chosen: string;
      readonly commit: string;
      readonly resolvedRef?: string;
      /** A retryable failure against this checkout: a dry run or a create. */
      readonly error?: string;
    }
  | { readonly status: "failed"; readonly reason: string };

export interface CreateProductState {
  cloneFrom?: string;
  id?: string;
  name?: string;
  mode?: CreateMode;
  /** A line above the form saying why the wizard opened -- Add gear with no product. */
  note?: string;
}

@injectable()
export class CreateProductWidget extends ReactWidget implements OwnedWidget {
  static readonly ID = "gearbox.create";
  static readonly LABEL = "New Product";
  /**
   * Which subject opened this wizard.
   *
   * Stamped by the contribution's `open*` path, read by the withdrawal sweep:
   * a proposal composed for one product must not survive into another, because
   * `ProductEditService` resolves the target at commit time and would otherwise
   * write it to whatever is open then. Undefined until something opens it.
   */
  ownerIdentity?: ContextIdentity;

  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;
  @inject(FileDialogService) protected readonly fileDialog!: FileDialogService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;

  protected mode: CreateMode = "blank";
  protected productId = "new-product";
  protected name = "New Product";
  protected version = "0.1.0";
  protected profileKind = "embedded";
  protected profileId = "dev";
  protected cloneFrom: string | undefined;
  protected gitUrl = "";
  protected gitRef = "";

  /**
   * Where a Clone Git attempt has got to.
   *
   * `creating` returns to `reviewing`, it does not leave it: a dry-run or create
   * failure is retryable against the same checkout, and only the clone itself
   * failing is terminal. The earlier flow had one path -- Create clones, stamps
   * and writes -- so the first thing a person saw about a repository was whether
   * the whole thing had worked.
   */
  protected clone: CloneState = { status: "idle" };

  /**
   * Which clone attempt this widget is allowed to act on.
   *
   * **A logical cancellation, and it has to be**: Cancel pressed while the clone
   * is running leaves this side with no `attemptId`, and the RPC may then
   * *succeed* -- so the node layer's own failure cleanup never fires. The token
   * is what lets a late result be recognised as unwanted, kept out of the state,
   * and discarded by id the moment it arrives.
   */
  protected cloneToken = 0;
  /** Editable destination; empty means use the default under the workspace. */
  protected destination = "";
  protected destinationTouched = false;
  /** The destination came from "Use suggested", so it follows the id. */
  protected destinationFollowsId = false;
  protected preview = "";
  protected previewTimer: ReturnType<typeof setTimeout> | undefined;
  protected roots: string[] = [];
  protected selectedRoots = new Set<string>();
  protected note: string | undefined;

  /**
   * Constructor Studio: the gear corpus as a source -- see `corpus-source.ts`.
   * The copy on this machine when there is one, else the corpus the backend
   * lists, to bring here from the form.
   */
  protected corpusCopy: CorpusCopy | undefined;
  protected corpusChecked = false;
  /** Whether the checkbox has been decided for this copy, by the default or a person. */
  protected corpusDecidedFor: string | undefined;
  protected corpusKey = "";

  @postConstruct()
  protected init(): void {
    this.id = CreateProductWidget.ID;
    this.title.label = CreateProductWidget.LABEL;
    this.title.closable = true;
    this.addClass("gbx-widget-create");
    this.toDispose.push(this.engine.onDidChange(() => this.update()));
    // A copy adopted or brought while the form is open, or the backend's
    // listing arriving after sign-in, changes what the sources can offer. The
    // store fires on every projected gear too, so the backend is asked only
    // when the roots or the listing moved.
    this.toDispose.push(
      this.catalogue.onChanged(() => {
        const bring = this.catalogue.corpusBringing;
        const key = [
          this.catalogue.rootPaths().join("|"),
          this.catalogue.current.remote ?? "",
          this.catalogue.corpusToBring?.rev ?? "",
          bring.busy ? "busy" : bring.error ?? "",
        ].join("#");
        if (key === this.corpusKey) return;
        this.corpusKey = key;
        void this.refreshCorpus();
      }),
    );
    void this.refreshRoots();
  }

  protected corpusOffer(): CorpusOffer {
    return corpusOffer({
      copy: this.corpusCopy,
      toBring: this.catalogue.corpusToBring,
      bringable: this.catalogue.corpusBringable,
      workspaceRoots: this.roots.map((path) => ({ path, id: this.sourceIdFor(path) })),
      engineRoots: this.catalogue.rootPaths(),
    });
  }

  protected async refreshCorpus(): Promise<void> {
    let copy: CorpusCopy | undefined;
    try {
      copy = await this.service.corpusCopy();
    } catch {
      copy = undefined;
    }
    const changed = copy?.path !== this.corpusCopy?.path;
    this.corpusCopy = copy;
    const offer = this.corpusOffer();
    // The default is applied once per copy, so a person's unticking survives
    // every catalogue change after it.
    if (offer.kind === "copy" && this.corpusDecidedFor !== offer.copy.path) {
      this.corpusDecidedFor = offer.copy.path;
      this.corpusChecked = offer.preselect || this.corpusRequested;
      this.corpusRequested = false;
    }
    if (changed) this.schedulePreview();
    else this.update();
  }

  /** Set by the inline "Bring the gears here": tick the copy once it is here. */
  protected corpusRequested = false;

  protected async bringCorpus(): Promise<void> {
    this.corpusRequested = true;
    this.update();
    await this.catalogue.bringCorpusHere();
    await this.refreshCorpus();
  }

  openWith(state?: CreateProductState): void {
    this.note = state?.note;
    if (state?.cloneFrom !== undefined) {
      this.cloneFrom = state.cloneFrom;
      this.mode = state.mode ?? "clone-local";
      const base = state.id ?? "copy";
      this.productId = base;
      this.name = state.name ?? `${base} copy`;
    } else {
      this.cloneFrom = undefined;
      this.mode = state?.mode ?? "blank";
      this.gitUrl = "";
      this.gitRef = "";
      this.abandonClone();
    }
    if (state?.id !== undefined) this.productId = state.id;
    if (state?.name !== undefined) this.name = state.name;
    this.destinationTouched = false;
    this.destinationFollowsId = false;
    this.destination = "";
    void this.refreshPreview();
    this.update();
  }

  protected async refreshRoots(): Promise<void> {
    this.roots = this.workspace.tryGetRoots().map((r) => r.resource.path.fsPath());
    this.selectedRoots = new Set(this.selectableRoots());
    await this.refreshCorpus();
    await this.refreshPreview();
    this.update();
  }

  protected workspaceRoot(): string {
    return this.workspace.tryGetRoots()[0]?.resource.path.fsPath() ?? "";
  }

  /**
   * Where the product would go, shown as a hint and never installed as a value.
   *
   * **ADR-0013: "The wizard asks for a destination folder. It must not silently
   * take the first workspace root."** It did: this string was written into the
   * field on open, on every root refresh, and on every keystroke in the id box,
   * and `productPath()` fell back to it when the field was blank -- so a person
   * could finish a create without ever choosing a folder, and what they got was
   * `tryGetRoots()[0]`, chosen by index. It is a placeholder now, so the
   * suggestion is still visible and one click away via `Choose…`, and pressing
   * Create without a destination is not possible.
   */
  protected suggestedProductPath(): string {
    return suggestedProductPath(this.workspaceRoot(), this.productId);
  }

  /** The chosen path, or `""` when nothing has been chosen. Never a guess. */
  protected productPath(): string {
    return this.destination.trim().replace(/\\/g, "/");
  }

  /**
   * Why this product id is not usable, or `undefined` when it is.
   *
   * Mirror of `gearbox_ir::ProductId` -- `validate_kebab` -- which now refuses
   * the same values at the `gearbox/product/create` boundary. Stated twice
   * because one is a form and the other is a protocol, the arrangement
   * `isSecretConfigKey` already has with `is_secret_config_key`: the engine has
   * to refuse whatever any client sends, and the form has to say so before a
   * person presses Create.
   *
   * There was no check on either side. An empty box produced `id = ""` and a
   * destination of `products//product.gdl`; a single space produced `id = " "`
   * and a product that opened and resolved with no diagnostics at all.
   */
  protected idRefusal(): string | undefined {
    const id = this.productId.trim();
    if (id === "") return "A product needs an id. Something like `payments-demo`.";
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) {
      return `\`${id}\` is not a product id: lowercase letters, digits and single hyphens, starting with a letter. Something like \`payments-demo\`.`;
    }
    return undefined;
  }

  /**
   * The roots this product may declare as sources, given where it lands.
   *
   * **A root that contains the destination cannot be one of its sources.**
   * `writable_out_root` refuses any path inside a source root -- ADR-0013 says
   * so and ADR-0010 tier 5 is why: generation must not write next to
   * human-authored crates. So a product whose own folder sits inside a declared
   * source is a product that cannot be written, and the wizard was pre-selecting
   * exactly that: it checked *every* workspace root, and the first of those is
   * this checkout, which contains `products/`.
   *
   * The consequence was not a refused create but a poisoned session. The first
   * create succeeded -- at boot the engine's roots are the corpus only -- and
   * opened the new product, which re-initialised the engine with the roots that
   * product declared, this checkout among them. From then on every create under
   * `<checkout>/products/...` was refused, unchecking the box in a later wizard
   * changed nothing, and the only cure was opening a product whose sources
   * happened to exclude the checkout. `CatalogueStore.resetToBootSession` closes
   * the other half of that; this closes the half that starts it.
   *
   * With no destination chosen yet, nothing is excluded: there is no containment
   * to test against, and the checkboxes are inert until the field is filled.
   */
  protected selectableRoots(): string[] {
    const dir = this.productDir();
    if (dir === "") return [...this.roots];
    return this.roots.filter((root) => !contains(root, dir));
  }

  /** The directory the description lands in -- `productPath()` minus the file. */
  protected productDir(): string {
    const path = this.productPath();
    const cut = path.lastIndexOf("/");
    return cut <= 0 ? path : path.slice(0, cut);
  }

  /**
   * A source root as the new description should name it.
   *
   * **Relative where a relative form exists, absolute only where none does** --
   * the rule the generator already states for `path =` values: a tree that still
   * resolves after the whole checkout moves is the goal, and a root on another
   * volume has no relative form at all.
   *
   * Two things were wrong here and a claim found both. The distance was measured
   * from the *default* product directory rather than the chosen one, so any other
   * destination produced entries pointing at nothing. And `URI.relative` only
   * expresses descendants: the corpus is a **sibling** of this checkout, so it
   * returned nothing and every generated product named its sources by absolute
   * path -- correct on the machine that made it and broken for everyone who
   * cloned it. `../../../gears-rust` is exactly the form the existing
   * `payments-demo` uses, and it was the one form this could not produce.
   */
  protected relativeSource(at: string): string {
    const from = this.productDir().replace(/\\/g, "/").replace(/\/+$/, "");
    const to = at.replace(/\\/g, "/").replace(/\/+$/, "");
    const fromParts = from.split("/");
    const toParts = to.split("/");

    let shared = 0;
    while (
      shared < fromParts.length &&
      shared < toParts.length &&
      fromParts[shared] === toParts[shared]
    ) {
      shared += 1;
    }

    // No common root at all -- a different Windows volume, or a path this cannot
    // reason about. An absolute path that works beats a relative one that does not.
    if (shared === 0) return to;

    const up = fromParts.slice(shared).map(() => "..");
    const down = toParts.slice(shared);
    const relative = [...up, ...down].join("/");
    // The source *is* the product's own directory: `.` rather than an empty string,
    // which `path("")` would turn into a refusal one layer down.
    return relative === "" ? "." : relative;
  }

  protected setMode(mode: CreateMode): void {
    this.mode = mode;
    if (mode === "blank") {
      this.cloneFrom = undefined;
    }
    this.schedulePreview();
  }

  /**
   * Schedule the preview, and **repaint now**.
   *
   * The repaint is not a nicety, it is what makes typing work. These inputs are
   * controlled -- `value={this.field}` -- and React restores the last committed
   * props into the DOM node after every change event. A handler that mutated
   * the field and returned without repainting therefore had its character
   * erased on the spot, and it reappeared only when the debounced round trip
   * below finally repainted, one engine call later. Measured as letter-by-letter
   * typing, and the tell was that every `<select>` here repainted and every
   * `<input type="text">` did not.
   *
   * It lives here rather than in eleven handlers because every one of them
   * wants the same thing: the state changed enough to be worth a new preview,
   * so it is certainly worth showing.
   */
  protected schedulePreview(): void {
    // The hint about choosing a destination goes as soon as there is one, not
    // when the engine's dry run finally answers -- that can take a while
    // behind a catalogue load.
    this.preview = pendingPreview(this.preview, this.productPath(), this.suggestedProductPath());
    // Sent, not posted -- see `repaintNow`. `update()` posted the repaint, and
    // React put each controlled field back before it landed, so real typing
    // lost its keystrokes.
    repaintNow(this);
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.refreshPreview(), 200);
  }

  /**
   * What the engine calls this root, because that is the only name that works.
   *
   * A source id is a join: `sources` declares it and every `use_gear(source =
   * ...)` refers to it, and the ids on the other side of that join are the
   * engine's -- it names each root after its own directory, and that is what
   * `GearDescriptor::source` carries and what Add Gear writes. This used to
   * mint `source-1`, `source-2`, so a scaffolded product declared two names
   * nothing else in the application used: adding any gear to it produced
   * `use_gear("x", source = "gears-rust")` against `sources = [source(id =
   * "source-1")]`, which the loader refuses. It matched for `payments-demo`
   * only because that file was written by hand as `source(id = "gears-rust")`.
   *
   * The catalogue knows the id when it has initialized; when it has not, the
   * directory's own name lowercased is not a guess but the same rule
   * (`gearbox_engine::default_source_id`). Neither branch invents a spelling.
   */
  protected sourceIdFor(at: string): string {
    const known = this.catalogue.sourceIdOf(at);
    if (known !== undefined) return known;
    const name = at
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .split("/")
      .pop();
    // `local` is the engine's own last resort for a path with no final
    // component, and matching it keeps the two from disagreeing about `/`.
    return name === undefined || name === "" ? "local" : name.toLowerCase();
  }

  protected createParams(cloneFrom: string | undefined, dryRun: boolean) {
    const offer = this.corpusOffer();
    const sources =
      this.mode === "blank"
        ? [
            ...[...this.selectedRoots].map((at) => ({
              id: this.sourceIdFor(at),
              at: this.relativeSource(at),
            })),
            ...(offer.kind === "copy" && this.corpusChecked ? [corpusSourceDecl(offer.copy)] : []),
          ]
        : [];
    return {
      path: this.productPath(),
      id: this.productId,
      name: this.name,
      version: this.version,
      sources,
      profileKind: this.profileKind,
      profileId: this.profileId,
      cloneFrom,
      dryRun,
    };
  }

  /**
   * Stop caring about the attempt in flight, and throw away what exists.
   *
   * Bumping the token first is what makes a late success discardable: the reply
   * arrives, is recognised as unwanted, and is deleted by the id it brought with
   * it rather than leaking a directory nobody can name.
   */
  protected abandonClone(): void {
    this.cloneToken += 1;
    const attemptId = this.clone.status === "reviewing" ? this.clone.attemptId : undefined;
    this.clone = { status: "idle" };
    if (attemptId !== undefined) {
      void this.service.discardGitClone(attemptId);
    }
  }

  /**
   * Clone, and describe what is there. Nothing is created by this.
   *
   * Backstage separates entering, reviewing, running and the result, and the
   * reason is this step: a clone is where "the URL was wrong", "the branch does
   * not exist" and "this repository has no product in it" are found out, and
   * finding them out during a create means finding them out after a write has
   * been attempted.
   */
  protected async cloneAndReview(): Promise<void> {
    const url = this.gitUrl.trim();
    if (url === "") return;
    this.abandonClone();
    const token = this.cloneToken;
    this.clone = { status: "cloning", url };
    this.update();

    try {
      const review = await this.service.gitCloneProduct(
        url,
        this.gitRef.trim() === "" ? undefined : this.gitRef.trim(),
      );
      if (token !== this.cloneToken) {
        // Cancelled, or the URL changed, while this was in flight. The reply is
        // a real checkout on disk, so it is discarded by id -- not merely
        // ignored, which is what left directories behind before.
        void this.service.discardGitClone(review.attemptId);
        return;
      }
      this.clone = {
        status: "reviewing",
        attemptId: review.attemptId,
        candidates: review.candidates,
        chosen: review.candidates[0]?.id ?? "",
        commit: review.commit,
        ...(review.resolvedRef === undefined ? {} : { resolvedRef: review.resolvedRef }),
      };
      await this.previewChosenCandidate();
    } catch (error) {
      if (token !== this.cloneToken) return;
      // Terminal: there is no checkout to retry against. The node layer has
      // already removed its own directory.
      this.clone = {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    this.update();
  }

  /** Dry-run the create against the candidate now chosen, and show the text. */
  protected async previewChosenCandidate(): Promise<void> {
    if (this.clone.status !== "reviewing" || this.clone.chosen === "") return;
    const token = this.cloneToken;
    try {
      const from = await this.service.selectClonedProduct(this.clone.attemptId, this.clone.chosen);
      const dry = await this.service.createProduct({
        ...this.createParams(from, true),
      });
      if (token !== this.cloneToken) return;
      this.preview = dry.after;
      if (this.clone.status === "reviewing") this.clone = { ...this.clone, error: undefined };
    } catch (error) {
      if (token !== this.cloneToken) return;
      // Retryable: the checkout stands, and a person fixes a field and asks
      // again. Kept on the review state rather than replacing it.
      const reason = error instanceof Error ? error.message : String(error);
      this.preview = reason;
      if (this.clone.status === "reviewing") this.clone = { ...this.clone, error: reason };
    }
    this.update();
  }

  /**
   * The clone, what it found, and which of it to use.
   *
   * Backstage's shape: enter, review, run, result. What this adds to the review
   * is the two facts a URL does not carry -- which commit was actually checked
   * out, and which `product.gdl` in the repository is meant.
   */
  protected renderCloneReview(connected: boolean): React.ReactNode {
    const state = this.clone;
    return (
      <div className="gbx-clone-review" data-clone-status={state.status}>
        <button
          type="button"
          className="gbx-choice"
          data-clone-review
          // Empty URL is refused by being unavailable, not by a message after
          // the fact -- the old flow enabled Create with no URL and reported it
          // afterwards.
          disabled={!connected || this.gitUrl.trim() === "" || state.status === "cloning"}
          onClick={() => void this.cloneAndReview()}
        >
          {state.status === "cloning" ? "Cloning…" : "Clone & Review"}
        </button>

        {state.status === "failed" && (
          <div className="gbx-error" role="alert" data-clone-error>
            {state.reason}
          </div>
        )}

        {state.status === "reviewing" && (
          <>
            <div className="gbx-kv">
              <span>checked out</span>
              <span data-clone-commit={state.commit}>
                <code>{state.commit.slice(0, 12)}</code>
                {state.resolvedRef !== undefined && ` on ${state.resolvedRef}`}
              </span>
            </div>
            {/* One candidate is a fact and reads as one; several is a choice,
                and choosing the first silently is what this replaced. */}
            {state.candidates.length === 1 ? (
              <div className="gbx-kv">
                <span>found</span>
                <span data-clone-candidate={state.candidates[0]?.id}>
                  <code>{state.candidates[0]?.relPath}</code>
                </span>
              </div>
            ) : (
              <label>
                Which product
                <select
                  data-clone-candidate-pick
                  value={state.chosen}
                  disabled={!connected}
                  onChange={(e) => {
                    if (this.clone.status !== "reviewing") return;
                    this.clone = { ...this.clone, chosen: e.target.value };
                    this.update();
                    void this.previewChosenCandidate();
                  }}
                >
                  {state.candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.relPath}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {state.error !== undefined && (
              <div className="gbx-error" role="alert" data-clone-retryable>
                {state.error}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  /**
   * Closing the wizard throws away a checkout nobody asked to keep.
   *
   * The last of the terminal transitions, and the one that is easy to forget:
   * a person who clones and then closes the panel has abandoned the attempt as
   * surely as one who presses Cancel.
   */
  protected override onCloseRequest(message: Message): void {
    this.abandonClone();
    super.onCloseRequest(message);
  }

  protected async refreshPreview(): Promise<void> {
    if (!this.engine.isConnected) {
      this.preview = "";
      this.update();
      return;
    }
    if (this.mode === "clone-git") {
      // **No invented preview any more.** This used to render a hand-written
      // sketch of what a clone might produce, because a real dry run needs a
      // local file and the clone only happened on Create -- so the pane showed
      // something no engine had said. Now the clone is its own step: before it
      // there is nothing to preview, and after it the preview is the engine's
      // own dry run against the file that was actually found.
      if (this.clone.status === "reviewing") {
        await this.previewChosenCandidate();
        return;
      }
      this.preview =
        this.clone.status === "cloning"
          ? "Cloning…"
          : this.clone.status === "failed"
            ? this.clone.reason
            : this.gitUrl.trim() === ""
              ? "Enter a git URL, then Clone & Review."
              : "Clone & Review first: the preview is the engine's answer about the file it finds.";
      this.update();
      return;
    }
    if (this.mode === "clone-local" && (this.cloneFrom === undefined || this.cloneFrom.trim() === "")) {
      this.preview = "Choose a product.gdl to clone.";
      this.update();
      return;
    }
    // **A preview needs a destination, because the destination decides the
    // answer.** `sources` are written relative to the description's own folder,
    // so a preview against a guessed path is a preview of a different product.
    // The field is empty until somebody chooses; this says so rather than
    // previewing the suggestion and letting it be mistaken for the choice.
    if (this.productPath() === "") {
      this.preview = `Choose a destination. Suggested: ${this.suggestedProductPath()}`;
      this.update();
      return;
    }
    const refusal = this.idRefusal();
    if (refusal !== undefined) {
      this.preview = refusal;
      this.update();
      return;
    }
    try {
      const result = await this.service.createProduct(
        this.createParams(this.mode === "clone-local" ? this.cloneFrom : undefined, true),
      );
      this.preview = result.after;
    } catch (error) {
      this.preview = error instanceof Error ? error.message : String(error);
    }
    this.update();
  }

  protected async browseCloneSource(): Promise<void> {
    const uri = await this.fileDialog.showOpenDialog({
      title: "Clone from product.gdl",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "Product description": ["gdl"] },
    });
    if (uri === undefined) return;
    this.cloneFrom = uri.path.fsPath().replace(/\\/g, "/");
    this.schedulePreview();
  }

  /**
   * Choose the folder the product lands in.
   *
   * A folder, not a file: what a person picks is where the product goes, and the
   * description's name is not theirs to choose -- `product.gdl` is what discovery
   * looks for. So the dialog selects a directory and this appends the filename.
   *
   * The field stays editable beside it. A path is often faster to paste than to
   * navigate to, and the default has to remain visible and correctable when there
   * is no dialog worth opening.
   */
  protected async browseDestination(): Promise<void> {
    const uri = await this.fileDialog.showOpenDialog({
      title: "Folder for the new product",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    });
    if (uri === undefined) return;
    const folder = uri.path.fsPath().replace(/\\/g, "/").replace(/\/+$/, "");
    this.destinationTouched = true;
    this.destinationFollowsId = false;
    this.destination = `${folder}/product.gdl`;
    this.selectedRoots = new Set(this.selectableRoots());
    this.schedulePreview();
  }

  protected render(): React.ReactNode {
    const connected = this.engine.isConnected;
    const cloning = this.mode !== "blank";
    return (
      <div className="gbx-create">
        <div className="gbx-create-form">
          <h2>New product</h2>
          {this.note !== undefined && (
            <p className="gbx-create-note" data-create-note>
              {this.note}
            </p>
          )}
          {!connected && (
            <div className="gbx-error" role="alert" data-engine-status="disconnected">
              Engine disconnected: {this.engine.disconnectReason}. Preview and Create need the
              engine.
            </div>
          )}
          <div className="gbx-create-modes" role="tablist" aria-label="Create mode" data-create-modes>
            {(
              [
                ["blank", "Blank"],
                ["clone-local", "Clone Local"],
                ["clone-git", "Clone Git"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                className={this.mode === value ? "theia-button main" : "theia-button secondary"}
                data-create-mode={value}
                aria-selected={this.mode === value}
                disabled={!connected}
                onClick={() => this.setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {this.mode === "clone-local" && (
            <label>
              clone from
              <div className="gbx-create-row">
                <input
                  data-clone-path
                  value={this.cloneFrom ?? ""}
                  disabled={!connected}
                  onChange={(e) => {
                    this.cloneFrom = e.target.value.trim() === "" ? undefined : e.target.value.trim();
                    this.schedulePreview();
                  }}
                />
                <button
                  type="button"
                  className="theia-button secondary"
                  data-clone-browse
                  disabled={!connected}
                  onClick={() => void this.browseCloneSource()}
                >
                  Browse
                </button>
              </div>
            </label>
          )}
          {this.mode === "clone-git" && (
            <>
              <label>
                git URL
                <input
                  data-clone-git-url
                  value={this.gitUrl}
                  disabled={!connected}
                  onChange={(e) => {
                    this.gitUrl = e.target.value;
                    // Same rule as the ref: the checkout in hand is of the URL
                    // that produced it, and keeping it would let Create write
                    // from a repository the field no longer names.
                    this.abandonClone();
                    this.schedulePreview();
                  }}
                />
              </label>
              <label>
                ref (optional)
                <input
                  data-clone-git-ref
                  value={this.gitRef}
                  disabled={!connected}
                  placeholder="branch or tag"
                  onChange={(e) => {
                    this.gitRef = e.target.value;
                    // A different ref is a different checkout, so the one in
                    // hand is thrown away rather than silently reused.
                    this.abandonClone();
                    this.schedulePreview();
                  }}
                />
              </label>
              {this.renderCloneReview(connected)}
            </>
          )}
          <label>
            Product ID
            <input
              data-create-id
              value={this.productId}
              disabled={!connected}
              onChange={(e) => {
                this.productId = e.target.value;
                this.destination = destinationAfterIdChange(
                  this.destination,
                  this.destinationFollowsId,
                  this.workspaceRoot(),
                  this.productId,
                );
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            name
            <input
              data-create-name
              value={this.name}
              disabled={!connected}
              onChange={(e) => {
                this.name = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            version
            <input
              data-create-version
              value={this.version}
              disabled={!connected}
              onChange={(e) => {
                this.version = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            destination
            <div className="gbx-create-row">
              <input
                data-create-destination
                value={this.destination}
                placeholder={this.suggestedProductPath()}
                disabled={!connected}
                onChange={(e) => {
                  this.destinationTouched = true;
                  this.destinationFollowsId = false;
                  this.destination = e.target.value;
                  // Which roots may be sources depends on where the product
                  // lands, so the selection follows the destination.
                  this.selectedRoots = new Set(this.selectableRoots());
                  this.schedulePreview();
                }}
              />
              <button
                type="button"
                className="theia-button secondary"
                data-destination-browse
                disabled={!connected}
                onClick={() => void this.browseDestination()}
              >
                Choose…
              </button>
              {/* The suggestion taken by a press, never by default (ADR-0013).
                  It is a folder the product list finds: `products/<id>` under
                  the opened repository. */}
              {this.productPath() === "" && this.workspaceRoot() !== "" && (
                <button
                  type="button"
                  className="theia-button secondary"
                  data-destination-suggested
                  disabled={!connected}
                  onClick={() => {
                    this.destinationTouched = true;
                    this.destinationFollowsId = true;
                    this.destination = this.suggestedProductPath();
                    this.selectedRoots = new Set(this.selectableRoots());
                    this.schedulePreview();
                  }}
                >
                  Use suggested
                </button>
              )}
            </div>
          </label>
          {/* **The whole path, wrapped, outside the field.** A destination is
              long -- an absolute path plus `products/<id>/product.gdl` -- and a
              single-line input shows its *start*, which is the half that is the
              same for every product. The end is the half that says where this
              one lands, so it was the half nobody could read. Outside the label
              because clicking a label focuses its input, and Copy is not that. */}
          {this.productPath() !== "" && (
            <div className="gbx-create-row" data-destination-resolved>
              <span className="gbx-destination-full" data-destination-full>
                {this.productPath()}
              </span>
              <button
                type="button"
                className="theia-button secondary"
                data-destination-copy
                onClick={() => void navigator.clipboard?.writeText(this.productPath())}
              >
                Copy path
              </button>
            </div>
          )}
          {this.mode === "blank" ? (
            <div className="gbx-create-sources">
              <div>sources</div>
              {this.roots.map((root) => {
                // A root that contains the destination cannot be a source of the
                // product going into it -- see `selectableRoots`. Offered and
                // refused is worse than not offered: the refusal arrives from
                // the engine three steps later, and unchecking it afterwards
                // does not undo what the first successful create already did to
                // the session.
                const usable = this.selectableRoots().includes(root);
                return (
                  <label
                    key={root}
                    data-create-source={root}
                    data-source-unusable={usable ? undefined : "true"}
                    title={
                      usable
                        ? undefined
                        : "The product lands inside this root, and generation must not write next to human-authored crates."
                    }
                  >
                    <input
                      type="checkbox"
                      checked={usable && this.selectedRoots.has(root)}
                      disabled={!connected || !usable}
                      onChange={() => {
                        if (this.selectedRoots.has(root)) this.selectedRoots.delete(root);
                        else this.selectedRoots.add(root);
                        this.schedulePreview();
                      }}
                    />
                    {root}
                    {!usable && <span className="gbx-id"> — contains the destination</span>}
                  </label>
                );
              })}
              {this.renderCorpusSource(connected)}
              {this.productPath() !== "" && this.createParams(undefined, true).sources.length === 0 && (
                // Said before Create rather than after: a product with no
                // sources is written, and then refuses to open.
                <div className="gbx-create-sources-note" data-create-no-sources>
                  No source is selected, so the product would have no gears to compose and would not open.
                </div>
              )}
            </div>
          ) : (
            <p className="gbx-create-sources-note" data-clone-sources-note>
              sources kept from the cloned file
            </p>
          )}
          <div className="gbx-create-actions">
            <button
              type="button"
              className="theia-button main"
              data-create-submit
              // A mode that clones needs something to clone *from*, and for git
              // that is a review rather than a URL: a URL is a thing a person
              // typed, and a review is a checkout that exists.
              // A destination and a usable id are the two things create cannot
              // invent: the ADR forbids assuming the first workspace root, and
              // the engine refuses an id that is blank or not kebab-case. Both
              // are said in the preview pane; this is what stops the press.
              disabled={
                !connected ||
                this.productPath() === "" ||
                this.idRefusal() !== undefined ||
                (cloning && this.mode === "clone-local" && !this.cloneFrom) ||
                (this.mode === "clone-git" && this.clone.status !== "reviewing")
              }
              onClick={() => void this.create()}
            >
              Create
            </button>
            <button
              type="button"
              className="theia-button secondary"
              data-create-cancel
              onClick={() => this.close()}
            >
              Cancel
            </button>
          </div>
        </div>
        <pre className="gbx-create-preview" data-preview-ready={connected ? "true" : "false"}>
          {connected ? this.preview : "Preview unavailable while the engine is disconnected."}
        </pre>
      </div>
    );
  }

  /**
   * Constructor Studio: the corpus among the sources -- its copy on this
   * machine, or a way to bring one here without leaving the form.
   */
  protected renderCorpusSource(connected: boolean): React.ReactNode {
    const offer = this.corpusOffer();
    if (offer.kind === "copy") {
      return (
        <label
          data-create-source={offer.copy.path}
          data-create-source-corpus
          title="The gear corpus, from the one copy kept on this machine for every project."
        >
          <input
            type="checkbox"
            checked={this.corpusChecked}
            disabled={!connected}
            onChange={() => {
              this.corpusChecked = !this.corpusChecked;
              this.schedulePreview();
            }}
          />
          {offer.copy.path}
          <span className="gbx-id"> — the gear corpus, this machine's copy</span>
          {this.corpusChecked && (
            <div className="gbx-create-sources-note" data-corpus-local-note>
              Named by its path on this machine: the product resolves here. To share it, declare the
              corpus as <code>git(url, rev)</code> instead, which opens anywhere.
            </div>
          )}
        </label>
      );
    }
    if (offer.kind === "bring") {
      const { busy, error } = this.catalogue.corpusBringing;
      return (
        <div data-create-source-bring>
          <div>
            The gear corpus ({offer.origin.url.replace(/^https:\/\//, "").replace(/\.git$/, "")}) is not on this
            machine yet.
          </div>
          {offer.unavailable !== undefined ? (
            <div className="gbx-create-sources-note" data-corpus-unavailable>
              {offer.unavailable} Add its repository to the workspace to use it as a source.
            </div>
          ) : (
            <>
              <button
                type="button"
                className="theia-button secondary"
                data-corpus-bring
                disabled={!connected || busy}
                onClick={() => void this.bringCorpus()}
              >
                {busy ? "Bringing the gears here…" : "Bring the gears here"}
              </button>
              {offer.note !== undefined && (
                <div className="gbx-create-sources-note" data-corpus-note>
                  {offer.note}
                </div>
              )}
            </>
          )}
          {error !== undefined && (
            <div className="gbx-error" role="alert" data-corpus-error>
              {error}
            </div>
          )}
        </div>
      );
    }
    return null;
  }

  protected async create(): Promise<void> {
    if (!this.engine.isConnected) return;

    let cloneFrom = this.mode === "clone-local" ? this.cloneFrom : undefined;
    if (this.mode === "clone-git") {
      // **No cloning here any more.** Create acts on what Review found: the
      // checkout already exists, the candidate is already chosen, and the
      // preview the confirmation compares against is the engine's own dry run
      // against that file. Cloning inside Create is what made "the URL is wrong"
      // and "this repository has no product" into failures of a write.
      if (this.clone.status !== "reviewing") {
        this.messages.error("Clone & Review first, so there is something to create from.");
        return;
      }
      try {
        cloneFrom = await this.service.selectClonedProduct(
          this.clone.attemptId,
          this.clone.chosen,
        );
      } catch (error) {
        // Retryable: the attempt is gone or the candidate is not one it reported,
        // and either way the answer is to clone again.
        const reason = error instanceof Error ? error.message : String(error);
        this.clone = { ...this.clone, error: reason };
        this.messages.error(reason);
        this.update();
        return;
      }
    }

    const params = this.createParams(cloneFrom, false);
    const ok = await this.edits.createProduct(
      {
        ...params,
        preview: this.preview,
      },
      this.ownerIdentity,
    );
    if (!ok) {
      // The checkout stands and a person fixes a field and retries. Only a
      // successful create discards it, below.
      if (this.clone.status === "reviewing") {
        this.clone = { ...this.clone, error: "The product was not created. Fix the fields and try again." };
        this.update();
      }
      return;
    }
    // Terminal, and the only success path: the file has been copied into the
    // product's own place, so the checkout has nothing left to hold.
    this.abandonClone();
    this.close();
    // The product this just made is what a person wants to look at. Asked for
    // rather than assumed: `ProductViewContribution.mayTakeTheFront` will not
    // steal the front from a Gearbox surface, and this wizard was one.
    void this.commands.executeCommand(SHOW_PRODUCT.id);
  }
}

/**
 * Whether `dir` is `root` or sits underneath it.
 *
 * Segment-wise rather than a `startsWith` on the string: `/a/products-old` does
 * not sit inside `/a/products`, and a prefix test says it does. Both sides are
 * normalised to forward slashes and stripped of a trailing one, which is the
 * same shape `relativeSource` works in.
 */
function contains(root: string, dir: string): boolean {
  const normalise = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = normalise(root);
  const b = normalise(dir);
  if (a === "" || b === "") return false;
  return b === a || b.startsWith(`${a}/`);
}
