// Preview and apply the artefact tree for the resolution on screen.
//
// The engine already knows how to generate; this panel is the missing place
// to look at the plan and to say yes. The tree is `FilePlan[]` -- one line
// per file, no bytes -- and a click asks `gearbox/generate/file` for the two
// sides of that one file. Putting every file on the plan would drag
// `Cargo.lock` (~100k) across for a preview nobody asked to read.

import { codicon, ConfirmDialog, ReactWidget } from "@theia/core/lib/browser";
import { WindowService } from "@theia/core/lib/browser/window/window-service";
import { CommandService } from "@theia/core/lib/common/command";
import { Disposable, DisposableCollection } from "@theia/core/lib/common/disposable";
import { MessageService } from "@theia/core/lib/common/message-service";
import type { Message } from "@theia/core/shared/@lumino/messaging";
import { inject, injectable, optional, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";
import * as monaco from "@theia/monaco-editor-core";

import type { FileAction } from "../../common/generated/FileAction";
import type { FileKind } from "../../common/generated/FileKind";
import type { FilePlan } from "../../common/generated/FilePlan";
import type { GenerateFileResult } from "../../common/generated/GenerateFileResult";
import { CatalogueStore } from "../catalogue-store";
import { DiagnosticsList, selectionOf } from "../diagnostics/diagnostics-list";
import { SelectionService } from "../shell/selection-service";
import { ProductEditService } from "../product-edit-service";
import { ProductStore } from "../product-store";
import { SHOW_PRODUCT } from "../shell/session-command-ids";
import { GenerateService } from "./generate-service";
import { BuildReports, DeployEnvironmentsSource, GearboxService } from "../../common/protocol";
import { BuildWatcher, newBuildId, type BuildOutcome, type BuildReport } from "../../common/build-report";
import type { TerminalWidget } from "@theia/terminal/lib/browser/base/terminal-widget";
import {
  LOCAL_POSTGRES,
  LOCAL_POSTGRES_PASSWORD,
  buildCommand,
  dbNameOf,
  linkedGearsCommand,
  plainPath,
  runCommand,
  runTargetsOf,
  toolchainVerdict,
  type BuildToolchain,
  type RunTarget,
} from "../../common/run-product";
import { ProductTerminals } from "./product-terminals";
import { PUBLISH_WAIT_MS, publishOutcome } from "./publish-outcome";
import { RunPanel, type PostgresState } from "./run-panel";
import { DeployPanel, type DeployStatusView } from "./deploy-panel";
import { ProductDescriptionSync } from "../shell/product-description-sync";
import {
  defaultTarget,
  deployAnswer,
  deployBuildRequest,
  deployCommands,
  deployRequest,
  nextStep,
  publishPlan,
  publishStamp,
  targetEnvironment,
  type DeployInfo,
  type DeployTarget,
  type DeployTargets,
  type BuildWorkflow,
  type ProductBuild,
  type ProductDeployment,
} from "../../common/deploy-product";

const ACTION_ICON: Record<FileAction, string> = {
  create: "new-file",
  update: "edit",
  unchanged: "pass",
  conflict: "warning",
  kept: "lock",
};

const KIND_LANGUAGE: Record<FileKind, string> = {
  rust: "rust",
  toml: "ini",
  yaml: "yaml",
  json: "json",
  dockerfile: "dockerfile",
  shell: "shell",
  text: "plaintext",
};

interface TreeNode {
  readonly name: string;
  readonly plan?: FilePlan;
  readonly children: TreeNode[];
}

function treeOf(plans: readonly FilePlan[]): TreeNode[] {
  const root: TreeNode = { name: "", children: [] };
  for (const plan of plans) {
    const parts = plan.path.split("/");
    let at = root;
    for (let i = 0; i < parts.length; i += 1) {
      const name = parts[i] ?? "";
      const last = i === parts.length - 1;
      let next = at.children.find((child) => child.name === name);
      if (next === undefined) {
        next = { name, children: [], plan: last ? plan : undefined };
        at.children.push(next);
      }
      at = next;
    }
  }
  sortTree(root);
  return root.children;
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    const aDir = a.plan === undefined;
    const bDir = b.plan === undefined;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
}

function countByAction(plans: readonly FilePlan[]): Partial<Record<FileAction, number>> {
  const counts: Partial<Record<FileAction, number>> = {};
  for (const plan of plans) {
    counts[plan.action] = (counts[plan.action] ?? 0) + 1;
  }
  return counts;
}

/** How often a running build is read again: the portal's Builds tab follows it as often. */
const FLOW_FOLLOW_MS = 5000;

/** How long Generate and Build waits for a product just opened to resolve and plan. */
const PLAN_WAIT_MS = 3 * 60_000;

@injectable()
export class GenerateWidget extends ReactWidget {
  static readonly ID = "gearbox.generate";
  static readonly LABEL = "Gearbox Generate";

  @inject(ProductStore) protected readonly product!: ProductStore;
  /**
   * Constructor Studio, from Gearbox Studio (constructorfabric/gearbox#14): a
   * pending draft blocks Apply. Generation reads the saved description, so
   * applying beside unapplied edits writes a tree for a product nobody sees.
   */
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  @inject(GenerateService) protected readonly generate!: GenerateService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  // For the one way out of a failed plan. See the error branch in `render`.
  @inject(CommandService) protected readonly commands!: CommandService;
  // For the trip from a blocked generation to the object that blocked it.
  @inject(SelectionService) protected readonly selection!: SelectionService;
  // Constructor Studio: Build and Run -- see `run-panel.tsx`.
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(ProductTerminals) protected readonly terminals!: ProductTerminals;
  @inject(WindowService) protected readonly windows!: WindowService;
  @inject(MessageService) protected readonly messages!: MessageService;
  // Constructor Studio: the organization's environments (ADR-0043); absent
  // in Gearbox Studio proper, where Deploy offers the kube contexts alone.
  @inject(DeployEnvironmentsSource) @optional() protected readonly environments?: DeployEnvironmentsSource;
  // Constructor Studio: where a build's start and end are reported (ADR-0045);
  // absent in Gearbox Studio proper.
  @inject(BuildReports) @optional() protected readonly buildReports?: BuildReports;
  @inject(ProductDescriptionSync) @optional() protected readonly descriptionSync?: ProductDescriptionSync;
  /** The build being read off each product's Build and Run terminals. */
  protected readonly tracking = new Map<string, (cancelled: boolean) => void>();
  /** The newest build of each product that passed: Deploy names it. */
  protected readonly passedBuilds = new Map<string, { readonly id: string; readonly commit?: string }>();

  protected toolchain: BuildToolchain | undefined;
  protected askingToolchain = false;
  protected runApp: string | undefined;
  protected postgres: PostgresState = "unknown";
  protected startingPostgres = false;
  protected creatingDatabases = false;
  /** Constructor Studio: Deploy, for a kubernetes profile -- see `deploy-panel.tsx`. */
  protected deploy: DeployInfo | undefined;
  protected deployFor: string | undefined;
  protected deployTargets: DeployTargets | undefined;
  protected deployTarget: DeployTarget | undefined;
  protected requestingDeploy = false;
  protected deployNote: string | undefined;
  /** The build Publish put into an environment's registry (ADR-0048): Deploy names it. */
  protected published:
    | {
        readonly environmentId: string;
        readonly buildId: string;
        readonly startedAt: string;
        readonly commit?: string;
        readonly images: readonly { readonly app: string; readonly image: string }[];
        readonly chartRef: string;
        readonly chartVersion: string;
      }
    | undefined;
  protected publishing = false;
  /** The build Studio runs in an environment's cluster for this product (ADR-0048 §9): Deploy names it. */
  protected studioBuild: { readonly environmentId: string; readonly buildId: string } | undefined;
  protected startingBuild = false;
  /**
   * The project's builds and deploys, as the Studio server records them --
   * what the portal's Builds and Deploys tabs show -- for the file they were
   * read for. Followed every few seconds while a build runs.
   */
  protected flowFor: string | undefined;
  protected flowBuilds: readonly ProductBuild[] = [];
  protected flowDeployments: readonly ProductDeployment[] = [];
  protected flowError: string | undefined;
  protected flowTimer: ReturnType<typeof setTimeout> | undefined;
  protected flowFollowing = false;
  protected binding = false;
  /** Each deploy's live status, as last read from its cluster. */
  protected statuses: Record<string, DeployStatusView> = {};
  /** The CI build workflow proposed, by environment. */
  protected workflows: Record<string, BuildWorkflow> = {};
  protected proposingWorkflow = false;
  protected savingSecret = false;
  protected fetchingProtoc = false;

  protected selected: string | undefined;
  protected preview: GenerateFileResult | undefined;
  protected previewError: string | undefined;
  protected previewing = false;

  @postConstruct()
  protected init(): void {
    this.id = GenerateWidget.ID;
    this.title.label = GenerateWidget.LABEL;
    this.title.iconClass = codicon("checklist");
    this.title.caption = GenerateWidget.LABEL;
    this.title.closable = true;
    this.addClass("gbx-widget-generate");
    this.toDispose.push(
      this.product.onChanged(() => {
        this.generate.forgetIfStale();
        this.update();
      }),
    );
    this.toDispose.push(this.generate.onChanged(() => this.update()));
    this.toDispose.push(this.edits.onDraftChanged(() => this.update()));
    this.toDispose.push(this.catalogue.onChanged(() => this.update()));
    this.update();
  }

  /**
   * Constructor Studio: ask again what the machine has each time the view is
   * shown -- someone who just installed cargo reopens it and expects to see so.
   */
  protected override onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    this.toolchain = undefined;
    void this.askToolchain();
  }

  protected async askToolchain(): Promise<void> {
    if (this.askingToolchain) return;
    this.askingToolchain = true;
    try {
      this.toolchain = await this.service.buildToolchain();
    } catch {
      this.toolchain = { cargo: undefined, msvcLinker: "n/a", docker: false, pgPasswordSet: false };
    } finally {
      this.askingToolchain = false;
    }
    await this.probePostgres();
    this.update();
  }

  /** The applications Run can start, for the resolution on screen. */
  protected runTargets(): RunTarget[] {
    const product = this.product.current.resolution?.product;
    if (product === undefined || product === null) return [];
    const hasDb = (gear: string): boolean =>
      this.catalogue.current.rows.some(
        (row) => row.kind === "projected" && row.gear.id === gear && (row.gear.runtime_caps ?? []).includes("db"),
      );
    return runTargetsOf(product, hasDb);
  }

  protected chosenTarget(targets: readonly RunTarget[]): RunTarget | undefined {
    return targets.find((target) => target.app === this.runApp) ?? targets[0];
  }

  protected async probePostgres(): Promise<void> {
    const chosen = this.chosenTarget(this.runTargets());
    if (chosen === undefined || chosen.dbGears.length === 0) {
      this.postgres = "unknown";
      return;
    }
    this.postgres = (await this.service.localPortAnswers(LOCAL_POSTGRES.port).catch(() => false)) ? "answers" : "none";
  }

  /** The product id the terminals are named by, and the folder they open in. */
  protected runContext(): { product: string; cwd: string } | undefined {
    const plan = this.generate.current.plan;
    const product = this.product.current.intent?.id ?? this.product.current.resolution?.product?.product?.id;
    if (plan === undefined || product === undefined) return undefined;
    return { product, cwd: plainPath(plan.out_root) };
  }

  /**
   * The environment of both terminals, the same for Build and Run: the tools
   * found off the PATH and the short target folder (`toolchain.env`) -- Run is
   * `cargo run`, so a Run terminal without them rebuilds into another folder
   * and fails where Build did not -- and the local Postgres password.
   */
  protected terminalEnv(target: RunTarget): Record<string, string> {
    // The local Postgres Studio starts has a known password; a member who runs
    // their own sets GEARS_PG_PASSWORD, and then the terminal inherits it.
    const pg: Record<string, string> =
      target.dbGears.length > 0 && this.toolchain?.pgPasswordSet !== true
        ? { [LOCAL_POSTGRES.passwordEnv]: LOCAL_POSTGRES_PASSWORD }
        : {};
    return { ...(this.toolchain?.env ?? {}), ...pg };
  }

  /**
   * Constructor Studio: which half of the product's way out the product view
   * shows here. `generate` is the code -- the plan, its files, Apply;
   * `deploy` is what comes after Apply -- build and run it on this machine, or
   * build, publish and deploy it to an environment, with how that went. One
   * screen held both, and the tree a person came to Generate for sat under a
   * page of builds, deploys and secrets.
   */
  protected view: "generate" | "deploy" = "generate";

  setView(view: "generate" | "deploy"): void {
    if (this.view === view) return;
    this.view = view;
    this.update();
  }

  /** Whether the generated tree is on disk: applied, or nothing left to write. */
  protected isGenerated(plans: readonly FilePlan[]): boolean {
    return (
      this.generate.current.written !== undefined ||
      (plans.length > 0 && plans.every((plan) => plan.action === "unchanged" || plan.action === "kept"))
    );
  }

  /**
   * Constructor Studio: Generate and Build in one step (`GENERATE_AND_BUILD`),
   * for the portal's Builds tab: wait for the plan of the product on screen,
   * Apply it when it writes anything, then press the Build this profile shows
   * -- Build images for a kubernetes profile, `cargo build` otherwise. It stops,
   * and says why, wherever a person pressing the buttons would be stopped.
   */
  async generateAndBuild(): Promise<void> {
    const settled = await this.planSettled(PLAN_WAIT_MS);
    if (settled === "timeout") {
      this.messages.warn(
        `Nothing was built: the product's plan did not come within ${PLAN_WAIT_MS / 60_000} minutes. Press Apply and Build when it does.`,
      );
      return;
    }
    if (settled === "error") {
      this.messages.error(`Nothing was built: ${this.generate.current.error ?? this.product.current.error ?? "the product did not resolve"}.`);
      return;
    }
    // `nothing` is "generation is up to date": the tree is already there to build.
    const blocks = this.generate.blocks.filter((block) => block.id !== "nothing");
    if (blocks.length > 0) {
      this.messages.warn(`Nothing was built: ${blocks.map((block) => block.reason).join("; ")}.`);
      return;
    }
    if (this.edits.hasDraft()) {
      this.messages.warn("Nothing was built: the product has unsaved edits. Save them, then Apply and Build.");
      return;
    }
    if (this.generate.canApply && (await this.generate.apply()) === undefined) return;
    if (this.kubernetes() !== undefined) {
      await this.buildImages();
      return;
    }
    await this.toolchainKnown();
    const chosen = this.chosenTarget(this.runTargets());
    if (chosen === undefined) {
      this.messages.warn("Nothing was built: the product has no application to build.");
      return;
    }
    await this.build(chosen);
  }

  /** Until the product on screen has a plan, or cannot have one. */
  protected planSettled(ms: number): Promise<"ready" | "error" | "timeout"> {
    return new Promise((resolve) => {
      const listening = new DisposableCollection();
      const settle = (outcome: "ready" | "error" | "timeout") => {
        listening.dispose();
        resolve(outcome);
      };
      const check = () => {
        const product = this.product.current.status;
        const gen = this.generate.current;
        if (product === "error" || gen.status === "error") settle("error");
        else if (product === "ready" && gen.status === "ready" && gen.plan !== undefined) settle("ready");
        else if (product === "ready") void this.generate.ensurePlan();
      };
      const timer = setTimeout(() => settle("timeout"), ms);
      listening.push(Disposable.create(() => clearTimeout(timer)));
      listening.push(this.product.onChanged(check));
      listening.push(this.generate.onChanged(check));
      check();
    });
  }

  /** The toolchain, asked for if nobody is asking: Build's terminal needs its environment. */
  protected async toolchainKnown(): Promise<void> {
    for (let tries = 0; this.toolchain === undefined && tries < 60; tries++) {
      if (this.askingToolchain) await new Promise((resolve) => setTimeout(resolve, 500));
      else await this.askToolchain();
    }
  }

  protected async build(target: RunTarget): Promise<void> {
    const context = this.runContext();
    if (context === undefined) return;
    await this.lockTree(context.cwd);
    const terminal = await this.terminals.send("build", context.product, context.cwd, buildCommand(target), this.terminalEnv(target));
    void this.reportBuild("build", context.product, terminal);
  }

  /**
   * Constructor Studio: tell the Studio server a build started, and how it
   * ended, read off the terminal it runs in (`common/build-report.ts`). A
   * second press of the same button ends the first as cancelled; so does
   * closing the terminal. Best effort: a server that cannot be told does not
   * stop the build.
   */
  protected async reportBuild(action: "build" | "run", product: string, terminal: TerminalWidget): Promise<void> {
    const sink = this.buildReports;
    const file = this.product.current.open?.path;
    if (sink === undefined || file === undefined) return;
    const key = `${action}:${product}`;
    this.tracking.get(key)?.(true);
    const commit = await this.service.headCommitOf(file).catch(() => undefined);
    const profile = this.product.current.profile;
    const base = {
      build_id: newBuildId(),
      action,
      product,
      ...(profile ? { profile } : {}),
      ...(commit !== undefined ? { commit } : {}),
      started_at: new Date().toISOString(),
      // The description revision the file is in step with (ADR-0053 §2).
      ...(this.descriptionSync?.revisionOf(file) !== undefined ? { description_revision: this.descriptionSync.revisionOf(file) } : {}),
    };
    const send = (report: BuildReport): void => {
      sink.report(file, report).catch((error) => console.warn("Studio: a build report was not taken", error));
    };
    send({ ...base, status: "running" });
    const watcher = new BuildWatcher(action);
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const subscriptions: { dispose(): void }[] = [];
    const finish = (outcome: BuildOutcome | undefined, cancelled: boolean): void => {
      if (this.tracking.get(key) !== end) return;
      this.tracking.delete(key);
      if (quiet !== undefined) clearTimeout(quiet);
      subscriptions.forEach((s) => s.dispose());
      const status = cancelled || outcome === undefined ? "cancelled" : outcome.status;
      send({
        ...base,
        status,
        finished_at: new Date().toISOString(),
        ...(outcome?.failure !== undefined ? { failure: outcome.failure } : {}),
        ...(outcome?.failureStep !== undefined ? { failure_step: outcome.failureStep } : {}),
      });
      if (status === "passed") this.passedBuilds.set(product, { id: base.build_id, commit });
    };
    const end = (cancelled: boolean): void => finish(undefined, cancelled);
    this.tracking.set(key, end);
    subscriptions.push(
      terminal.onOutput((chunk) => {
        const outcome = watcher.feed(chunk);
        if (outcome !== undefined) {
          finish(outcome, false);
          return;
        }
        if (quiet !== undefined) clearTimeout(quiet);
        quiet = setTimeout(() => {
          const idle = watcher.idle();
          if (idle !== undefined) finish(idle, false);
        }, 5000);
      }),
      terminal.onTerminalDidClose(() => end(true)),
    );
  }

  protected async linkedGears(target: RunTarget): Promise<void> {
    const context = this.runContext();
    if (context === undefined) return;
    await this.terminals.send("build", context.product, context.cwd, linkedGearsCommand(target), this.terminalEnv(target));
  }

  protected async run(target: RunTarget): Promise<void> {
    const context = this.runContext();
    if (context === undefined) return;
    let config = target.config;
    await this.lockTree(context.cwd);
    try {
      const written = await this.service.writeRunConfig(context.cwd, target.app, [...target.dbGears]);
      config = written.config;
      if (written.missing.length > 0) {
        this.messages.warn(`${written.missing.join(", ")} not found in ${target.config}; no database was added for ${written.missing.length === 1 ? "it" : "them"}.`);
      }
    } catch (error) {
      this.messages.error(`The run configuration could not be written: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const terminal = await this.terminals.send("run", context.product, context.cwd, runCommand(target, config), this.terminalEnv(target));
    void this.reportBuild("run", context.product, terminal);
  }

  protected async createDatabases(target: RunTarget): Promise<void> {
    if (this.creatingDatabases) return;
    this.creatingDatabases = true;
    this.update();
    try {
      const result = await this.service.createLocalDatabases(target.dbGears.map(dbNameOf));
      if (result.ok) this.messages.info(result.message);
      else this.messages.error(result.message);
    } finally {
      this.creatingDatabases = false;
      this.update();
    }
  }

  protected async fetchProtoc(): Promise<void> {
    if (this.fetchingProtoc) return;
    this.fetchingProtoc = true;
    this.update();
    try {
      const result = await this.service.fetchProtoc();
      if (result.ok) this.messages.info(result.message);
      else this.messages.error(result.message);
    } finally {
      this.fetchingProtoc = false;
      this.toolchain = undefined;
      await this.askToolchain();
    }
  }

  protected async startPostgres(target: RunTarget): Promise<void> {
    const context = this.runContext();
    if (context === undefined || this.startingPostgres) return;
    this.startingPostgres = true;
    this.update();
    try {
      const result = await this.service.startLocalPostgres(context.product, target.dbGears.map(dbNameOf));
      if (result.ok) this.messages.info(result.message);
      else this.messages.error(result.message);
    } finally {
      this.startingPostgres = false;
      await this.probePostgres();
      this.update();
    }
  }

  /** The kubernetes settings of the resolution on screen, when its profile is one. */
  protected kubernetes(): { namespace?: string | null; image_registry?: string | null } | undefined {
    return this.product.current.resolution?.product?.kubernetes ?? undefined;
  }

  protected async askDeploy(outRoot: string): Promise<void> {
    if (this.deployFor === outRoot) return;
    this.deployFor = outRoot;
    this.deploy = undefined;
    try {
      this.deploy = await this.service.deployInfo(outRoot);
    } catch (error) {
      this.messages.error(`Deploy could not read the generated tree: ${error instanceof Error ? error.message : String(error)}`);
    }
    const file = this.product.current.open?.path;
    if (this.environments !== undefined && file !== undefined) {
      try {
        this.deployTargets = await this.environments.targets(file);
      } catch {
        // Signed out, or a Studio from before environments: the kube contexts remain.
        this.deployTargets = undefined;
      }
    }
    this.deployTarget ??= defaultTarget(this.deployTargets, this.product.current.profile, this.deploy?.contexts ?? [], this.deploy?.currentContext);
    this.update();
  }

  /** The registry and namespace Deploy uses: the chosen environment's, else the profile's. */
  protected deployPlace(): { namespace: string | undefined; registry: string | undefined } {
    const environment = targetEnvironment(this.deployTargets, this.deployTarget);
    if (environment !== undefined) return { namespace: environment.namespace, registry: environment.registry || undefined };
    const kubernetes = this.kubernetes();
    return { namespace: kubernetes?.namespace ?? undefined, registry: kubernetes?.image_registry ?? undefined };
  }

  protected deployCommandsFor(kubeContext?: string): ReturnType<typeof deployCommands> | undefined {
    const context = this.runContext();
    const deploy = this.deploy;
    if (context === undefined || deploy?.script === undefined || deploy.chart === undefined) return undefined;
    const place = this.deployPlace();
    return deployCommands({
      outRoot: context.cwd,
      script: deploy.script,
      chart: deploy.chart,
      release: context.product,
      namespace: place.namespace,
      registry: place.registry,
      ...(kubeContext !== undefined ? { kubeContext } : {}),
    });
  }

  /** The tree locked to its sources' crate versions before cargo runs in it; a build without it still starts. */
  protected async lockTree(cwd: string): Promise<void> {
    await this.service.lockBuildTree(cwd).catch((error) =>
      this.messages.warn(`Cargo.lock could not be added to the tree: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  /** Build images: the tree made buildable first (see `prepareImageBuild`), then `docker build` per application. */
  protected async buildImages(): Promise<void> {
    const context = this.runContext();
    if (context === undefined) return;
    try {
      await this.service.prepareImageBuild(context.cwd);
    } catch (error) {
      this.messages.error(`The generated Dockerfiles could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await this.sendDeploy(this.deployCommandsFor()?.build ?? []);
  }

  /** One step into the Deploy terminal: several commands run one after another, stopping at the first that fails. */
  protected async sendDeploy(commands: readonly string[]): Promise<void> {
    const context = this.runContext();
    if (context === undefined || commands.length === 0) return;
    await this.terminals.send("deploy", context.product, context.cwd, commands.join(" && "), { DOCKER_BUILDKIT: "1" });
  }

  /**
   * Publish into an environment's registry (ADR-0048): the server gets a
   * token from the registry that may push this product's images and chart
   * and nothing else; the images Build images made are tagged and pushed
   * with it, the chart packaged and pushed beside them, and the build is
   * reported with what it published -- so Deploy can name it.
   */
  protected async publish(): Promise<void> {
    const context = this.runContext();
    const environment = targetEnvironment(this.deployTargets, this.deployTarget);
    const deploy = this.deploy;
    const source = this.environments;
    if (
      context === undefined ||
      environment === undefined ||
      deploy?.script === undefined ||
      deploy.chart === undefined ||
      source?.pushToken === undefined ||
      this.deployTargets === undefined ||
      !environment.registry
    )
      return;
    this.publishing = true;
    this.deployNote = undefined;
    this.update();
    try {
      const file = this.product.current.open?.path;
      const commit = file !== undefined ? await this.service.headCommitOf(file) : undefined;
      const stamp = publishStamp(commit);
      // The repositories first, from a plan with no folder yet: the token is for them.
      const draft = publishPlan({
        outRoot: context.cwd,
        script: deploy.script,
        chart: deploy.chart,
        product: context.product,
        prefix: environment.registry,
        ...stamp,
        configDir: ".",
      });
      const token = await source.pushToken(this.deployTargets.projectId, environment.id, draft.repositories);
      const configDir = await this.service.writeRegistryConfig(token.registry, token.token);
      const plan = publishPlan({
        outRoot: context.cwd,
        script: deploy.script,
        chart: deploy.chart,
        product: context.product,
        prefix: environment.registry,
        ...stamp,
        configDir,
      });
      // Published only once the terminal says every push went through: a
      // build recorded as published with a chart the registry refused sent
      // every Deploy after it to "not found".
      const marker = `studio-publish-${newBuildId()}`;
      const terminal = await this.terminals.send(
        "publish",
        context.product,
        context.cwd,
        `${plan.commands.join(" && ")} && echo ${marker}-ok || echo ${marker}-failed`,
        { DOCKER_BUILDKIT: "1" },
      );
      this.deployNote = `Publishing ${plan.chartVersion} to ${environment.registry} in the Publish terminal…`;
      this.update();
      const ended = await publishOutcome(terminal, marker, PUBLISH_WAIT_MS);
      if (ended.ok) {
        this.published = {
          environmentId: environment.id,
          buildId: newBuildId(),
          startedAt: new Date().toISOString(),
          ...(commit !== undefined ? { commit } : {}),
          images: plan.images,
          chartRef: plan.chartRef,
          chartVersion: plan.chartVersion,
        };
        this.deployNote = `Published ${plan.chartVersion} to ${environment.registry}. Deploy asks the Studio server to install it into ${environment.name}.`;
      } else {
        this.deployNote = `Publish failed${ended.why ? `: ${ended.why}` : ""}. Nothing was recorded as published; see the Publish terminal.`;
        this.messages.error(`Publish to ${environment.registry} failed${ended.why ? `: ${ended.why}` : ""}`);
      }
    } catch (error) {
      this.messages.error(`Publish did not start: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.publishing = false;
      this.update();
    }
  }

  /**
   * Build in Studio: the server runs the build as a Job in the environment's
   * cluster, from what is pushed to this branch, and records it; Deploy then
   * names it.
   */
  protected async buildInStudio(): Promise<void> {
    const environment = targetEnvironment(this.deployTargets, this.deployTarget);
    const source = this.environments;
    const file = this.product.current.open?.path;
    if (environment === undefined || source?.startBuild === undefined || this.deployTargets === undefined || file === undefined) return;
    const where = await this.service.repositoryPathOf(file);
    if (where === undefined) {
      this.messages.error("This product is not in a git repository Studio can build from.");
      return;
    }
    const ok = await new ConfirmDialog({
      title: `Build in ${environment.name}?`,
      msg:
        `Studio builds ${where.path} as pushed to ${where.branch ?? "the repository's branch"} -- push your changes first -- ` +
        `in a Job in ${environment.namespace} on ${environment.name}'s cluster, and pushes the images and the chart to ${environment.registry}.`,
      ok: "Build",
    }).open();
    if (ok !== true) return;
    this.startingBuild = true;
    this.update();
    try {
      const started = await source.startBuild(this.deployTargets.projectId, {
        environment_id: environment.id,
        profile: this.product.current.profile ?? "prod",
        product_file: where.path,
        ...(where.branch !== undefined ? { ref: where.branch } : {}),
      });
      this.studioBuild = { environmentId: environment.id, buildId: started.build_id };
      void this.refreshFlow();
      this.deployNote =
        `Studio is building ${started.build_id} in ${started.namespace} (about ten minutes; the project's Builds tab shows it). ` +
        `When it has passed, Deploy installs it into ${environment.name}.`;
    } catch (error) {
      this.messages.error(`The Studio server did not start the build: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.startingBuild = false;
      this.update();
    }
  }

  protected async confirmDeploy(): Promise<void> {
    const target = this.deployTarget;
    if (target?.kind === "environment") {
      const built = this.studioBuild;
      if (built !== undefined && built.environmentId === target.id) return this.requestStudioBuildDeploy(built.buildId);
      const published = this.published;
      if (published !== undefined && published.environmentId === target.id) return this.requestBuildDeploy();
      return this.requestServerDeploy();
    }
    const kubeContext = target?.kind === "context" ? target.name : undefined;
    const commands = this.deployCommandsFor(kubeContext);
    if (kubeContext === undefined || commands?.install === undefined) return;
    const namespace = this.deployPlace().namespace ?? "the chart's namespace";
    const ok = await new ConfirmDialog({
      title: "Deploy to a cluster?",
      msg: `helm upgrade --install ${this.runContext()?.product ?? ""} into ${namespace} on ${kubeContext}. This changes that cluster.`,
      ok: "Deploy",
    }).open();
    if (ok === true) await this.sendDeploy([commands.install]);
  }

  /**
   * Deploy into an organization's environment: the server installs the chart
   * with the environment's connection. Asks first, packs the chart here and
   * sends it with the images Generate built -- pushed beforehand.
   */
  protected async requestServerDeploy(): Promise<void> {
    const context = this.runContext();
    const environment = targetEnvironment(this.deployTargets, this.deployTarget);
    const deploy = this.deploy;
    const source = this.environments;
    if (context === undefined || environment === undefined || deploy?.script === undefined || deploy.chart === undefined || source === undefined || this.deployTargets === undefined) return;
    const ok = await new ConfirmDialog({
      title: `Deploy to ${environment.name}?`,
      msg:
        `The Studio server installs ${context.product} into ${environment.namespace} on ${environment.name}, ` +
        `pulling the images from ${environment.registry || "where they were built"} -- push them first.` +
        (environment.protected ? " An organization administrator approves it before it runs." : ""),
      ok: "Deploy",
    }).open();
    if (ok !== true) return;
    this.requestingDeploy = true;
    this.deployNote = undefined;
    this.update();
    try {
      const chart = await this.service.packChart(context.cwd, deploy.chart);
      const file = this.product.current.open?.path;
      const commit = file !== undefined ? await this.service.headCommitOf(file) : undefined;
      // The build this deploy came from: the newest that passed here, at this commit.
      const built = this.passedBuilds.get(context.product);
      const build = built !== undefined && (built.commit === undefined || built.commit === commit) ? built.id : undefined;
      const answer = await source.requestDeploy(
        this.deployTargets.projectId,
        deployRequest({
          environment,
          profile: this.product.current.profile ?? "",
          product: context.product,
          ...(commit !== undefined ? { commit } : {}),
          ...(build !== undefined ? { build } : {}),
          script: deploy.script,
          chart,
        }),
      );
      this.deployNote = deployAnswer(answer.state, answer.environment_name, answer.namespace);
      void this.refreshFlow();
    } catch (error) {
      this.deployNote = undefined;
      this.messages.error(`The Studio server did not take the deploy: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.requestingDeploy = false;
      this.update();
    }
  }

  /** Deploy the build Studio ran: the server refuses it until it has passed. */
  protected async requestStudioBuildDeploy(buildId: string): Promise<void> {
    const context = this.runContext();
    const environment = targetEnvironment(this.deployTargets, this.deployTarget);
    const source = this.environments;
    if (context === undefined || environment === undefined || source === undefined || this.deployTargets === undefined) return;
    const ok = await new ConfirmDialog({
      title: `Deploy to ${environment.name}?`,
      msg:
        `The Studio server installs build ${buildId} into ${environment.namespace} on ${environment.name} once it has passed.` +
        (environment.protected ? " An organization administrator approves it before it runs." : ""),
      ok: "Deploy",
    }).open();
    if (ok !== true) return;
    this.requestingDeploy = true;
    this.update();
    try {
      const answer = await source.requestDeploy(
        this.deployTargets.projectId,
        deployBuildRequest({ environment, profile: this.product.current.profile ?? "", product: context.product, build: buildId }),
      );
      this.deployNote = deployAnswer(answer.state, answer.environment_name, answer.namespace);
      void this.refreshFlow();
    } catch (error) {
      this.messages.error(`The Studio server did not take the deploy: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.requestingDeploy = false;
      this.update();
    }
  }

  /**
   * Deploy the build Publish put into the environment's registry. The build is
   * reported here, once the member says Publish finished, with what it
   * published; the server then pulls its chart and images.
   */
  protected async requestBuildDeploy(): Promise<void> {
    const context = this.runContext();
    const environment = targetEnvironment(this.deployTargets, this.deployTarget);
    const source = this.environments;
    const published = this.published;
    const file = this.product.current.open?.path;
    if (
      context === undefined ||
      environment === undefined ||
      source === undefined ||
      this.deployTargets === undefined ||
      published === undefined ||
      file === undefined
    )
      return;
    if (this.buildReports === undefined) {
      this.messages.error("This IDE cannot report builds to Studio, so the published build cannot be deployed by name.");
      return;
    }
    const ok = await new ConfirmDialog({
      title: `Deploy to ${environment.name}?`,
      msg:
        `The Studio server installs the build you published into ${environment.namespace} on ${environment.name}, ` +
        `pulling its chart and images from ${environment.registry} -- once Publish has finished in the terminal.` +
        (environment.protected ? " An organization administrator approves it before it runs." : ""),
      ok: "Deploy",
    }).open();
    if (ok !== true) return;
    this.requestingDeploy = true;
    this.update();
    try {
      await this.buildReports.report(file, {
        build_id: published.buildId,
        action: "build",
        status: "passed",
        product: context.product,
        ...(this.product.current.profile !== undefined ? { profile: this.product.current.profile } : {}),
        ...(published.commit !== undefined ? { commit: published.commit } : {}),
        started_at: published.startedAt,
        finished_at: new Date().toISOString(),
        images: published.images,
        chart_ref: published.chartRef,
        chart_version: published.chartVersion,
      });
      const answer = await source.requestDeploy(
        this.deployTargets.projectId,
        deployBuildRequest({
          environment,
          profile: this.product.current.profile ?? "",
          product: context.product,
          build: published.buildId,
        }),
      );
      this.published = undefined;
      this.deployNote = deployAnswer(answer.state, answer.environment_name, answer.namespace);
      void this.refreshFlow();
    } catch (error) {
      this.messages.error(`The Studio server did not take the deploy: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.requestingDeploy = false;
      this.update();
    }
  }

  /**
   * Constructor Studio: read the project's builds and deploys once for the open
   * product -- whether or not this machine generated anything, because a build
   * Studio ran deploys without it. The environments come with them when Deploy
   * has not asked yet.
   */
  protected async askFlow(file: string): Promise<void> {
    if (this.flowFor === file || this.environments?.builds === undefined) return;
    this.flowFor = file;
    if (this.deployTargets === undefined) {
      try {
        this.deployTargets = await this.environments.targets(file);
      } catch {
        this.deployTargets = undefined;
      }
      this.deployTarget ??= defaultTarget(this.deployTargets, this.product.current.profile, this.deploy?.contexts ?? [], this.deploy?.currentContext);
    }
    await this.refreshFlow();
  }

  /** Read the builds and deploys again; while a build runs, again in a few seconds. */
  protected async refreshFlow(): Promise<void> {
    const source = this.environments;
    const projectId = this.deployTargets?.projectId;
    if (source?.builds === undefined || projectId === undefined) return;
    if (this.flowTimer !== undefined) clearTimeout(this.flowTimer);
    this.flowTimer = undefined;
    try {
      const [builds, deployments] = await Promise.all([source.builds(projectId), source.deployments?.(projectId) ?? Promise.resolve([])]);
      // A project can hold more than one product: this panel is about the open one.
      const product = this.product.current.intent?.id;
      this.flowBuilds = builds.filter((b) => b.product === undefined || product === undefined || b.product === product);
      this.flowDeployments = deployments.filter((d) => product === undefined || d.product === product);
      this.flowError = undefined;
    } catch (error) {
      this.flowError = error instanceof Error ? error.message : String(error);
    }
    if (this.flowBuilds.some((b) => b.status === "running") && !this.isDisposed) {
      if (!this.flowFollowing) {
        this.flowFollowing = true;
        this.toDispose.push({ dispose: () => this.flowTimer !== undefined && clearTimeout(this.flowTimer) });
      }
      this.flowTimer = setTimeout(() => void this.refreshFlow(), FLOW_FOLLOW_MS);
    }
    this.update();
  }

  /** Bind the open profile to an environment, keeping the project's other bindings. */
  protected async bindProfile(environmentId: string): Promise<void> {
    const source = this.environments;
    const profile = this.product.current.profile;
    const file = this.product.current.open?.path;
    if (source?.bind === undefined || this.deployTargets === undefined || profile === undefined || file === undefined) return;
    this.binding = true;
    this.update();
    try {
      await source.bind(this.deployTargets.projectId, profile, environmentId);
      this.deployTargets = (await source.targets(file)) ?? this.deployTargets;
      this.deployTarget = { kind: "environment", id: environmentId };
      await this.refreshFlow();
    } catch (error) {
      this.messages.error(`The Studio server did not bind ${profile}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.binding = false;
      this.update();
    }
  }

  /** Read a deploy's release from its cluster now, in the project's organization. */
  protected async readStatus(deploymentId: string): Promise<void> {
    const source = this.environments;
    const organization = this.deployTargets?.organizationId;
    if (source?.status === undefined || organization === undefined) return;
    this.statuses = { ...this.statuses, [deploymentId]: { kind: "loading" } };
    this.update();
    try {
      const status = await source.status(organization, deploymentId);
      this.statuses = { ...this.statuses, [deploymentId]: { kind: "status", status } };
    } catch (error) {
      this.statuses = { ...this.statuses, [deploymentId]: { kind: "error", error: error instanceof Error ? error.message : String(error) } };
    }
    this.update();
  }

  /**
   * Propose the product's CI build workflow to its repository, publishing into
   * the chosen environment's registry: the product file as the repository
   * names it, which is what the workflow checks out and builds.
   */
  protected async proposeWorkflow(): Promise<void> {
    const environment = targetEnvironment(this.deployTargets, this.deployTarget);
    const source = this.environments;
    const file = this.product.current.open?.path;
    if (environment === undefined || source?.proposeBuildWorkflow === undefined || this.deployTargets === undefined || file === undefined) return;
    const where = await this.service.repositoryPathOf(file);
    if (where === undefined) {
      this.messages.error("This product is not in a git repository Studio can propose a workflow to.");
      return;
    }
    this.proposingWorkflow = true;
    this.update();
    try {
      const workflow = await source.proposeBuildWorkflow(this.deployTargets.projectId, {
        environment_id: environment.id,
        profile: this.product.current.profile ?? "prod",
        product_file: where.path,
      });
      this.workflows = { ...this.workflows, [environment.id]: workflow };
    } catch (error) {
      this.messages.error(`The Studio server did not propose the workflow: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.proposingWorkflow = false;
      this.update();
    }
  }

  /** Set or remove a configuration secret in the chosen environment, then read the keys again. */
  protected async configSecret(key: string, value: string | undefined): Promise<void> {
    const environment = targetEnvironment(this.deployTargets, this.deployTarget);
    const source = this.environments;
    const file = this.product.current.open?.path;
    if (environment === undefined || source?.configSecret === undefined || this.deployTargets === undefined || file === undefined) return;
    this.savingSecret = true;
    this.update();
    try {
      await source.configSecret(this.deployTargets.projectId, environment.id, key, value);
      this.deployTargets = (await source.targets(file)) ?? this.deployTargets;
    } catch (error) {
      this.messages.error(`The Studio server did not ${value === undefined ? "remove" : "set"} ${key}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.savingSecret = false;
      this.update();
    }
  }

  /** The builds-and-deploys section's props, when Studio can be asked for them. */
  protected deployFlow(): React.ComponentProps<typeof DeployPanel>["flow"] {
    if (this.environments?.builds === undefined || this.deployTargets === undefined) return undefined;
    const profile = this.product.current.profile;
    const environments = this.deployTargets.environments;
    const bound = profile !== undefined && environments.some((e) => e.id === this.deployTargets?.bound[profile]);
    return {
      next: nextStep({
        builds: this.flowBuilds,
        deployments: this.flowDeployments,
        environments: environments.length,
        bound,
        canBuildInStudio: environments.some((e) => e.registryLogin === true),
      }),
      builds: this.flowBuilds,
      deployments: this.flowDeployments,
      ...(this.flowError !== undefined ? { error: this.flowError } : {}),
      ...(!bound && profile !== undefined && this.environments.bind !== undefined ? { unbound: profile } : {}),
      binding: this.binding,
    };
  }

  protected renderDeploy(generated: boolean): React.ReactNode {
    const context = this.runContext();
    if (generated && context !== undefined) void this.askDeploy(context.cwd);
    const file = this.product.current.open?.path;
    if (file !== undefined) void this.askFlow(file);
    const flow = this.deployFlow();
    const place = this.deployPlace();
    const deploy = this.deploy;
    return (
      <DeployPanel
        onShowGenerate={() => void this.commands.executeCommand(SHOW_PRODUCT.id, "generate")}
        generated={generated}
        ready={deploy === undefined ? undefined : true}
        images={deploy?.script?.images ?? []}
        chart={deploy?.chart}
        registry={place.registry}
        namespace={place.namespace}
        docker={deploy?.docker === true}
        helm={deploy?.helm}
        environments={this.deployTargets?.environments ?? []}
        contexts={deploy?.contexts ?? []}
        target={this.deployTarget}
        onTarget={(next) => {
          this.deployTarget = next;
          this.deployNote = undefined;
          this.update();
        }}
        requesting={this.requestingDeploy}
        publishing={this.publishing}
        startingBuild={this.startingBuild}
        studioBuild={this.studioBuild !== undefined && this.deployTarget?.kind === "environment" && this.studioBuild.environmentId === this.deployTarget.id}
        {...(this.environments?.startBuild !== undefined ? { onBuildInStudio: () => void this.buildInStudio() } : {})}
        published={this.published !== undefined && this.deployTarget?.kind === "environment" && this.published.environmentId === this.deployTarget.id}
        {...(this.deployNote !== undefined ? { note: this.deployNote } : {})}
        onBuildImages={() => void this.buildImages()}
        onPush={() => {
          const environment = targetEnvironment(this.deployTargets, this.deployTarget);
          if (environment?.registryLogin === true && this.environments?.pushToken !== undefined) void this.publish();
          else void this.sendDeploy(this.deployCommandsFor()?.push ?? []);
        }}
        onTemplate={() => {
          const template = this.deployCommandsFor()?.template;
          if (template !== undefined) void this.sendDeploy([template]);
        }}
        onDeploy={() => void this.confirmDeploy()}
        {...(flow !== undefined ? { flow } : {})}
        onDeployBuild={(buildId) => void this.requestStudioBuildDeploy(buildId)}
        onBind={(environmentId) => void this.bindProfile(environmentId)}
        statuses={this.statuses}
        {...(this.environments?.status !== undefined && this.deployTargets?.organizationId !== undefined
          ? { onStatus: (id: string) => void this.readStatus(id) }
          : {})}
        onOpen={(url) => this.windows.openNewWindow(url, { external: true })}
        {...(this.deployTarget?.kind === "environment" && this.workflows[this.deployTarget.id] !== undefined
          ? { workflow: this.workflows[this.deployTarget.id] }
          : {})}
        proposingWorkflow={this.proposingWorkflow}
        {...(this.environments?.proposeBuildWorkflow !== undefined ? { onProposeWorkflow: () => void this.proposeWorkflow() } : {})}
        secrets={(this.deployTargets?.secrets ?? [])
          .filter((secret) => this.deployTarget?.kind === "environment" && secret.environmentId === this.deployTarget.id)
          .map((secret) => secret.key)}
        savingSecret={this.savingSecret}
        {...(this.environments?.configSecret !== undefined ? { onSecret: (key: string, value: string | undefined) => void this.configSecret(key, value) } : {})}
      />
    );
  }

  protected renderRun(plans: readonly FilePlan[]): React.ReactNode {
    const generated = this.isGenerated(plans);
    // A kubernetes profile runs in a cluster, not on this machine.
    if (this.kubernetes() !== undefined) return this.renderDeploy(generated);
    if (generated && this.toolchain === undefined) void this.askToolchain();
    const targets = this.runTargets();
    const chosen = this.chosenTarget(targets);
    return (
      <RunPanel
        generated={generated}
        verdict={this.toolchain === undefined ? undefined : toolchainVerdict(this.toolchain)}
        targets={targets}
        chosen={chosen}
        postgres={this.postgres}
        docker={this.toolchain?.docker === true}
        startingPostgres={this.startingPostgres}
        onChoose={(app) => {
          this.runApp = app;
          void this.probePostgres().then(() => this.update());
        }}
        onBuild={() => chosen !== undefined && void this.build(chosen)}
        onRun={() => chosen !== undefined && void this.run(chosen)}
        onLinkedGears={() => chosen !== undefined && void this.linkedGears(chosen)}
        onStartPostgres={() => chosen !== undefined && void this.startPostgres(chosen)}
        onOpen={(url) => this.windows.openNewWindow(url, { external: true })}
        onFetchProtoc={() => void this.fetchProtoc()}
        fetchingProtoc={this.fetchingProtoc}
        onCreateDatabases={() => chosen !== undefined && void this.createDatabases(chosen)}
        creatingDatabases={this.creatingDatabases}
      />
    );
  }

  /**
   * The profile this plan belongs to, and what its kind does not produce.
   *
   * **The condition is the engine's own, not a table repeated here.**
   * `docker::files` and `helm::files` both return nothing when
   * `lock.kubernetes.is_none()`, and that same field is on the resolution the
   * client already holds -- so this reads the fact rather than re-deriving it
   * from the profile kind. A future profile kind that gains images would light
   * this up without anyone remembering to edit it.
   */
  protected renderProfile(): React.ReactNode {
    const state = this.product.current;
    const profile = state.profile;
    if (profile === undefined) return undefined;
    const decl = state.intent?.profiles[profile];
    const kubernetes = state.resolution?.product?.kubernetes;
    const deploys = kubernetes !== undefined && kubernetes !== null;
    return (
      <div className="gbx-generate-profile" data-generate-profile={profile}>
        <span className="gbx-badge" title="deployment profile">
          {profile}
        </span>
        {decl !== undefined && <span className="gbx-id">{decl.profile}</span>}
        {!deploys && (
          <span className="gbx-generate-profile-note" data-generate-no-deployment>
            no images or chart: those come from a `kubernetes` profile
          </span>
        )}
      </div>
    );
  }

  protected render(): React.ReactNode {
    const caps = this.catalogue.engineCapabilities;
    if (caps !== undefined && !caps.generate) {
      return undefined;
    }

    const state = this.product.current;
    if (state.open === undefined || state.status !== "ready") {
      return (
        <div className="gbx-generate gbx-empty">
          Generate draws a <em>resolution</em>, so it needs a product and a
          profile. Open the Product view and it fills in.
        </div>
      );
    }

    if (this.generate.current.plan === undefined && this.generate.current.status !== "error") {
      void this.generate.ensurePlan();
    }

    const gen = this.generate.current;
    if (gen.status === "error") {
      // **A refusal is not a reason, and this screen used to show only the
      // refusal.** `resolution reported errors; nothing was generated` replaced
      // the entire widget: no profile, no list of which errors, and no control
      // of any kind -- so the correct decision not to generate arrived as a dead
      // end. The errors are already in the store, because the resolution is what
      // this screen draws from, so the reasons cost nothing to show.
      const errors = (state.resolution?.diagnostics ?? []).filter((d) => d.severity === "error");
      if (this.view === "deploy") {
        // Run & Deploy works on generated code: one line on why there is none,
        // and the way to the errors -- not a second copy of the list.
        return (
          <div className="gbx-generate" data-generate-view="deploy">
            {this.renderProfile()}
            <div className="gbx-generate-actions" data-deploy-state="resolution-errors">
              <span className="gbx-inline-error">
                Nothing to build or deploy yet: the product has {errors.length === 1 ? "an error" : `${errors.length} errors`}, so no code
                was generated.
              </span>
              <button
                type="button"
                className="gbx-choice"
                onClick={() => void this.commands.executeCommand(SHOW_PRODUCT.id, "checks")}
              >
                Show them in Checks
              </button>
            </div>
          </div>
        );
      }
      return (
        <div className="gbx-generate">
          {this.renderProfile()}
          <div className="gbx-error" role="alert">
            {gen.error}
          </div>
          {errors.length > 0 && (
            <>
              <div className="gbx-group-label">
                {errors.length === 1 ? "the error" : `the ${errors.length} errors`} that stopped it
              </div>
              <DiagnosticsList diagnostics={errors} density="compact" />
            </>
          )}
          <div className="gbx-generate-actions">
            {/* **To the object, not just to the view.** Landing on the Product
                view left a person to find, among the gears, the one the error is
                about. The first error names its subject, and `selectionOf` is
                the same reader the diagnostics rows use, so the trip ends on the
                thing that has to change with its settings already open.
                The profile is untouched on purpose: it lives in the store, and
                the errors being read are that profile's. */}
            <button
              type="button"
              className="gbx-start-primary"
              data-generate-to-product="true"
              onClick={() => {
                const subject = selectionOf(errors[0]?.subject);
                if (subject !== undefined) this.selection.select(subject);
                void this.commands.executeCommand(SHOW_PRODUCT.id, "composition");
              }}
            >
              {selectionOf(errors[0]?.subject) !== undefined
                ? "Fix it in the product"
                : "Open the Product view"}
            </button>
            <span className="gbx-waiting">
              Generation resumes on its own once the resolution has no errors.
            </span>
          </div>
        </div>
      );
    }
    if (gen.plan === undefined) {
      return <div className="gbx-generate gbx-empty">Planning generation…</div>;
    }

    const plans = gen.plan.plans;
    const counts = countByAction(plans);
    const blocks = this.edits.hasDraft()
      ? [...this.generate.blocks, { id: "draft", reason: "the product has unapplied changes: apply or discard them first" }]
      : this.generate.blocks;
    const selectedPlan = plans.find((p) => p.path === this.selected);

    if (this.view === "deploy") {
      return (
        <div className="gbx-generate" data-generate-view="deploy">
          {this.renderProfile()}
          {this.renderRun(plans)}
        </div>
      );
    }
    const generated = this.isGenerated(plans);

    return (
      <div className="gbx-generate" data-out-root={gen.plan.out_root} data-written={gen.written ?? ""}>
        <div className="gbx-generate-head">
          {/* **Which profile this plan is for.** The screen used to name no
              profile at all: the only identity it carried was `data-out-root`,
              an attribute nothing prints, so a plan for `dev` and a plan for
              `prod` were two file lists with no way to tell them apart. A
              Kubernetes profile writes a Dockerfile per image and a Helm
              umbrella chart and an embedded one writes neither, which makes the
              absence of `docker/` and `helm/` either correct or alarming
              depending on a fact the screen was keeping to itself.

              Named, not offered: the switch lives in the Product view, and the
              shell header follows the same rule -- it "shows the profile; it
              does not offer to change it". */}
          {this.renderProfile()}
          <div className="gbx-generate-counts">
            {(["create", "update", "unchanged", "conflict", "kept"] as const).map((action) =>
              (counts[action] ?? 0) > 0 ? (
                <span key={action} className="gbx-badge gbx-badge-count" data-count={action}>
                  {counts[action]} {action}
                </span>
              ) : undefined,
            )}
            {gen.written !== undefined && (
              <span className="gbx-badge gbx-badge-count" data-written-count={gen.written}>
                {gen.written} written
              </span>
            )}
            {/* An unexpected chart must have a visible cause. The engine has
                always known which builtins a product replaced; the RPC path
                dropped it, so this panel showed a house template and a stock one
                as the same thing. */}
            {(gen.plan.overridden_templates ?? []).length > 0 && (
              <span
                className="gbx-badge"
                data-overridden={(gen.plan.overridden_templates ?? []).join(",")}
                title={`Product templates replace: ${(gen.plan.overridden_templates ?? []).join(", ")}`}
              >
                {(gen.plan.overridden_templates ?? []).length} overridden
              </span>
            )}
          </div>
        </div>
        {/* **Its own row, and the house primary style.** This was a
            `gbx-choice gbx-choice-on` chip inside the head -- the class whose own
            comment in the stylesheet calls it the profile switch -- so the
            central action of the product looked like a small selected toggle. It
            also sat *after* `.gbx-generate-counts`, which is `flex: 1` in a
            `flex-wrap: wrap` row, so a wide enough badge row pushed it onto a
            second line at the left edge: the position of the one thing this
            screen is for depended on how many badges there happened to be.
            A row of its own is what makes that impossible.

            Under the head rather than at the bottom of the panel: the tree and
            the diff below both scroll, and a footer would leave the screen. */}
        <div className="gbx-generate-actions">
          <button
            className="gbx-start-primary"
            type="button"
            disabled={!this.generate.canApply || this.edits.hasDraft()}
            data-apply="true"
            onClick={() => void this.generate.apply()}
          >
            Apply
          </button>
          {/* Beside the button it explains, not two elements away from it. */}
          {blocks.length > 0 && (
            <ul className="gbx-generate-blocks">
              {blocks.map((block) => (
                <li key={block.id} data-apply-block={block.id}>
                  {block.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* Constructor Studio: what comes after Apply is the Run & Deploy
            stage of the product view (`setView`); here, only the way there. */}
        {generated && (
          <div className="gbx-generate-actions" data-generate-next>
            <span className="gbx-waiting">The code is on disk.</span>
            <button
              type="button"
              className="gbx-choice"
              data-generate-to-deploy
              onClick={() => void this.commands.executeCommand(SHOW_PRODUCT.id, "deploy")}
            >
              {this.kubernetes() !== undefined ? "Build and deploy it" : "Build and run it"} →
            </button>
          </div>
        )}
        <div className="gbx-generate-body">
          <div className="gbx-generate-tree" role="tree">
            {treeOf(plans).map((node) => this.renderNode(node, 0))}
          </div>
          <div className="gbx-generate-preview">
            {this.renderPreview(selectedPlan)}
          </div>
        </div>
      </div>
    );
  }

  protected renderNode(node: TreeNode, depth: number): React.ReactNode {
    const plan = node.plan;
    if (plan === undefined) {
      return (
        <div className="gbx-generate-dir" key={node.name} style={{ paddingLeft: depth * 14 }}>
          <div className="gbx-generate-dir-label">
            <span className="codicon codicon-folder" />
            {node.name}
          </div>
          {node.children.map((child) => this.renderNode(child, depth + 1))}
        </div>
      );
    }
    const on = this.selected === plan.path;
    return (
      <div
        className={`gbx-row ${on ? "gbx-selected" : ""}`}
        key={plan.path}
        role="treeitem"
        tabIndex={0}
        style={{ paddingLeft: 4 + depth * 14 }}
        data-plan-path={plan.path}
        data-action={plan.action}
        data-ownership={plan.ownership}
        aria-selected={on}
        onClick={() => void this.select(plan)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void this.select(plan);
          }
        }}
      >
        <span className={`gbx-leaf-icon codicon codicon-${ACTION_ICON[plan.action]}`} />
        <span className="gbx-row-name">{node.name}</span>
        <span className="gbx-badge" data-ownership={plan.ownership}>
          {plan.ownership}
        </span>
      </div>
    );
  }

  protected renderPreview(plan: FilePlan | undefined): React.ReactNode {
    if (plan === undefined) {
      return <div className="gbx-empty">Select a file to see the proposed content.</div>;
    }
    if (!plan.preview_available) {
      return (
        <div className="gbx-empty" data-preview-unavailable={plan.path}>
          `{plan.path}` is not text, so there is no preview to show. The plan
          still names it; applying will write the bytes.
        </div>
      );
    }
    if (this.previewing && this.selected === plan.path && this.preview === undefined) {
      return <div className="gbx-empty">Loading preview…</div>;
    }
    if (this.previewError !== undefined && this.selected === plan.path) {
      return (
        <div className="gbx-error" role="alert">
          {this.previewError}
        </div>
      );
    }
    if (this.preview === undefined || this.selected !== plan.path) {
      return <div className="gbx-empty">Select a file to see the proposed content.</div>;
    }
    return (
      <GenerateDiff
        original={this.preview.current ?? ""}
        modified={this.preview.proposed ?? ""}
        language={KIND_LANGUAGE[plan.kind]}
      />
    );
  }

  protected async select(plan: FilePlan): Promise<void> {
    this.selected = plan.path;
    this.preview = undefined;
    this.previewError = undefined;
    this.update();
    if (!plan.preview_available) {
      return;
    }
    this.previewing = true;
    try {
      this.preview = await this.generate.file(plan);
    } catch (error) {
      this.previewError = error instanceof Error ? error.message : String(error);
    } finally {
      this.previewing = false;
      this.update();
    }
  }
}

/**
 * A read-only Monaco diff of one planned file.
 *
 * Created here rather than opened as a Theia editor tab: the preview belongs
 * to this panel, and a tab would steal the Product view. Disposed on every
 * change of the two sides, because Monaco models are not cheap to leak.
 */
function GenerateDiff(props: { original: string; modified: string; language: string }): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = host.current;
    if (el === null) return undefined;
    const original = monaco.editor.createModel(props.original, props.language);
    const modified = monaco.editor.createModel(props.modified, props.language);
    const editor = monaco.editor.createDiffEditor(el, {
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
    });
    editor.setModel({ original, modified });
    return () => {
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [props.original, props.modified, props.language]);
  return <div className="gbx-generate-diff" ref={host} />;
}
