// The frontend's copy of the catalogue as it arrives.
//
// The whole point of this file is the transition: a row starts pending and is
// replaced by a projected one, keyed by `(source, gdl_path)` because `GearId`
// is projected and does not exist at the pending stage (ADR
// cpt-gearbox-adr-staged-catalogue-loading).
//
// `load()` looks sequential and is not: notifications mutate the same `Map`
// during its awaits. Three things keep that honest. Every await resumption in
// `load()` is guarded by a load epoch, so a superseded load cannot install its
// pending set over a newer one's projections; notifications are accepted only
// while a load is *streaming*, so an abandoned load's late projections cannot
// walk an error back to `ready`; and failures move the store to an `error` state
// instead of leaving `loading` set forever.

import { Emitter, Event } from "@theia/core/lib/common/event";
import { inject, injectable, optional, postConstruct } from "@theia/core/shared/inversify";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { EngineConnectionService } from "./shell/engine-connection-service";
import { gearIdOf, SelectionService } from "./shell/selection-service";

import type { CatalogueChanged } from "../common/generated/CatalogueChanged";
import type { CatalogueDiagnostics } from "../common/generated/CatalogueDiagnostics";
import type { InitializeResult } from "../common/generated/InitializeResult";
import type { ProgressParams } from "../common/generated/ProgressParams";
import {
  CatalogueState,
  type CorpusOrigin,
  GearboxClient,
  GearboxService,
  RemoteCatalogueSource,
  Row,
  type StudioSession,
  keyFor,
} from "../common/protocol";
import { remoteKey } from "../common/git-remote";
import { announceOpenedWorkspace } from "./shell/opened-workspace";

/**
 * How many engine log lines are kept.
 *
 * A window's worth of context, not a transcript: the engine's own stderr goes to
 * the backend log, which is where a full history belongs.
 */
const LOG_LIMIT = 500;

/** The state a store starts in and returns to at the head of every load. */
const EMPTY: CatalogueState = {
  status: "idle",
  rows: [],
  diagnostics: [],
  failedRoots: [],
  error: undefined,
  total: 0,
  completed: 0,
};

/**
 * Everything the backend calls back about the catalogue.
 *
 * `onDocumentDiagnostics` is deliberately not here: it is about one open
 * editor, not about the catalogue, and `DescriptionMarkers` owns it. The
 * forwarder in the frontend module is what implements the whole `GearboxClient`,
 * routing each callback to whichever object the question belongs to.
 */
@injectable()
export class CatalogueStore implements Omit<GearboxClient, "onDocumentDiagnostics"> {
  @inject(GearboxService) protected readonly service!: GearboxService;
  /** What this window has open; the backend scans it where there is no `/workspace`. */
  @inject(WorkspaceService) @optional() protected readonly workspaceService?: WorkspaceService;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;
  @inject(RemoteCatalogueSource) @optional() protected readonly remote?: RemoteCatalogueSource;

  protected readonly onChangedEmitter = new Emitter<void>();
  readonly onChanged: Event<void> = this.onChangedEmitter.event;

  protected rowsByKey = new Map<string, Row>();
  protected state: CatalogueState = EMPTY;
  protected capabilities: InitializeResult["capabilities"] | undefined;
  /**
   * Where each source root is on this machine, from `initialize`.
   *
   * Needed because every path the catalogue carries -- `gdl_path`, and every
   * PRD/DESIGN/ADR link -- is relative to its source root, and the root is the
   * one thing only the server knows. Without it those paths cannot be opened,
   * which is exactly how they came to be silently dead.
   */
  protected rootsById = new Map<string, string>();
  protected logLines: string[] = [];

  /**
   * Which load is current.
   *
   * Bumped at the head of every `load()`. A load that resumes from an await
   * with a stale epoch returns without touching anything -- otherwise closing
   * and reopening the panel mid-projection lets the first load's `pending` set
   * land on top of the second load's already-projected rows, and those
   * projections are not resent.
   */
  /** The session the last load ran under, reused by a bare `load()`. */
  protected session: StudioSession | undefined;

  protected epoch = 0;

  /**
   * The epoch of the load currently streaming projections, if one is.
   *
   * The epoch alone could not do this job. It says which load is *newest*; this
   * says whether the newest one is still entitled to be spoken for -- and the
   * notifications carry no epoch, because the engine has no idea one exists.
   *
   * Set when `loadCatalogue` answers at the S1/S2 boundary, which is the moment
   * projections start arriving, and cleared by anything that ends the load:
   * terminal progress, a failure, the engine dying, or the head of a newer load.
   * Without it a load abandoned on timeout stays visible in its consequences --
   * the engine goes on projecting into a store that has already reported the
   * error, and the final `$/progress done` sets `ready` over the top of it, so
   * the panel ends up showing a tree for a load it told the person had failed.
   */
  protected streaming: number | undefined;

  /**
   * Where the selection lives now.
   *
   * It used to be a `selectedKey` field here, and a second selection lived in
   * `ProductStore`. One gear chosen two ways was two selections, and the panel
   * that answered "what is it" could not see the one made in the product tree.
   * `SelectionService` owns the value; this store translates between it and the
   * row key the tree renders with, and still fires its own change event so the
   * highlight follows a selection made anywhere.
   */
  @inject(SelectionService) protected readonly selection!: SelectionService;

  /** Set once, in `@postConstruct` -- never in a field initializer, which runs before injection. */
  protected selectionSubscribed = false;

  /** The load in flight, if one is. See `load`. */
  protected loading: Promise<void> | undefined;

  @postConstruct()
  protected init(): void {
    this.watchSelection();
    // A catalogue listed from the backend -- or not listed, because the member
    // was not signed in yet -- is read again when that source says it moved.
    // A workspace with its own source roots never asked it, so it is left alone.
    this.remote?.onDidChange?.(() => {
      if (this.rootsById.size === 0) {
        void this.load();
      }
    });
  }

  get current(): CatalogueState {
    return this.state;
  }

  get engineCapabilities(): InitializeResult["capabilities"] | undefined {
    return this.capabilities;
  }

  get logs(): readonly string[] {
    return this.logLines;
  }

  /**
   * The selected row's key, for whatever is selected anywhere.
   *
   * A `gear` selection is resolved to the row that projected it, so choosing a
   * gear in the product tree lights up the same gear in the catalogue. That
   * lookup is a scan of the rows and the catalogue is fourteen of them; a map
   * from id to key would be a second index to keep correct across the
   * pending-to-projected replacement, for no measurable gain.
   */
  get selected(): string | undefined {
    const selection = this.selection.current;
    if (selection === undefined) return undefined;
    if (selection.kind === "catalogue-row") return selection.key;
    // **Both gear acts highlight the row, and this is an `if` chain rather than
    // a switch, so the compiler would not have said so.** The catalogue shows
    // where a gear is whether it was chosen here or in the product tree --
    // that is the half of "one subject" this panel is responsible for.
    const id = gearIdOf(selection);
    if (id === undefined) return undefined;
    for (const [key, row] of this.rowsByKey) {
      if (row.kind === "projected" && row.gear.id === id) return key;
    }
    return undefined;
  }

  get selectedRow(): Row | undefined {
    const key = this.selected;
    return key === undefined ? undefined : this.rowsByKey.get(key);
  }

  /**
   * The source a gear was projected from, for a caller that has only its id.
   *
   * A `use_gear` line names both, and the id alone does not determine the
   * source: rows are keyed by `(source, gdl_path)`, so two roots may offer the
   * same gear. Writing a constant there produces a description naming a source
   * the product does not declare -- which nothing refuses at edit time and
   * everything refuses at the next resolve.
   *
   * A scan for the same reason [`selected`] is a scan: the catalogue is
   * fourteen rows, and a second index would be another thing to keep correct
   * across the pending-to-projected replacement.
   */
  sourceOf(gear: string): string | undefined {
    for (const row of this.rowsByKey.values()) {
      if (row.kind === "projected" && row.gear.id === gear) return row.gear.source;
    }
    return undefined;
  }

  /**
   * The source roots the engine currently has open.
   *
   * For `ProductSessionService`, which has to re-initialize with a new workspace
   * *before* it can read a description and learn the roots that description wants.
   * The engine refuses `product/load` when no root is open, so "keep what is
   * already there" is the only honest thing to pass at that point.
   */
  rootPaths(): string[] {
    return [...this.rootsById.values()];
  }

  /**
   * The id the engine calls this root, or `undefined` if it does not know it.
   *
   * The reverse of [`rootPaths`], and it exists because two things named the
   * same root differently. The engine names every root after its own directory
   * (`gearbox_engine::default_source_ids`), and that is the id
   * `GearDescriptor::source` carries and the id `add_gear` writes into a
   * description. The Create wizard invented `source-1`, `source-2` instead, so
   * a scaffolded product declared sources under one set of names while every
   * gear added to it referred to another -- a description that could not load.
   *
   * Absent rather than guessed when the catalogue has not initialized yet: the
   * caller has a correct fallback (the directory's own name, which is the rule
   * the engine applies), and a wrong id here would be written into a file.
   */
  sourceIdOf(path: string): string | undefined {
    for (const [id, root] of this.rootsById) {
      if (root === path) return id;
    }
    return undefined;
  }

  /** One row by key, for a widget that resolves a selection rather than holding one. */
  row(key: string): Row | undefined {
    return this.rowsByKey.get(key);
  }

  /**
   * Absolute path for a catalogue-relative path, or `undefined` if the source
   * is unknown or the path is not one the catalogue may carry.
   *
   * Returning `undefined` rather than the relative path: a caller that gets a
   * path back will try to open it, and a relative path produces a URI with no
   * scheme that no opener handles -- which fails quietly. Being unable to
   * answer has to look different from answering.
   */
  absolutePath(source: string, relative: string): string | undefined {
    const root = this.rootsById.get(source);
    if (root === undefined || !isCatalogueRelative(relative)) {
      return undefined;
    }
    return join(root, relative);
  }

  /**
   * Select a row, as a selection the rest of the application can act on.
   *
   * Normalised here rather than by the caller: a **projected** row becomes a
   * `gear` selection, because at that point the row is a gear with an id and
   * everything else -- the explanation graph, the product tree, the markers --
   * speaks in ids. A **pending** row has no id to speak of yet, so it stays a row
   * key, and the Inspector renders what S0/S1 knows.
   */
  select(key: string | undefined): void {
    if (key === undefined) {
      this.selection.select(undefined);
      return;
    }
    const row = this.rowsByKey.get(key);
    // `catalogue-gear`, not `gear`. This normalised to `gear`, which made a
    // catalogue click indistinguishable from choosing the same gear in the open
    // product -- so the Composition pane answered a catalogue click by replacing
    // the product's settings with a message about a gear the product does not
    // contain. The id is still the subject; the kind now says which act it was.
    this.selection.select(
      row?.kind === "projected"
        ? { kind: "catalogue-gear", id: row.gear.id }
        : { kind: "catalogue-row", key },
    );
  }

  /**
   * Re-render when the selection changes anywhere.
   *
   * Called from `@postConstruct`, and guarded: `load()` does not reset it, and
   * subscribing twice would fire this store's change event twice per selection.
   */
  protected watchSelection(): void {
    if (this.selectionSubscribed) return;
    this.selectionSubscribed = true;
    this.selection.onDidChange(() => this.onChangedEmitter.fire());
  }

  /**
   * Initialize the engine and run one staged load.
   *
   * Never rejects. A failure is a state, not an exception: the only callers are
   * a command and an application contribution, and a rejected promise from
   * either becomes an unhandled rejection in the console while the panel keeps
   * claiming it is still projecting.
   */
  async load(session?: StudioSession): Promise<void> {
    // Remembered here, and **captured here**, which are two different things.
    //
    // `Reload Catalogue` and the reconnect path call `load()` with nothing and
    // must reuse the product session's roots, so the field is set at call time.
    // But the load itself now runs later, and reading the field *then* was a bug
    // this queue introduced: the application's boot load is queued first, a
    // product session opening in the same tick sets the field to its own
    // `{roots: [], workspace}` -- the deliberate no-roots step that lets a
    // description be evaluated -- and the boot load, when its turn came, read that
    // and initialized with no roots at all. The catalogue then said "no source
    // root is open" and the product never finished opening.
    if (session !== undefined) {
      this.session = session;
    }
    const forThisLoad = this.session;
    return this.queued(() => this.doLoad(forThisLoad));
  }

  /**
   * Forget the product session and put the engine back on its boot roots.
   *
   * **Because closing a product used to leave its roots in force for the rest of
   * the session.** `initialize` is what sets the engine's source roots and its
   * write boundary, and nothing called it again when a product closed -- so a
   * product that declared this checkout as a source left the checkout a source
   * root permanently, and every later `create` under `<checkout>/products/...`
   * was refused with "is inside a source root". The first create in a session
   * worked and the second did not, and the only cure anyone found was to open a
   * different product whose sources happened to exclude the checkout.
   *
   * ADR-0013 says start-screen create "runs against the repository workspace the
   * engine already knows from boot ... not against an open product session".
   * This is the call that makes closing return to that state.
   *
   * `undefined` rather than a constructed session: `initialize` reads an absent
   * session -- and an empty `roots` -- as "use the CLI defaults", which is
   * exactly the boot state and saves this from restating what those defaults are.
   */
  async resetToBootSession(): Promise<void> {
    this.session = undefined;
    return this.queued(() => this.doLoad(undefined));
  }

  /**
   * Re-read the source roots **without restarting the engine**.
   *
   * `load()` respawns, because `initialize` is what changes the roots and the
   * write boundary, and a catalogue only ever belongs to the roots it was
   * scanned from. Nothing about re-reading *the same* roots needs that:
   * `gearbox/catalogue/load` re-runs the staged load from disk and replaces the
   * server's cached catalogue on the process that is already running. The
   * pairing of the two calls in `doLoad` is a client-side habit, not a protocol
   * requirement, and this is the path that does not pay for it.
   *
   * For the filesystem watcher, which fires on every saved `gear.gdl`. A
   * respawn per save would be a restart wearing a refresh's name.
   *
   * Never rejects, for the same reason `load()` does not.
   */
  async refresh(): Promise<void> {
    return this.queued(() => this.doRefresh());
  }

  /**
   * Run `work` after whatever is already in flight, never concurrently with it.
   *
   * **One at a time, and the second waits rather than replacing it.**
   *
   * `initialize` disposes the engine and spawns a new one, so two loads in the
   * air mean two respawns -- and the second one's spawn can land while the
   * first's `loadProduct` is mid-flight, which the first sees as an engine that
   * died under it. That is a race the boot sequence walks straight into: the
   * application starts one load at `onStart`, and a product session opening in
   * the same tick starts another with the product's own roots.
   *
   * Queued, not deduplicated: `Reload Catalogue` after a load in flight has to
   * actually re-read, so a second call cannot be answered with the first one's
   * promise. It waits, then runs. The epoch guard still decides which load's
   * answers are installed.
   *
   * A refresh joins the same queue as a load, because they mutate the same rows
   * and the same streaming epoch -- a refresh reading the tree while a respawn
   * is half-done would install answers from an engine that is being killed.
   */
  protected async queued(work: () => Promise<void>): Promise<void> {
    const previous = this.loading;
    const started = (async () => {
      // The previous load never rejects -- a failure is a state -- but `catch`
      // rather than trusting that, because one throw here would strand every load
      // queued behind it.
      if (previous !== undefined) {
        await previous.catch(() => undefined);
      }
      await work();
    })();
    this.loading = started;
    try {
      await started;
    } finally {
      if (this.loading === started) {
        this.loading = undefined;
      }
    }
  }

  /**
   * Constructor Studio: start an engine on `session` without reading the
   * catalogue. Undefined when it started, else why it did not.
   *
   * For the first step of opening a product, which only needs the product's
   * description evaluated with the right write boundary. `load` would also
   * start a catalogue load, and the engine answers one request at a time: the
   * `product/load` sent next waits behind the whole projection pass (measured
   * 7 s warm on the 44-gear corpus against 17 ms without it; a cold desktop
   * took longer than the 60 s allowance), and the open then scans the same
   * roots again in step 3. Queued with the loads, so it never respawns an
   * engine one of them is still using. The rows are cleared: they belonged to
   * the engine this replaces.
   */
  async prepare(session: StudioSession): Promise<string | undefined> {
    let failure: string | undefined;
    // Not remembered as `this.session`, unlike `load`: this engine is a step,
    // and a `load()` after an open that stops here -- the recovery below it --
    // has to go back to the session there was, not to this one.
    await this.queued(async () => {
      const epoch = ++this.epoch;
      this.streaming = undefined;
      this.rowsByKey.clear();
      this.state = { ...EMPTY, status: "loading" };
      this.onChangedEmitter.fire();
      try {
        await this.announceOpenedWorkspace();
        const init = await this.service.initialize(session);
        if (epoch !== this.epoch) return;
        this.engine.markConnected();
        this.capabilities = init.capabilities;
        this.rootsById = new Map((init.roots ?? []).map((r) => [r.id, r.path]));
      } catch (error) {
        if (epoch !== this.epoch) return;
        failure = describe(error);
        this.engine.markDisconnected(failure);
        this.state = { ...this.state, status: "error", error: failure };
        this.onChangedEmitter.fire();
      }
    });
    return failure;
  }

  protected async announceOpenedWorkspace(): Promise<void> {
    await announceOpenedWorkspace(this.service, this.workspaceService);
  }

  /** One load, against the session decided when it was asked for. */
  protected async doLoad(session: StudioSession | undefined): Promise<void> {
    const epoch = ++this.epoch;
    this.streaming = undefined;
    this.rowsByKey.clear();
    this.state = { ...EMPTY, status: "loading" };
    this.onChangedEmitter.fire();

    try {
      // The session, when a product session drives the load. `initialize`
      // disposes and respawns the engine, so this is also what makes the roots
      // and the write boundary change wholesale rather than drift.
      // Said first, every time: the folder is this window's, and a desktop
      // member opening another project reloads the window onto it.
      await this.announceOpenedWorkspace();
      const init = await this.service.initialize(session);
      if (epoch !== this.epoch) {
        return;
      }
      this.engine.markConnected();
      this.capabilities = init.capabilities;
      this.rootsById = new Map((init.roots ?? []).map((r) => [r.id, r.path]));

      if (!(await this.installCatalogue(epoch, init.failed_roots ?? []))) {
        return;
      }
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.streaming = undefined;
      this.engine.markDisconnected(describe(error));
      // Constructor Studio: an engine that would not start -- none installed,
      // or one that refused `initialize` -- still leaves the corpus the Studio
      // backend reads. Listing it beats an error with nothing under it.
      if (this.remote !== undefined && (await this.installRemote(epoch, [])) === true) {
        this.onLog(`the engine did not start (${describe(error)}); listing the Studio backend's corpus`);
        this.onChangedEmitter.fire();
        return;
      }
      if (epoch !== this.epoch) {
        return;
      }
      this.state = {
        ...this.state,
        status: "error",
        rows: [],
        error: describe(error),
      };
      this.rowsByKey.clear();
    }
    this.onChangedEmitter.fire();
  }

  /**
   * One staged read, against an engine that is already running.
   *
   * The half both paths share, extracted so they cannot drift: `doLoad` runs it
   * after respawning, `doRefresh` runs it alone. `false` means a newer load
   * superseded this one, and the caller must stop without firing a change for
   * answers nobody is waiting for.
   */
  protected async installCatalogue(
    epoch: number,
    failedRoots: CatalogueState["failedRoots"],
    keepProjected = false,
  ): Promise<boolean> {
    // Constructor Studio: an engine with no source root has no gears to find.
    // The Studio backend reads its own corpus checkout, so ask it instead of
    // having every project clone the corpus.
    if (this.rootsById.size === 0 && this.remote !== undefined) {
      const installed = await this.installRemote(epoch, failedRoots);
      if (installed !== undefined) {
        return installed;
      }
    }
    // Resolves at the S1/S2 boundary: the whole tree, none of it projected.
    const loaded = await this.service.loadCatalogue();
    if (epoch !== this.epoch) {
      return false;
    }
    // **The key set is replaced; the facts behind it are not, on a refresh.**
    //
    // Rebuilt from `pending` rather than merged into, because that is what
    // makes a *deleted* gear disappear: it has no entry here and no
    // `catalogueChanged` to announce its absence, so anything additive would
    // keep its row forever.
    //
    // But `pending` is the S1 answer -- every gear, none of them projected --
    // and installing it verbatim would downgrade every row that already had
    // its facts, for the length of the S2 pass. That is not cosmetic: the
    // dependency graph renders `rows.filter(isProjected)`, so a refresh would
    // empty it for about a second on every saved `gear.gdl`. A regression
    // claim caught exactly that (`every edge is directed`), and it was right
    // to. On a refresh the roots have not moved, so a row that was projected
    // still describes the gear at that path until its replacement lands.
    //
    // A *load* keeps the plain behaviour: the roots may have changed, so a
    // carried-over projection could be about a gear the new roots do not have.
    const previous = this.rowsByKey;
    this.rowsByKey = new Map();
    for (const gear of loaded.pending) {
      const key = keyFor(gear.source, gear.gdl_path);
      const carried = keepProjected ? previous.get(key) : undefined;
      this.rowsByKey.set(
        key,
        carried?.kind === "projected" ? carried : { kind: "pending", gear },
      );
    }
    // Nothing discovered is nothing to project, and no `$/progress done` will
    // come to say so: an engine with no source root answers an empty tree and
    // stops. Waiting for it left the panel on "projecting 0/0" for good.
    const empty = loaded.total === 0 && loaded.pending.length === 0;
    this.state = {
      status: empty ? "ready" : "loading",
      rows: this.sorted(),
      diagnostics: loaded.diagnostics,
      failedRoots,
      error: undefined,
      total: loaded.total,
      completed: 0,
    };
    // The boundary is passed: projections for *this* load are now welcome.
    this.streaming = empty ? undefined : epoch;
    return true;
  }

  /**
   * The corpus's gears as the Studio backend lists them, installed projected
   * and complete: there is nothing for a local engine to stream. Undefined
   * when the backend offers none, so the caller reads the (empty) engine.
   */
  protected async installRemote(
    epoch: number,
    failedRoots: CatalogueState["failedRoots"],
  ): Promise<boolean | undefined> {
    let remote;
    try {
      remote = await this.remote?.load();
    } catch (error) {
      this.onLog(`the Studio backend could not list the gear corpus: ${describe(error)}`);
      return undefined;
    }
    if (epoch !== this.epoch) {
      return false;
    }
    if (remote === undefined) {
      return undefined;
    }
    this.rowsByKey = new Map(
      remote.gears.map((gear) => [keyFor(gear.source, gear.gdl_path), { kind: "projected", gear }]),
    );
    this.streaming = undefined;
    this.state = {
      status: "ready",
      rows: this.sorted(),
      diagnostics: [],
      failedRoots,
      error: undefined,
      total: remote.gears.length,
      completed: remote.gears.length,
      remote: remote.corpus,
    };
    this.remoteOrigin = remote.origin;
    this.knownOrigin = remote.origin ?? this.knownOrigin;
    // A copy of this very commit may already be on this machine, brought by
    // another project. Then there is no reason to stay read-only: adopt it and
    // reload onto it. Only a copy already there -- nothing is fetched unasked.
    if (remote.origin !== undefined && (!remote.origin.needsToken || remote.origin.clonePath !== undefined)) {
      void this.adoptSharedCorpus(remote.origin, false);
    }
    return true;
  }

  /** Where the listed corpus comes from, while the rows are the backend's. */
  protected remoteOrigin: CorpusOrigin | undefined;
  /** The last corpus origin the backend named, kept after a copy is adopted. */
  protected knownOrigin: CorpusOrigin | undefined;

  /**
   * Where the listed corpus can be brought from, while the rows are the
   * backend's and no copy is here yet. What New Product offers inline.
   */
  get corpusToBring(): CorpusOrigin | undefined {
    return this.state.remote === undefined ? undefined : this.remoteOrigin;
  }

  /**
   * The corpus the Studio backend relays, when `url` is that repository: how a
   * product's `git(url, rev)` source reaches a private corpus. Asks the backend
   * when nothing has been listed from it yet (a workspace with its own roots
   * never did); undefined when there is no backend or it names another corpus.
   */
  async corpusOriginFor(url: string): Promise<CorpusOrigin | undefined> {
    if (this.knownOrigin === undefined && this.remote !== undefined) {
      try {
        this.knownOrigin = (await this.remote.load())?.origin;
      } catch {
        // No Studio backend to ask: the source is fetched as its URL says.
      }
    }
    const origin = this.knownOrigin;
    return origin !== undefined && remoteKey(origin.url) === remoteKey(url) ? origin : undefined;
  }
  protected bringingState: { readonly busy: boolean; readonly error?: string } = { busy: false };

  /**
   * Whether the listed corpus can be brought here: `undefined` when there is
   * nothing to bring, otherwise the reason it cannot be, or `true`.
   */
  get corpusBringable(): true | string | undefined {
    if (this.state.remote === undefined || this.remoteOrigin === undefined) return undefined;
    if (this.remoteOrigin.needsToken && this.remoteOrigin.clonePath === undefined) {
      return "This corpus is private, and this Studio does not relay it.";
    }
    return true;
  }

  get corpusBringing(): { readonly busy: boolean; readonly error?: string } {
    return this.bringingState;
  }

  /**
   * Clone the listed corpus into the machine's shared copy (once per commit,
   * for every project) and reload the catalogue onto it, so gears open and a
   * product resolves and generates.
   */
  async bringCorpusHere(): Promise<void> {
    const origin = this.remoteOrigin;
    if (origin === undefined || this.corpusBringable !== true || this.bringingState.busy) return;
    this.bringingState = { busy: true };
    this.onChangedEmitter.fire();
    await this.adoptSharedCorpus(origin, true);
  }

  protected async adoptSharedCorpus(origin: CorpusOrigin, fetch: boolean): Promise<void> {
    let dir: string | undefined;
    try {
      dir = await this.service.useSharedCorpus(origin.sourceId, origin.url, origin.rev, fetch, origin.clonePath);
    } catch (error) {
      this.bringingState = { busy: false, error: describe(error) };
      this.onChangedEmitter.fire();
      return;
    }
    this.bringingState = { busy: false };
    if (dir === undefined) {
      if (fetch) {
        this.bringingState = { busy: false, error: "the corpus could not be brought here" };
      }
      this.onChangedEmitter.fire();
      return;
    }
    this.remoteOrigin = undefined;
    await this.load();
  }

  /**
   * One re-read, on the engine that is already running.
   *
   * **What it deliberately does not do is blank the panel.** `doLoad` opens by
   * clearing every row and setting `status: "loading"`, which is right when the
   * roots are about to change: nothing on screen is known to still apply. Here
   * the roots are the same and almost every row will come back identical, so
   * emptying the Catalogue and the Inspector for the length of a rescan --
   * on every save of every `gear.gdl` -- would be a worse answer to "it does
   * not update" than leaving it alone. The rows stay until
   * `installCatalogue` swaps them at the boundary.
   */
  protected async doRefresh(): Promise<void> {
    const epoch = ++this.epoch;
    // Stop accepting projections from the previous load immediately. They are
    // about rows this read is replacing, and one arriving mid-flight would be
    // installed under a key the new tree may not even have.
    this.streaming = undefined;

    try {
      if (await this.installCatalogue(epoch, this.state.failedRoots, true)) {
        this.onChangedEmitter.fire();
      }
      return;
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      // **Fall through to the full path rather than reporting a failure.**
      // `loadCatalogue` refuses outright when the child is gone -- "the engine
      // is not running" -- and that is a situation a respawn fixes and a
      // refresh cannot. Paying for one here is paying for it exactly when it
      // is the thing needed.
      this.onLog(`catalogue refresh failed (${describe(error)}); reloading`);
    }
    await this.doLoad(this.session);
  }

  onCatalogueChanged(event: CatalogueChanged): void {
    if (!this.isStreaming()) {
      return;
    }
    // `replaces` is the pending `gdl_path`, and the gear carries the source it
    // came from -- together they are the row key. Sent by the server so the
    // client does not have to know how the pending list was built.
    const key = keyFor(event.gear.source, event.replaces);
    this.rowsByKey.set(key, { kind: "projected", gear: event.gear });
    this.state = { ...this.state, rows: this.sorted() };
    this.onChangedEmitter.fire();
  }

  onCatalogueDiagnostics(event: CatalogueDiagnostics): void {
    if (!this.isStreaming()) {
      return;
    }
    // Everything the second pass found. A gear that fails to project emits no
    // `catalogueChanged`, so this is the only account of why its row never
    // filled in.
    this.state = {
      ...this.state,
      diagnostics: [...this.state.diagnostics, ...event.diagnostics],
    };
    this.onChangedEmitter.fire();
  }

  onProgress(event: ProgressParams): void {
    if (!this.isStreaming()) {
      return;
    }
    // `done` ends the load whatever is left pending. A row still pending at
    // that point did not project, which the widget says rather than leaving it
    // reading `parsing…` under a finished progress bar.
    if (event.done) {
      this.streaming = undefined;
    }
    this.state = {
      ...this.state,
      completed: event.completed,
      total: event.total,
      status: event.done ? "ready" : "loading",
    };
    this.onChangedEmitter.fire();
  }

  onLog(message: string): void {
    // Capped, and deliberately *not* firing `onChanged`.
    //
    // Two costs, neither of which buys anything today. The list grew without
    // bound for the life of the window, and nothing reads it -- there is no log
    // view yet. And every line re-rendered all six panels, the dependency graph
    // among them, which relays its whole SVG: an engine that logs while
    // projecting made the graph the most expensive thing in the application.
    // When a log view exists it gets its own emitter; a shared one would put
    // this cost back.
    this.logLines = [...this.logLines.slice(1 - LOG_LIMIT), message];
  }

  onEngineExit(reason: string): void {
    this.engine.markDisconnected(`the engine ${reason}`);
    // Only a load in flight has anything to lose. An engine that exits between
    // loads -- disposed on reconnect, killed on the way out -- is ordinary, and
    // reporting it as a catalogue error would put a red panel in front of a
    // tree that is perfectly good.
    if (!this.isStreaming()) {
      return;
    }
    this.streaming = undefined;
    this.state = {
      ...this.state,
      status: "error",
      error: `the engine ${reason} while projecting; reload the catalogue`,
    };
    // The rows are kept, unlike a failed `load()`. Everything projected before
    // the engine died is still true, and a partial tree beside "reload" is more
    // use than an empty panel.
    this.onChangedEmitter.fire();
  }

  /** Whether the newest load is at the stage where projections belong to it. */
  protected isStreaming(): boolean {
    return this.streaming === this.epoch;
  }

  /**
   * Ordered by category then name, so a row does not jump when it is replaced.
   *
   * Sorting by anything that changes at projection -- capabilities, dependency
   * count -- would make the tree reshuffle under the reader as badges arrive,
   * which is the one thing incremental rendering must not do.
   */
  protected sorted(): Row[] {
    const rows = [...this.rowsByKey.values()];
    rows.sort((a, b) => {
      const byCategory = category(a).localeCompare(category(b));
      return byCategory !== 0 ? byCategory : name(a).localeCompare(name(b));
    });
    return rows;
  }
}

function category(row: Row): string {
  return row.gear.category ?? "uncategorised";
}

function name(row: Row): string {
  return row.kind === "pending"
    ? (row.gear.display_name ?? row.gear.gdl_path)
    : row.gear.display_name;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  // A JSON-RPC rejection arrives as a `ResponseError`-shaped object, which is
  // an `Error` in-process but need not be across the Theia proxy.
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Whether a path is one the catalogue is allowed to have produced.
 *
 * `RelPath` on the engine side already rejects `..`, backslashes and leading
 * separators, so a matching engine cannot send anything else. This re-checks it
 * anyway: the engine is a separate process that a `GEARBOX_ENGINE` override can
 * point anywhere, and the answer is fed straight to a file opener.
 */
function isCatalogueRelative(relative: string): boolean {
  if (relative.length === 0 || relative.includes("\\") || relative.startsWith("/")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(relative)) {
    return false;
  }
  return !relative.split("/").includes("..");
}

/**
 * Join a root reported by the engine to a forward-slash catalogue path.
 *
 * The engine sends `Path::display()`, which is `C:\src\gears` on Windows and
 * `/src/gears` elsewhere, so the separator has to come from the root rather
 * than be assumed. String concatenation with `/` produced `C:\src/gears/x`,
 * which `URI.fromFilePath` does not resolve to the file anyone meant.
 */
function join(root: string, relative: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const tail = separator === "\\" ? relative.split("/").join("\\") : relative;
  const base = root.endsWith("/") || root.endsWith("\\") ? root.slice(0, -1) : root;
  return `${base}${separator}${tail}`;
}
