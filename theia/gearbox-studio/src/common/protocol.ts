// The service the frontend talks to, and the callback it registers.
//
// Types crossing the wire come from `generated/`, written by
// `cargo test -p gearbox-rpc --test export_bindings`. Nothing here restates a
// field: a transcribed wire format diverges, and diverges silently
// (cpt-gearbox-nfr-no-type-drift).
//
// The `textDocument/*` methods are the one place that reads differently, and for
// the same reason rather than against it. Their payloads are LSP's, not
// Gearbox's, so the definition both ends share is the protocol's own -- imported
// below from `vscode-languageserver-protocol`, written by neither side and
// therefore unable to drift from either (cpt-gearbox-adr-gdl-language-server).

import type {
  CompletionItem,
  Hover,
  PublishDiagnosticsParams,
} from "@theia/core/shared/vscode-languageserver-protocol";

import type { CatalogueChanged } from "./generated/CatalogueChanged";
import type { CatalogueDiagnostics } from "./generated/CatalogueDiagnostics";
import type { CatalogueLoadResult } from "./generated/CatalogueLoadResult";
import type { EditGearResult } from "./generated/EditGearResult";
import type { GenerateApplyResult } from "./generated/GenerateApplyResult";
import type { GenerateFileResult } from "./generated/GenerateFileResult";
import type { GeneratePlanResult } from "./generated/GeneratePlanResult";
import type { GearKind } from "./generated/GearKind";
import type { PluginScaffold } from "./generated/PluginScaffold";
import type { ScaffoldGearResult } from "./generated/ScaffoldGearResult";
import type { LockResult } from "./generated/LockResult";
import type { ProductEdit } from "./generated/ProductEdit";
import type { ProductLoadResult } from "./generated/ProductLoadResult";
import type { ResolveResult } from "./generated/ResolveResult";
import type { ValidateResult } from "./generated/ValidateResult";
import type { Diagnostic } from "./generated/Diagnostic";
import type { FailedRoot } from "./generated/FailedRoot";
import type { GearDescriptor } from "./generated/GearDescriptor";
import type { InitializeResult } from "./generated/InitializeResult";
import type { PendingGear } from "./generated/PendingGear";
import type { ProgressParams } from "./generated/ProgressParams";
import type { BuildToolchain } from "./run-product";

export const GEARBOX_SERVICE_PATH = "/services/gearbox";

/**
 * The engine's JSON-RPC method names, in one place.
 *
 * ts-rs exports types, not constants, so these cannot be generated from
 * `gearbox_rpc::protocol::method` the way the payloads are. One table is the
 * next best thing: a rename then breaks in one place rather than in whichever
 * `sendRequest("...")` string was missed, which compiles and fails at runtime.
 * **Keep in sync with `crates/gearbox-rpc/src/protocol.rs`.**
 */
export const method = {
  INITIALIZE: "initialize",
  INITIALIZED: "initialized",
  SHUTDOWN: "shutdown",
  EXIT: "exit",
  CATALOGUE_LOAD: "gearbox/catalogue/load",
  PRODUCT_LOAD: "gearbox/product/load",
  PRODUCT_RESOLVE: "gearbox/product/resolve",
  PRODUCT_RESOLVE_PREVIEW: "gearbox/product/resolvePreview",
  PRODUCT_LOCK: "gearbox/product/lock",
  PRODUCT_ADD_GEAR: "gearbox/product/addGear",
  PRODUCT_REMOVE_GEAR: "gearbox/product/removeGear",
  PRODUCT_SET_CONFIG: "gearbox/product/setConfig",
  PRODUCT_SET_FEATURES: "gearbox/product/setFeatures",
  PRODUCT_ADD_PROFILE: "gearbox/product/addProfile",
  PRODUCT_REMOVE_PROFILE: "gearbox/product/removeProfile",
  PRODUCT_SET_PROFILE_FIELD: "gearbox/product/setProfileField",
  PRODUCT_APPLY_EDITS: "gearbox/product/applyEdits",
  PRODUCT_CREATE: "gearbox/product/create",
  GEAR_SCAFFOLD: "gearbox/gear/scaffold",
  VALIDATE: "gearbox/validate",
  GENERATE_PLAN: "gearbox/generate/plan",
  GENERATE_APPLY: "gearbox/generate/apply",
  GENERATE_FILE: "gearbox/generate/file",
  CATALOGUE_CHANGED: "gearbox/catalogueChanged",
  CATALOGUE_DIAGNOSTICS: "gearbox/catalogueDiagnostics",
  PROGRESS: "$/progress",
  LOG: "gearbox/log",
  // LSP's own, and spelled as LSP spells them rather than under a `gearbox/`
  // prefix: the engine answers these to any language client, not only to this
  // one (`cpt-gearbox-adr-gdl-language-server`).
  DID_OPEN: "textDocument/didOpen",
  DID_CHANGE: "textDocument/didChange",
  DID_CLOSE: "textDocument/didClose",
  COMPLETION: "textDocument/completion",
  HOVER: "textDocument/hover",
  PUBLISH_DIAGNOSTICS: "textDocument/publishDiagnostics",
} as const;

/**
 * A product description the client offered to open.
 *
 * A client-side convenience, not part of the engine's contract: the engine only
 * ever receives an explicit absolute path. Discovery lives here for the same
 * reason `InitializeResult.roots` does -- where the repository is on this
 * machine is the one thing only the server knows -- and for the reason an IDE
 * lists sketches rather than making a person type a path.
 */
/**
 * One `product.gdl` a clone turned out to contain.
 *
 * `id` is opaque and is the only handle the browser gets: it is minted by the
 * node layer for one attempt, so a request naming it cannot ask for a file
 * outside that attempt's own directory. `relPath` exists to be *shown*.
 */
export interface CloneCandidate {
  readonly id: string;
  /** Where it is, relative to the clone's root, for display. */
  readonly relPath: string;
}

/**
 * What a clone turned out to be, before anything is created from it.
 *
 * The `commit` is here because "cloned `main`" is not what a person needs to
 * know when a repository moves: what was actually checked out is.
 */
export interface GitCloneReview {
  readonly attemptId: string;
  /** Every `product.gdl` found, not the first — several is a choice, not a guess. */
  readonly candidates: readonly CloneCandidate[];
  readonly commit: string;
  /** The ref git resolved to, when it reported one. */
  readonly resolvedRef?: string;
}

export interface ProductRef {
  /** Absolute path, which is what `loadProduct` and `resolve` take. */
  readonly path: string;
  /** Relative to the repository root, which is what a person recognises. */
  readonly label: string;
}

/**
 * Where a session may read and where it may write.
 *
 * Declared by the client because the engine cannot judge it: `writable_path` and
 * `writable_out_root` both measure from `workspace`, so a product outside it can
 * be *read* and never edited or generated. Until this existed the backend fixed
 * both values -- `../gears-rust` and the repository root -- which made "open a
 * product" mean "open one of the products in this checkout".
 */
export interface StudioSession {
  /** Source roots to scan for `gear.gdl`. Absolute. */
  readonly roots: readonly string[];
  /** The directory writes are confined to. Absolute. */
  readonly workspace: string;
}

/**
 * Constructor Studio: `initialize`'s answer, and whether the engine already
 * running was kept for it (`GearboxService.initialize`'s `keep`). A kept engine
 * still holds the catalogue it read, and may still be reading it.
 */
export type StudioInitializeResult = InitializeResult & { readonly reused?: boolean };

/**
 * Constructor Studio: `loadCatalogue`'s answer, and the projections remembered
 * on disk for exactly these roots and this engine (`node/catalogue-cache.ts`).
 * The engine's own projections still arrive and replace them; until they do the
 * Catalogue shows these rather than a tree of names.
 */
export type StudioCatalogueLoad = CatalogueLoadResult & { readonly cached?: readonly CatalogueChanged[] };

/**
 * Constructor Studio: files that took a long time to read the first time --
 * on-access antivirus scanning -- and the folder an exclusion would cover.
 */
export interface ScanHint {
  readonly folder: string;
  readonly files: number;
  readonly seconds: number;
}

export const GearboxService = Symbol("GearboxService");
export interface GearboxService {
  /**
   * Start the engine and hand back what it can do.
   *
   * Omitting the session keeps the built-in defaults, which is what the
   * catalogue's own reload does when no product has been opened yet. A session
   * replaces both values, and because `initialize` disposes and respawns the
   * engine, it takes effect wholesale rather than merging with what was there.
   *
   * Constructor Studio: `keep` lets the engine already running stay when it was
   * started on these same roots and they are corpus copies at a commit: it is
   * given the new workspace, keeps the catalogue it read, and the next
   * `loadCatalogue` is answered from that load instead of a rescan. For an open;
   * a reload of the catalogue does not pass it.
   */
  initialize(session?: StudioSession, keep?: boolean): Promise<StudioInitializeResult>;

  /**
   * Constructor Studio: the slow first read of source files the last catalogue
   * load saw on this machine, once; `undefined` when there was none.
   */
  scanHint(): Promise<ScanHint | undefined>;

  /**
   * The folder this window has open, as Theia names it: a `file://` URI of a
   * folder, or of a workspace file (whose folder is the one beside it).
   *
   * Where the environment names no workspace — no `GEARBOX_WORKSPACE`, no
   * `/workspace`, which is a desktop IDE — this is the workspace the catalogue
   * scans for sources. The window says it before its first `initialize`: the
   * backend cannot tell which of its windows asked, and the most recently used
   * workspace it keeps is the command line's when one was given.
   */
  useOpenedWorkspace(uri: string | undefined): Promise<void>;

  /**
   * Begin a staged load. Resolves at the boundary between the two passes: the
   * whole tree by name, none of it projected. Projections arrive on the client
   * callback.
   */
  loadCatalogue(): Promise<StudioCatalogueLoad>;

  /**
   * The directories a Studio workspace should contain.
   *
   * The repository root plus every source root the engine was given. Answered
   * here for the same reason `InitializeResult.roots` is: where things are on
   * this machine is the one thing only the server knows. And answered as one
   * list rather than assembled in the client, because the two halves come from
   * two different places on this side and joining them there would put the
   * layout knowledge in a second file.
   *
   * Why a workspace at all: the Explorer needs one to show anything, an opened
   * `product.lock` needs one to be openable, and the VS Code git extension finds
   * repositories by walking workspace folders. The two that matter here --
   * `gearbox` and `gears-rust` -- are *siblings*, so one folder cannot
   * cover both and the workspace has to be multi-root.
   */
  workspaceRoots(): Promise<string[]>;

  /**
   * The product descriptions under the repository root.
   *
   * Does not touch the engine: this is the Theia backend answering "what could I
   * open", so it works before `initialize` and does not fail when the engine is
   * down.
   */
  listProducts(): Promise<ProductRef[]>;

  /**
   * Constructor Studio: the absolute path of `file` (relative to a checkout)
   * as it is on `branch`, bringing the branch in beside its checkout as a git
   * worktree when no checkout has it. `undefined` when no checkout's origin
   * has the branch, or the file is not on it. For a product the portal saved
   * onto its own branch of a shared repository.
   */
  fileOnBranch(branch: string, file: string): Promise<string | undefined>;

  /**
   * Constructor Studio: a directory named `id` holding the git source `url` at
   * `ref`. A workspace checkout that already is that commit, else the commit in
   * the per-machine cache `useSharedCorpus` fills (`~/ConstructorStudio/corpus`),
   * brought there when missing. For a description that names its corpus as
   * `git(url, rev)`. `clonePath` is the Studio relay's path when `url` is the
   * corpus the backend relays (a private one). `undefined` when the input is not
   * something to hand to git or the ref names no commit; rejects with git's
   * reason when the repository cannot be reached.
   */
  materializeGitSource(
    id: string,
    url: string,
    ref: { rev?: string | null; tag?: string | null; branch?: string | null },
    clonePath?: string,
  ): Promise<string | undefined>;

  /**
   * Constructor Studio: the corpus copy on this machine, with the source id the
   * engine names it by -- the one `useSharedCorpus` adopted, else the newest
   * finished copy in the per-machine cache, which needs no backend (signed
   * out). `undefined` when there is none.
   */
  corpusCopy(): Promise<{ id: string; path: string } | undefined>;

  /**
   * Constructor Studio: make the gear corpus `url` at commit `rev` a source
   * root of every engine this backend starts, from the one copy kept per
   * machine (`~/ConstructorStudio/corpus`). With `fetch` false it only adopts a
   * copy already there and never touches the network; with `fetch` true it
   * clones one, and rejects with git's reason when that fails. The directory,
   * or `undefined` when there is none to adopt.
   */
  useSharedCorpus(
    id: string,
    url: string,
    rev: string,
    fetch: boolean,
    clonePath?: string,
  ): Promise<string | undefined>;

  /** Evaluate a `product.gdl`. Evaluation only; nothing is joined against the
   * catalogue. */
  loadProduct(path: string): Promise<ProductLoadResult>;

  /**
   * Resolve a product for one profile.
   *
   * `profile` omitted uses the product's own default, so the answer still comes
   * from the description rather than from a guess made in the client.
   */
  resolve(path: string, profile?: string): Promise<ResolveResult>;

  /**
   * Resolve the description a configurator is about to write, without writing it.
   *
   * The answer `Add Gear` needs before the person commits to finding out: which
   * gears the closure would pull in, which applications change, which bindings stop
   * being local. `add` and `edits` are applied to the text in memory, in the same
   * order `commitAddGear` writes them, so the preview and the write cannot drift.
   */
  resolvePreview(params: {
    path: string;
    profile?: string;
    add?: { gear: string; source: string };
    edits?: readonly ProductEdit[];
  }): Promise<ResolveResult>;

  /**
   * The canonical `product.lock` text for one profile.
   *
   * A separate call rather than a field on `resolve`: serializing the lock costs
   * work and bytes the other panels do not need. And it is the engine's call to
   * make -- a client rendering its own TOML would be a second answer to the one
   * question the lock exists to settle byte-for-byte.
   */
  lock(path: string, profile?: string): Promise<LockResult>;

  /**
   * Add a gear to a product description, or preview the change.
   *
   * `dryRun` returns what the file would become and writes nothing, which is
   * ADR `cpt-gearbox-adr-authoring-ownership-tiers`'s "a preview is not
   * optional" rather than a convenience. The engine refuses unless this client declared write capability at initialize and the
   * path is inside the declared workspace.
   */
  addGear(path: string, gear: string, source: string, dryRun: boolean, expectedBefore?: string): Promise<EditGearResult>;

  /** Remove a gear from a product description, or preview the removal. */
  removeGear(path: string, gear: string, dryRun: boolean, expectedBefore?: string): Promise<EditGearResult>;

  setConfig(
    path: string,
    gear: string,
    key: string,
    value: string | undefined,
    dryRun: boolean,
  ): Promise<EditGearResult>;

  setFeatures(
    path: string,
    gear: string,
    features: readonly string[],
    dryRun: boolean,
  ): Promise<EditGearResult>;

  addProfile(
    path: string,
    kind: string,
    id: string,
    fields: ReadonlyArray<{ name: string; value: string }>,
    dryRun: boolean,
  ): Promise<EditGearResult>;

  removeProfile(path: string, id: string, dryRun: boolean, expectedBefore?: string): Promise<EditGearResult>;

  setProfileField(
    path: string,
    id: string,
    field: string,
    value: string | undefined,
    dryRun: boolean,
  ): Promise<EditGearResult>;

  /**
   * Apply several description edits in one pass, or preview them.
   *
   * One dry-run and one write for a draft of config, features and profile
   * scalars — the Studio's Apply path, not N per-field RPCs.
   */
  applyEdits(path: string, edits: readonly ProductEdit[], dryRun: boolean, expectedBefore?: string): Promise<EditGearResult>;

  createProduct(params: {
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
  }): Promise<EditGearResult>;

  /**
   * Scaffold a new gear crate (`gear.gdl`, `Cargo.toml`, `src/lib.rs`), or
   * preview the `FilePlan[]` when `dryRun` is true.
   */
  scaffoldGear(params: {
    id: string;
    name: string;
    version: string;
    /** Which shape to write; the engine defaults to `minimal` when absent. */
    kind?: GearKind;
    /**
     * What a `plugin` scaffold fills, when a host has been chosen.
     *
     * Absent keeps the engine's commented locator, which exists because an `sdk`
     * pointing nowhere makes the gear fail to load. Present means the host came
     * out of a loaded catalogue, so the locator is a fact and is written live.
     */
    plugin?: PluginScaffold;
    destinationDir: string;
    dryRun: boolean;
  }): Promise<ScaffoldGearResult>;

  /**
   * Shallow-clone a product repository into a temporary place and describe what
   * was found, without committing to any of it.
   *
   * Does not enable `git(...)` sources in a session — this is only the Clone Git
   * wizard's path, and the engine still receives a local file.
   *
   * **Three methods rather than one, because the old one could not express the
   * flow it was used for.** It returned a single path, so there was nowhere to
   * report several `product.gdl` candidates, nothing to name the checkout that
   * was made, and no way to say "throw that away" — a failed attempt left a
   * directory behind and the deterministic destination made every retry fail on
   * `already exists`.
   */
  gitCloneProduct(url: string, ref: string | undefined): Promise<GitCloneReview>;

  /**
   * Take one candidate from an attempt, and get the path the engine will read.
   *
   * **A `candidateId`, never a path.** The browser names something this attempt
   * handed it, and the node layer resolves it inside that attempt's own root —
   * an absolute path from a client is a path the node layer would have to
   * validate anyway, and validating a token it minted is the smaller job.
   */
  selectClonedProduct(attemptId: string, candidateId: string): Promise<string>;

  /**
   * Throw an attempt away, with its directory.
   *
   * Idempotent, and that is a contract rather than a convenience: Cancel, the
   * wizard closing, a changed URL and a late result can all reach it for the
   * same attempt. An unknown or already-removed attempt succeeds — turning
   * routine cleanup into a failure is how callers learn to skip it.
   */
  discardGitClone(attemptId: string): Promise<void>;

  /** Everything checkable without resolving. `product` omitted checks only the
   * catalogue. */
  validate(product?: string): Promise<ValidateResult>;

  /**
   * What applying generation would do, without doing it.
   *
   * `out` is the CLI's `--out`. Omitted, the engine writes under
   * `<workspace>/.gearbox/<product>/<profile>/`.
   */
  planGenerate(path: string, profile?: string, out?: string): Promise<GeneratePlanResult>;

  /** Write the planned tree. Refused unless this client declared writes. */
  applyGenerate(path: string, profile?: string, out?: string): Promise<GenerateApplyResult>;

  /**
   * The two sides of one planned file: proposed bytes and what is on disk.
   *
   * Re-runs generation; there is no cached plan. `file` is `FilePlan.path`.
   */
  generateFile(
    path: string,
    file: string,
    profile?: string,
    out?: string,
  ): Promise<GenerateFileResult>;

  /**
   * Constructor Studio: what the IDE's machine has for Build and Run -- cargo,
   * the MSVC linker on Windows, docker -- answered without the engine.
   */
  buildToolchain(): Promise<BuildToolchain>;

  /** Constructor Studio: whether something answers on 127.0.0.1:`port` (a Postgres for Run). */
  localPortAnswers(port: number): Promise<boolean>;

  /**
   * Constructor Studio: write `config/<app>.local.yaml` under a generated tree,
   * the generated configuration plus a Postgres section for `dbGears`, and say
   * which configuration Run should use (relative to `outRoot`).
   */
  writeRunConfig(outRoot: string, app: string, dbGears: string[]): Promise<{ config: string; missing: string[] }>;

  /** Constructor Studio: start (or reuse) a local Postgres container and create the databases. */
  startLocalPostgres(product: string, databases: string[]): Promise<{ ok: boolean; message: string }>;

  /**
   * Tell the engine an editor opened a `.gdl`, and what is in the buffer.
   *
   * The three document methods are LSP notifications, so they answer nothing:
   * what comes back is `onDocumentDiagnostics`, whenever the engine has an
   * opinion. The `Promise<void>` is the RPC layer's, not the protocol's.
   *
   * `text` rather than a path, because the buffer is the question. What is on
   * disk is what `validate` and the catalogue load answer about, and an editor
   * that asked about a file it had not saved would be told about the version it
   * was replacing.
   */
  didOpenDocument(uri: string, version: number, text: string): Promise<void>;

  /** The whole buffer again. The engine advertises `textDocumentSync: Full`. */
  didChangeDocument(uri: string, version: number, text: string): Promise<void>;

  /**
   * The editor closed it.
   *
   * The engine answers with an empty diagnostic list, but that is not what the
   * markers rely on: `DescriptionMarkers.forget` clears them as it stops
   * tracking the file, because the engine may already be gone and a `didClose`
   * sent into a dead connection is dropped on purpose. Having stopped tracking
   * it, the client then ignores that empty list along with any other answer
   * about a closed buffer. What must not happen on either path is a marker
   * outliving its buffer, pointing at text nobody can see.
   */
  didCloseDocument(uri: string): Promise<void>;

  /**
   * What may be typed at one position in an open description.
   *
   * The first *request* on the document surface, unlike the three notifications
   * above. The engine answers from the buffer it was last told about, so a
   * caller must have sent `didOpenDocument` first -- an unknown document answers
   * with an empty list rather than failing, because an editor can legitimately
   * ask before the open has crossed the wire.
   *
   * `CompletionItem` is LSP's, imported rather than generated, for the reason
   * the header of this file gives.
   */
  completion(uri: string, line: number, character: number): Promise<CompletionItem[]>;

  /**
   * The documentation for whatever call the caret is inside.
   *
   * `null` when the caret is not inside a known construct, which is most of a
   * file.
   */
  hover(uri: string, line: number, character: number): Promise<Hover | null>;

  dispose(): void;
  setClient(client: GearboxClient | undefined): void;
}

export const GearboxClient = Symbol("GearboxClient");
export interface GearboxClient {
  onCatalogueChanged(event: CatalogueChanged): void;
  /** Diagnostics the second pass produced, after the load response went out. */
  onCatalogueDiagnostics(event: CatalogueDiagnostics): void;
  onProgress(event: ProgressParams): void;
  onLog(message: string): void;
  /**
   * The engine process is gone, and with it any load still streaming.
   *
   * Its own callback rather than a line on `onLog`, because it is the one thing
   * that has to change state: `loadCatalogue` resolves at the S1/S2 boundary,
   * so an engine that dies during projection has already answered every request
   * and there is nothing left to reject. Without this the panel keeps its
   * `loading` status and reads `n gear(s) projecting` forever -- the progress
   * `done` that would have ended it died with the process.
   */
  onEngineExit(reason: string): void;
  /**
   * Diagnostics for one open description, replacing whatever was published for
   * that URI before.
   *
   * `PublishDiagnosticsParams` is imported from the protocol rather than
   * generated from Rust like every other type on this wire. That is not an
   * exception to `cpt-gearbox-nfr-no-type-drift` but the same rule reaching its
   * better answer: these four methods carry LSP's payloads, so the definition
   * both sides agree on is LSP's own, written by neither of them. See
   * `cpt-gearbox-adr-gdl-language-server`.
   */
  onDocumentDiagnostics(params: PublishDiagnosticsParams): void;
}

/**
 * One row of the catalogue tree.
 *
 * A row is pending or projected, and the union is what keeps the two apart at
 * every use site: there is no way to read `runtime_caps` off a pending row,
 * because a pending row has no such field. That is the same reason the engine
 * keeps unprojected gears in a separate list rather than as a state on
 * `GearDescriptor` (ADR cpt-gearbox-adr-staged-catalogue-loading).
 */
export type Row =
  | { readonly kind: "pending"; readonly gear: PendingGear }
  | { readonly kind: "projected"; readonly gear: GearDescriptor };

/**
 * What a row is keyed by, and it is never the id.
 *
 * Both variants carry `source` and `gdl_path` precisely so this function does
 * not have to branch: the key has to survive the pending-to-projected
 * transition, and an id cannot, because it does not exist until S2 has run.
 *
 * `source` is part of the key because `gdl_path` alone is not unique. It is
 * relative to *one* source root, and the engine accepts several -- two roots
 * with the same layout both hold `foo/gear.gdl`, and keying on the path alone
 * collapses them into one row that the second projection then overwrites.
 */
export function rowKey(row: Row): string {
  return keyFor(row.gear.source, row.gear.gdl_path);
}

/** The row key for a `(source, gdl_path)` pair, as the notification sends it. */
export function keyFor(source: string, gdlPath: string): string {
  return `${source}:${gdlPath}`;
}

export function rowName(row: Row): string {
  return row.kind === "pending"
    ? (row.gear.display_name ?? row.gear.gdl_path)
    : row.gear.display_name;
}

export function rowCategory(row: Row): string {
  return row.gear.category ?? "uncategorised";
}

/**
 * Where a load has got to.
 *
 * A discriminant rather than a `loading: boolean`, because the boolean could
 * not say "the load failed": a rejected `load()` left it stuck at `true`, and
 * the empty state is gated on it, so a missing engine rendered as an eternal
 * `0 gear(s) projecting 0/0` with no error anywhere.
 */
export type CatalogueStatus = "idle" | "loading" | "ready" | "error";

export interface CatalogueState {
  readonly status: CatalogueStatus;
  readonly rows: readonly Row[];
  readonly diagnostics: readonly Diagnostic[];
  /** Roots `initialize` was asked for and could not open. */
  readonly failedRoots: readonly FailedRoot[];
  /** Set only when `status === "error"`. */
  readonly error: string | undefined;
  readonly total: number;
  readonly completed: number;
  /**
   * Constructor Studio: set when the rows were listed by the Studio backend
   * from its own corpus checkout, because this workspace holds none. Names
   * that corpus (`owner/repo@ref`). Such rows have no file on this machine.
   */
  readonly remote?: string;
  /**
   * Constructor Studio: set when this workspace holds no corpus and the Studio
   * backend that would list one could not be asked -- signed out, not
   * answering, failing. Says why. An empty catalogue with this set is not "no
   * `gear.gdl` here", and the panel offers to ask again.
   */
  readonly unavailable?: string;
}

/**
 * Constructor Studio: where the catalogue comes from when the workspace holds
 * no gear corpus. The backend keeps one checkout for every project, so the
 * gears are listed without cloning it here. Bound by the Studio extension,
 * which holds the member's API token; absent in Gearbox Studio proper.
 *
 * A `Symbol.for` key, because the extension that binds it does not import
 * this one.
 */
export const RemoteCatalogueSource = Symbol.for("gearbox-studio.RemoteCatalogueSource");
export interface RemoteCatalogueSource {
  /**
   * Undefined when the backend has no corpus to offer. Rejects, saying why,
   * when the backend could not be asked at all.
   */
  load(): Promise<RemoteCatalogue | undefined>;
  /**
   * Fires when the answer may have changed: a desktop starts signed out, so
   * its first load finds nothing, and signing in is what makes the corpus
   * reachable.
   */
  onDidChange?(listener: () => void): { dispose(): void };
}
export interface RemoteCatalogue {
  /** `owner/repo@ref`, as a person reads it. */
  readonly corpus: string;
  readonly gears: readonly GearDescriptor[];
  /** Where the corpus can be had from, when the backend says. */
  readonly origin?: CorpusOrigin;
}
export interface CorpusOrigin {
  /** The source id its gears name, and the directory a copy is kept under. */
  readonly sourceId: string;
  readonly url: string;
  /** The commit the listed gears were read at. */
  readonly rev: string;
  /** Cloning it takes a token the backend does not hand out. */
  readonly needsToken: boolean;
  /**
   * For such a corpus, the gateway-rooted path the Studio backend relays it
   * from, signed with the member's own token. `url` still names the copy.
   */
  readonly clonePath?: string;
}
