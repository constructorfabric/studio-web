// The backend half: owns the engine process, forwards its notifications.
//
// Notifications are relayed rather than accumulated here. The frontend holds the
// catalogue state, because it is the frontend that renders it and a second copy
// on the backend would be a second thing to keep correct.
//
// One instance per frontend connection (see `gearbox-studio-backend-module.ts`),
// so a second window gets its own engine rather than stealing the first's.

import { ILogger } from "@theia/core/lib/common/logger";
import { ResponseError } from "@theia/core/lib/common/message-rpc/rpc-message-encoder";
import { inject, injectable } from "@theia/core/shared/inversify";
import type {
  CompletionItem,
  Hover,
  PublishDiagnosticsParams,
} from "@theia/core/shared/vscode-languageserver-protocol";
import { randomBytes } from "crypto";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

import type { CatalogueChanged } from "../common/generated/CatalogueChanged";
import type { CatalogueDiagnostics } from "../common/generated/CatalogueDiagnostics";
import type { CatalogueLoadResult } from "../common/generated/CatalogueLoadResult";
import type { EditGearResult } from "../common/generated/EditGearResult";
import type { GenerateApplyResult } from "../common/generated/GenerateApplyResult";
import type { GenerateFileResult } from "../common/generated/GenerateFileResult";
import type { GeneratePlanResult } from "../common/generated/GeneratePlanResult";
import type { GearKind } from "../common/generated/GearKind";
import type { PluginScaffold } from "../common/generated/PluginScaffold";
import type { ScaffoldGearResult } from "../common/generated/ScaffoldGearResult";
import type { InitializeResult } from "../common/generated/InitializeResult";
import type { LockResult } from "../common/generated/LockResult";
import type { LogParams } from "../common/generated/LogParams";
import type { ProductEdit } from "../common/generated/ProductEdit";
import type { ProductLoadResult } from "../common/generated/ProductLoadResult";
import type {
  GitCloneReview,
  ScanHint,
  StudioCatalogueLoad,
  StudioInitializeResult,
  StudioSession,
} from "../common/protocol";
import type { ResolveResult } from "../common/generated/ResolveResult";
import type { ValidateResult } from "../common/generated/ValidateResult";
import type { ProgressParams } from "../common/generated/ProgressParams";
import { GearboxClient, GearboxService, ProductRef, method } from "../common/protocol";
import { fileOnBranch } from "./product-branch";
import { cachedCorpora, corpusCacheRoot, corpusRelay, materializeGitSource, materializeSharedCorpus } from "./git-sources";
import {
  enginePath,
  GEARBOX_DESKTOP_ONLY,
  gearboxEnabled,
  folderOfWorkspaceUri,
  isDescribedCheckout,
  productFiles,
  sourceRoots,
  workspaceDir,
} from "./gearbox-environment";
import { EngineHandle, spawnEngine } from "./gearbox-engine-process";
import { closeSourcesList } from "./sources-list";
import { LOCAL_POSTGRES, type BuildToolchain } from "../common/run-product";
import { buildToolchain, portAnswers, startLocalPostgres, writeRunConfig } from "./run-support";
import {
  LoadRecord,
  catalogueCacheFile,
  catalogueCacheKey,
  corpusCommitOf,
  engineIdentity,
  normalizeRoot,
  readCatalogueCache,
  replayCatalogue,
  sameRoots,
  writeCatalogueCache,
  type CatalogueCacheKey,
} from "./catalogue-cache";
import { Prewarmer, shouldPrewarm } from "./source-prewarm";

/**
 * Constructor Studio: the source roots read ahead of the engine, shared by
 * every window's service -- a root warmed for one is warm for all.
 */
const prewarmer = new Prewarmer();

/** A first read slower than this is worth a word about the scanner (`scanHint`). */
const SLOW_SCAN_MS = 5_000;

/** The slowest first read seen, for `scanHint`. */
let slowScan: ScanHint | undefined;

/**
 * How long the engine gets to answer before the request is abandoned.
 *
 * A cap, not an expectation: the measured staged load of the 14-gear slice is
 * ~1.3s. The point is that a wedged engine -- a pathological parse, a hung
 * network filesystem -- becomes an error the panel can show and retry from,
 * rather than a spinner with no end. The load is generous because it is the one
 * call whose cost grows with the tree.
 */
const INITIALIZE_TIMEOUT_MS = 20_000;
const LOAD_TIMEOUT_MS = 120_000;
/**
 * And the same cap for the product methods.
 *
 * Between the two: a resolve reads the cached catalogue rather than rescanning
 * the tree, so it is nowhere near a load's cost, but it is not a constant-time
 * call either -- it evaluates a description, resolves a profile and may
 * serialize a lock. Generous enough that a real answer is never cut off, short
 * enough that the Resolve button stops spinning while someone still cares.
 */
const PRODUCT_TIMEOUT_DEFAULT_MS = 60_000;

/** The narrowest and the widest cap this accepts from the environment. */
const PRODUCT_TIMEOUT_MIN_MS = 1_000;
const PRODUCT_TIMEOUT_MAX_MS = 600_000;

/**
 * The product cap, overridable for a test that has to *reach* it.
 *
 * A 60s wait is not something a claim can sit through, which is the reason this
 * behaviour has never been tested: the timeout is what disposes the handle, and
 * everything downstream of that -- every later call refusing, the child ending,
 * `initialize` being the only way back -- has therefore only ever been reasoned
 * about. So the cap becomes a seam. Not a behaviour change: unset, it is the
 * same 60s constant it has always been, and nothing in the application writes
 * this variable.
 *
 * **Validated, and loudly.** A cap that silently fell back to 60s on a typo
 * would make a wedge test pass for the wrong reason -- the request answering
 * normally, long before a timeout nobody had configured -- and that is the same
 * mistake as reading an unreadable default as an absent one. A malformed value
 * is an error naming the variable and what it said.
 *
 * Read per call rather than at module load, like `enginePath()` above: a throw
 * during module initialisation takes the whole Theia backend down with a stack
 * trace, while a throw here surfaces where every other product failure does.
 */
export function productTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GEARBOX_PRODUCT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return PRODUCT_TIMEOUT_DEFAULT_MS;
  }
  // Digits only. `parseInt` would accept `30s` as 30 and `1e4` as 1, and a cap
  // of one millisecond derived from a plausible-looking value is worse than no
  // cap at all.
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(
      `GEARBOX_PRODUCT_TIMEOUT_MS is \`${raw}\`, which is not a whole number of ` +
        `milliseconds. Unset it for the default of ${PRODUCT_TIMEOUT_DEFAULT_MS}ms.`,
    );
  }
  const ms = Number(raw.trim());
  if (ms < PRODUCT_TIMEOUT_MIN_MS || ms > PRODUCT_TIMEOUT_MAX_MS) {
    throw new Error(
      `GEARBOX_PRODUCT_TIMEOUT_MS is ${ms}ms, outside ` +
        `${PRODUCT_TIMEOUT_MIN_MS}..${PRODUCT_TIMEOUT_MAX_MS}. Below the floor every real ` +
        `answer is cut off and the panel only ever reports a dead engine; above the ceiling ` +
        `the cap is longer than any wait a person will sit through.`,
    );
  }
  return ms;
}

// Constructor Studio: the engine, the roots and the workspace come from
// `./gearbox-environment`, which knows the session's `/workspace` layout — and,
// on a desktop, the folder the IDE has open (`GearboxServiceImpl.opened`).

@injectable()
export class GearboxServiceImpl implements GearboxService {
  @inject(ILogger) protected readonly logger!: ILogger;

  /**
   * The folder this window has open, as it said (`useOpenedWorkspace`). One
   * service per window, so it is that window's: a desktop member opens a
   * project, the window reloads onto it, and says so before the boot load.
   */
  protected opened: string | undefined;

  async useOpenedWorkspace(uri: string | undefined): Promise<void> {
    this.opened = folderOfWorkspaceUri(uri);
  }

  /** The workspace when no session names one. */
  protected defaultWorkspace(): string {
    return workspaceDir(process.env, this.opened);
  }

  /**
   * The source roots when no session names them. A desktop member who opened
   * one repository directly has opened a source root, not a workspace of them.
   */
  protected defaultRoots(): string[] {
    const workspace = this.defaultWorkspace();
    if (!process.env.GEARBOX_ROOT?.trim() && workspace === this.opened && isDescribedCheckout(workspace)) {
      return [workspace];
    }
    return sourceRoots(process.env, workspace);
  }

  /** The shared corpus adopted by `useSharedCorpus`, if any. */
  protected sharedCorpus: string | undefined;

  /** What an engine opens by default: the workspace's own roots, and the shared corpus. */
  protected engineRoots(): string[] {
    const roots = this.defaultRoots();
    return this.sharedCorpus !== undefined && !roots.includes(this.sharedCorpus)
      ? [...roots, this.sharedCorpus]
      : roots;
  }

  protected client: GearboxClient | undefined;
  protected engine: EngineHandle | undefined;

  setClient(client: GearboxClient | undefined): void {
    this.client = client;
  }

  /**
   * The write boundary this session declared, remembered.
   *
   * **Needed because a clone has to land inside it.** The engine refuses a
   * `clone_from` outside the declared workspace and every source root, so a
   * checkout parked next to the repository was read as an attempt to read from
   * nowhere -- which is what it was. The browser knows a workspace root too, but
   * the boundary is *this* value, and having two places compute it is how they
   * end up disagreeing.
   */
  protected workspace = workspaceDir();

  async initialize(session?: StudioSession, keep?: boolean): Promise<StudioInitializeResult> {
    // Constructor Studio: no engine where Gearbox is off. Refused here, where
    // every load starts, so the panel shows why instead of spawning an engine
    // over a corpus this session does not have.
    if (!gearboxEnabled()) {
      throw new Error(GEARBOX_DESKTOP_ONLY);
    }
    // From the session when there is one. The fixed repository root is only a
    // default for the catalogue-only case.
    const workspace = session?.workspace ?? this.defaultWorkspace();
    // Empty `roots` means "use the defaults", not "open nothing". The frontend
    // reaches that after a reload, when `CatalogueStore.rootPaths()` is still
    // empty because the boot load has not installed `rootsById` yet; passing the
    // empty list through used to spawn an engine with no `--root`, and
    // `product/load` then answered `no source root is open`. The RPC side already
    // treats an empty `initialize.roots` as "keep the CLI defaults" -- match it.
    const roots_ =
      session === undefined || session.roots.length === 0 ? this.engineRoots() : [...session.roots];
    // Constructor Studio: the engine already on these roots, kept -- see `keepEngine`.
    if (keep === true && this.canKeepEngine(roots_)) {
      return this.keepEngine(workspace);
    }
    this.disposeEngine();
    this.workspace = workspace;
    // Constructor Studio: from the spawn, not the load -- the load's first pass
    // reads every description, and that is scanned too.
    void this.prewarm(roots_);
    const engine = spawnEngine(enginePath(), roots_, this.logger);
    this.engine = engine;
    this.openRoots = roots_;
    this.record = undefined;
    this.replayNext = false;
    this.pendingInit = undefined;
    this.lastInit = undefined;

    // Constructor Studio: each notification is also recorded, for the load that
    // `keepEngine` answers from and the cache beside the corpus copy.
    const recording = (): LoadRecord | undefined => (this.engine === engine ? this.record : undefined);
    engine.connection.onNotification(method.CATALOGUE_CHANGED, (event: CatalogueChanged) => {
      recording()?.changed(event);
      this.client?.onCatalogueChanged(event);
    });
    engine.connection.onNotification(method.CATALOGUE_DIAGNOSTICS, (event: CatalogueDiagnostics) => {
      recording()?.diagnostics(event);
      this.client?.onCatalogueDiagnostics(event);
    });
    engine.connection.onNotification(method.PROGRESS, (event: ProgressParams) => {
      recording()?.progress(event);
      this.client?.onProgress(event);
    });
    engine.connection.onNotification(method.LOG, (event: LogParams) =>
      this.client?.onLog(event.message),
    );
    engine.connection.onNotification(
      method.PUBLISH_DIAGNOSTICS,
      (params: PublishDiagnosticsParams) => this.client?.onDocumentDiagnostics(params),
    );

    // A child that dies on its own has to stop being this service's engine, or
    // the next `loadCatalogue` sends a request into a disposed connection and
    // reports "engine not initialized" for something that was.
    void engine.exited.then((reason) => {
      // The log line is about *this* handle whatever became of it: a replaced
      // engine exiting is worth reading in a log, and reading it there is how
      // the guard below was noticed.
      this.client?.onLog(`engine ${reason}`);
      // **The event only when this handle is still the engine.** It used to fire
      // unconditionally, outside this check — so *replacing* an engine told the
      // browser the engine had exited, and `CatalogueStore.onEngineExit` marks
      // the connection dead without asking which engine it was. The result is
      // the mirror of the defect it was written for: a session reporting a dead
      // engine while a healthy one answers every call.
      //
      // The race is in the timing. `dispose()` gives the child a second before
      // SIGTERM and three before SIGKILL, so the old handle's `exited` settles
      // *after* the new one is live and serving. Which is precisely when the
      // notification used to arrive.
      //
      // Told as an event and not only as a log line, for the reason it always
      // was: `loadCatalogue` answers at the S1/S2 boundary, so an engine that
      // dies during projection has no outstanding request left to reject and
      // the `$/progress done` that would have ended the load died with it. Only
      // the client knows whether a load was live, so that decision stays there.
      if (this.engine !== engine) return;
      this.engine = undefined;
      this.record?.fail();
      this.client?.onEngineExit(reason);
    });

    const result = await engine.request<InitializeResult>(
      method.INITIALIZE,
      {
        roots: roots_,
        // Declared, because this client edits descriptions on a person's
        // instruction (`cpt-gearbox-fr-rpc-writes-opt-in`). The engine refuses
        // every mutating call until someone claims this, and claiming it is a
        // statement about the client, not about the engine.
        allow_writes: true,
        // And the boundary those writes may not leave. A product description
        // lives beside the products rather than inside a gear source root, so the
        // roots alone would refuse every legitimate edit.
        //
        // From the session when there is one. The fixed repository root is only a
        // default for the catalogue-only case: a product opened from elsewhere
        // would otherwise be readable and unwritable, which is the worst of both.
        workspace: this.workspace,
        // **Where a product may be created, whatever this session is.**
        // ADR `cpt-gearbox-adr-create-product`: "Start-screen create runs
        // against the repository workspace the engine already knows from boot
        // ... not against an open product session." It could not, and the reason is two lines up: the session's
        // roots and workspace are what the write gate reads, so opening a
        // product whose `sources` contain the directory products live in made
        // every later create there refuse -- permanently, because unchecking the
        // source in the next wizard tells the engine nothing.
        //
        // Sent on every `initialize` and always the same values, because the
        // engine cannot work them out: this backend disposes and respawns it per
        // call, so each process sees exactly one `initialize` and has no boot of
        // its own to remember. These are that boot -- the same defaults the
        // catalogue-only case uses.
        creation_boundary: { roots: this.engineRoots(), workspace: this.defaultWorkspace() },
      },
      INITIALIZE_TIMEOUT_MS,
    );
    engine.connection.sendNotification(method.INITIALIZED, {});
    // **Re-open what the editor still has open.** `initialize` disposes and
    // respawns the engine, so the new process knows about no documents at all --
    // and the frontend has no reason to find out, since opening a product is not
    // an event about the file somebody is editing. Without this, every marker on
    // an open `.gdl` would freeze at whatever the previous engine said and stay
    // there until the next keystroke, which is exactly the stale-marker failure
    // `cpt-gearbox-fr-editor-diagnostics` is about.
    for (const [uri, document] of this.documents) {
      this.notifyEngine(method.DID_OPEN, {
        textDocument: { uri, languageId: "gdl", version: document.version, text: document.text },
      });
    }
    if (this.engine === engine) this.lastInit = result;
    return result;
  }

  /** The source roots the running engine was started on. */
  protected openRoots: readonly string[] = [];

  /**
   * Constructor Studio: the running engine's latest catalogue load, as it
   * arrived -- in flight, finished, or cut short. See `catalogue-cache.ts`.
   */
  protected record: LoadRecord | undefined;

  /** Constructor Studio: answer the next `loadCatalogue` from `record` (set by `keepEngine`). */
  protected replayNext = false;

  /** Constructor Studio: a kept engine's `initialize`, sent behind its load. Awaited before anything else is. */
  protected pendingInit: Promise<unknown> | undefined;

  /** Constructor Studio: what the running engine answered to its `initialize`. */
  protected lastInit: InitializeResult | undefined;

  /**
   * Constructor Studio: whether the running engine can serve a session on
   * `roots` as it is. Only for the same roots, in the same order, when every
   * one is a corpus copy at a commit: what the engine read from those is still
   * what is on disk, so its catalogue is still the answer. A workspace's own
   * checkout changes under a person's hands and gets a new engine and a rescan,
   * as before.
   */
  protected canKeepEngine(roots: readonly string[]): boolean {
    const engine = this.engine;
    if (engine === undefined || engine.dead || this.lastInit === undefined) return false;
    if (!sameRoots(this.openRoots, roots)) return false;
    const cache = corpusCacheRoot();
    return roots.every((root) => corpusCommitOf(root, cache) !== undefined);
  }

  /**
   * Constructor Studio: keep the running engine for a new session on the same
   * roots, instead of respawning it and reading the whole corpus again.
   *
   * **This is what makes a second open fast.** Opening a product respawned the
   * engine twice, and the second one scanned the roots from scratch -- 7-8 s on
   * the 44-gear corpus with the scanner's verdicts cached, more than a minute
   * without -- even when the engine already running, the boot one or the last
   * product's, had read exactly those roots. `initialize` with no `roots` keeps
   * the engine's catalogue (gearbox-rpc `initialize`: the cache is dropped only
   * when the roots change) and takes the new workspace and creation boundary.
   *
   * **Sent behind a load in flight, not awaited here.** The engine answers one
   * request at a time, so an `initialize` sent during a load is answered when
   * the projection ends; the caller is answered now, with `reused`, and the
   * open waits for the projection it can see (`ProductSessionService`). Every
   * request after this awaits it, so none reaches the engine ahead of it.
   */
  protected keepEngine(workspace: string): StudioInitializeResult {
    const engine = this.engine as EngineHandle;
    this.workspace = workspace;
    this.replayNext = this.record !== undefined;
    const params = {
      roots: [],
      allow_writes: true,
      workspace,
      creation_boundary: { roots: this.engineRoots(), workspace: this.defaultWorkspace() },
    };
    const behind = this.record?.settled ?? Promise.resolve();
    this.pendingInit = behind
      .then(() => engine.request<InitializeResult>(method.INITIALIZE, params, INITIALIZE_TIMEOUT_MS))
      .then((result) => {
        if (this.engine === engine) this.lastInit = result;
      })
      .catch((error: unknown) => this.logger.warn(`gearbox: the kept engine refused initialize: ${String(error)}`));
    this.logger.info(`gearbox: kept the engine on ${this.openRoots.join(", ")} for ${workspace}`);
    return { ...(this.lastInit as InitializeResult), reused: true };
  }

  async loadCatalogue(): Promise<StudioCatalogueLoad> {
    const engine = this.engine;
    if (!engine || engine.dead) {
      throw new Error("the engine is not running; reload the catalogue to start it");
    }
    // A workspace whose repositories hold no `gear.gdl` has no source root, and
    // the engine answers that with `no source root is open; pass roots to
    // initialize or --root to the CLI` -- advice for a command line, shown to a
    // person who opened a project. Having no gears is an empty catalogue.
    if (this.openRoots.length === 0) {
      return { total: 0, pending: [], diagnostics: [] };
    }
    await this.pendingInit;
    // Constructor Studio: a kept engine still has the catalogue it read; say it
    // again rather than reading the corpus again.
    if (this.replayNext) {
      this.replayNext = false;
      const replayed = await this.replay(engine);
      if (replayed !== undefined) return replayed;
    }
    return this.freshLoad(engine);
  }

  /**
   * Constructor Studio: the recorded load of `engine`, told again: answered
   * with its S1 result, then its projections and `done` as notifications,
   * as the engine sent them. `undefined` when there is no complete record --
   * a load the engine died in -- and the caller loads for real.
   */
  protected async replay(engine: EngineHandle): Promise<StudioCatalogueLoad | undefined> {
    const record = this.record;
    if (record === undefined) return undefined;
    await record.settled;
    const recorded = record.snapshot();
    if (recorded === undefined || this.engine !== engine || engine.dead) return undefined;
    // After the answer, as the engine does: the client installs the tree from
    // the answer and accepts projections from then on.
    setTimeout(() => {
      if (this.engine !== engine || this.client === undefined) return;
      replayCatalogue(recorded, this.client);
      this.client.onLog(`catalogue: ${recorded.changed.length} gear(s) from the engine's last load of the same roots`);
    }, 0);
    return recorded.load;
  }

  /**
   * One real `catalogue/load`, recorded; answered with the projections cached
   * for these roots when there are some (`StudioCatalogueLoad.cached`), and
   * with the source files read ahead where a scanner makes the engine's own
   * reads slow (`source-prewarm.ts`).
   */
  protected async freshLoad(engine: EngineHandle): Promise<StudioCatalogueLoad> {
    const roots = [...this.openRoots];
    const record = new LoadRecord();
    this.record = record;
    void this.prewarm(roots);
    const key = this.cacheKeyFor(roots);
    const file = key === undefined ? undefined : catalogueCacheFile(roots[0]!, key);
    let result: CatalogueLoadResult;
    try {
      result = await engine.request<CatalogueLoadResult>(method.CATALOGUE_LOAD, {}, LOAD_TIMEOUT_MS);
    } catch (error) {
      record.fail();
      throw error;
    }
    record.answered(result);
    const cached = key === undefined || file === undefined ? undefined : readCatalogueCache(file, key);
    if (key !== undefined && file !== undefined) {
      void record.settled.then(() => this.remember(record, key, file, cached));
    }
    return cached === undefined ? result : { ...result, cached: cached.changed };
  }

  /** The cache key for a load of `roots` by this backend's engine, if it is one to cache. */
  protected cacheKeyFor(roots: readonly string[]): CatalogueCacheKey | undefined {
    return catalogueCacheKey(roots, corpusCacheRoot(), engineIdentity(enginePath()));
  }

  /** Write a finished load to its cache file, unless the file already says the same. */
  protected remember(
    record: LoadRecord,
    key: CatalogueCacheKey,
    file: string,
    cached: ReturnType<typeof readCatalogueCache>,
  ): void {
    const recorded = record.snapshot();
    if (recorded === undefined) return;
    if (cached !== undefined && JSON.stringify(cached) === JSON.stringify(recorded)) return;
    try {
      writeCatalogueCache(file, key, recorded);
      this.logger.info(`gearbox: remembered the catalogue of ${key.roots.map((r) => r.path).join(", ")} in ${file}`);
    } catch (error) {
      this.logger.warn(`gearbox: could not remember the catalogue in ${file}: ${String(error)}`);
    }
  }

  /**
   * Constructor Studio: read `roots` ahead of the engine where an on-access
   * scanner would otherwise scan each file as the engine reaches it
   * (`source-prewarm.ts`), and remember a slow first read for `scanHint`.
   */
  protected async prewarm(roots: readonly string[]): Promise<void> {
    if (!shouldPrewarm() || !gearboxEnabled()) return;
    for (const warmed of await prewarmer.prewarm(roots)) {
      this.logger.info(`gearbox: read ${warmed.files} source files of ${warmed.root} ahead of the engine in ${warmed.ms} ms`);
      if (warmed.ms >= SLOW_SCAN_MS && (slowScan === undefined || warmed.ms / 1000 > slowScan.seconds)) {
        const cache = corpusCacheRoot();
        const inCache = normalizeRoot(warmed.root).startsWith(normalizeRoot(cache));
        slowScan = { folder: inCache ? cache : warmed.root, files: warmed.files, seconds: Math.round(warmed.ms / 1000) };
      }
    }
  }

  async scanHint(): Promise<ScanHint | undefined> {
    return slowScan;
  }

  async workspaceRoots(): Promise<string[]> {
    const candidates = [this.defaultWorkspace(), ...this.defaultRoots()];
    const seen = new Set<string>();
    return candidates
      .map((dir) => path.resolve(dir))
      .filter((dir) => {
        // Deduped and existence-checked: `GEARBOX_ROOT` can point at something
        // inside the repository, and a root that is not there would make Theia
        // open a workspace with a broken folder in it.
        if (seen.has(dir) || !fs.existsSync(dir)) return false;
        seen.add(dir);
        return true;
      });
  }

  /**
   * `products/<name>/product.gdl` under the repository root.
   *
   * One level deep and one fixed filename, deliberately: this is a picker, not a
   * discovery mechanism, and a recursive walk would make the client's idea of
   * "the products" differ from what anyone typed on a command line. A product
   * outside this layout is still resolvable -- open it in the editor.
   */
  async listProducts(): Promise<ProductRef[]> {
    const root = this.defaultWorkspace();
    return productFiles(root).map((candidate) => ({ path: candidate, label: path.relative(root, candidate) }));
  }

  async fileOnBranch(branch: string, file: string): Promise<string | undefined> {
    try {
      return await fileOnBranch(this.defaultWorkspace(), branch, file);
    } catch (error) {
      this.logger.warn(`gearbox: could not bring ${branch} into the workspace: ${String(error)}`);
      return undefined;
    }
  }

  async materializeGitSource(
    id: string,
    url: string,
    ref: { rev?: string | null; tag?: string | null; branch?: string | null },
    clonePath?: string,
  ): Promise<string | undefined> {
    // The shared per-machine cache, the same one `useSharedCorpus` fills: a
    // product naming the corpus at a commit reads the copy already there.
    const via = clonePath === undefined ? undefined : corpusRelay(clonePath);
    try {
      return await materializeGitSource(this.defaultWorkspace(), id, url, ref, { cacheRoot: corpusCacheRoot(), via });
    } catch (error) {
      this.logger.warn(`gearbox: could not bring source ${id} (${url}) here: ${String(error)}`);
      const signedOut =
        clonePath !== undefined && via === undefined
          ? " It is private: Studio relays it to the desktop app while you are signed in."
          : "";
      throw new Error(`${url} could not be fetched: ${messageOfGit(error)}.${signedOut}`);
    }
  }

  async corpusCopy(): Promise<{ id: string; path: string } | undefined> {
    const dir = this.sharedCorpus;
    if (dir !== undefined && fs.existsSync(dir)) return { id: path.basename(dir), path: dir };
    // Nothing adopted -- signed out, so the backend was never asked which
    // commit it lists -- but a copy on disk needs no backend.
    const newest = cachedCorpora(corpusCacheRoot())[0];
    return newest === undefined ? undefined : { id: newest.id, path: newest.path };
  }

  async useSharedCorpus(
    id: string,
    url: string,
    rev: string,
    fetch: boolean,
    clonePath?: string,
  ): Promise<string | undefined> {
    const via = clonePath === undefined ? undefined : corpusRelay(clonePath);
    if (fetch && clonePath !== undefined && via === undefined) {
      throw new Error("this corpus can only be cloned through Studio, from the desktop app while signed in");
    }
    let dir: string | undefined;
    try {
      dir = await materializeSharedCorpus(corpusCacheRoot(), id, url, rev, fetch, via);
    } catch (error) {
      this.logger.warn(`gearbox: could not bring the corpus ${url}@${rev} here: ${String(error)}`);
      throw new Error(`the corpus could not be cloned from ${url}: ${messageOfGit(error)}`);
    }
    if (dir !== undefined) {
      this.sharedCorpus = dir;
      // Constructor Studio: read it ahead now, at start, before any load asks.
      void this.prewarm([dir]);
    }
    return dir;
  }

  async loadProduct(path: string): Promise<ProductLoadResult> {
    return this.request(method.PRODUCT_LOAD, { path });
  }

  async resolve(path: string, profile?: string): Promise<ResolveResult> {
    return this.request(method.PRODUCT_RESOLVE, { path, profile });
  }

  async resolvePreview(params: {
    path: string;
    profile?: string;
    add?: { gear: string; source: string };
    edits?: readonly ProductEdit[];
  }): Promise<ResolveResult> {
    return this.request(method.PRODUCT_RESOLVE_PREVIEW, {
      path: params.path,
      profile: params.profile,
      add: params.add,
      edits: params.edits ?? [],
    });
  }

  async lock(path: string, profile?: string): Promise<LockResult> {
    return this.request(method.PRODUCT_LOCK, { path, profile });
  }

  async addGear(path: string, gear: string, source: string, dryRun: boolean): Promise<EditGearResult> {
    return this.request(method.PRODUCT_ADD_GEAR, {
      path,
      gear,
      source,
      dry_run: dryRun,
    });
  }

  async removeGear(path: string, gear: string, dryRun: boolean): Promise<EditGearResult> {
    return this.request(method.PRODUCT_REMOVE_GEAR, { path, gear, dry_run: dryRun });
  }

  async setConfig(
    path: string,
    gear: string,
    key: string,
    value: string | undefined,
    dryRun: boolean,
  ): Promise<EditGearResult> {
    return this.request(method.PRODUCT_SET_CONFIG, {
      path,
      gear,
      key,
      value,
      dry_run: dryRun,
    });
  }

  async setFeatures(
    path: string,
    gear: string,
    features: readonly string[],
    dryRun: boolean,
  ): Promise<EditGearResult> {
    return this.request(method.PRODUCT_SET_FEATURES, {
      path,
      gear,
      features: [...features],
      dry_run: dryRun,
    });
  }

  async addProfile(
    path: string,
    kind: string,
    id: string,
    fields: ReadonlyArray<{ name: string; value: string }>,
    dryRun: boolean,
  ): Promise<EditGearResult> {
    return this.request(method.PRODUCT_ADD_PROFILE, {
      path,
      kind,
      id,
      fields: [...fields],
      dry_run: dryRun,
    });
  }

  async removeProfile(path: string, id: string, dryRun: boolean): Promise<EditGearResult> {
    return this.request(method.PRODUCT_REMOVE_PROFILE, { path, id, dry_run: dryRun });
  }

  async setProfileField(
    path: string,
    id: string,
    field: string,
    value: string | undefined,
    dryRun: boolean,
  ): Promise<EditGearResult> {
    return this.request(method.PRODUCT_SET_PROFILE_FIELD, {
      path,
      id,
      field,
      value,
      dry_run: dryRun,
    });
  }

  async applyEdits(
    path: string,
    edits: readonly ProductEdit[],
    dryRun: boolean,
    expectedBefore?: string,
  ): Promise<EditGearResult> {
    // Constructor Studio: before a batch that appends a source, give the list
    // the trailing comma the engine's append needs -- see `closeSourcesListFor`
    // and https://github.com/MikeFalcon77/gearbox/issues/1. On the dry run too:
    // the dry run is where the engine would otherwise write the broken text,
    // and the preview a person confirms is computed from it.
    if (edits.some((edit) => edit.kind === "add_source")) {
      await this.closeSourcesListFor(path);
    }
    return this.request(method.PRODUCT_APPLY_EDITS, {
      path,
      edits: [...edits],
      expected_before: expectedBefore,
      dry_run: dryRun,
    });
  }

  /**
   * Constructor Studio: close `productPath`'s `sources` list with a comma, and
   * keep the change only if the product still reads the same.
   *
   * The workaround for https://github.com/MikeFalcon77/gearbox/issues/1 (see
   * `sources-list.ts`): a product `product/create` wrote has no comma after its
   * last source, and `add_source` appends without adding one, so the product
   * becomes unreadable (GBX0101). This is the one place Studio asks the engine
   * to append a source, so it is the one place the list is closed first.
   *
   * **Guarded by the engine's own reading, before and after.** Nothing is
   * touched when the product does not read now (the engine's refusal of the
   * batch will say why), and the old text is put back when the new one does not
   * read, or reads with different sources. The file is written only when the
   * list needs the comma; a product that already has one, or a one-line list,
   * is left as it is. Remove with the pin that fixes the engine.
   */
  protected async closeSourcesListFor(productPath: string): Promise<boolean> {
    let original: string;
    try {
      original = await fs.promises.readFile(productPath, "utf8");
    } catch {
      return false;
    }
    const closed = closeSourcesList(original);
    if (closed === undefined) return false;
    let before: ProductLoadResult;
    try {
      before = await this.loadProduct(productPath);
    } catch {
      return false;
    }
    await fs.promises.writeFile(productPath, closed, "utf8");
    try {
      const after = await this.loadProduct(productPath);
      if (JSON.stringify(after.intent?.sources ?? null) === JSON.stringify(before.intent?.sources ?? null)) {
        this.logger.info(`gearbox: closed the sources list of ${productPath} with a comma before adding a source`);
        return true;
      }
    } catch {
      // Falls through to the restore.
    }
    await fs.promises.writeFile(productPath, original, "utf8");
    this.logger.warn(`gearbox: left the sources list of ${productPath} as it was: the closed list did not read the same`);
    return false;
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
    /** Re-base the clone's relative paths onto its new folder: Clone Local only. */
    rebaseRelativePaths?: boolean;
    dryRun: boolean;
  }): Promise<EditGearResult> {
    return this.request(method.PRODUCT_CREATE, {
      path: params.path,
      id: params.id,
      name: params.name,
      version: params.version,
      sources: [...params.sources],
      profile_kind: params.profileKind,
      profile_id: params.profileId,
      clone_from: params.cloneFrom,
      rebase_relative_paths: params.rebaseRelativePaths ?? false,
      dry_run: params.dryRun,
    });
  }

  async scaffoldGear(params: {
    id: string;
    name: string;
    version: string;
    kind?: GearKind;
    plugin?: PluginScaffold;
    destinationDir: string;
    dryRun: boolean;
  }): Promise<ScaffoldGearResult> {
    return this.request(method.GEAR_SCAFFOLD, {
      id: params.id,
      name: params.name,
      version: params.version,
      // Omitted rather than defaulted here: `ScaffoldGearParams.kind` has a
      // serde default, so the engine decides what "unspecified" means and this
      // client does not hold a second copy of that answer.
      ...(params.kind === undefined ? {} : { kind: params.kind }),
      // Same rule: absent means "no host was chosen", which the engine reads as
      // "keep the locator commented". Sending `plugin: undefined` would serialise
      // a null and make this client assert something it has no opinion about.
      ...(params.plugin === undefined ? {} : { plugin: params.plugin }),
      destination_dir: params.destinationDir,
      dry_run: params.dryRun,
    });
  }

  /**
   * `git clone --depth 1` into `destDir`, then walk a few levels for `product.gdl`.
   *
   * Studio-side only: the engine still receives a local path via `clone_from`.
   */
  /**
   * One clone attempt: its directory and what was found in it.
   *
   * Held here rather than derived from the id, so a `candidateId` can only ever
   * resolve to a file this layer itself found. Cleared by `discardGitClone`.
   */
  protected attempts = new Map<
    string,
    { readonly root: string; readonly candidates: Map<string, string> }
  >();

  async gitCloneProduct(url: string, ref: string | undefined): Promise<GitCloneReview> {
    const trimmed = url.trim();
    if (trimmed === "") {
      throw new Error("git clone URL is empty");
    }

    // **A fresh directory per attempt, not one keyed on the product id.** The
    // deterministic destination refused to overwrite -- correctly -- which meant
    // one failed clone made every retry fail on `already exists`, and the only
    // way out was to delete a directory by hand.
    const attemptId = `clone-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const root = path.join(cloneParent(this.workspace), attemptId);
    fs.mkdirSync(root, { recursive: true });

    const args = ["clone", "--depth", "1"];
    if (ref !== undefined && ref.trim() !== "") {
      args.push("--branch", ref.trim());
    }
    args.push(trimmed, root);

    // **Every failure before the return cleans up after itself.** A caller with
    // no `attemptId` cannot discard anything, so a directory left here is a
    // directory nobody can name.
    try {
      await execFileAsync("git", args, { maxBuffer: 10 * 1024 * 1024 });
      const found = findProductGdl(root, 4);
      if (found.length === 0) {
        throw new Error(
          `no product.gdl within four directories of the repository root (${root})`,
        );
      }
      const candidates = new Map<string, string>();
      const listed = found.map((absolute, index) => {
        const id = `c${String(index)}`;
        candidates.set(id, absolute);
        return { id, relPath: path.relative(root, absolute).replace(/\\/g, "/") };
      });
      this.attempts.set(attemptId, { root, candidates });
      return {
        attemptId,
        candidates: listed,
        // What was checked out, not what was asked for: a person reviewing a
        // clone of `main` needs to know which `main`.
        commit: await describeHead(root, "%H"),
        ...(await headRef(root)),
      };
    } catch (error) {
      removeQuietly(root);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.startsWith("no product.gdl") ? message : `git clone failed: ${message}`);
    }
  }

  async selectClonedProduct(attemptId: string, candidateId: string): Promise<string> {
    const attempt = this.attempts.get(attemptId);
    if (attempt === undefined) {
      throw new Error("that clone is no longer available; clone again");
    }
    const chosen = attempt.candidates.get(candidateId);
    if (chosen === undefined) {
      // Only what this attempt handed out. The browser never names a path, so
      // there is no path here to validate -- which is the point of the token.
      throw new Error("that file is not one of the candidates this clone reported");
    }
    return chosen;
  }

  async discardGitClone(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    this.attempts.delete(attemptId);
    // Unknown, or already gone: succeed. Cancel, a wizard closing, a changed URL
    // and a late result can all arrive for the same attempt, and cleanup that
    // throws is cleanup callers learn to skip.
    if (attempt !== undefined) removeQuietly(attempt.root);
  }

  async validate(product?: string): Promise<ValidateResult> {
    return this.request(method.VALIDATE, { product });
  }

  async planGenerate(path: string, profile?: string, out?: string): Promise<GeneratePlanResult> {
    return this.request(method.GENERATE_PLAN, { path, profile, out });
  }

  async applyGenerate(path: string, profile?: string, out?: string): Promise<GenerateApplyResult> {
    return this.request(method.GENERATE_APPLY, { path, profile, out });
  }

  async generateFile(
    path: string,
    file: string,
    profile?: string,
    out?: string,
  ): Promise<GenerateFileResult> {
    return this.request(method.GENERATE_FILE, { path, profile, out, file });
  }

  // Constructor Studio: Build and Run -- see `run-support.ts`. Independent of
  // the engine, like the checks they make.

  async buildToolchain(): Promise<BuildToolchain> {
    return buildToolchain();
  }

  async localPortAnswers(port: number): Promise<boolean> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    return portAnswers(LOCAL_POSTGRES.host, port);
  }

  async writeRunConfig(outRoot: string, app: string, dbGears: string[]): Promise<{ config: string; missing: string[] }> {
    // Only inside a generated tree, and only an application's own file: the
    // frontend names both, and this writes to disk.
    const normalized = outRoot.replace(/\\/g, "/");
    if (!/\/\.gearbox\//.test(normalized) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(app)) {
      throw new Error(`refusing to write a run configuration for ${app} under ${outRoot}`);
    }
    if (dbGears.some((gear) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(gear))) {
      throw new Error("refusing a gear id that is not one");
    }
    return writeRunConfig(outRoot, app, dbGears, LOCAL_POSTGRES);
  }

  async startLocalPostgres(product: string, databases: string[]): Promise<{ ok: boolean; message: string }> {
    const id = product.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (id === "" || databases.some((db) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(db))) {
      return { ok: false, message: "refusing a product or database name that is not an identifier" };
    }
    const result = await startLocalPostgres({ container: `gbx-pg-${id}`, port: LOCAL_POSTGRES.port, databases });
    this.logger.info(`gearbox: local Postgres for ${product}: ${result.message}`);
    return result;
  }

  /**
   * One place that refuses when the engine is not up, and one that always
   * settles when it is.
   *
   * Through `EngineHandle.request` rather than `connection.sendRequest`, which
   * is the whole point: `sendRequest` on a wedged engine never settles, and a
   * promise that never settles crosses the Theia proxy as a Resolve button that
   * spins for the rest of the session with nothing to retry from and nothing in
   * the log. `initialize` and `catalogue/load` have had the death/timeout race
   * since the supervisor was written; these methods were reaching past it.
   *
   * **And one place that keeps the engine's reasons attached.** See
   * `withEngineData`: every refusal the engine explains travels through here, so
   * this is where the explanation is either preserved or lost.
   */
  private async request<T>(method: string, params: unknown): Promise<T> {
    const engine = this.engine;
    if (!engine || engine.dead) {
      throw new Error(`cannot call ${method}: the engine is not initialized`);
    }
    // Constructor Studio: a kept engine's new workspace first (`keepEngine`).
    await this.pendingInit;
    try {
      return await engine.request<T>(method, params, productTimeoutMs());
    } catch (error) {
      throw withEngineData(error);
    }
  }

  /**
   * The editor's open descriptions, mirrored on this side of the wire.
   *
   * Held because this service respawns the engine on every `initialize`, and a
   * new engine knows nothing. The frontend is the authority on what is open; this
   * is only what has to be replayed to make a fresh process agree with it.
   */
  private readonly documents = new Map<string, { version: number; text: string }>();

  async didOpenDocument(uri: string, version: number, text: string): Promise<void> {
    this.documents.set(uri, { version, text });
    this.notifyEngine(method.DID_OPEN, {
      textDocument: { uri, languageId: "gdl", version, text },
    });
  }

  async didChangeDocument(uri: string, version: number, text: string): Promise<void> {
    this.documents.set(uri, { version, text });
    this.notifyEngine(method.DID_CHANGE, {
      textDocument: { uri, version },
      // One whole-document event: the engine advertises `textDocumentSync: Full`
      // and refuses a change carrying a `range` rather than half-applying it.
      contentChanges: [{ text }],
    });
  }

  async completion(uri: string, line: number, character: number): Promise<CompletionItem[]> {
    return this.documentRequest<CompletionItem[]>(method.COMPLETION, uri, line, character, []);
  }

  async hover(uri: string, line: number, character: number): Promise<Hover | null> {
    return this.documentRequest<Hover | null>(method.HOVER, uri, line, character, null);
  }

  /**
   * One position-based request, or the empty answer.
   *
   * **Swallows the failure deliberately, unlike `request`.** These two are asked
   * on a keystroke, so a dead or restarting engine would otherwise surface as a
   * dialog per character typed. The features silently do nothing until the
   * engine is back, which is what an editor does when a language server is down
   * -- and `didOpenDocument` is replayed on the next `initialize`, so recovery
   * needs no action from the person.
   */
  private async documentRequest<T>(
    engineMethod: string,
    uri: string,
    line: number,
    character: number,
    empty: T,
  ): Promise<T> {
    const engine = this.engine;
    if (!engine || engine.dead) return empty;
    try {
      await this.pendingInit;
      return await engine.request<T>(
        engineMethod,
        { textDocument: { uri }, position: { line, character } },
        productTimeoutMs(),
      );
    } catch (error) {
      this.logger.warn(`gearbox: ${engineMethod} failed: ${String(error)}`);
      return empty;
    }
  }

  async didCloseDocument(uri: string): Promise<void> {
    this.documents.delete(uri);
    this.notifyEngine(method.DID_CLOSE, { textDocument: { uri } });
  }

  /**
   * Send one notification to the engine, or drop it.
   *
   * Deliberately not `request`: a notification has no reply, so there is no
   * timeout to race and nothing to reject. Dropping it when the engine is gone is
   * right rather than lax -- a `didChange` for a process that no longer exists
   * describes a document nothing is tracking, and throwing would surface an
   * engine restart to the person as an editor error about a file they are simply
   * typing in. The markers already on screen go stale for as long as it takes the
   * engine to come back and the next keystroke to arrive, which is the mildest
   * failure available here.
   */
  private notifyEngine(method: string, params: unknown): void {
    const engine = this.engine;
    if (!engine || engine.dead) return;
    engine.connection.sendNotification(method, params).catch((error: unknown) => {
      this.logger.warn(`gearbox: cannot send ${method}: ${String(error)}`);
    });
  }

  dispose(): void {
    this.client = undefined;
    this.disposeEngine();
  }

  protected disposeEngine(): void {
    const engine = this.engine;
    this.engine = undefined;
    this.record?.fail();
    engine?.dispose();
  }
}

/** Breadth-first search for `product.gdl` under `root`, capped at `maxDepth`. */
/**
 * Every `product.gdl` within `maxDepth` of the root, breadth first.
 *
 * **All of them, not the first.** A repository with two products is a repository
 * a person has to choose from, and returning whichever the walk reached first
 * made that choice silently and unrepeatably. Breadth first so the shallowest --
 * usually the one meant -- is offered first.
 */
function findProductGdl(root: string, maxDepth: number): string[] {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "product.gdl") {
        found.push(full);
      }
      if (entry.isDirectory() && depth < maxDepth) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return found;
}

/**
 * Where clone attempts live: one directory per attempt, **inside the workspace**.
 *
 * It used to be beside the first source root -- `<root>/../.gearbox/git-clones`
 * -- which put it outside the declared workspace, and the engine refused the
 * resulting `clone_from` for exactly the reason it should: a path outside the
 * workspace and every source root is a path this session may not read. Create
 * then failed after a clone that had worked, which is the shape of failure the
 * review step exists to remove.
 */
function cloneParent(workspace: string): string {
  return path.join(workspace, ".gearbox", "git-clones");
}

/** Remove a directory and say nothing: cleanup that throws is cleanup nobody runs. */
function removeQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Nothing to do about it, and nothing a person could do either. The
    // directory is under `.gearbox/`, which is gitignored and disposable.
  }
}

/** One `git log -1` field of the checkout, or `unknown` when git will not say. */
async function describeHead(root: string, format: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "log", "-1", `--format=${format}`]);
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

/**
 * The ref the checkout is on, when there is one.
 *
 * A `--depth 1` clone of a branch is on that branch; a clone of a tag or a
 * commit is detached and `symbolic-ref` fails, which is a real answer rather
 * than an error -- so the field is simply absent.
 */
async function headRef(root: string): Promise<{ resolvedRef?: string }> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      root,
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    const ref = stdout.trim();
    return ref === "" ? {} : { resolvedRef: ref };
  } catch {
    return {};
  }
}

/**
 * Re-throwable form of an engine refusal that survives the Theia proxy.
 *
 * **The bug this exists to close.** The engine attaches its reasons to a JSON-RPC
 * error as `data.diagnostics` -- `error_with_diagnostics` in `gearbox-rpc` --
 * and `vscode-jsonrpc` hands us a `ResponseError` carrying them. Theia then
 * serialises errors with a msgpack extension that keeps `data` **only** when the
 * value is an instance of *its own* `ResponseError` class:
 *
 * ```js
 * const isResponseError = error instanceof ResponseError;   // @theia/core's
 * ...
 * data.isResponseError ? new ResponseError(code, message, data) : new Error(message)
 * ```
 *
 * Two unrelated classes with the same name, so the test failed for every engine
 * error and every one of them reached the browser as a bare `new Error(message)`.
 * `ProductStore.diagnosticsOf` therefore always answered `undefined`, and its
 * `?? this.state.diagnostics` fallback -- written as the rare case -- was the
 * only branch that ever ran. That is why a product that would not evaluate still
 * showed the previous product's diagnostics as current.
 *
 * Converting here rather than at each call site: `request` is the single funnel,
 * so one conversion covers every method, including the ones added later.
 *
 * Exported for `scripts/rpc-error-smoke.mjs`, which pins both halves: that
 * Theia's codec keeps `data` for its own class and drops it for the other, and
 * that this function turns the second into the first. The first half is a fact
 * about a dependency, so it is the half that can change under an upgrade
 * without anything here failing to compile.
 */
export function withEngineData(error: unknown): unknown {
  // Already Theia's own, or nothing to preserve: hand it back untouched.
  if (error instanceof ResponseError) return error;
  if (!(error instanceof Error)) return error;
  const carrier = error as Error & { code?: unknown; data?: unknown };
  if (carrier.data === undefined) return error;
  const code = typeof carrier.code === "number" ? carrier.code : 0;
  const wrapped = new ResponseError(code, error.message, carrier.data);
  // Keep the origin readable in the backend log; the browser gets its own stack.
  wrapped.stack = error.stack;
  return wrapped;
}

/** The line git said, not the whole `Command failed: git clone ...` dump. */
function messageOfGit(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : String(error);
  return text.trim().split(/\r?\n/).filter(Boolean).pop() ?? text;
}
