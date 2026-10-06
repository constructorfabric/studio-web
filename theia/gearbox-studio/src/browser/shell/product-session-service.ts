// Opening a product, and everything that has to be true for it to be editable.
//
// A product is a directory and the unit of work, so opening one is not "point a
// panel at a file": it decides **where the engine looks and where it may write**.
// Until this existed the backend fixed both -- `../gears-rust` as the only source
// root, the repository as the write boundary -- which meant a product anywhere
// else could be read and then silently refused on every edit and every generate,
// because `writable_path` and `writable_out_root` both measure from the declared
// workspace.
//
// **The order is forced, and one step of it is not obvious.** Source roots come
// from the product's own `sources`, and reading those means evaluating the
// description, which needs a running engine. So the engine starts twice:
//
//   1. initialize with the product's directory as the workspace and no roots --
//      enough to evaluate a description, which `load_product` does without any
//      catalogue;
//   2. read `sources`, resolve each `path(at = ...)` against the description's
//      own directory, as the IR documents it;
//   3. initialize again with those roots, which respawns the engine;
//   4. load the catalogue, then load and resolve the product.
//
// Two spawns per open is the price of deriving roots from the thing being opened
// rather than from a constant. It is the same cost `Reload Catalogue` already
// pays, and the alternative -- a client that guesses the roots -- is what this
// replaces.
//
// `git(...)` sources are fetched into the per-machine cache before step 2 reads
// the roots (`materializeGitSource`), and one that cannot be fetched is refused
// rather than skipped: a catalogue quietly missing a source is
// indistinguishable from a product whose gears do not exist.

import { StorageService } from "@theia/core/lib/browser/storage-service";

import { hasUnsavedEdits } from "./unsaved";
import { Emitter, Event } from "@theia/core/lib/common/event";
import type { SourceDecl } from "../../common/generated/SourceDecl";
import { MessageService } from "@theia/core/lib/common/message-service";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import { GearboxService, type ProductRef, type StudioSession } from "../../common/protocol";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { CatalogueStore } from "../catalogue-store";
import {
  GO,
  catalogueUsable,
  openedSuccessfully,
  projectionStalled,
  scanHintMessage,
  type Outcome,
  sourceRootsOf,
  sourcesUsable,
  type OpeningStage,
} from "./opening-outcome";
import { ProductStore } from "../product-store";
import { GearSessionService } from "./gear-session-service";
import { isInside, parentOf, resolveFrom } from "./source-paths";

// The steps and their words live in `opening-outcome.ts`, beside the decisions
// that attribute a failure to one of them. Re-exported because the Product view
// reads them and this is the service it already imports.
export {
  OPENING_LABEL,
  OPENING_STAGES,
  projectionProgress,
  type OpeningStage,
} from "./opening-outcome";

/** Where the Recent list lives. Per browser profile, like any other Theia state. */
const RECENT_KEY = "gearbox.recentProducts";

/** Constructor Studio: whether the scanning hint (`hintScanning`) was shown. */
const SCAN_HINT_KEY = "gearbox.scanHintShown";

/**
 * A remembered product, and when it was last opened.
 *
 * `openedAt` is optional because entries written before it existed have none,
 * and a Continue card that said "last opened just now" for a week-old entry
 * would be worse than one that says nothing.
 */
export interface RecentEntry extends ProductRef {
  readonly openedAt?: number;
}

/**
 * Whether an open is running, and how far it got.
 *
 * **A discriminated union rather than a stage beside a boolean**, because the
 * two can disagree and did: a bare `openingRef` said only *that* something was
 * happening, so a refusal cleared it and left the panel with nothing to show but
 * the picker again -- the message went to a toast and the screen forgot which
 * step had failed. `failed` keeps both the step and the reason, which is what a
 * person needs in order to try the right thing next.
 */
export type OpeningState =
  | { readonly status: "idle" }
  | {
      readonly status: "opening";
      readonly stage: OpeningStage;
      readonly product: ProductRef;
      /** Constructor Studio: the catalogue's projection, while the `catalogue` step waits for it. */
      readonly progress?: { readonly completed: number; readonly total: number };
    }
  | {
      readonly status: "failed";
      readonly stage: OpeningStage;
      readonly product: ProductRef;
      readonly reason: string;
    };

const IDLE: OpeningState = { status: "idle" };

/**
 * How many to keep.
 *
 * Short on purpose: a Recent list is a shortcut, and one that needs scrolling has
 * stopped being one. `Open Product` is the answer for anything older.
 */
const RECENT_LIMIT = 8;

@injectable()
export class ProductSessionService {
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(MonacoTextModelService) protected readonly models!: MonacoTextModelService;
  @inject(StorageService) protected readonly storage!: StorageService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(GearSessionService) protected readonly gears!: GearSessionService;

  /**
   * The open in flight, if any.
   *
   * **An open is not reentrant.** It respawns the engine twice, and two of them
   * interleaved leave the catalogue loading against one set of roots while the
   * product resolves against another -- which presents as a panel that never
   * finishes resolving. Several callers ask independently -- the Continue card,
   * the picker, `File > Open Product...`, a Recent entry -- so concurrent callers
   * wait for the same answer rather than starting a second sequence.
   */
  protected inFlight: Promise<boolean> | undefined;

  /**
   * Which open is the current one.
   *
   * **Because recovery made "an open in flight" a state a person acts during.**
   * A reconnect is a full open -- two engine spawns, a catalogue load, a re-read
   * -- and the thing a person is most likely to do while waiting on a broken
   * product is go and open a different one. The sequence below has five awaits
   * and installs its answer into `ProductStore` at the end of them, so without
   * this the abandoned open would finish and put product A on screen with B
   * open, which is the one failure mode a recovery path must not have.
   *
   * `ProductStore`'s epoch guards the same edge one layer down, and that is
   * deliberate: two independent guards for a state that is this hard to see by
   * hand, and neither is load-bearing alone.
   */
  protected generation = 0;

  /**
   * Which product is being opened, while it is being opened.
   *
   * An open takes two engine spawns and a catalogue load -- measured at roughly
   * three seconds on this corpus -- and until this existed nothing on screen said
   * so. The shell's answer arrived only at the end, when `ProductStore` finally
   * had a product, so the person watched Home sit there and concluded the click
   * had missed. This is what lets the Product view open *first*, with the name of
   * the thing it is waiting for.
   */
  protected openingState: OpeningState = IDLE;

  protected readonly onDidChangeOpeningEmitter = new Emitter<OpeningState>();

  /** Fires when an open starts, changes step, succeeds, or refuses. */
  readonly onDidChangeOpening: Event<OpeningState> = this.onDidChangeOpeningEmitter.event;

  /** How far the open in flight has got, or why the last one stopped. */
  get openingProgress(): OpeningState {
    return this.openingState;
  }

  /**
   * The product being opened right now, if any.
   *
   * Kept as the narrow question, because that is what the Product view's "may I
   * be on screen" test asks -- and a failed open must answer `undefined` there:
   * the panel should show what went wrong, not go on waiting.
   */
  get opening(): ProductRef | undefined {
    return this.openingState.status === "opening" ? this.openingState.product : undefined;
  }

  /**
   * End the open, unless it refused.
   *
   * **A refusal is left standing**: clearing it would put the panel back to a
   * picker a beat after saying what went wrong, which is how the reason used to
   * survive only as a toast.
   *
   * A method rather than three lines in `open`'s `finally`, because
   * `doOpen` mutates this field and the compiler cannot see that from there --
   * it narrows the field to the value `open` assigned and then reports the
   * `failed` test as unreachable. Reading it where nothing has narrowed it is
   * the honest fix; a cast would have silenced the same question.
   */
  protected settleOpening(): void {
    if (this.openingState.status === "failed") return;
    this.openingState = IDLE;
    this.onDidChangeOpeningEmitter.fire(this.openingState);
  }

  /**
   * Forget a refusal, so the previous subject owns the screen again.
   *
   * Needed because a failure is deliberately left standing: with product A open
   * and B refused at `describe`, the store still holds A while the panel shows
   * B's failure, and without this there is no way back to A short of opening it
   * again. Nothing to do when an open is in flight -- that is not a state a
   * person can dismiss.
   */
  dismissOpening(): void {
    if (this.openingState.status !== "failed") return;
    this.openingState = IDLE;
    this.onDidChangeOpeningEmitter.fire(this.openingState);
  }

  /** Whether this open is still the one being waited for. */
  protected current(generation: number): boolean {
    return this.generation === generation;
  }

  /**
   * Constructor Studio: how long the projection may go without progress before
   * the open stops and says so. Minutes on a cold desktop are normal; this is
   * for a projection that has stopped, not one that is slow.
   */
  protected projectionStallMs = 120_000;

  /**
   * Constructor Studio: wait until the catalogue has projected every gear, and
   * narrate it.
   *
   * **This is where an open spends its time, and it used to spend it hidden.**
   * `CatalogueStore.load` resolves once the engine has *started* the load, and
   * the engine answers one request at a time -- so the store's `product/load`
   * sent next was answered only when the whole projection had finished: 7 s
   * warm, 90 s and more cold on this corpus (measured on Windows), minutes on a
   * desktop opened just after start. For all of it the Product view said
   * "Reading the description…" with nothing moving, which reads as a hang.
   * Waiting here instead keeps the checklist on "loading the gears it
   * declares — 12 of 44 gears", and the store's requests are answered at once.
   *
   * A projection that stops moving for `projectionStallMs` stops the open with
   * a reason; one abandoned for another open just returns.
   */
  protected awaitProjection(ref: ProductRef, generation: number): Promise<Outcome> {
    const settled = (): boolean => this.catalogue.current.status !== "loading";
    if (settled()) return Promise.resolve(GO);
    return new Promise<Outcome>((resolve) => {
      let seen = -1;
      let movedAt = Date.now();
      const finish = (outcome: Outcome): void => {
        subscription.dispose();
        clearInterval(timer);
        resolve(outcome);
      };
      const check = (): void => {
        if (!this.current(generation) || settled()) return finish(GO);
        const { completed, total, rows } = this.catalogue.current;
        const moved = completed + rows.filter((row) => row.kind === "projected").length;
        if (moved !== seen) {
          seen = moved;
          movedAt = Date.now();
          this.reportProjection(generation, completed, total);
        } else if (Date.now() - movedAt >= this.projectionStallMs) {
          finish({ ok: false, reason: projectionStalled(ref.label, completed, total, Math.round(this.projectionStallMs / 1000)) });
        }
      };
      const subscription = this.catalogue.onChanged(check);
      const timer = setInterval(check, 1000);
      check();
    });
  }

  protected reportProjection(generation: number, completed: number, total: number): void {
    if (!this.current(generation) || this.openingState.status !== "opening") return;
    const previous = this.openingState.progress;
    if (previous?.completed === completed && previous.total === total) return;
    this.openingState = { ...this.openingState, progress: { completed, total } };
    this.onDidChangeOpeningEmitter.fire(this.openingState);
  }

  /** Move to the next step of the open in flight. Ignored once it has ended. */
  protected enterStage(stage: OpeningStage, generation: number): void {
    // An abandoned open must not narrate. Without this it goes on publishing
    // steps for product A while the panel is waiting on B.
    if (!this.current(generation)) return;
    if (this.openingState.status !== "opening") return;
    this.openingState = { status: "opening", stage, product: this.openingState.product };
    this.onDidChangeOpeningEmitter.fire(this.openingState);
  }

  /**
   * `failStage`, and put the engine back on the session this open replaced.
   *
   * **Because a refused open used to take the whole application with it.** By the
   * time a step refuses, the engine has already been re-initialized for this
   * product -- its folder as the workspace, then its declared roots -- and nothing
   * undid that. A product whose only source did not exist left the engine
   * disconnected with that reason, and every later bare `load()` re-used the same
   * session: Start said "Engine disconnected", New Product, New Gear and Continue
   * were disabled, and Retry repeated the failure. The only way out anybody found
   * was opening some other product. Measured, with a clone whose relative source
   * pointed nowhere.
   *
   * Not for the `resolve` step: by then this product's catalogue loaded, and the
   * panel shows the product with its error, which is the state to be in.
   */
  protected async failAndRestore(
    stage: OpeningStage,
    reason: string,
    generation: number,
    before: StudioSession | undefined,
  ): Promise<false> {
    this.failStage(stage, reason, generation);
    // A different open has taken over: its session is the one that should stand.
    if (!this.current(generation)) return false;
    await (before === undefined
      ? this.catalogue.resetToBootSession()
      : this.catalogue.load(before, { keep: true }));
    return false;
  }

  /**
   * Stop the open at the step that refused, and say why.
   *
   * The message still goes to the message service -- a refusal a person did not
   * see is a refusal that looks like a hang -- and it also stays here, so the
   * panel that was showing the steps can show which one stopped instead of
   * reverting to a picker as though nothing had been attempted.
   */
  /**
   * Constructor Studio: stop at `describe`, and give the catalogue back. Step 1
   * started an engine for reading the description only (`CatalogueStore.prepare`),
   * so an open that stops here would otherwise leave the catalogue empty on an
   * engine nobody meant to keep. `load()` goes back to the session there was.
   */
  protected failDescribing(reason: string, generation: number): false {
    if (this.current(generation)) void this.catalogue.load(undefined, { keep: true });
    return this.failStage("describe", reason, generation);
  }

  protected failStage(stage: OpeningStage, reason: string, generation: number): false {
    // Nor must it complain. A reconnect abandoned because somebody opened
    // another product did not fail; saying so would put A's refusal in front of
    // B for no reason.
    if (!this.current(generation)) return false;
    if (this.openingState.status === "opening") {
      this.openingState = { status: "failed", stage, product: this.openingState.product, reason };
      this.onDidChangeOpeningEmitter.fire(this.openingState);
    }
    this.messages.error(reason);
    return false;
  }

  /**
   * The products opened before, most recent first.
   *
   * Read through, not cached: the list is short and a stale one is the whole
   * failure mode of a Recent menu.
   */
  async recent(): Promise<ProductRef[]> {
    return (await this.recentEntries()).map(({ path, label }) => ({ path, label }));
  }

  /** The same list, with the times the Continue card reads. */
  async recentEntries(): Promise<RecentEntry[]> {
    return (await this.storage.getData<RecentEntry[]>(RECENT_KEY)) ?? [];
  }

  /**
   * Open a remembered product, dropping the entry only if it is gone.
   *
   * A Recent list is the one place where a path is expected to have rotted, and
   * the honest response is to say so and forget it -- not to open an empty panel
   * and leave the reader wondering. Which failure counts as rot is the whole
   * question, and the answer is the stage the open stopped at; see below.
   */
  async openRecent(ref: ProductRef): Promise<boolean> {
    if (await this.open(ref)) return true;

    // **Forget it only when the description itself could not be read.** This
    // used to forget on *any* failure, which is not what a rotted Recent entry
    // is: an engine that would not start, or a catalogue that would not load,
    // says nothing about whether the product is still there -- and deleting the
    // shortcut to a product you can still see is worse than leaving one that
    // warns when clicked.
    //
    // Found while tracking down a flaky test, and it was the second half of the
    // same defect: closing a product left the engine on that product's session,
    // a later open then failed at `workspace`, and this silently dropped the
    // entry and stayed on Home. `CatalogueStore.resetToBootSession` fixed the
    // cause; this stops the consequence being destructive when some other
    // transient takes its place.
    //
    // `describe` is the stage that reads the description at this path, so it is
    // the one that means the path is the problem -- a file that was moved or
    // deleted fails there, because starting the engine does not require the
    // product's directory to exist.
    const failure = this.openingProgress;
    const unreadable = failure.status === "failed" && failure.stage === "describe";
    // No second message: `failStage` has already named the step and the reason,
    // and "it also stayed in Recent" is not news -- staying is what a list does.
    if (!unreadable) return false;
    await this.forget(ref);
    this.messages.warn(`${ref.label} could not be read, so it was removed from Recent.`);
    return false;
  }

  /**
   * Remember a product that opened.
   *
   * **Only after a successful open**, which is the difference between a Recent
   * list and a list of things once attempted. Canonicalised on the path the
   * engine reported, so the same product reached two ways is one entry.
   */
  protected async remember(ref: ProductRef): Promise<void> {
    const kept = (await this.recentEntries()).filter((entry) => entry.path !== ref.path);
    kept.unshift({ ...ref, openedAt: Date.now() });
    await this.storage.setData(RECENT_KEY, kept.slice(0, RECENT_LIMIT));
  }

  protected async forget(ref: ProductRef): Promise<void> {
    const kept = (await this.recentEntries()).filter((entry) => entry.path !== ref.path);
    await this.storage.setData(RECENT_KEY, kept);
  }

  /**
   * Close the open product, unless doing so would lose an edit.
   *
   * **Refuses rather than asking.** `ProductEditService` already takes this
   * position for a write -- it will not touch a description with unsaved changes,
   * and it will not save on the author's behalf either, because that commits an
   * edit they had not finished. Closing is the same shape of decision, so it gets
   * the same answer until there is a reason for a three-way dialog. The full
   * Save / Close without saving / Cancel set is a later choice, not a missing one.
   *
   * Returns whether it closed.
   */
  async close(): Promise<boolean> {
    const open = this.products.current.open;
    if (open === undefined) return true;

    if (this.isDirty(open.path)) {
      this.messages.error(
        `${open.label} has unsaved changes. Save or revert them before closing -- ` +
          `closing now would leave an edit nobody asked to discard.`,
      );
      return false;
    }

    // Everything the product was, not just the reference. A stale resolution
    // behind a closed product is worse than an empty panel: it looks like an
    // answer. `ProductStore.clear` drops the resolution, the diagnostics, the
    // lock, the selection and the profile together.
    this.products.clear();

    // **And the engine, which the store cannot clear.** The product's declared
    // source roots are the engine's roots until something calls `initialize`
    // again, and closing never did -- so a product that named this checkout as a
    // source made the whole checkout a source root for the rest of the session,
    // and `create` under `<checkout>/products/...` was refused from then on.
    // ADR `cpt-gearbox-adr-create-product` puts start-screen create against the
    // boot workspace; this is what returns to it.
    //
    // Not awaited before returning `true`: the close itself has happened, the
    // reset is a background restoration, and making the Close button wait on an
    // engine respawn would trade a real delay for a state nobody is looking at
    // yet. Failures land on the catalogue's own status, which is where every
    // other load failure is reported.
    void this.catalogue.resetToBootSession();
    return true;
  }

  /** Whether the description is open in an editor with unsaved changes. */
  protected isDirty(path: string): boolean {
    return hasUnsavedEdits(this.models, path);
  }

  // `ensureOpen()` used to live here: "one product is a question with one answer,
  // so it opens". It was called from `ProductWidget`'s constructor, which made it
  // a rule about *widget construction* rather than about intent -- a reload, or a
  // restored layout naming the Product view, opened a product nobody had asked
  // for, and the Home screen could not be reached with a product in the
  // workspace. Discovery still happens (`ProductStore.ensureDiscovered`); acting
  // on it is the Start screen's Continue card and the picker.

  /**
   * The write boundary for a product: the workspace folder that contains it.
   *
   * **Not the product's own directory**, and the difference is a generated tree in
   * the wrong place. The engine derives its output root from the workspace, so a
   * workspace of `products/payments-demo` put the generated crates in
   * `products/payments-demo/.gearbox/payments-demo/dev` -- inside the descriptions
   * folder, and *not* the tree the CLI writes when it is run from the repository
   * root. One product, two trees, which is exactly the divergence removed when
   * Studio stopped generating into a tree of its own (plan 9.1).
   *
   * The containing workspace folder is the honest boundary: it contains the
   * description, so an edit is inside it; it is the root the CLI would be run
   * from, so both write the same `.gearbox/<product>/<profile>`; and it is what
   * the person opened, so it is a boundary they chose rather than one derived.
   *
   * The longest containing root wins, because Theia allows several and they may
   * nest. A product outside every root falls back to its own directory -- a
   * narrower boundary than the person expects is safe, and refusing to open it
   * would be worse.
   */
  protected workspaceFor(path: string, directory: string): string {
    const containing = this.workspace
      .tryGetRoots()
      .map((stat) => stat.resource.path.fsPath())
      .filter((root) => isInside(path, root))
      .sort((a, b) => b.length - a.length);
    return containing[0] ?? directory;
  }

  /**
   * Open `ref` as the session's product.
   *
   * Returns whether it opened. A refusal is reported to the person rather than
   * thrown: every reason is something they can act on -- a description that does
   * not evaluate, a `git(...)` source that cannot be fetched, no sources at all.
   */
  async open(ref: ProductRef): Promise<boolean> {
    const pending = this.inFlight;
    // **Deduplicated for the same product, abandoned for a different one.** The
    // non-reentrancy above is about two opens of *one* product interleaving
    // their engine spawns, and four callers ask for that independently. A
    // different product is a different request, and answering it with the
    // in-flight one's result meant a switch during an open silently did nothing
    // -- which is precisely what a person does while a recovery is under way.
    if (
      pending !== undefined &&
      this.openingState.status !== "idle" &&
      this.openingState.product.path === ref.path
    ) {
      return pending;
    }
    const generation = ++this.generation;
    this.openingState = { status: "opening", stage: "workspace", product: ref };
    this.onDidChangeOpeningEmitter.fire(this.openingState);
    const started = this.doOpen(ref, generation);
    this.inFlight = started;
    try {
      return await started;
    } finally {
      if (this.inFlight === started) {
        this.inFlight = undefined;
        this.settleOpening();
      }
    }
  }

  protected async doOpen(ref: ProductRef, generation: number): Promise<boolean> {
    const directory = parentOf(ref.path);
    const workspace = this.workspaceFor(ref.path, directory);
    // What to go back to if this open stops before it has a catalogue of its own:
    // the previous product's session, or the boot one when there was none. See
    // `failAndRestore`.
    const before = this.catalogue.currentSession();

    if (this.gears.current !== undefined) {
      await this.gears.close();
    }

    // Constructor Studio: the roots below are read once the boot load has its
    // engine. An open clicked while that engine was still starting read none,
    // fell back to the product's folder, and so replaced the engine reading the
    // corpus instead of keeping it. `prepare` waits for the same queue anyway.
    await this.catalogue.idle();
    if (!this.current(generation)) return false;

    // Step 1: an engine whose workspace is the product's, so a later edit is
    // inside the write boundary before anything reads the description.
    //
    // **Keeping the roots already open, not asking for none.** Passing `roots: []`
    // on purpose used to leave an engine that refused `product/load` with
    // `no source root is open` (measured). Whatever is open now is the right set
    // to carry: at boot it is the backend's defaults, and after a previous product
    // it is that product's -- either way a description can be evaluated, and step
    // 4 replaces them with the ones this product actually declares.
    //
    // After a page reload `rootPaths()` can still be empty while the boot catalogue
    // load has not finished. `initialize` treats that empty list as "use defaults"
    // rather than "open nothing", so this step stays safe in that window.
    //
    // Constructor Studio: `prepare`, not `load` -- the engine is started without
    // a catalogue load. Evaluating a description needs none, and the engine
    // answers one request at a time, so `loadProduct` below used to wait behind
    // the whole projection pass of a catalogue step 4 reads again anyway. On a
    // desktop's cold first open that wait alone ran past the product methods'
    // allowance, and the open failed with the engine ended.
    // With no root open at all (a repository with no gears, nothing adopted)
    // the product's own folder stands in: the engine refuses `product/load`
    // with no root, and this engine is only asked to read the description.
    const open = this.catalogue.rootPaths();
    const notStarted = await this.catalogue.prepare({ roots: open.length > 0 ? open : [directory], workspace });
    if (!this.current(generation)) return false;
    if (notStarted !== undefined) {
      // Upstream c30d111: a refused open puts the engine back on the session it
      // replaced, rather than leaving it on a folder nobody kept.
      return this.failAndRestore(
        "workspace",
        `The engine could not be started on ${ref.label}'s folder: ${notStarted}`,
        generation,
        before,
      );
    }
    // Constructor Studio: the engine was kept (a corpus copy it had already
    // started reading -- the boot load, on a desktop) and is still projecting.
    // It answers nothing else until that ends, so wait for it here, counting,
    // rather than on "reading the description". What it reads is kept, and the
    // catalogue step below is then answered from it instead of a second read.
    if (this.catalogue.projecting) {
      const warmed = await this.awaitProjection(ref, generation);
      if (!this.current(generation)) return false;
      if (!warmed.ok) return this.failAndRestore("workspace", warmed.reason, generation, before);
    }

    // Step 2: read what the description declares. `loadProduct` is evaluation
    // only -- nothing is joined against the catalogue -- which is exactly why it
    // works with no roots declared yet.
    this.enterStage("describe", generation);
    let intent;
    try {
      intent = (await this.service.loadProduct(ref.path)).intent;
    } catch (error) {
      return this.failDescribing(
        `${ref.label} could not be evaluated, so it cannot be opened: ${messageOf(error)}`,
        generation,
      );
    }
    if (!this.current(generation)) return false;

    // Constructor Studio: a description Studio writes names its corpus as a
    // git source at a commit; that commit is brought onto this machine first,
    // into the per-machine cache the corpus copy lives in -- through the Studio
    // relay when it is the private corpus the backend relays.
    const gitRoots: Record<string, string> = {};
    const gitFailures: Record<string, string> = {};
    for (const [id, source] of Object.entries(intent.sources ?? {}) as [string, SourceDecl][]) {
      if (source.kind !== "git") continue;
      const relayed = await this.catalogue.corpusOriginFor(source.url);
      const dir = await this.service
        .materializeGitSource(
          id,
          source.url,
          { rev: source.rev, tag: source.tag, branch: source.branch },
          relayed?.clonePath,
        )
        .catch((error: unknown) => {
          gitFailures[id] = messageOf(error);
          return undefined;
        });
      if (dir !== undefined) gitRoots[id] = dir;
    }
    if (!this.current(generation)) return false;
    const sources = sourceRootsOf(intent, (at) => resolveFrom(directory, at), gitRoots);
    const usable = sourcesUsable(ref.label, sources, gitFailures);
    if (!usable.ok) return this.failDescribing(usable.reason, generation);
    const roots = [...sources.roots];

    // Step 3 and 4: the real session, then the catalogue and the product.
    this.enterStage("catalogue", generation);
    const session: StudioSession = { roots, workspace };
    // Constructor Studio: `keep` -- when the roots are the ones the engine has
    // already read, it is not made to read them again.
    await this.catalogue.load(session, { keep: true });
    if (!this.current(generation)) return false;
    // Constructor Studio: the projection, before the product -- see `awaitProjection`.
    const projected = await this.awaitProjection(ref, generation);
    if (!this.current(generation)) return false;
    if (!projected.ok) return this.failAndRestore("catalogue", projected.reason, generation, before);
    const loaded = catalogueUsable(
      this.catalogue.current,
      `${ref.label}'s gears could not be loaded from ${roots.join(", ")}`,
    );
    if (!loaded.ok) return this.failAndRestore("catalogue", loaded.reason, generation, before);

    this.enterStage("resolve", generation);
    // **The last checkpoint, immediately before the answer is installed.** Every
    // one above it saves work; this one is the correctness of the whole guard.
    if (!this.current(generation)) return false;
    await this.products.open(ref);
    const resolved = openedSuccessfully(ref, this.products.current);
    if (resolved.ok) {
      await this.remember(ref);
      void this.hintScanning();
      return true;
    }
    // The store also renders its own error, and that is the surface a person
    // should end up on: this stops the open and says why, and the panel shows
    // the product with its error rather than four steps still in progress.
    return this.failStage("resolve", resolved.reason, generation);
  }

  /** This window has asked for the scanning hint already (`hintScanning`). */
  protected scanHintClaimed = false;

  /**
   * Constructor Studio: once per browser profile, say that the gear sources
   * were slow to read the first time and which folder an antivirus exclusion
   * would cover. Advice only: Studio changes no system setting.
   */
  protected async hintScanning(): Promise<void> {
    // Claimed before the first await: two opens finishing close together (a
    // create, then the open it triggers) both read "not shown" from storage
    // before either wrote it, and the member got the same notice twice.
    // Held only while one check runs: an open with nothing slow to report
    // leaves the next open free to report it.
    if (this.scanHintClaimed) return;
    this.scanHintClaimed = true;
    let shown = false;
    try {
      if ((await this.storage.getData<boolean>(SCAN_HINT_KEY)) === true) {
        shown = true;
        return;
      }
      const hint = await this.service.scanHint();
      if (hint === undefined) return;
      await this.storage.setData(SCAN_HINT_KEY, true);
      shown = true;
      void this.messages.info(scanHintMessage(hint));
    } catch {
      // A hint that cannot be given is not worth a second message.
    } finally {
      this.scanHintClaimed = shown;
    }
  }

  /**
   * Establish the engine again for the product already open, and re-read it.
   *
   * The whole open sequence rather than a narrower repair, because that sequence
   * *is* what a session is: an engine initialized on the product's roots and
   * write boundary, a catalogue loaded from them, and the description read and
   * resolved against it. A cheaper reconnect would be a second, slightly
   * different definition of the same thing -- and the difference between the two
   * would be discovered as a product that resolves against the wrong roots.
   *
   * What survives it, and where each one lives: the **profile** in
   * `ProductStore.open`, which keeps the one being viewed when the description
   * still offers it; the **selection** in `SelectionService`, which the store
   * drops only when the product changes; and the **draft** in
   * `ProductEditService`, keyed by path and not by session. None of them is
   * carried through here, and that is deliberate -- a recovery path that
   * re-installed them would be a second source of truth for three things that
   * already have one.
   */
  async reconnect(): Promise<boolean> {
    const ref = this.products.current.open;
    if (ref === undefined) return false;
    return this.open(ref);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
