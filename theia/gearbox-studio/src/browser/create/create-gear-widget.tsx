// New Gear wizard — id / name / version / destination with a live FilePlan preview.
//
// ADR `cpt-gearbox-adr-authoring-ownership-tiers`: a preview is not optional.
// The right pane is `.gbx-file-plan`, the same shape generate uses, before any
// write.

import { ReactWidget } from "@theia/core/lib/browser";
import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";
import { FileDialogService } from "@theia/filesystem/lib/browser";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { GearboxService } from "../../common/protocol";
import { EngineConnectionService } from "../shell/engine-connection-service";
import { gearIdProblem, gearVersionProblem } from "../../common/gear-identity";
import { CommandRegistry } from "@theia/core/lib/common";

import type { GearKind } from "../../common/generated/GearKind";
import type { ProductEdit } from "../../common/generated/ProductEdit";
import { placeNewGear, type HostStanding } from "./gear-edits";
import { relativeTo, volumeOf } from "./paths";
import { UPSTREAM_SCAFFOLD_ISSUE, createGearGuidance, describeScaffoldRefusal } from "./create-gear-guidance";
import { pluginLocatorFor, type HostPoint, type LocatorOutcome } from "./plugin-locator";
import type { ScaffoldGearResult } from "../../common/generated/ScaffoldGearResult";
import { pointsOf } from "../../common/extension-points";
import { type Row } from "../../common/protocol";

import { SHOW_PRODUCT } from "../shell/session-command-ids";
import { CatalogueStore } from "../catalogue-store";
import { ProductEditService } from "../product-edit-service";
import { repaintNow } from "../widgets/repaint";
import { ProductStore } from "../product-store";
import { ProfileScope } from "../product/profile-scope";
import { plainPath } from "../../common/run-product";
import { GearLocator } from "../shell/gear-locator";
import { GearSessionService } from "../shell/gear-session-service";
import type { ContextIdentity, OwnedWidget } from "../shell/screens";

export interface CreateGearState {
  /**
   * The product this gear is being created for, when there is one.
   *
   * A path and a label: after scaffold the panel declares the new folder as a
   * source and adds the gear in one batch. A bare flag used to travel instead,
   * which is why the flow ended in a notification telling the person to add the
   * gear themselves.
   */
  id?: string;
  name?: string;
  version?: string;
  /** Parent folder; gear lands in `{destination}/{id}/`. */
  destinationDir?: string;
  readonly product?: { readonly path: string; readonly label: string };
  /** Which shape to preselect, when the caller has an opinion. */
  readonly kind?: GearKind;
}

@injectable()
export class CreateGearWidget extends ReactWidget implements OwnedWidget {
  static readonly ID = "gearbox.gear.create";
  static readonly LABEL = "New Gear";
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
  @inject(GearSessionService) protected readonly gears!: GearSessionService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;
  // Reached for the last step of a create-for-a-product: the batch that declares
  // the new folder as a source and adds the gear.
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
  // The same picker New Product uses. A destination typed into a text field is a
  // path nobody checked, and this wizard already knows the refusal it will get.
  @inject(FileDialogService) protected readonly fileDialog!: FileDialogService;
  @inject(GearLocator) protected readonly locator!: GearLocator;

  /**
   * Which shape to scaffold.
   *
   * `service` by default rather than `minimal`, and the corpus is the reason: of
   * the fourteen described gears, none is a bare crate with a name -- every one
   * either does something on its own or fills another gear's extension point. The
   * minimal shape is what this panel wrote before there were kinds, and it stays
   * for a crate that is being described before it does anything.
   */
  protected kind: GearKind = "service";

  protected gearId = "new-gear";
  protected name = "New Gear";
  protected version = "0.1.0";
  protected destination = "";
  protected destinationTouched = false;
  /**
   * The host and point a `plugin` scaffold fills, as `hostId::traitIdent`.
   *
   * Empty means no host chosen, which the engine reads as "keep the locator
   * commented" -- so the wizard has a state for "I know it is a plugin but not
   * yet whose", which is the state a person is in when they open this.
   */
  protected point = "";

  protected plan: ScaffoldGearResult | undefined;
  protected planError = "";
  protected previewTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Which preview request the pane is allowed to show.
   *
   * **A debounce without one lets a superseded answer win**, and it did: choosing
   * `plugin` and then a host fires three dry runs, and the pane showed whichever
   * *replied* last rather than whichever was *asked* last -- so the live locator
   * appeared and was then overwritten by the answer for `service`. The bug reads
   * as "the host picker does nothing", which is what a UX pass would report.
   *
   * The same guard `AddGearWidget` documents, for the same reason.
   */
  protected previewToken = 0;
  /**
   * A preview has been asked for and not yet answered.
   *
   * `plan === undefined` held Create only until the first answer; after that a
   * plan for the previous field values kept it live through the debounce and the
   * round trip, so a Create in that window acted on a preview the pane was about
   * to replace.
   */
  protected previewPending = false;
  /** The profiles a plugin created for a product is attached under; empty is all. */
  protected pluginProfiles: string[] = [];
  protected product: { path: string; label: string } | undefined;
  protected applying = false;

  @postConstruct()
  protected init(): void {
    this.id = CreateGearWidget.ID;
    this.title.label = CreateGearWidget.LABEL;
    this.title.closable = true;
    this.addClass("gbx-widget-create-gear");
    this.toDispose.push(this.engine.onDidChange(() => this.update()));
    // **The workspace may not be open yet, and the destination comes from it.**
    // `DomainWorkspace` opens the source roots asynchronously at startup, so a
    // widget built before that read `tryGetRoots()[0]` as `undefined`, defaulted
    // the destination to the empty string, and the scaffold dry run refused --
    // presenting as a New Gear screen with an error and no file plan. It used to
    // be hidden by timing: boot opened a product, which took long enough for the
    // roots to land first. Nothing about the destination should depend on that.
    this.toDispose.push(
      this.workspace.onWorkspaceChanged(() => {
        if (this.destinationTouched) return;
        const next = this.defaultDestination();
        if (next === this.destination) return;
        this.destination = next;
        void this.refreshPreview();
        void this.adoptProjectDestination();
      }),
    );
    this.destination = this.defaultDestination();
    void this.refreshPreview();
    void this.adoptProjectDestination();
  }

  /**
   * In a Studio session the workspace root holds checkouts -- the project's
   * repository and the gear corpus beside it -- so `<root>/gears` is in
   * neither. Once the checkouts are read, the default moves into the project's
   * own repository, beside its gears when it has some: the repository the
   * portal created the project's first gear in. Never over a typed path.
   */
  protected async adoptProjectDestination(): Promise<void> {
    const found = await this.locator.newGearDestination().catch(() => "");
    if (found === "" || this.destinationTouched || found === this.destination) return;
    this.destination = found;
    void this.refreshPreview();
    this.update();
  }

  openWith(state?: CreateGearState): void {
    if (state?.id !== undefined) this.gearId = state.id;
    if (state?.name !== undefined) this.name = state.name;
    if (state?.version !== undefined) this.version = state.version;
    this.kind = state?.kind ?? "service";
    this.product = state?.product === undefined ? undefined : { ...state.product };
    // A scope names one product's profiles; carried into another product's
    // wizard it would write a connection scoped to profiles that product lacks.
    this.pluginProfiles = [];
    this.destinationTouched = state?.destinationDir !== undefined;
    this.destination = state?.destinationDir ?? this.defaultDestination();
    void this.refreshPreview();
    this.update();
    void this.adoptProjectDestination();
  }

  protected workspaceRoot(): string {
    return this.workspace.tryGetRoots()[0]?.resource.path.fsPath().replace(/\\/g, "/") ?? "";
  }

  protected defaultDestination(): string {
    const root = this.workspaceRoot();
    return root === "" ? "" : `${root}/gears`;
  }

  protected destinationDir(): string {
    const trimmed = this.destination.trim();
    return (trimmed === "" ? this.defaultDestination() : trimmed).replace(/\\/g, "/");
  }

  /**
   * Every extension point the catalogue declares, with the gear that declares it.
   *
   * Read from the catalogue rather than asked for: a host's `extension_points`
   * are projected at S2, so by the time this panel is open they are a fact the
   * engine has already sent. `pointKey` is the identity -- `sdk_lib::TraitIdent`,
   * never a derived short name, for the reason `extension-points.ts` records.
   */
  protected hosts(): HostPoint[] {
    return this.catalogue.current.rows
      .filter((row): row is Extract<Row, { kind: "projected" }> => row.kind === "projected")
      .flatMap((row) =>
        pointsOf(row.gear).map((point) => ({
          host: row.gear,
          point,
          key: `${row.gear.id}::${point.trait_ident}`,
        })),
      );
  }

  /**
   * Whether the chosen host's `sdk` locator can be written, and what to say.
   *
   * **The decision is in `create/plugin-locator.ts`, and it used to be a
   * `PluginScaffold | undefined` here.** That shape collapsed four unrelated
   * refusals into one silent omission of the whole `plugin` field: the engine
   * then commented the locator, Create stayed enabled, and the picker had
   * already promised "the locator is written from this host". This reads the
   * widget's state and delegates; the arms below decide what is rendered and
   * whether Create is offered.
   */
  protected locatorOutcome(): LocatorOutcome {
    return pluginLocatorFor({
      isPlugin: this.kind === "plugin",
      pointKey: this.point,
      destinationDir: this.destinationDir(),
      gearId: this.gearId,
      hosts: this.hosts(),
      absolutePath: (source, relative) => this.catalogue.absolutePath(source, relative),
    });
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
    // Bumped here as well as in `refreshPreview`: an answer still in flight when
    // a field changes is already stale, and must not clear `previewPending`
    // during the debounce with a plan for the old values.
    this.previewToken += 1;
    this.previewPending = true;
    // Sent, not posted -- see `repaintNow`. `update()` posted the repaint, and
    // React put each controlled field back before it landed, so real typing
    // lost its keystrokes.
    repaintNow(this);
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.refreshPreview(), 200);
  }

  protected async refreshPreview(): Promise<void> {
    if (!this.engine.isConnected) {
      this.plan = undefined;
      this.planError = "";
      this.previewPending = false;
      this.update();
      return;
    }
    const token = ++this.previewToken;
    // One call, one local: asking twice let the two answers differ, which for a
    // decision this cheap is only a way for the preview to describe a request
    // that was not sent.
    const locator = this.locatorOutcome();
    try {
      const answer = await this.service.scaffoldGear({
        id: this.gearId,
        name: this.name,
        version: this.version,
        kind: this.kind,
        ...(locator.kind === "ready" ? { plugin: locator.scaffold } : {}),
        destinationDir: this.destinationDir(),
        dryRun: true,
      });
      if (token !== this.previewToken) return;
      this.plan = answer;
      this.planError = "";
    } catch (error) {
      if (token !== this.previewToken) return;
      this.plan = undefined;
      this.planError = describeScaffoldRefusal(error instanceof Error ? error.message : String(error));
    }
    this.previewPending = false;
    this.update();
  }

  /**
   * The batch that puts the new gear into the product.
   *
   * The decision itself is in `create/gear-edits.ts`, which is pure and is where
   * the three host states are checked; this reads the two facts that decide it
   * out of the store. `undefined` means refused, and the person has been told.
   */
  protected editsFor(gearId: string, sourceId: string, at: string): ProductEdit[] | undefined {
    const chosen = this.hosts().find((entry) => entry.key === this.point);
    const placed = placeNewGear(
      {
        gearId,
        sourceId,
        at,
        isPlugin: this.kind === "plugin",
        ...(this.kind === "plugin" && chosen !== undefined
          ? {
              host: {
                id: chosen.host.id,
                source: chosen.host.source,
                standing: this.standingOf(chosen.host.id),
              },
              profiles: this.pluginProfiles,
            }
          : {}),
      },
      this.product?.label ?? "This product",
    );
    if (!placed.ok) {
      this.messages.warn(placed.reason);
      return undefined;
    }
    return [...placed.edits];
  }

  /**
   * Why this gear cannot be put into the product it was started for, if it cannot.
   *
   * The same decision `editsFor` makes, asked before anything is written. `undefined`
   * when there is no product to add to -- a standalone gear is placed nowhere and
   * has nothing to refuse.
   */
  protected placementProblem(): string | undefined {
    if (this.product === undefined) return undefined;
    const at = relativeTo(this.product.path, this.destinationDir());
    if (at === undefined) return undefined;
    const chosen = this.hosts().find((entry) => entry.key === this.point);
    const placed = placeNewGear(
      {
        gearId: this.gearId,
        sourceId: sourceIdFor(at),
        at,
        isPlugin: this.kind === "plugin",
        ...(this.kind === "plugin" && chosen !== undefined
          ? {
              host: {
                id: chosen.host.id,
                source: chosen.host.source,
                standing: this.standingOf(chosen.host.id),
              },
            }
          : {}),
      },
      this.product.label,
    );
    return placed.ok ? undefined : placed.reason;
  }

  /**
   * Constructor Studio: the two things New Gear has to say before Create -- a
   * scaffold is not catalogued until its code carries `#[toolkit::gear]`, and a
   * plugin for a corpus host has to be moved into that corpus by hand.
   */
  protected renderGuidance(): React.ReactNode {
    const chosen = this.kind === "plugin" ? this.hosts().find((entry) => entry.key === this.point) : undefined;
    const gdl = chosen === undefined ? undefined : this.catalogue.absolutePath(chosen.host.source, chosen.host.gdl_path);
    const notes = createGearGuidance({
      kind: this.kind,
      addingToProduct: this.product !== undefined,
      gearId: this.gearId,
      destinationDir: this.destinationDir(),
      ...(chosen === undefined
        ? {}
        : { host: { id: chosen.host.id, dir: gdl === undefined ? undefined : gdl.replace(/[\\/][^\\/]*$/, "") } }),
    });
    return notes.map((note) => (
      <p key={note.id} className="gbx-create-note" data-create-gear-guidance={note.id}>
        {note.text}
      </p>
    ));
  }

  /**
   * Whether the product names a gear directly, only pulled it in, or lacks it.
   *
   * `selected_gears` is the intent -- what the description says -- and the
   * resolution's `gears` is the closure. The difference is the whole point:
   * `add_gear_plugin` needs a `use_gear` to attach to, and a closure entry is
   * not one.
   */
  protected standingOf(host: string): HostStanding {
    const state = this.products.current;
    if (state.intent?.selected_gears?.some((selected) => selected.gear === host) === true) {
      return "named";
    }
    const resolved = state.resolution?.product;
    if (resolved !== null && resolved !== undefined && host in resolved.gears) {
      return "closure-only";
    }
    return "absent";
  }

  /**
   * Which host and point this plugin fills.
   *
   * **The control that makes the kind mean something.** `Plugin` chose a
   * different `gear.gdl` all along, but every declaration in it was a comment
   * -- an `sdk` pointing nowhere makes a gear fail to load -- so choosing it
   * changed nothing a person could see. A host picked from the catalogue is a
   * locator the engine itself projected, so it can be written live, and the
   * preview changes as soon as it is chosen.
   *
   * Grouped by host and labelled by the trait, because the trait is the identity:
   * `pointKey` is `sdk_lib::TraitIdent` and never a derived short name, which is
   * the mistake GBX0206 exists to catch.
   */
  protected renderHostPicker(connected: boolean, locator: LocatorOutcome): React.ReactNode {
    const hosts = this.hosts();
    if (hosts.length === 0) {
      return (
        <div className="gbx-empty" data-create-gear-no-hosts>
          No gear in the catalogue declares an extension point, so there is nothing for a plugin
          to fill yet. Creating it will leave the <code>sdk</code> locator commented, which is
          what a scaffold writes when it has nothing real to point at.
        </div>
      );
    }
    const byHost = new Map<string, typeof hosts>();
    for (const entry of hosts) {
      const already = byHost.get(entry.host.id) ?? [];
      already.push(entry);
      byHost.set(entry.host.id, already);
    }
    return (
      <label>
        What it fills
        <select
          data-create-gear-point
          value={this.point}
          disabled={!connected}
          onChange={(e) => {
            this.point = e.target.value;
            // A scope belongs to one connection, and a different host is a
            // different connection.
            this.pluginProfiles = [];
            this.schedulePreview();
          }}
        >
          {/* An honest empty option: not choosing is a state, and it is the one
              a person starts in. Its consequence is stated below rather than
              hidden behind a disabled Create. */}
          <option value="">— not decided yet —</option>
          {[...byHost.entries()].map(([host, entries]) => (
            <optgroup key={host} label={host}>
              {entries.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.point.trait_ident}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {/* **Derived from the outcome, not from `this.point === ""`.** The
            second sentence below is a promise, and in the two states where the
            locator cannot be written it was a false one -- said in a note while
            the reason sat nowhere. Now the note speaks for the two states that
            have nothing to report, and the message under it speaks for the two
            that do. */}
        {locator.kind === "none" && (
          <span className="gbx-create-note">
            Without a host, `fills` is written as a comment: a spec no described gear declares
            is refused (GBX0519), so the declaration waits until you know what it fills.
          </span>
        )}
        {locator.kind === "ready" && (
          <span className="gbx-create-note">
            The locator is written from this host, and this plugin is attached to it in the
            product.
          </span>
        )}
        {/* **The same control the Add Gear dialog's two routes carry.** Attaching
            is writing a connection, and a connection is scoped; without this the
            plugin went in under every profile, beside whatever the host already
            runs there. */}
        {locator.kind === "ready" && this.product !== undefined && (
          <ProfileScope
            legend="Profiles for the new plugin's connection"
            profiles={this.pluginProfiles}
            available={Object.keys(this.products.current.intent?.profiles ?? {})}
            {...(this.products.current.profile === undefined
              ? {}
              : { viewing: this.products.current.profile })}
            onChange={(profiles) => {
              this.pluginProfiles = profiles;
              this.update();
            }}
          />
        )}
        {/* Beside the control that promised the locator, which is this one, and
            before anything is written. An engine refusal would arrive on the
            other side of the screen 400 ms later -- and for three of these four
            causes it would not arrive at all, because the request simply omits
            the field. */}
        {locator.kind === "blocked" && (
          <span className="gbx-inline-error" role="alert" data-create-gear-locator="blocked">
            {locator.reason}
          </span>
        )}
        {/* A note, not an error: an SDK on another volume has no relative path
            from here on any platform, so a commented locator is the honest
            answer and the crate is still worth writing. */}
        {locator.kind === "draft" && (
          <span className="gbx-inline-note" data-create-gear-locator="draft">
            {locator.reason}
            {this.product !== undefined &&
              ` ${this.product.label} is left untouched: a plugin whose locator is a comment ` +
                `cannot be attached to a host. Choose a destination on the SDK's volume to add it.`}
          </span>
        )}
      </label>
    );
  }

  /**
   * Pick the destination folder, rather than typing a path.
   *
   * The same dialog New Product uses for the same reason: a path typed into a
   * text field is a path nobody checked, and the wizard already knows the
   * refusal it will get. The field stays editable beside it -- a person who
   * knows the path should not have to click through a tree for it.
   */
  protected async browseDestination(): Promise<void> {
    const uri = await this.fileDialog.showOpenDialog({
      title: "Folder for the new gear",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    });
    if (uri === undefined) return;
    this.destination = uri.path.fsPath().replace(/\\/g, "/").replace(/\/+$/, "");
    this.destinationTouched = true;
    this.schedulePreview();
  }

  protected render(): React.ReactNode {
    const connected = this.engine.isConnected;
    const plans = this.plan?.plans ?? [];
    // Checked at the field, not only by the dry run. The engine refuses both --
    // and stays the boundary -- but its refusal arrived in the preview pane on
    // the other side of the screen, 400 ms after the keystroke, with no
    // indication of which field it was about.
    const idProblem = gearIdProblem(this.gearId);
    const versionProblem = gearVersionProblem(this.version);
    const placement = this.placementProblem();
    const locator = this.locatorOutcome();
    // Every kind, not only a plugin's locator: the engine joins a relative
    // destination to its own working directory, so a service or minimal gear
    // with one was written somewhere nobody chose. Refused there too.
    const destinationProblem =
      this.destinationDir() === ""
        ? "Choose a destination folder."
        : volumeOf(this.destinationDir()) === undefined
          ? `\`${this.destinationDir()}\` is not an absolute path. Choose a folder, or give its full path.`
          : undefined;
    return (
      <div className="gbx-create gbx-create-gear">
        <div className="gbx-create-form">
          <h2>New gear</h2>
          {/* **Whose product this is for.** The panel is reached two ways -- from
              Home, where a gear is a thing in its own right, and from a product,
              where it is a component of that product -- and it looked identical
              either way. What follows from the difference is the whole flow
              below: a gear created for a product is declared as a source and
              added to it, in one batch, and the panel returns there. */}
          {this.product !== undefined && (
            <p className="gbx-create-banner" data-create-gear-for={this.product.label}>
              Creating a gear for <strong>{this.product.label}</strong>. It will be added to that
              product when you create it.
            </p>
          )}
          {/* Beside the promise it qualifies, rather than as a message after a
              click: this is the reason the gear cannot go into that product, and
              it is knowable before anything is written. */}
          {placement !== undefined && (
            <div className="gbx-inline-error" role="alert" data-create-gear-placement>
              {placement}
            </div>
          )}
          {!connected && (
            <div className="gbx-error" role="alert" data-engine-status="disconnected">
              Engine disconnected: {this.engine.disconnectReason}. Preview and Create need the
              engine.
            </div>
          )}
          {/* First, because it decides what the rest of the file will say. Three
              shapes, and what differs is which declarations the description
              offers -- the preview on the right is the whole answer, which is
              why this control re-previews rather than explaining itself. */}
          <label>
            Kind
            <select
              data-create-gear-kind
              value={this.kind}
              disabled={!connected}
              onChange={(e) => {
                this.kind = e.target.value as GearKind;
                this.schedulePreview();
              }}
            >
              <option value="service">Service — a gear that does something</option>
              <option value="plugin">Plugin — fills another gear&apos;s extension point</option>
              <option value="minimal">Minimal — a crate and a name</option>
            </select>
          </label>
          {this.kind === "plugin" && this.renderHostPicker(connected, locator)}
          <label>
            Gear id
            <input
              data-create-gear-id
              value={this.gearId}
              disabled={!connected}
              aria-invalid={idProblem !== undefined ? true : undefined}
              onChange={(e) => {
                this.gearId = e.target.value;
                this.schedulePreview();
              }}
            />
            {idProblem !== undefined && (
              <span className="gbx-inline-error" role="alert" data-create-gear-id-error>
                {idProblem}
              </span>
            )}
          </label>
          <label>
            Name
            <input
              data-create-gear-name
              value={this.name}
              disabled={!connected}
              onChange={(e) => {
                this.name = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            Version
            <input
              data-create-gear-version
              value={this.version}
              disabled={!connected}
              aria-invalid={versionProblem !== undefined ? true : undefined}
              onChange={(e) => {
                this.version = e.target.value;
                this.schedulePreview();
              }}
            />
            {versionProblem !== undefined && (
              <span className="gbx-inline-error" role="alert" data-create-gear-version-error>
                {versionProblem}
              </span>
            )}
          </label>
          <label>
            Destination folder
            <span className="gbx-create-path">
              <input
                data-create-gear-destination
                value={this.destination}
                disabled={!connected}
                onChange={(e) => {
                  this.destinationTouched = true;
                  this.destination = e.target.value;
                  this.schedulePreview();
                }}
              />
              <button
                type="button"
                className="gbx-choice"
                data-create-gear-destination-browse
                disabled={!connected}
                onClick={() => void this.browseDestination()}
              >
                Choose…
              </button>
            </span>
          </label>
          <p className="gbx-create-sources-note">
            Writes <code>{this.destinationDir()}/{this.gearId}/</code> (gear.gdl, Cargo.toml,
            src/lib.rs). Must stay under the workspace and outside source roots.
          </p>
          {/* Constructor Studio: what the engine does not say until after the
              crate exists -- see `create-gear-guidance.ts`. */}
          {this.renderGuidance()}
          <p className="gbx-create-note gbx-create-note-upstream">
            These are engine limits, reported at{" "}
            <a href={UPSTREAM_SCAFFOLD_ISSUE} target="_blank" rel="noreferrer">
              gearbox#2
            </a>
            .
          </p>
          {destinationProblem !== undefined && (
            <p className="gbx-inline-error" role="alert" data-create-gear-destination-refusal>
              {destinationProblem}
            </p>
          )}
          <div className="gbx-create-actions">
            <button
              type="button"
              className="theia-button main"
              data-create-gear-submit
              // And on a placement that cannot happen. The banner above promises
              // the gear will be added to the product; a live Create over a
              // plugin with no host made that promise and then broke it after
              // writing the crate.
              //
              // A `blocked` locator joins them for the same reason: the crate
              // would be written with an `sdk` line the engine commented out,
              // which is a gear that cannot load. `draft` does not -- see the
              // label below.
              disabled={
              !connected ||
              this.applying ||
              this.previewPending ||
              this.plan === undefined ||
              idProblem !== undefined ||
              versionProblem !== undefined ||
              placement !== undefined ||
              destinationProblem !== undefined ||
              locator.kind === "blocked"
            }
              onClick={() => void this.create()}
            >
              {/* **The label says what the click does.** A cross-volume SDK
                  still produces a useful crate, so the action stays live -- but
                  the locator is a comment, and in a product the plugin is not
                  attached, because attaching one that cannot load would turn a
                  healthy product into a knowingly incomplete one. Calling that
                  `Create` would have been the same false promise the banner
                  used to make. */}
              {locator.kind !== "draft"
                ? "Create"
                : this.product === undefined
                  ? "Create draft"
                  : "Create without adding"}
            </button>
            <button
              type="button"
              className="theia-button secondary"
              data-create-gear-cancel
              onClick={() => this.close()}
            >
              Cancel
            </button>
          </div>
        </div>
        <div
          className="gbx-file-plan gbx-create-preview"
          data-preview-ready={
            connected && this.plan !== undefined && !this.previewPending ? "true" : "false"
          }
          aria-busy={this.previewPending}
        >
          {!connected && "Preview unavailable while the engine is disconnected."}
          {connected && this.planError !== "" && <div className="gbx-error">{this.planError}</div>}
          {/* A skeleton rather than the word "Planning…": three rows is what a
              scaffold always writes, so the shape of the answer is known before
              the answer is, and a pane that reserves the space does not jump when
              it arrives. `aria-busy` is what says it is not the answer yet. */}
          {connected && this.planError === "" && plans.length === 0 && (
            <div className="gbx-skeleton" aria-busy="true" data-create-gear-planning>
              <span className="gbx-skeleton-row" />
              <span className="gbx-skeleton-row" />
              <span className="gbx-skeleton-row" />
            </div>
          )}
          {connected &&
            plans.map((plan) => (
              <div
                key={plan.path}
                className="gbx-row"
                data-plan-path={plan.path}
                data-plan-blake3={plan.blake3}
                data-action={plan.action}
                data-ownership={plan.ownership}
              >
                <span className="gbx-badge" data-action={plan.action}>
                  {plan.action}
                </span>
                <span className="gbx-row-name">{plan.path}</span>
                <span className="gbx-badge" data-ownership={plan.ownership}>
                  {plan.ownership}
                </span>
              </div>
            ))}
          {connected && this.plan?.out_root !== undefined && (
            <div className="gbx-id" style={{ marginTop: 8 }}>
              → {plainPath(this.plan.out_root)}
            </div>
          )}
          {/* **The file the kind actually decides.** The three paths above are
              the same for all three shapes, so a preview of paths alone showed
              Service and Plugin as identical answers -- which a UX pass read as
              the choice doing nothing. What differs is this text, and it comes
              from the engine's own dry run rather than being reconstructed here:
              the same rule the Add Gear panel's "what will be written" follows. */}
          {connected && this.plan !== undefined && (
            <div className="gbx-create-gdl">
              <div className="gbx-impact-title">gear.gdl</div>
              <pre data-create-gear-gdl>{this.plan.gear_gdl}</pre>
            </div>
          )}
        </div>
      </div>
    );
  }

  /**
   * Declare the new gear's folder as a source of `product`, and add the gear.
   *
   * **Two edits, one batch, and the first one is not optional.** A scaffold
   * cannot land inside an existing source root -- `writable_out_root` refuses
   * that, because ADR `cpt-gearbox-adr-authoring-ownership-tiers` tier 5 keeps
   * the tool out of a corpus somebody else owns -- so a gear created for a
   * product is always in a directory that product does not read yet, and
   * `use_gear` cannot reach it. That is why this flow used to end in a
   * notification asking the person to fix the description by hand.
   *
   * The source id is derived from the folder rather than asked for: it is a
   * key inside one description, the folder is what it names, and one more
   * question in a form is one more thing to get wrong. `add_source` is
   * idempotent, so creating a second gear in the same folder adds only the gear.
   */
  protected async addToProduct(
    product: { path: string; label: string },
    gearId: string,
  ): Promise<void> {
    const at = relativeTo(product.path, this.destinationDir());
    if (at === undefined) {
      // Outside the description's own directory: `path(at = ...)` is resolved
      // against that directory, and a `../..` chain to somewhere unrelated is a
      // description nobody would have written. Said rather than guessed at.
      this.messages.warn(
        `${gearId} was created outside ${product.label}'s folder, so it was not added. ` +
          `Declare its directory as a source in the description to use it.`,
      );
      return;
    }
    const sourceId = sourceIdFor(at);
    const edits = this.editsFor(gearId, sourceId, at);
    if (edits === undefined) return;
    const added = await this.edits.applyProductEdits(product, edits, this.ownerIdentity);
    if (!added) {
      // **Said, not swallowed.** The scaffold succeeded and the description edit
      // did not, and the two are not a transaction -- so the crate exists and
      // nothing names it. The wizard promised "it will be added", and a silent
      // return would leave that promise looking kept.
      this.messages.warn(
        `${gearId} was created at ${this.destinationDir()}/${gearId}, but ${product.label} ` +
          `was not updated. Open the product and add it, or delete the folder.`,
      );
      return;
    }
    // Back where the flow started. The audit's phrasing: "after creating --
    // `Add this gear to Payments Demo` -- and a return to the Product
    // workspace". This is the return.
    void this.commands.executeCommand(SHOW_PRODUCT.id);
    // The catalogue has to read the new source root before the gear can be
    // resolved: `initialize` respawns the engine, and nothing watches the
    // filesystem (§9.1, "what is not watched").
    await this.catalogue.load();
    await this.products.reload();
  }

  protected async create(): Promise<void> {
    if (!this.engine.isConnected || this.applying) return;
    // **Before the scaffold, not after it.** `scaffoldGear` writes a crate to
    // disk; `applyProductEdits` refuses when the product this was started for is
    // no longer open. Checking only at the second one would leave the crate
    // behind with nothing naming it -- so the wizard asks first whether it is
    // still working on what it was opened for.
    if (!this.edits.ownsSubject(this.ownerIdentity)) return;
    // **Before the scaffold, like the owner check beside it.** The placement
    // refusal used to be computed after `scaffoldGear` had written the crate, so
    // a plugin with no host -- or one whose host the product does not use -- left
    // a directory on disk that nothing named. The wizard knows both answers
    // before it writes; asking afterwards is what made the promise in the banner
    // false.
    const blocked = this.placementProblem();
    if (blocked !== undefined) {
      this.messages.warn(blocked);
      return;
    }
    // **The same reason, one field over.** A `blocked` locator means the crate
    // would land with its `sdk` line commented out -- a gear that cannot load --
    // and asking afterwards leaves that on disk. The button is already disabled
    // on this; the guard is here because `create()` is also the commit point and
    // the catalogue can reload between a render and a click.
    const locator = this.locatorOutcome();
    if (locator.kind === "blocked") {
      this.messages.warn(locator.reason);
      return;
    }
    this.applying = true;
    this.update();
    try {
      // The same request the preview made, `dry_run` apart. Sending a different
      // one would make the preview a description of something else, which is the
      // rule ADR `cpt-gearbox-adr-authoring-ownership-tiers` states as "a
      // preview is not optional".
      const result = await this.service.scaffoldGear({
        id: this.gearId,
        name: this.name,
        version: this.version,
        kind: this.kind,
        ...(locator.kind === "ready" ? { plugin: locator.scaffold } : {}),
        destinationDir: this.destinationDir(),
        dryRun: false,
      });
      const root = result.out_root;
      const product = this.product;
      const gearId = this.gearId;
      this.messages.info(`Created gear at ${root}`);
      this.close();
      // **A draft is not added, and the button said so.** Its `sdk` locator is a
      // comment, so `add_gear_plugin` would attach a plugin that cannot load to
      // a host that is otherwise fine -- a healthy product made knowingly
      // incomplete by a step the person did not ask for.
      if (locator.kind === "draft") {
        if (product !== undefined) {
          this.messages.warn(
            `${gearId} was created at ${root} as a draft, and ${product.label} was left ` +
              `unchanged: its sdk locator is a comment. Move the gear to the SDK's volume, ` +
              `then add it from the product.`,
          );
        }
        await this.gears.openGear(root);
        return;
      }
      if (product !== undefined) {
        await this.addToProduct(product, gearId);
        return;
      }
      await this.gears.openGear(root);
    } catch (error) {
      this.messages.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.applying = false;
      this.update();
    }
  }
}

/**
 * `to` expressed relative to the directory holding `descriptionPath`.
 *
 * `undefined` when `to` is not inside that directory: `path(at = ...)` resolves
 * against the description's own folder, and this is the one case where writing a
 * `../..` chain would be describing a layout nobody chose.
 *
 * Hand-rolled because the browser has no `path`, and the inputs are POSIX
 * absolute paths -- the same reason `resolveFrom` in `ProductSessionService` is.
 */
/**
 * A source id for a folder: its last segment, kebab-cased.
 *
 * `SourceId` is kebab-case (`gears-rust` is the corpus's own), and the engine
 * refuses anything else -- so this produces a name the description can hold and
 * a person can recognise, rather than asking for one.
 */
function sourceIdFor(at: string): string {
  const segment = at.split("/").filter((part) => part !== "" && part !== ".").pop() ?? "local";
  const kebab = segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab === "" || !/^[a-z]/.test(kebab) ? `local-${kebab || "gears"}` : kebab;
}
