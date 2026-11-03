// One product, resolved for one profile.
//
// The clause this answers is "edits and resolves a product across profiles"
// (`cpt-gearbox-fr-studio`). The *editing* is the `.gdl` editor Theia already
// gives us -- there is no form here on purpose, because a form would be a second
// way to express a description and the two would drift. What the panel adds is
// the half a text editor cannot show: what the description *resolves to*, and how
// that answer differs between profiles.
//
// The profile switch is the centre of it. One description, three profiles, three
// distinct locks -- and every difference visible without editing anything, which
// is the property `profiles = [...]` as a data field exists to buy.

import { codicon, ContextMenuRenderer, ReactWidget } from "@theia/core/lib/browser";
import { CommandRegistry } from "@theia/core/lib/common";
import { QuickInputService, type QuickPickItem } from "@theia/core/lib/common/quick-pick-service";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import { Widget, WidgetManager } from "@theia/core/lib/browser";
import React from "@theia/core/shared/react";

import type { Choice } from "../../common/generated/Choice";
import type { DeploymentProfileDecl } from "../../common/generated/DeploymentProfileDecl";
import type { ClusterResolution } from "../../common/generated/ClusterResolution";
import type { Diagnostic } from "../../common/generated/Diagnostic";
import type { Discovery } from "../../common/generated/Discovery";
import type { ResolvedBinding } from "../../common/generated/ResolvedBinding";
import type { ResolvedApplication } from "../../common/generated/ResolvedApplication";
import type { ResolvedClusterBinding } from "../../common/generated/ResolvedClusterBinding";
import type { ResolvedProduct } from "../../common/generated/ResolvedProduct";
import { GearboxService, type ProductRef } from "../../common/protocol";
import { staleCorpusSource, type CorpusCopy } from "../create/corpus-source";
import {
  DiagnosticsList,
  errorsIn,
  worstFirst,
  worstOf,
} from "../diagnostics/diagnostics-list";
import { CatalogueStore } from "../catalogue-store";
import { Composition } from "./composition";
import { GearBlurb, GearDocs, GearHeading, InclusionReasons } from "../gear/gear-facts";
import { GearSettings } from "./gear-settings";
import { PluginSettings } from "./plugin-settings";
import { ConfigFields } from "../add-gear/config-fields";
import { ProductStore, type Staleness } from "../product-store";
import { GenerateService } from "../generate/generate-service";
import { ProductEditService } from "../product-edit-service";
import { PendingCreateGear } from "../create/pending-create-gear";
import {
  OPENING_LABEL,
  OPENING_STAGES,
  ProductSessionService,
  projectionProgress,
  type OpeningState,
} from "../shell/product-session-service";
import {
  ADD_GEAR,
  NEW_GEAR,
  NEW_PRODUCT,
  OPEN_PRODUCT,
  SHOW_GENERATE,
} from "../shell/session-command-ids";
import { EngineConnectionService } from "../shell/engine-connection-service";
import type { RecentEntry } from "../shell/product-session-service";
import { ProductEmptyState, emptyStateLists } from "./product-empty-state";
import {
  ProductStatusStrip,
  draftStateOf,
  healthLabel,
  plural,
  productStatusOf,
  type ProductStatusBadge,
} from "./product-status-strip";
import { nextStepOf, profileLabel } from "./product-summary";
import { GearboxMenus } from "../menus";
import type { OpeningStage } from "../shell/opening-outcome";
import { RevealPathLink } from "../reveal-link";
import { RevealService } from "../reveal-service";
import { SelectionService, type Selection } from "../shell/selection-service";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import type { GearSelection } from "../../common/generated/GearSelection";
import type { InclusionReason } from "../../common/generated/InclusionReason";
import { pointKey, pointsOf } from "../../common/extension-points";
import type { Message } from "@theia/core/shared/@lumino/messaging";

/** One product workspace; old section names remain accepted by command adapters. */
export type ProductSection = "composition" | "topology" | "checks" | "generate" | "deploy" | "settings";
export type ProductSectionInput = ProductSection | "overview" | "validation";
const SECTIONS: readonly { readonly id: ProductSection; readonly label: string }[] = [
  { id: "composition", label: "Composition" },
  { id: "topology", label: "Topology" },
  { id: "checks", label: "Checks" },
  { id: "generate", label: "Generate" },
  // Constructor Studio: what comes after Generate -- build, run, deploy --
  // drawn by the same Generate widget (`setView`), on a stage of its own.
  { id: "deploy", label: "Run & Deploy" },
];

@injectable()
export class ProductWidget extends ReactWidget {
  static readonly ID = "gearbox.product";
  static readonly LABEL = "Gearbox Product";

  @inject(ProductStore) protected readonly store!: ProductStore;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  // Opening is the session's, not the store's: it decides the engine's roots and
  // write boundary, which is what makes a product outside this checkout editable.
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(RevealService) protected readonly reveals!: RevealService;
  // Read only. Overview reports whether a plan exists; it never asks for one --
  // see `renderGenerationStatus`.
  @inject(GenerateService) protected readonly generate!: GenerateService;
  /**
   * Constructor Studio: Generate is a section of this view, and the section is
   * the Generate widget itself -- its plan, Apply, Build and Run, Deploy --
   * attached here rather than rewritten as a component, so the one view keeps
   * every path it has (`mountGenerate`).
   */
  @inject(WidgetManager) protected readonly widgets!: WidgetManager;
  protected generateWidget: Widget | undefined;
  // For the `explain` control on a diagnostic row: `Diagnostic.subject` names a
  // graph node so that a client can select it, and the Inspector is what answers
  // about a selection.
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(PendingCreateGear) protected readonly pendingGear!: PendingCreateGear;
  // Constructor Studio: Apply needs the engine, and the strip says so.
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;
  @inject(GearboxService) protected readonly gearbox!: GearboxService;
  // Constructor Studio: the head's "⋯" menu and its profile switch.
  @inject(ContextMenuRenderer) protected readonly contextMenu!: ContextMenuRenderer;
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService;

  /** Constructor Studio: the corpus copy Studio adopted, asked once per open product. */
  protected corpusCopy: CorpusCopy | undefined;
  protected corpusCopyFor: string | undefined;
  /** Constructor Studio: the branch the open description is on, asked once per open product. */
  protected checkout: { branch: string; root: string; worktreeOf?: string } | undefined;

  /**
   * Constructor Studio: Recent products, for the empty state. Held rather than
   * read in `render`, as the Start screen holds them: `recentEntries()` goes to
   * `StorageService`, and a render that starts a promise starts one per frame.
   */
  protected recent: readonly RecentEntry[] = [];

  /** Which branches are folded away. Widget state; nobody else's business. */
  protected collapsed = new Set<string>();
  /**
   * Which Composition hosts are folded shut.
   *
   * A second set rather than a prefix in `collapsed`: the two trees fold
   * different things -- a topology branch is an application, a composition host
   * is a gear -- and one id can legitimately be both.
   */
  protected expandedHosts = new Set<string>();
  protected generateVisited = false;
  /**
   * What the Composition pane is about.
   *
   * The last selection made *in this product* -- a gear in the tree, a
   * connection under it, a diagnostic's subject. Deliberately not
   * `SelectionService.current`: that also carries what is selected in the
   * catalogue, and this pane is not about the catalogue.
   */
  protected productSelection: Selection | undefined;

  /**
   * Which stage of the product a person is looking at.
   *
   * The panel had grown to the whole product on one strip -- header, profile
   * switch, profile fields, four foldable branches and a diagnostics line -- and
   * a UX pass reported it as a very long screen with no sense of where one is.
   * The four names are the stages of composing a product: what it *is*, what it
   * is *made of*, how that *deploys*, and what is *wrong with it*. Generate is
   * the fifth stage and stays a view of its own; the strip links to it rather
   * than reproducing a file plan and an Apply button in two places.
   *
   * Folds are kept underneath: a section with three applications and eight bindings
   * still wants them, and the two mechanisms answer different questions --
   * "which stage" and "how much of this stage".
   */
  protected section: ProductSection = "composition";

  /**
   * The product whose errors have already chosen a stage.
   *
   * Keyed on the open product's path, so the landing below happens when a
   * product arrives and not again while it is being worked on.
   *
   * **Per resolution was the obvious key and it was wrong.** `ProductStore`
   * bumps its revision on every piece of work it starts, and editing a
   * description is a stream of them -- so a draft that momentarily resolved with
   * an error moved the stage out from under someone who was typing into it.
   * `adr-0013-create-product` caught it: the config key input went from visible
   * to detached mid-`fill`, and the failure read as a timeout on an element that
   * was plainly there. Arriving at a product is the event this is about.
   */
  protected stagedFor: string | undefined;
  protected addingProfile = false;
  protected newProfileId = "";
  protected newProfileHost = "";
  protected newProfileDiscovery = "static";
  protected newProfileKind: "embedded" | "self_hosted" | "kubernetes" = "embedded";

  @postConstruct()
  protected init(): void {
    this.toDispose.push(
      this.selection.onDidChange((current) => {
        // **Only a selection made in this product moves the settings pane.**
        // A catalogue click is a different act (`catalogue-gear`), and letting
        // it through replaced the form a person was working in with a card
        // about a gear they had merely looked up. The wrong *explanation* was
        // the first half of that defect; this is the other half -- independence
        // of the two selections, not just honesty about them.
        if (current === undefined || current.kind === "gear" || current.kind === "plugin") {
          this.productSelection = current;
        }
        this.update();
      }),
    );
    this.toDispose.push(this.catalogue.onChanged(() => this.update()));
    this.id = ProductWidget.ID;
    this.title.label = ProductWidget.LABEL;
    this.title.iconClass = codicon("project");
    this.title.caption = ProductWidget.LABEL;
    this.title.closable = true;
    this.addClass("gbx-widget-product");
    this.toDispose.push(
      this.store.onChanged(() => {
        this.stageForOpenProduct();
        this.update();
      }),
    );
    this.toDispose.push(this.edits.onDraftChanged(() => this.update()));
    // Constructor Studio: the status strip's Apply and the head's actions follow
    // the engine and the registry, and Theia re-asks neither on its own.
    this.toDispose.push(this.engine.onDidChange(() => this.update()));
    this.toDispose.push(this.commands.onCommandsChanged(() => this.update()));
    // The empty state's Recent list: re-read when a product opens or closes,
    // which is when the list changes.
    this.toDispose.push(this.store.onChanged(() => this.refreshRecent()));
    this.refreshRecent();
    // Overview reports whether a generated tree exists, so it has to hear when
    // that answer changes -- a plan arriving, an apply writing, or the plan being
    // dropped as stale. Subscribing rather than polling, and reading rather than
    // asking: see `renderGenerationStatus`.
    this.toDispose.push(this.generate.onChanged(() => this.update()));
    // An open takes two engine spawns; without this the panel renders its
    // "choose a product" list for three seconds while one is already opening.
    this.toDispose.push(this.session.onDidChangeOpening(() => this.update()));
    // **Constructing this panel no longer opens a product.** It used to call
    // `session.ensureOpen()`, which opened the only product it could find -- so
    // the application effectively had no Home: a reload, or anything that built
    // this widget, put a product back on screen with nobody having asked for one.
    // Home is a deliberate starting point now, and a product arrives by an
    // explicit act: the Continue card, the picker, or `File > Open Product...`.
    //
    // **Staged before the first render, not only on the next store event.** The
    // subscription above covers the common path, where this panel exists and a
    // product arrives afterwards. It does not cover a panel built while a
    // product is *already* resolved -- closing and reopening the Product view --
    // because no store event follows, and the widget would sit on Overview with
    // the errors one tab away. Idempotent by the guards inside: `stagedFor`
    // fires once per open product.
    this.stageForOpenProduct();
    this.update();
  }

  /**
   * A newly opened product starts on Composition.
   *
   * **This used to move to Validation when the resolution carried errors, and
   * deliberately no longer does.** Sending someone to a list of problems is the
   * right answer when the screen they came from cannot show them anything; it is
   * the wrong one now that the screen they came from *is* the product. An error
   * does not stop a product having a composition, and a person who opened a
   * product asked to see the product. The count on the Validation tab and the
   * summary line are the way there, and they name the object, so the trip is
   * chosen rather than imposed.
   *
   * **Once per product, not once per store event.** Keyed on the open path, so a
   * re-resolve, a profile switch or an Apply cannot pull the stage out from
   * under someone mid-edit. Reopening the panel over a product that is already
   * resolved runs this too -- no store event follows that, and the widget would
   * otherwise come back on whatever stage the field initialiser named.
   *
   * Idempotent by the `stagedFor` guard, so both call sites can be unconditional.
   */
  protected stageForOpenProduct(): void {
    const path = this.store.current.open?.path;
    if (path !== this.stagedFor) {
      this.stagedFor = path;
      this.section = "composition";
      this.productSelection = undefined;
      this.expandedHosts.clear();
      this.generateVisited = false;
    }
  }

  /**
   * How many diagnostics the Validation stage holds, and how bad the worst is.
   *
   * **A signpost, not a second summary.** The list, the per-severity counts and
   * the explain controls all already live on that stage; what was missing was
   * any reason to go there. The strip drew four bare labels, Overview reported
   * no number at all, and the one visible affordance -- `Show conflicts` -- sent
   * a person to a separate panel at the bottom rather than to the stage that
   * answers the same question in place.
   *
   * Nothing when there is nothing: a tab that always carries a `0` trains the
   * reader to stop seeing it, which is the same argument that keeps the
   * Conflicts panel from opening at startup to say "no conflicts".
   */
  protected renderStageCount(
    diagnostics: readonly Diagnostic[],
    stale: Staleness | undefined,
  ): React.ReactNode {
    // **Silence is an answer here, and it was the wrong one.** A failed
    // resolution clears the list, so the count simply vanished -- and a tab with
    // no badge is how this panel says "nothing to report". Measured: three
    // problems before the timeout, no badge after it, with the engine dead and
    // nothing re-read. The badge now says it does not know.
    if (stale !== undefined) {
      return (
        <span
          className="gbx-stage-count gbx-stage-count-stale"
          data-validation-stale
          title="These counts are from before the engine stopped answering. Reconnect to re-read."
        >
          —
        </span>
      );
    }
    if (diagnostics.length === 0) return undefined;
    const errors = errorsIn(diagnostics);
    const warnings = diagnostics.filter(d => d.severity === "warning").length;
    return <span className="gbx-check-counts" data-validation-count={diagnostics.length}
      data-validation-worst={worstOf(diagnostics) ?? "info"}>
      {errors > 0 && <span className="gbx-stage-count gbx-stage-count-error" aria-label={plural(errors, "error", "errors")}>{plural(errors, "error", "errors")}</span>}
      {warnings > 0 && <span className="gbx-stage-count gbx-stage-count-warning" aria-label={plural(warnings, "warning", "warnings")}>{plural(warnings, "warning", "warnings")}</span>}
      {errors === 0 && warnings === 0 && <span className="gbx-stage-count gbx-stage-count-info">{plural(diagnostics.length, "note", "notes")}</span>}
    </span>;
  }

  /**
   * The Conflicts screen, by command, so the panel does not have to be injected.
   *
   * `SHOW_CONFLICTS`, not the view toggle: a summary line that hides the screen
   * when clicked is the defect `BROWSE_CATALOGUE` was introduced to avoid, and
   * here the thing being hidden is the reason the line exists.
   */
  protected showConflicts(): void {
    this.showSection("checks");
  }

  /** New Gear with destination under this product, then Add Gear for selection. */
  /**
   * New Gear, for *this* product.
   *
   * The product travels as a path and a label. A bare flag used to be the whole
   * context, so the panel knew a product existed and nothing about which one --
   * which is why the flow used to end in a notification asking the person to add
   * the gear themselves.
   */
  protected createGearForProduct(): void {
    const open = this.store.current.open;
    if (open === undefined) return;
    const productDir = open.path.replace(/\/[^/]+$/, "");
    this.pendingGear.state = {
      destinationDir: `${productDir}/gears`,
      product: { path: open.path, label: this.store.current.intent?.display_name ?? open.label },
    };
    void this.commands.executeCommand(NEW_GEAR.id);
  }

  /**
   * Constructor Studio: re-read Recent, and repaint only when it changed -- the
   * store fires often while a product resolves, and the list rarely moves.
   */
  protected refreshRecent(): void {
    void this.session.recentEntries().then((recent) => {
      const same =
        recent.length === this.recent.length &&
        recent.every((entry, index) => entry.path === this.recent[index]?.path);
      if (same) return;
      this.recent = recent;
      this.update();
    });
  }

  /**
   * Constructor Studio: the product's health, as the head's pill and the
   * summary band both draw it -- one call, so the two cannot disagree.
   */
  protected statusBadge(): ProductStatusBadge {
    const state = this.store.current;
    return productStatusOf(
      state.status,
      errorsIn(state.diagnostics),
      state.resolution?.product?.product?.lock_hash !== undefined,
      state.diagnostics.filter((d) => d.severity === "warning").length,
      state.stale !== undefined,
    );
  }

  /**
   * Constructor Studio: the product's health and the draft -- see
   * `product-status-strip.tsx`. Resolve and Close used to sit beside them as
   * buttons; they are in the "⋯" menu now (`openProductMenu`), so no actions.
   */
  protected renderStatusStrip(): React.ReactNode {
    const state = this.store.current;
    return (
      <ProductStatusStrip
        status={this.statusBadge()}
        draft={draftStateOf({
          count: this.edits.draftEdits().length,
          writeUnknown: state.stale?.writeUnknown === true,
          engineConnected: this.engine.isConnected,
          busy: state.status === "loading" || state.status === "resolving",
        })}
        actions={[]}
        onApply={() => void this.edits.applyDraft()}
        onDiscard={() => this.edits.discardDraft()}
        onShowConflicts={() => this.showConflicts()}
        onRun={(id) => void this.commands.executeCommand(id)}
      />
    );
  }

  /**
   * The "⋯" menu: a registered Theia menu (`GearboxMenus.PRODUCT_ACTIONS`),
   * drawn by `ContextMenuRenderer` under the button.
   *
   * It replaces a `<details>` popup of plain buttons, which neither the
   * keyboard nor a screen reader treated as a menu, and which stayed open
   * after a click unless each button remembered to close it. Theia's renderer
   * gives arrow keys, Escape, icons and separators, and on the desktop the
   * native menu where Theia uses one.
   */
  protected openProductMenu(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    this.contextMenu.render({
      menuPath: GearboxMenus.PRODUCT_ACTIONS,
      anchor: { x: rect.left, y: rect.bottom },
      context: anchor,
      includeAnchorArg: false,
    });
  }

  /**
   * The profile switch, as a quick pick rather than a native `<select>`.
   *
   * A pick is keyboard-first and wide enough to say what each profile *is* --
   * `local · processes on one host`, the portal's words -- where the select had
   * room for the id alone. It also ends with Add profile, which is where a
   * person looking for a profile that is not there already is.
   */
  protected async pickProfile(): Promise<void> {
    const intent = this.store.current.intent;
    if (intent === undefined) return;
    const current = this.store.current.profile;
    type Item = QuickPickItem & { readonly profile?: string; readonly add?: true };
    const profiles: Item[] = Object.entries(intent.profiles).map(([id, decl]) => ({
      label: profileLabel(id, decl.profile),
      description: [id === intent.default_profile ? "default" : "", id === current ? "current" : ""]
        .filter((word) => word !== "")
        .join(", "),
      profile: id,
    }));
    const chosen = await this.quickInput.showQuickPick<Item>(
      [...profiles, { type: "separator" }, { label: "Add profile…", add: true }],
      {
        placeholder: "Deployment profile",
        activeItem: profiles.find((item) => item.profile === current),
      },
    );
    if (chosen === undefined) return;
    if (chosen.add) {
      this.startAddProfile();
      return;
    }
    if (chosen.profile !== undefined && chosen.profile !== current) {
      await this.store.setProfile(chosen.profile);
    }
  }

  /** Open the Add profile form, on the settings stage where profiles are edited. */
  public startAddProfile(): void {
    this.addingProfile = true;
    this.newProfileId = "";
    this.newProfileKind = "embedded";
    this.newProfileHost = "";
    this.newProfileDiscovery = "static";
    this.showSection("settings");
  }

  /** The open product's description, in the editor. */
  public openDescription(): void {
    const path = this.store.current.open?.path;
    if (path !== undefined) void this.reveals.revealPath(path);
  }

  /**
   * Constructor Studio: a product reading an older copy of the corpus than the
   * one Studio has, said where the product is: its gears load from there, and
   * after an engine update a stale corpus is why none of them does. The engine
   * cannot repoint a source yet (`remove_source` refuses one a gear reads), so
   * this names the one line to change and opens it, rather than rewriting the
   * description behind the engine (constructorfabric/gearbox#8).
   */
  protected renderStaleCorpus(): React.ReactNode {
    const state = this.store.current;
    const path = state.open?.path;
    if (path !== undefined && this.corpusCopyFor !== path) {
      this.corpusCopyFor = path;
      void this.gearbox.corpusCopy().then(
        (copy) => {
          this.corpusCopy = copy;
          this.update();
        },
        () => undefined,
      );
      this.checkout = undefined;
      void this.gearbox.checkoutOfFile(path).then(
        (checkout) => {
          this.checkout = checkout;
          this.update();
        },
        () => undefined,
      );
    }
    const stale = staleCorpusSource(state.intent?.sources, this.corpusCopy);
    if (stale === undefined) return null;
    const declaredAt = stale.declaredAt;
    return (
      <div className="gbx-stale-corpus" role="status" data-stale-corpus={stale.id}>
        <p>
          This product reads <code>{stale.id}</code> from an older copy of the corpus (
          <code>{stale.declaredCommit}</code>); Studio has <code>{stale.currentCommit}</code>. Gears described for
          another engine may not load. Change the source&apos;s path in the description to{" "}
          <code data-stale-corpus-current>{stale.current}</code>.
        </p>
        {declaredAt ? (
          <button type="button" className="gbx-choice" data-stale-corpus-open onClick={() => void this.reveals.revealLocation(declaredAt)}>
            Open the source line
          </button>
        ) : null}{" "}
        <button type="button" className="gbx-choice" data-stale-corpus-copy onClick={() => void navigator.clipboard?.writeText(stale.current)}>
          Copy the path
        </button>
      </div>
    );
  }

  /**
   * Constructor Studio: which branch the open description is on. The status
   * bar shows the branch of the checkout the IDE's Git selects; a product the
   * portal saved on its own branch is brought into a worktree beside a
   * checkout that has uncommitted work, and then the two differ -- the bar
   * said `main*` while the product came from `product/…`.
   *
   * **A chip, and the worktree's story in its tooltip.** The sentence that used
   * to follow the branch -- which worktree, beside which checkout, and why the
   * status bar disagrees -- is true and rarely wanted, and it read as a
   * paragraph in the product's title line. The chip says where; hovering it
   * says why.
   */
  protected renderCheckout(): React.ReactNode {
    const checkout = this.checkout;
    if (checkout === undefined) return null;
    const base = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p;
    const worktreeOf = checkout.worktreeOf;
    const title =
      worktreeOf === undefined
        ? `On branch ${checkout.branch}`
        : `On branch ${checkout.branch}, in the worktree ${base(checkout.root)} beside ${base(worktreeOf)}. ` +
          `The status bar shows ${base(worktreeOf)}'s own branch.`;
    return (
      <span className="gbx-product-checkout gbx-meta-chip" data-product-branch={checkout.branch} title={title}>
        <span className="codicon codicon-git-branch" aria-hidden />
        <span>{checkout.branch}</span>
        {worktreeOf !== undefined && (
          <span className="gbx-product-worktree" data-product-worktree={base(checkout.root)}>
            · worktree
          </span>
        )}
      </span>
    );
  }

  /** Generate, by command that opens rather than toggles -- see `SHOW_GENERATE`. */
  protected showGenerate(): void {
    void this.commands.executeCommand(SHOW_GENERATE.id);
  }

  /**
   * Leave a refused open, and put the session back where it was.
   *
   * **Re-opening, not merely dismissing, and the difference is not cosmetic.**
   * The first step of an open re-initializes the engine on the *new* product's
   * folder -- that is what the `workspace` step is -- so a refusal at `describe`
   * or `catalogue` leaves the store holding A while the engine is pointed at B.
   * Clearing the screen alone would show A looking perfectly healthy while
   * Resolve, an edit and Generate all went through a session configured for a
   * product that never opened, with B's write boundary.
   *
   * So the way out of a refusal is the same act as opening A in the first place:
   * it re-runs the four steps and the engine ends up where the screen says it is.
   * With no previous product there is no session to restore and dismissing is the
   * whole of it.
   */
  protected leaveFailedOpen(previous: ProductRef | undefined): void {
    this.session.dismissOpening();
    if (previous === undefined) return;
    void this.session.open(previous);
  }

  /**
   * Take the focus when the shell activates this view. Theia waits up to two
   * seconds for an activated widget to accept focus, and a mode switch
   * activates its views one after another: without this, entering Building
   * cost ten seconds, and the rail showed the previous mode's tabs meanwhile.
   */
  /**
   * Constructor Studio: ask what products there are whenever the panel is on
   * screen. Discovery used to be started only by the Start screen, the Open
   * Product command and product creation; the desktop shows product-ext's
   * start page instead of Gearbox's, so nothing asked and this panel drew
   * "no product yet" for a workspace that has one. `ensureDiscovered` returns
   * at once when a list is in hand or a load is in flight.
   */
  protected override onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    void this.store.ensureDiscovered();
  }

  protected override onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    void this.store.ensureDiscovered();
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    if (!this.node.hasAttribute("tabindex")) {
      this.node.tabIndex = -1;
    }
    this.node.focus();
  }

  protected render(): React.ReactNode {
    const state = this.store.current;

    // Opening, and saying which part of it. `ProductSessionService` restarts the
    // engine twice to derive this product's source roots and write boundary,
    // which is around three seconds on this corpus -- long enough that a person
    // who sees the previous screen concludes the click missed. The name is the
    // product's, because "Loading..." with no subject is what an application that
    // has lost track of itself says.
    //
    // **By identity, not by "nothing is open".** Testing `state.open ===
    // undefined` meant that switching from one product to another showed the
    // *old* product for the whole three seconds -- and, if the new one refused,
    // hid the refusal completely: the store still held the previous product, so
    // the panel had something to render and rendered that.
    //
    // **And before the error branch, which is the other half of the same
    // mistake.** A store holding a *failed* A answered `status === "error"` first,
    // so opening B kept A's error on screen for the whole open and then in place
    // of B's own refusal. A product's error is the product's; it must not outlive
    // the moment another product becomes the subject.
    //
    // Once the store holds the product being opened, the panel is that product's
    // and its own `resolving…` line and error box take over -- which is why a
    // refusal at `resolve` is not shown here: by then the product *is* the
    // subject, and its error belongs beside it rather than in a checklist.
    const opening = this.session.openingProgress;
    if (opening.status !== "idle" && state.open?.path !== opening.product.path) {
      return (
        <div className="gbx-product">
          {renderOpening(opening, state.open, (previous) => this.leaveFailedOpen(previous))}
        </div>
      );
    }

    // Nothing could be read, so there is no composition to fall back to: the
    // panel is the recovery state until a reload or an edit produces an intent.
    if (state.status === "error" && !state.intent) {
      return (
        <div className="gbx-product">
          {this.renderRecovery(state.error)}
          {renderDiagnosticsSummary(state.diagnostics, () => this.showConflicts())}
        </div>
      );
    }

    if (state.open === undefined) {
      // Constructor Studio: New, Open, the workspace's products and Recent --
      // the Start screen's way to a product, where Building looks for it. See
      // `product-empty-state.tsx`.
      return (
        <div className="gbx-product">
          <ProductEmptyState
            lists={emptyStateLists(state.products, this.recent)}
            engineConnected={this.engine.isConnected}
            onNew={() => void this.commands.executeCommand(NEW_PRODUCT.id)}
            onOpen={() => void this.commands.executeCommand(OPEN_PRODUCT.id)}
            onOpenWorkspace={(ref) => void this.session.open(ref)}
            // `openRecent`, not `open`: a remembered path may have rotted, and
            // that call is the one that forgets it and says so.
            onOpenRecent={(ref) => void this.session.openRecent(ref).then(() => this.refreshRecent())}
          />
        </div>
      );
    }

    const intent = state.intent;
    const product = state.resolution?.product ?? undefined;

    return (
      <div className="gbx-product">
        {/* **A head that stays and a body that scrolls.** The panel was one
            scrolling block, so reading a form in the settings column carried the
            product's name, its profile switcher and the stage tabs off the top --
            and scrolling anywhere moved everything, including the column the
            person was not reading. Making the stage strip alone `sticky` fixed
            neither: it pinned a strip in the middle of a header whose other
            halves still left. */}
        <div className="gbx-product-head">
          {/* **One card: who the product is on the left, what state it is in
              and what to do about it on the right.** The head was four rows of
              equal weight -- the name, a profile select, a sentence about the
              branch, the status strip -- and none of them read as the title. */}
          <div className="gbx-product-card gbx-product-context">
            {/* The id stays as the marker (`data-product-name`); the name opens
                another product, the way Gearbox Studio's switches one. */}
            <div className="gbx-product-identity">
              <button type="button" className="gbx-product-name" data-product-name={intent?.id}
                title="Open another product"
                onClick={() => void this.commands.executeCommand(OPEN_PRODUCT.id)}>
                {intent?.display_name ?? state.open.label}<span className="codicon codicon-chevron-down" aria-hidden />
              </button>
              {/* The meta line: which profile, which branch. Muted, under the
                  name, because both qualify the product rather than compete
                  with it. */}
              <div className="gbx-product-meta">
                {intent && state.profile !== undefined && (
                  <button type="button" className="gbx-meta-chip gbx-profile-pill" data-product-profile={state.profile}
                    aria-label={`Deployment profile: ${state.profile}`} aria-haspopup="listbox"
                    title="Switch the deployment profile"
                    onClick={() => void this.pickProfile()}>
                    <span className="codicon codicon-server-environment" aria-hidden />
                    <span>{profileLabel(state.profile, intent.profiles[state.profile]?.profile)}</span>
                    <span className="codicon codicon-chevron-down" aria-hidden />
                  </button>
                )}
                {this.renderCheckout()}
              </div>
            </div>
            <div className="gbx-product-card-actions">
              {/* Constructor Studio: the product's health and its draft's Apply
                  and Discard, on every section -- the strip Gearbox Studio's
                  bottom draft bar answers too; one of the two, so there is one
                  Apply. */}
              {this.renderStatusStrip()}
              {this.catalogue.engineCapabilities?.generate !== false && (
                <button type="button" className="gbx-start-primary gbx-product-generate" data-product-generate
                  title="Generate the product's code from its description"
                  onClick={() => this.showSection("generate")}>
                  <span className="codicon codicon-run-all" aria-hidden /> Generate
                </button>
              )}
              <button type="button" className="gbx-icon-button" aria-label="Product menu" aria-haspopup="menu"
                data-product-menu title="More actions"
                onClick={(event) => this.openProductMenu(event.currentTarget)}>
                <span className="codicon codicon-ellipsis" aria-hidden />
              </button>
            </div>
          </div>
          {this.renderStaleCorpus()}
          <div className="gbx-product-nav" role="tablist" aria-label="Product"
            onKeyDown={event => {
              const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
              const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault(); tabs[next]?.focus(); tabs[next]?.click();
            }}>
            {SECTIONS.filter(section => (section.id !== "generate" && section.id !== "deploy") || this.catalogue.engineCapabilities?.generate !== false).map(section =>
              <button type="button" key={section.id} role="tab" aria-selected={this.section === section.id}
                tabIndex={this.section === section.id || (this.section === "settings" && section.id === "composition") ? 0 : -1}
                className={`gbx-view-tab ${this.section === section.id ? "gbx-view-tab-on" : ""}`}
                data-product-section={section.id} data-product-section-generate={section.id === "generate" ? true : undefined}
                onClick={() => this.showSection(section.id)}>
                {section.label}{section.id === "checks" && this.renderStageCount(state.diagnostics, state.stale)}
              </button>)}
          </div>
        </div>

        <div
          className={`gbx-product-body${this.section === "composition" ? " gbx-product-body-fill" : ""}`}
        >
        {intent && this.addingProfile && this.renderAddProfile()}


        {/* Addressable, because a claim drives this state on purpose now: the
            RPC seam holds the answer to `resolve` so the moment lasts. */}
        {state.status === "resolving" && (
          <div className="gbx-progress" data-product-resolving>
            Checking the product…
          </div>
        )}

        {/* The product was read but something after it was not -- a failed
            resolve, most often. The composition below is still this product's,
            so the failure is reported beside it rather than replacing it. */}
        {/* **Or staleness with no error at all**, which is the state a write of
            unknown fate leaves: the resolution on screen is a real answer, the
            engine that gave it is gone, and until this existed the only trace
            was a toast that had already faded. */}
        {(state.error !== undefined || state.stale !== undefined) &&
          this.renderRecovery(state.error)}
        {/* Composition and Validation render from the intent and the
            diagnostics, so they survive a resolution that did not arrive.
            Overview and Topology are views *of* a resolution and wait for one. */}
        {this.section === "composition" ? this.renderComposition()
          : this.section === "checks" ? this.renderValidation()
          : this.section === "settings" ? <section className="gbx-product-settings">
              <button type="button" className="gbx-choice" onClick={() => this.showSection("composition")}>← Back to composition</button>
              <div className="gbx-settings-head">
                <h2>Product settings</h2>
                {/* The markers the old Product menu's buttons carried, on the
                    controls that do the same here, where profiles are edited. */}
                {intent && !this.addingProfile && <button type="button" className="gbx-choice" data-add-profile
                  onClick={() => this.startAddProfile()}>
                  <span className="codicon codicon-add" aria-hidden /> Add profile…
                </button>}
                <button type="button" className="gbx-choice" data-open-product-gdl onClick={() => this.openDescription()}>
                  <span className="codicon codicon-go-to-file" aria-hidden /> Open GDL
                </button>
              </div>
              {intent && state.profile && this.renderProfileEdit(intent.profiles[state.profile], state.profile, intent.default_profile)}
              {product && this.renderOverview(product)}
            </section>
          : this.section === "topology" && product ? this.renderTopology(product) : undefined}
        {/* No React children: the Generate widget's own node is attached here. */}
        {this.generateVisited && <div className="gbx-embedded-generate" hidden={this.section !== "generate" && this.section !== "deploy"}
          ref={this.generateHost} />}
        </div>
      </div>
    );
  }

  /**
   * What went wrong, and the one thing that can be done about it.
   *
   * One renderer for both places it appears -- the panel-wide recovery state
   * when nothing could be read, and the line above a composition that survived
   * whatever failed after it.
   *
   * **The action depends on what is broken, because the wrong one destroyed the
   * panel.** `Retry` is `ProductStore.reload()`, which re-reads the description
   * through the engine -- and with no engine there to read it, the re-read
   * clears the intent and then fails, so the product's name, its profile
   * switcher, its composition and its pending-changes line all disappeared and
   * were replaced by a second copy of the same refusal. Measured, against a real
   * timeout: one press turned a product with a failed resolve into a panel with
   * nothing in it.
   *
   * So when the session is what is gone, the offer is to re-establish it:
   * `ProductSessionService.reconnect`, which is the whole open sequence for the
   * product already open. Retry stays for the case it was written for -- a
   * description that did not evaluate, where the engine answered and the answer
   * was a refusal.
   */
  protected renderRecovery(error: string | undefined): React.ReactNode {
    const state = this.store.current;
    const path = state.open?.path;
    const stale = state.stale;
    return (
      <div
        className="gbx-error"
        role="alert"
        data-product-error
        {...(stale !== undefined
          ? { "data-product-stale": true, "data-write-unknown": stale.writeUnknown }
          : {})}
      >
        <span>{error ?? stale?.reason}</span>
        {/* **The sentence, not just the marker.** A person reading this needs to
            know that what is still on screen is from before the engine stopped
            -- the composition, the counts and the profile are all still drawn,
            correctly, from an answer that is no longer current. */}
        {stale !== undefined && error !== undefined && error !== stale.reason && (
          <span data-stale-reason>{stale.reason}</span>
        )}
        {stale !== undefined ? (
          <button type="button" data-reconnect-engine onClick={() => void this.session.reconnect()}>
            Reconnect engine
          </button>
        ) : (
          <button type="button" data-retry-read onClick={() => void this.store.reload()}>
            Retry
          </button>
        )}
        {path !== undefined && (
          <button type="button" onClick={() => void this.reveals.revealPath(path)}>
            Open GDL
          </button>
        )}
      </div>
    );
  }

  /**
   * Attach the Generate widget to the section's host. Taken out of any other
   * parent first: a layout saved before Generate moved here may still hold it
   * in the shell, and Lumino attaches only a widget without one.
   */
  /**
   * The host's ref: one function for the widget's life, so React calls it
   * when the host is mounted and unmounted, not on every render. An inline
   * arrow was a new ref each render -- harmless while unmounting did nothing,
   * but the host does unmount (the opening screen has none), and the Generate
   * widget then stayed "attached" to a node gone from the document: closing
   * the product failed with "Widget is not attached" and left it blank.
   */
  protected readonly generateHost = (host: HTMLDivElement | null): void => this.mountGenerate(host);

  /** The node the Generate widget goes into, while it is mounted. */
  protected generateHostNode: HTMLDivElement | null = null;

  protected mountGenerate(host: HTMLDivElement | null): void {
    this.generateHostNode = host;
    const widget = this.generateWidget;
    if (host === null) {
      // React clears the ref before it removes the node: detach while the
      // node is still in the document.
      if (widget !== undefined && !widget.isDisposed && widget.isAttached && widget.parent === null && widget.node.isConnected) {
        Widget.detach(widget);
      }
      return;
    }
    if (widget === undefined || widget.isDisposed) {
      void this.widgets.getOrCreateWidget(GENERATE_WIDGET_ID).then((created) => {
        if (this.isDisposed) return;
        this.generateWidget = created;
        // The ref is not called again on the next render: attach it to the
        // host that asked for it, if that host is still there.
        if (this.generateHostNode !== null) this.mountGenerate(this.generateHostNode);
        this.update();
      });
      return;
    }
    this.syncGenerateView();
    if (widget.node.parentElement === host) return;
    if (widget.parent !== null) widget.parent = null;
    else if (widget.isAttached && widget.node.isConnected) Widget.detach(widget);
    if (!widget.isAttached) Widget.attach(widget, host);
    else host.appendChild(widget.node);
  }

  /** One widget, two stages: the code on Generate, what comes after it on Run & Deploy. */
  protected syncGenerateView(): void {
    const widget = this.generateWidget as unknown as { setView?: (view: "generate" | "deploy") => void } | undefined;
    widget?.setView?.(this.section === "deploy" ? "deploy" : "generate");
  }

  override dispose(): void {
    const widget = this.generateWidget;
    if (widget !== undefined && !widget.isDisposed && widget.isAttached && widget.parent === null && widget.node.isConnected) {
      Widget.detach(widget);
    }
    super.dispose();
  }

  /** Move to a stage, from somewhere other than the strip. */
  public showSection(section: ProductSectionInput): void {
    this.section = section === "overview" ? "settings" : section === "validation" ? "checks" : section;
    if (this.section === "generate" || this.section === "deploy") this.generateVisited = true;
    this.syncGenerateView();
    this.update();
  }


  protected renderComposition(): React.ReactNode {
    const state = this.store.current;
    const selection = this.productSelection;
    // Constructor Studio: the pending-changes line, with Apply and Discard
    // beside it, is the status strip in the head now -- on every stage, since a
    // profile field (Overview) and a provider option (Topology) queue into the
    // same draft as a gear's settings here.
    return <>
      {this.renderSummaryBand()}
      <Composition state={state} loadingLabel={this.openingLabel()} descriptors={this.catalogue.current.rows.flatMap(row => row.kind === "projected" ? [row.gear] : [])}
        selection={selection} select={selected => { this.selection.select(selected); this.update(); }}
        add={(host, point) => void this.commands.executeCommand(ADD_GEAR.id, { host, point })}
        remove={(host, index) => void this.edits.removeComposition(host, index).then(ok => { if (ok) this.selection.select(undefined); })}
        settings={this.renderSettings(selection)} reveals={this.reveals}
        expanded={this.expandedHosts}
        create={() => this.createGearForProduct()}
        toggleFold={host => {
          if (!this.expandedHosts.delete(host)) this.expandedHosts.add(host);
          this.update();
        }} />
    </>;
  }

  /**
   * The product at a glance, above both Composition columns: its gears and
   * applications, its health, its last Generate, and the one step to take next.
   *
   * **Always there, not only with nothing selected.** These figures used to be
   * the right-hand pane's empty state, so they vanished at the first click on a
   * gear -- which is when a person starts changing the things they count.
   *
   * It degrades rather than disappears: with no resolution yet the gear count
   * is the description's own and the rest says it is waiting; after the engine
   * stopped the band is marked as from before; after a refused resolve the next
   * step is the retry, beside the error `renderRecovery` draws above it.
   */
  protected renderSummaryBand(): React.ReactNode {
    const state = this.store.current;
    if (state.open === undefined) return undefined;
    const product = state.resolution?.product ?? undefined;
    const stale = state.stale !== undefined;
    const status = this.statusBadge();
    const step = nextStepOf({
      status: state.status,
      stale,
      failed: state.error !== undefined,
      conflicts: errorsIn(state.diagnostics),
      pending: this.edits.draftEdits().length,
      gears: state.intent?.selected_gears.length ?? 0,
      canGenerate: this.catalogue.engineCapabilities?.generate !== false,
    });
    const act = (): void => {
      switch (step.kind) {
        case "reconnect":
          void this.session.reconnect();
          return;
        case "retry":
          void this.store.reload();
          return;
        case "checks":
          this.showSection("checks");
          return;
        case "apply":
          void this.edits.applyDraft();
          return;
        case "add-gear":
          void this.commands.executeCommand(ADD_GEAR.id);
          return;
        case "generate":
          this.showSection("generate");
          return;
        case "wait":
          return;
      }
    };
    return (
      <section className="gbx-summary-band" data-product-summary-band aria-label="Product summary"
        {...(stale ? { "data-summary-stale": true } : {})}>
        {product !== undefined ? (
          this.renderShape(product)
        ) : (
          // No resolution: the description still says what was asked for.
          <div className="gbx-overview-figures" data-overview-figures>
            <div className="gbx-figure gbx-figure-static" data-figure="gears">
              <span className="gbx-figure-value">{state.intent?.selected_gears.length ?? "—"}</span>
              <span className="gbx-figure-label">gears asked for — the rest once the product is checked</span>
            </div>
          </div>
        )}
        <div className="gbx-overview-figures">
          <button type="button" className="gbx-figure" data-figure="health" onClick={() => this.showSection("checks")}>
            <span className="gbx-figure-value gbx-figure-value-text" data-summary-health={status?.kind ?? "none"}>
              {healthLabel(status)}
            </span>
            <span className="gbx-figure-label">{stale ? "from before the connection was lost" : "health"}</span>
          </button>
          <button type="button" className="gbx-figure" data-figure="generate" title={this.generationSummary()} onClick={() => this.showSection("generate")}
            hidden={this.catalogue.engineCapabilities?.generate === false}>
            <span className="gbx-figure-value gbx-figure-value-text" data-summary-generate={this.generate.current.status}>
              {this.generationSummary()}
            </span>
            <span className="gbx-figure-label">last Generate</span>
          </button>
        </div>
        <div className={`gbx-next-step gbx-next-step-${step.kind}`} data-next-step={step.kind}>
          <span className="gbx-next-step-label">Next step</span>
          <span className="gbx-next-step-title">{step.title}</span>
          <span className="gbx-next-step-detail">{step.detail}</span>
          {"action" in step && (
            <button type="button" className={step.kind === "generate" || step.kind === "apply" ? "gbx-start-primary" : "gbx-choice"}
              data-next-step-action onClick={act}
              disabled={step.kind === "apply" && !this.engine.isConnected}>
              {step.action}
            </button>
          )}
        </div>
      </section>
    );
  }

  /**
   * The settings half of Composition, for whatever is selected.
   *
   * **Rendered here, not borrowed from the Inspector.** This used to call
   * `InspectorWidget.renderContent()` on an injected instance, which made the
   * right-hand panel and this pane one widget with one set of half-typed boxes.
   * They are components now, so each surface holds its own.
   *
   * Keyed on the draft epoch for the same reason the Inspector keys them: a
   * Discard or an Apply must take the scratch boxes with it.
   */
  /** What the open is doing now, when this product is the one opening. */
  protected openingLabel(): string | undefined {
    const opening = this.session.openingProgress;
    if (opening.status !== "opening") return undefined;
    if (opening.product.path !== this.store.current.open?.path) return undefined;
    return openingSentence(opening.stage);
  }

  protected renderSettings(selection: Selection | undefined): React.ReactNode {
    const state = this.store.current;
    const descriptorFor = (id: string): GearDescriptor | undefined => {
      const row = this.catalogue.current.rows.find(
        (row) => row.kind === "projected" && row.gear.id === id,
      );
      return row?.kind === "projected" ? row.gear : undefined;
    };

    if (selection?.kind === "plugin") {
      return (
        <PluginSettings
          key={`plugin-${selection.host}-${selection.entryIndex}-${this.edits.epoch}`}
          selection={selection}
          state={state}
          descriptor={descriptorFor(selection.id)}
          edits={this.edits}
          openGdl={() => {
            if (state.open) void this.reveals.revealPath(state.open.path);
          }}
          remove={() =>
            void this.edits
              .removeComposition(selection.host, selection.entryIndex)
              .then((ok) => {
                if (ok) this.selection.select({ kind: "gear", id: selection.host });
              })
          }
        />
      );
    }

    if (selection?.kind === "gear") {
      return this.renderGearSettings(selection.id, descriptorFor(selection.id));
    }

    // **A catalogue selection never reaches here**, because this pane reads
    // `productSelection` rather than the service: looking a gear up in the
    // catalogue is not a request to stop configuring the one in front of you.
    // The Inspector is where a catalogue row is answered, and it opens itself
    // for exactly that act.
    if (!state.intent && (state.status === "loading" || state.status === "resolving")) {
      return <div className="gbx-empty" role="status">{this.openingLabel() ?? "Reading the product…"}</div>;
    }
    return (
      <section className="gbx-product-summary" data-composition-summary>
        <h2>{state.intent?.display_name ?? state.open?.label}</h2>
        <p>Select a gear to configure it. Add gears to extend your product.</p>
        {/* The figures, the health and the next step are the summary band's
            now, above both columns; this pane keeps what the band does not
            say -- where the description lives and what it reads from. */}
        <div className="gbx-kv">
          <span>description file</span>
          <span className="gbx-links">
            <RevealPathLink reveals={this.reveals} path={state.open?.path ?? ""} label={state.open?.label ?? "—"} />
          </span>
        </div>
        {this.renderSources()}
      </section>
    );
  }

  /**
   * One named gear, and the truth about why it is on this screen.
   *
   * **Four answers, because there were four questions and one sentence.** This
   * decided everything from `picked === undefined` -- no `use_gear` entry in the
   * intent -- and then said "`X` is included by another gear, so it has no
   * settings of its own." That is true of a gear the closure pulled in. It is
   * false of a gear that exists only in the catalogue, where no such other gear
   * is named because there is none, and false again when no product is open at
   * all, which reaches the same branch through the optional chain.
   *
   * The resolution can tell them apart and was not being asked: a gear in the
   * closure has an entry in `resolution.product.gears` carrying `selected_by`;
   * a gear that is merely in the catalogue does not.
   *
   * Every branch names the object first. The form used to open with the words
   * "in this product" and never said which gear they were about.
   */
  protected renderGearSettings(id: string, descriptor?: GearDescriptor): React.ReactNode {
    const state = this.store.current;
    const picked = state.intent?.selected_gears.find((entry) => entry.gear === id);
    const resolved = state.resolution?.product?.gears?.[id];
    const selectGear = (gear: string): void => {
      this.selection.select({ kind: "gear", id: gear });
      this.update();
    };
    const heading = <GearHeading id={id} descriptor={descriptor} />;
    // **Overview first, as one captioned block**: what the gear is, where to
    // read more, and why it is in this product -- the facts, before the
    // controls. The blocks below follow the same caption style, so the pane
    // reads as sections rather than as one long form.
    const overview = (reasons: readonly InclusionReason[], openGdl: boolean): React.ReactNode => (
      <section className="gbx-block" data-gear-overview>
        <h3 className="gbx-block-caption">Overview</h3>
        <GearBlurb descriptor={descriptor} />
        <GearDocs descriptor={descriptor} reveals={this.reveals} />
        <div className="gbx-block-row">
          <InclusionReasons reasons={reasons} onSelectGear={selectGear} />
          {openGdl && (
            <button type="button" className="gbx-link" data-open-gear-gdl onClick={() => this.openDescription()}>
              <span className="codicon codicon-go-to-file" aria-hidden /> Open product GDL
            </button>
          )}
        </div>
      </section>
    );

    // Asked for by name: the one case with a `use_gear` entry to write into.
    if (picked !== undefined) {
      return (
        <div className="gbx-detail" data-settings-for={id}>
          {heading}
          {overview(resolved?.selected_by ?? [], true)}
          {descriptor === undefined ? (
            <div className="gbx-empty">
              No catalogue descriptor for <code>{id}</code> yet. It stays in your product;
              its fields appear once the catalogue has read it.
            </div>
          ) : (
            <GearSettings
              key={`gear-${id}-${this.edits.epoch}`}
              descriptor={descriptor}
              picked={picked}
              edits={this.edits}
              sources={{ edits: this.edits, products: this.store }}
              profileKind={state.resolution?.product?.product.profile_kind}
              viewingProfile={state.profile}
            />
          )}
          {this.renderGearPlugins(picked)}
        </div>
      );
    }

    // In the closure, and genuinely not editable here -- now said with the gear
    // that requires it named, and reachable.
    if (resolved !== undefined) {
      const host = resolved.selected_by.flatMap((reason) =>
        reason.reason === "colocated_by"
          ? [reason.gear]
          : reason.reason === "plugin_of"
            ? [reason.host]
            : [],
      )[0];
      return (
        <div className="gbx-detail" data-pulled-in-settings={id}>
          {heading}
          {overview(resolved.selected_by, false)}
          <div className="gbx-empty">
            It has no <code>use_gear</code> entry of its own, so what it is set to is the
            business of whatever requires it.
          </div>
          {host !== undefined && (
            <button
              type="button"
              className="gbx-choice"
              data-configure-host={host}
              onClick={() => selectGear(host)}
            >
              Configure {host}
            </button>
          )}
        </div>
      );
    }

    // Known to the catalogue and in no product -- reachable after a removal
    // while selected, or under a profile that does not take it.
    if (state.open !== undefined) {
      return (
        <div className="gbx-detail" data-not-in-product={id}>
          {heading}
          <div className="gbx-empty">
            <code>{id}</code> is in the catalogue and not in {state.open.label}.
          </div>
          <button
            type="button"
            className="gbx-choice"
            data-add-to-product={id}
            onClick={() => void this.commands.executeCommand(ADD_GEAR.id, { gearId: id })}
          >
            Add to product
          </button>
        </div>
      );
    }

    return (
      <div className="gbx-detail" data-not-in-product={id}>
        {heading}
        <div className="gbx-empty">Open a product to configure this gear in one.</div>
      </div>
    );
  }

  /**
   * The Plugins block: what this gear carries, each one a way to its own
   * settings. Nothing for a gear with no plugin and nowhere to put one -- an
   * empty block about plugins on a gear that takes none says nothing.
   */
  protected renderGearPlugins(picked: GearSelection): React.ReactNode {
    const state = this.store.current;
    const plugins = picked.plugins ?? [];
    const descriptor = this.catalogue.current.rows.find((row) => row.kind === "projected" && row.gear.id === picked.gear);
    const points = descriptor?.kind === "projected" ? pointsOf(descriptor.gear) : [];
    if (plugins.length === 0 && points.length === 0) return undefined;
    const nameOf = (gear: string): string => {
      const row = this.catalogue.current.rows.find((r) => r.kind === "projected" && r.gear.id === gear);
      return row?.kind === "projected" ? row.gear.display_name || gear : gear;
    };
    return (
      <section className="gbx-block" data-gear-plugins>
        <h3 className="gbx-block-caption">Plugins{plugins.length > 0 && ` · ${plugins.length}`}</h3>
        {plugins.length === 0 && <p className="gbx-empty">No plugins yet.</p>}
        {plugins.map((plugin) => (
          <button
            type="button"
            key={plugin.entry_index}
            className="gbx-block-item"
            data-gear-plugin={plugin.gear}
            onClick={() => {
              this.selection.select({
                kind: "plugin",
                host: picked.gear,
                id: plugin.gear,
                entryIndex: plugin.entry_index,
                path: state.open?.path ?? "",
              });
              this.update();
            }}
          >
            <span className="codicon codicon-extensions" aria-hidden />
            <span>{nameOf(plugin.gear)}</span>
            <span className="gbx-block-item-note">{plugin.profiles?.join(", ") || "All profiles"}</span>
          </button>
        ))}
        {points.length > 0 && (
          <button
            type="button"
            className="gbx-choice"
            data-add-plugin-for={`${picked.gear}:${points.length === 1 ? pointKey(points[0]!) : ""}`}
            onClick={() =>
              void this.commands.executeCommand(ADD_GEAR.id, {
                host: picked.gear,
                point: points.length === 1 ? pointKey(points[0]!) : undefined,
              })
            }
          >
            Add compatible plugin
          </button>
        )}
      </section>
    );
  }

  /** Whichever stage is selected, rendered from the same resolution. */
  protected renderSection(product: ResolvedProduct): React.ReactNode {
    switch (this.section) {
      case "settings":
        return this.renderOverview(product);
      case "topology":
        return this.renderTopology(product);
      // Both are rendered by `render` before it reaches here, because both work
      // without a resolution and this method is only called once there is one.
      case "composition":
      case "checks":
      case "generate":
      case "deploy":
        return undefined;
    }
  }

  /**
   * Why the id in the Add profile form cannot be added, or `undefined`.
   *
   * **Said at the field, before a round trip.** A malformed id used to reach the
   * description and make it unreadable, and an id the product already declares
   * was a silent no-op -- Add pressed, nothing written, nothing said. The engine
   * refuses the first now as well; this is where a person can act on it.
   */
  protected newProfileRefusal(): string | undefined {
    const id = this.newProfileId.trim();
    if (id === "") return undefined;
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) {
      return `\`${id}\` is not a profile id: lowercase letters, digits and single hyphens, starting with a letter.`;
    }
    if (this.store.current.intent?.profiles[id] !== undefined) {
      return `This product already declares \`${id}\`.`;
    }
    return undefined;
  }

  protected renderAddProfile(): React.ReactNode {
    const refusal = this.newProfileRefusal();
    return (
      <div className="gbx-profile-add" data-profile-add>
        <label>
          id
          <input
            data-profile-new-id
            value={this.newProfileId}
            onChange={(e) => {
              this.newProfileId = e.target.value;
              this.update();
            }}
          />
        </label>
        <label>
          kind
          <select
            data-profile-new-kind
            value={this.newProfileKind}
            onChange={(e) => {
              this.newProfileKind = e.target.value as typeof this.newProfileKind;
              this.update();
            }}
          >
            <option value="embedded">embedded</option>
            <option value="self_hosted">self_hosted</option>
            <option value="kubernetes">kubernetes</option>
          </select>
        </label>
        {/* **The host application, not a machine.** `host` names the application
            the others are spawned from, and the field used to open holding
            `localhost` -- a hostname, which became an application of that name. */}
        {this.newProfileKind === "self_hosted" && <label>Host application (required)
          <input
            data-profile-new-host
            value={this.newProfileHost}
            placeholder="e.g. gateway"
            onChange={e => { this.newProfileHost = e.target.value; this.update(); }}
          />
        </label>}
        {this.newProfileKind !== "embedded" && <label>Discovery (required)
          <select value={this.newProfileDiscovery} onChange={e => { this.newProfileDiscovery = e.target.value; this.update(); }}>
            <option value="static">static</option><option value="directory">directory</option>
          </select>
        </label>}
        <button
          type="button"
          className="gbx-choice"
          data-profile-add-confirm
          disabled={
            !this.newProfileId.trim() ||
            refusal !== undefined ||
            (this.newProfileKind === "self_hosted" && !this.newProfileHost.trim())
          }
          onClick={() => void this.confirmAddProfile()}
        >
          Add
        </button>
        <button
          type="button"
          className="gbx-choice"
          data-profile-add-cancel
          onClick={() => {
            this.addingProfile = false;
            this.update();
          }}
        >
          Cancel
        </button>
        {refusal !== undefined && (
          <span className="gbx-error" role="alert" data-profile-new-refusal>
            {refusal}
          </span>
        )}
      </div>
    );
  }

  protected renderProfileEdit(
    profile: DeploymentProfileDecl | undefined,
    id: string,
    defaultProfile: string,
  ): React.ReactNode {
    if (profile === undefined) return undefined;
    const fields = profileFields(profile).map(({ wire, label, value, choices, required }) => ({
      wire,
      label,
      choices,
      required,
      value: this.edits.draftProfileField(id, wire, value ?? undefined),
    }));
    return (
      <div
        className="gbx-profile-edit"
        data-profile-edit={id}
        // Keyed on the *service's* epoch, not on a counter of this widget's own.
        // The draft is one object shared with the Inspector, and a Discard from
        // either place has to remount both -- see `ProductEditService.epoch`.
        key={`profile-${id}-${this.edits.epoch}`}
      >
        <div className="gbx-kv">
          <span>kind</span>
          <span title="Profile kind is fixed at creation; remove and re-add to change it.">
            {profile.profile}
          </span>
        </div>
        {fields.map(({ wire, label, value, choices, required }) => (
          <div className="gbx-kv" key={wire} data-profile-field-row={wire}>
            <label htmlFor={`gbx-profile-${id}-${wire}`}>
              {label}
              {required === true && (
                /* Said in words as well as by the glyph, the same way the config
                   form marks a required field -- a bare `title` reaches no
                   screen reader. */
                <span className="gbx-config-required" data-profile-field-required={wire}>
                  <span className="gbx-sr-only">required</span>
                </span>
              )}
            </label>
            <span>
              {choices !== undefined ? (
                <select
                  id={`gbx-profile-${id}-${wire}`}
                  value={value ?? ""}
                  aria-label={label}
                  data-profile-field={wire}
                  data-field-modified={
                    this.edits.isDraftedProfileField(id, wire) ? "true" : undefined
                  }
                  onChange={(e) =>
                    this.edits.queueDraft({
                      kind: "set_profile_field",
                      profile: id,
                      field: wire,
                      value: e.target.value === "" ? null : e.target.value,
                    })
                  }
                >
                  {/* **No "not set" for a required field.** Unsetting removes
                      the argument, and these arguments are non-`Option` in the
                      grammar -- so the option was a way to make the open product
                      refuse to evaluate, after which this form is not rendered
                      and the value cannot be put back. The comment here used to
                      claim "a profile that declares no discovery gets the SDK's
                      default", which is true of no kind that has this field:
                      `embedded` is the one with no discovery, and it has no
                      fields at all. Optional fields keep the option. */}
                  {required !== true && <option value="">not set</option>}
                  {choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
              ) : (
              <input
                id={`gbx-profile-${id}-${wire}`}
                value={value ?? ""}
                aria-label={label}
                data-profile-field={wire}
                // Which control the unapplied edit is in. The `Apply changes` /
                // `Discard` pair is one per product and lives in the header, so
                // the marker is what says *here*.
                data-field-modified={this.edits.isDraftedProfileField(id, wire) ? "true" : undefined}
                onChange={(e) => {
                  // **The same rule as the select, and the easier one to hit.**
                  // `host` is a plain text box, so emptying it queued a removal
                  // with no dropdown involved -- the quickest accidental route
                  // to a product that will not open. An empty required box is
                  // not an edit; the field keeps what it had until something
                  // replaces it.
                  if (required === true && e.target.value.trim() === "") return;
                  this.edits.queueDraft({
                    kind: "set_profile_field",
                    profile: id,
                    field: wire,
                    value: e.target.value === "" ? null : e.target.value,
                  });
                }}
              />
              )}
            </span>
          </div>
        ))}
        {id !== defaultProfile && (
          <button
            type="button"
            className="gbx-choice"
            data-remove-profile={id}
            onClick={() => void this.edits.removeProfile(id).then(() => this.update())}
          >
            Remove profile
          </button>
        )}
      </div>
    );
  }

  protected async confirmAddProfile(): Promise<void> {
    const id = this.newProfileId.trim();
    if (id === "" || this.newProfileRefusal() !== undefined) return;
    const fields = this.newProfileKind === "embedded" ? [] : this.newProfileKind === "self_hosted"
      ? [{ name: "host", value: this.newProfileHost.trim() }, { name: "worker_discovery", value: this.newProfileDiscovery }]
      : [{ name: "discovery", value: this.newProfileDiscovery }];
    const ok = await this.edits.addProfile(this.newProfileKind, id, fields);
    if (ok) {
      this.addingProfile = false;
      this.newProfileId = "";
      this.update();
    }
  }

  /**
   * The resolved header and the description's own file.
   *
   * What the product *is*: which profile answered, which lock that produced, and
   * where the description lives. The profile switch is rendered above this, not
   * here -- it has to be reachable while a resolution is in flight, which a row
   * rendered from the resolved product cannot be.
   */
  protected renderOverview(product: ResolvedProduct): React.ReactNode {
    const stale = this.store.current.stale;
    return (
      <>
        <div className="gbx-kv" {...(stale !== undefined ? { "data-header-stale": true } : {})}>
          {/* **The loss is the row, and the resolve is the footnote.** Marking a
              row still labelled `resolved` was not enough: the label is what a
              person reads first, and "resolved · not re-read since the engine
              stopped" leads with the reassurance and qualifies it afterwards.
              What the panel knows, in the order it knows it: the connection is
              gone, so these results are stale, and the last one that *did* answer
              was for this profile. */}
          <span>{stale === undefined ? "up to date" : "connection lost"}</span>
          {/* The profile is taken from the *resolved header*, not from the switch
              above. They should agree, and stating both is what makes a
              disagreement visible instead of leaving the panel labelled one way
              and showing another profile's answer.
              *
              The lock hash used to be shown here and is not any more: it told a
              reader nothing they could act on. That the profile matters is already
              visible in the application count, the binding modes and which plugin was
              linked -- all of which say *what* differs, where the digest only said
              *that* something does. It stays on the element as `data-lock-hash`,
              because "three profiles, three distinct locks" is a fact still worth
              asserting, and it stays visible in the Lock view, where the lock is
              the subject rather than a footnote. */}
          {/* **The word `resolved` is about the last resolution, and after the
              engine stops that is exactly the problem.** The observation this
              closes: a refused write beside a header still reading `resolved`,
              which is honest on its own terms and reads as an all-clear. The
              resolution is kept -- it was a real answer and throwing it away
              would lose the graph -- and marked. */}
          <span
            data-resolved-profile={product.product.profile}
            data-lock-hash={product.product.lock_hash}
            {...(stale !== undefined ? { "data-resolved-stale": true } : {})}
          >
            {stale === undefined ? (
              <>
                {product.product.profile} · {product.product.profile_kind}
              </>
            ) : (
              <>
                {/* First, and in the row's own weight. The previous resolution is
                    kept -- it was a real answer, and discarding it would lose the
                    graph the panel is drawn from -- but it is no longer the
                    headline. */}
                <strong data-stale-headline>results are stale</strong>
                <span className="gbx-stale-note">
                  {" "}
                  — last resolved for {product.product.profile} ·{" "}
                  {product.product.profile_kind}, not re-read since
                </span>
              </>
            )}
          </span>
        </div>

        {/* The panel is about this product and had no way to open it. Same row
            and same shape as the Gear detail panel's, so the two read alike. */}
        <div className="gbx-kv">
          <span>description file</span>
          <span className="gbx-links">
            <RevealPathLink
              reveals={this.reveals}
              path={this.store.current.open?.path ?? ""}
              label={this.store.current.open?.label ?? "—"}
            />
          </span>
        </div>

        {this.renderShape(product)}
        {this.renderGenerationStatus()}
        {this.renderSources()}
      </>
    );
  }

  /**
   * What this product *is*, in the four numbers the other stages each hold one of.
   *
   * The stage was two rows -- the profile and a link to the file -- which made
   * Overview the emptiest screen in the application and the one every open lands
   * on. Every number here is already in `ProductStore.current`, so this reads
   * rather than asks; each one links to the stage that can be acted on, because a
   * count with no way through is trivia.
   *
   * Asked-for against pulled-in is the same split `renderGears` computes, from
   * the same field, for the reason that split exists at all: a closure that a
   * person did not ask for is the thing about this model that surprises people.
   */
  protected renderShape(product: ResolvedProduct): React.ReactNode {
    const entries = Object.entries(product.gears);
    const asked = entries.filter(([, gear]) =>
      gear.selected_by.some((reason) => reason.reason === "selected"),
    ).length;
    const applications = product.applications.length;
    const bindings = (product.bindings ?? []).length;
    const cluster = (product.cluster ?? []).length;
    return (
      <div className="gbx-overview-figures" data-overview-figures>
        <button
          type="button"
          className="gbx-figure"
          data-figure="gears"
          onClick={() => this.showSection("composition")}
        >
          <span className="gbx-figure-value" data-overview-gears={entries.length}>
            {entries.length}
          </span>
          <span className="gbx-figure-label">
            gears — {asked} asked for, {entries.length - asked} pulled in
          </span>
        </button>
        <button
          type="button"
          className="gbx-figure"
          data-figure="applications"
          onClick={() => this.showSection("topology")}
        >
          <span className="gbx-figure-value" data-overview-applications={applications}>
            {applications}
          </span>
          <span className="gbx-figure-label">
            {applications === 1 ? "application" : "applications"}
            {bindings > 0 && `, ${bindings} ${bindings === 1 ? "binding" : "bindings"}`}
            {cluster > 0 && `, ${cluster} in the cluster`}
          </span>
        </button>
      </div>
    );
  }

  /**
   * The last Generate, in one phrase, as the Overview row and the summary band
   * both say it. Read from the cache, like the row below -- never planned.
   */
  protected generationSummary(): string {
    const generate = this.generate.current;
    const plans = generate.plan?.plans ?? [];
    const writes = plans.filter((plan) => plan.action !== "unchanged").length;
    return generate.status === "planning"
      ? "planning…"
      : generate.status === "error"
        ? (generate.error ?? "the last plan failed")
        : generate.plan === undefined
          ? "not planned for this resolution yet"
          : writes === 0
            ? `${plural(plans.length, "file", "files")}, all unchanged`
            : `${writes} of ${plural(plans.length, "file", "files")} would change`;
  }

  /**
   * Whether a generated tree exists for this resolution.
   *
   * **Read from the cache, never planned from here.** `GenerateService.ensurePlan`
   * is a round trip to the engine, and calling it from a render would make
   * arriving on a screen do work -- once per paint, on a panel that repaints on
   * every store change. So this reports what the service happens to know: "not
   * planned yet" is an honest answer and a link, not a reason to go and find out.
   */
  protected renderGenerationStatus(): React.ReactNode {
    const generate = this.generate.current;
    const summary = this.generationSummary();
    return (
      <div className="gbx-kv">
        <span>generated tree</span>
        <span className="gbx-links" data-overview-generate={generate.status}>
          {summary}{" "}
          <button
            type="button"
            className="gbx-conflict-explain"
            data-overview-open-generate
            onClick={() => this.showGenerate()}
          >
            open Generate
          </button>
        </span>
      </div>
    );
  }

  /**
   * The source roots this product declares, as written.
   *
   * From the *intent* rather than from the resolution: what a person can change
   * is what the description says, and a root that failed to load is exactly the
   * one worth seeing named. `at` is relative to the description's own directory,
   * which is how the IR defines it, so it is shown as written rather than
   * resolved -- the resolved form is an absolute path nobody typed.
   *
   * **Not links, and the earlier version of this comment promised otherwise.** A
   * source root is a directory, and `RevealPathLink` opens a file in the editor;
   * a link that resolves to a folder either does nothing or opens something
   * arbitrary inside it. The description itself is one row above and is openable,
   * which is where a person goes to change any of this.
   */
  protected renderSources(): React.ReactNode {
    const intent = this.store.current.intent;
    const sources = Object.entries(intent?.sources ?? {});
    if (sources.length === 0) return undefined;
    return (
      <div className="gbx-kv">
        <span>{sources.length === 1 ? "source" : "sources"}</span>
        <span className="gbx-links" data-overview-sources={sources.length}>
          {sources.map(([id, source]) => (
            <span className="gbx-badge" key={id} data-overview-source={id}>
              {id} · {source.kind === "path" ? source.at : source.kind}
            </span>
          ))}
        </span>
      </div>
    );
  }

  /**
   * How the product deploys: applications, the bindings between them, and the
   * cluster primitives it asks for.
   *
   * One section rather than three tabs, because the three are read together --
   * a binding's `mode` is a consequence of which applications its ends landed in,
   * and a reader checking that needs both on screen.
   */
  protected renderTopology(product: ResolvedProduct): React.ReactNode {
    const bindings = product.bindings ?? [];
    const cluster = product.cluster ?? [];

    return (
      <>
        <div className="gbx-topology-head"><h2>Deployment topology</h2>
          <button type="button" className="gbx-choice" onClick={() => void this.commands.executeCommand("gearbox.graph.toggle")}>Open graph</button>
        </div>
        {this.renderBranch(
          "applications",
          "server-process",
          "Applications",
          product.applications.length,
          <>{product.applications.map((application) => this.renderApplication(application))}</>,
        )}

        {this.renderBranch(
          "contracts",
          "arrow-both",
          "Contracts",
          bindings.length,
          bindings.length === 0 ? (
            <div className="gbx-empty">No contract binding in this profile.</div>
          ) : (
            <>{bindings.map((binding) => this.renderBinding(binding))}</>
          ),
        )}

        {this.renderBranch(
          "cluster",
          "database",
          "Cluster",
          cluster.length,
          cluster.length === 0 ? (
            // Said rather than left blank: no gear in this product requests a
            // cluster scope, which is a fact about the product and not a gap.
            <div className="gbx-empty">No gear here requests a cluster primitive.</div>
          ) : (
            <>
              {cluster.map(binding => <details className="gbx-cluster-details" key={`${binding.scope}/${binding.primitive}`}>
                <summary>{binding.scope}/{binding.primitive} <span className="gbx-id">for {binding.requesters.join(", ")}</span></summary>
                <p>Requested {describeChoice(binding.selected.selected)} · resolved <code>{describeClusterResolution(binding.resolved)}</code>
                  {binding.secret_ref && <> · secret <code>{binding.secret_ref}</code></>}</p>
                {this.renderProviderOptions(binding)}
              </details>)}
            </>
          ),
        )}
      </>
    );
  }

  /**
   * The options a cluster binding was given, as the controls its backend reads.
   *
   * **The comment above this used to say `options` is deliberately not
   * rendered**, and it was right while the options were an untyped bag: a panel
   * that printed whatever the description passed was one schema change away from
   * putting a connection string on screen. What changed is that the backend's
   * own struct is now projected -- `cluster_plugin(cache_options = "...")`
   * supplies the join key Rust has no way to state -- so the panel knows which
   * key is the credential, and shows that one as the reference it is.
   *
   * Configured here rather than in Composition, and that is not a second
   * surface: a cluster binding is not a gear and has no row in the Composition
   * tree. The stage that shows it is the stage that configures it, which is the
   * rule ADR-0023's amendment states, applied to an object it did not have.
   */
  protected renderProviderOptions(binding: ResolvedClusterBinding): React.ReactNode {
    const state = this.store.current;
    const profile = state.profile;
    // The entry that applies to the profile being viewed. An empty `profiles`
    // means every profile, which is the same rule the engine's scoping uses.
    const scope = (state.intent?.cluster_scopes ?? []).find(
      (candidate) =>
        candidate.scope === binding.scope &&
        (candidate.profiles === undefined ||
          candidate.profiles.length === 0 ||
          (profile !== undefined && candidate.profiles.includes(profile))),
    );
    if (scope === undefined) return undefined;
    const declared =
      binding.primitive === "cache"
        ? scope.cache
        : binding.primitive === "lock"
          ? scope.lock
          : scope.leader_election;
    if (!declared) return undefined;

    const provider = this.catalogue.current.rows
      .flatMap((row) => (row.kind === "projected" ? (row.gear.cluster_providers ?? []) : []))
      .find((decl) => decl.name === declared.provider);
    const schema = provider?.options?.[binding.primitive];
    if (provider === undefined || schema === undefined) return undefined;

    const entryIndex = scope.entry_index;
    const values = this.edits.draftProviderOptions(
      entryIndex,
      binding.primitive,
      declared.options ?? {},
    );
    const credential = provider.credential_option ?? undefined;

    return (
      <div
        className="gbx-provider-options"
        data-provider-options={`${binding.scope}/${binding.primitive}`}
        data-provider-options-rust={schema.rust}
        data-provider-options-entry={entryIndex}
      >
        {/* **Which binding this form writes to, in full.** The scope name alone
            does not say: a product may declare the same scope twice for disjoint
            deployment profiles -- `payments-demo` does -- and the two have
            different providers and different options. So the header names the
            scope, the primitive, the provider whose struct these controls come
            from, and the profiles the entry applies under. */}
        <div className="gbx-kv" data-provider-options-head>
          <span>configuring</span>
          <span>
            <code>{binding.scope}</code>/{binding.primitive} ·{" "}
            <code data-provider-options-provider>{declared.provider}</code> ·{" "}
            <span data-provider-options-profiles>
              {scope.profiles === undefined || scope.profiles.length === 0
                ? "every profile"
                : scope.profiles.join(", ")}
            </span>{" "}
            · read into <code>{schema.rust}</code>
          </span>
        </div>
        <ConfigFields
          key={`${entryIndex}/${binding.primitive}/${this.edits.epoch}`}
          fields={(schema.fields ?? []).filter((field) => field.name !== credential)}
          values={values}
          isDrafted={(key) =>
            this.edits.providerOptionDrafted(entryIndex, binding.primitive, key)
          }
          // Set by this product, or left to the backend. The same two answers
          // the gear settings give, from the only place that knows: the written
          // options of the binding this form is for.
          provenanceOf={(key) =>
            Object.prototype.hasOwnProperty.call(declared.options ?? {}, key)
              ? "explicit"
              : "default"
          }
          // A value the description supplies that this form cannot render -- a
          // list, a nested map -- is still a value. Without this a required
          // field carrying one would be marked as needing to be supplied.
          isSet={(key) => Object.prototype.hasOwnProperty.call(declared.options ?? {}, key)}
          onChange={(key, value) =>
            void this.edits
              .setProviderOption(binding.scope, entryIndex, binding.primitive, key, value)
          }
          onReset={(key) =>
            void this.edits
              .setProviderOption(binding.scope, entryIndex, binding.primitive, key, undefined)
          }
        />
        {/* **The credential is named and not offered as a box.** Its field is a
            plain `String` in Rust, so nothing in the projection marks it -- the
            plugin declares which option it is, for the same reason it declares
            `process_local`. A form that saved a value here would be offering to
            commit a password, which is the refusal `GBX0116` makes one layer
            down. */}
        {/* **A key the backend does not read is still written down.** The form
            renders the struct's fields, so a key that is not one of them would
            otherwise be invisible here -- present in the description, refused by
            the engine (GBX0522), and absent from the only screen that shows this
            binding. Listed with what it says, and not offered as a control:
            nothing here knows what it was meant to be. */}
        {Object.keys(declared.options ?? {})
          .filter(
            (key) =>
              key !== credential &&
              !(schema.fields ?? []).some((field) => field.name === key),
          )
          .map((key) => (
            <p className="gbx-config-note" key={key} data-provider-option-unknown={key}>
              <code>{key}</code> = <code>{JSON.stringify(declared.options?.[key])}</code> —{" "}
              <code>{schema.rust}</code> does not read this key. It stays as written; remove it in
              the description, or correct the spelling.
            </p>
          ))}
        {credential !== undefined && (
          <p className="gbx-config-note" data-provider-credential={credential}>
            <code>{credential}</code> carries this backend&apos;s credential, so there is no box
            for it here. Reference it instead, on this <code>provider(...)</code>:{" "}
            <code>secret_ref = &quot;env:PG_PASSWORD&quot;</code> for an externally managed
            secret, or <code>{`${credential} = "…\${VAR}…"`}</code> for a value the backend
            expands at startup. A literal is refused by the engine (GBX0116) rather than written.
            {/* **A way there, not only a sentence about it.** A hidden control
                that names a syntax and leaves the person to find the call is
                half an answer: the description may be long and the same provider
                may be bound twice. This opens the file at the `provider(...)`
                the note is about. */}
            {declared.declared_at != null && (
              <button
                type="button"
                data-provider-credential-edit
                onClick={() => void this.reveals.revealLocation(declared.declared_at!)}
              >
                Edit in the description
              </button>
            )}
          </p>
        )}
      </div>
    );
  }

  /**
   * What the resolution could not decide, and the way to the screen about it.
   *
   * Deliberately thin: `ConflictsWidget` is the domain screen for this array --
   * it carries the code, the help sentence, the related locations and the
   * evidence -- and §9.1 already recorded why the Product view keeps a summary
   * rather than a second full list. This section is the summary with room for the
   * sentence that says where to go.
   */
  /**
   * The diagnostics, read here rather than pointed at.
   *
   * **This stage used to be a doorway.** It rendered two counts and two nearly
   * identical buttons -- `Open Conflicts` and `Show conflicts` -- while the rows
   * that carry the code, the remedy and the location lived only on the Conflicts
   * screen. A stage whose entire content is a way to leave it is not a stage, and
   * a person who navigated to Validation had navigated to the wrong place by
   * definition. eCos shows the list with its counts; DaVinci treats validation as
   * a step of its own before generation. This is that.
   *
   * Summary first, then the list. The counts are the orientation -- how bad is
   * this, and is it blocking -- and orientation before detail is the order every
   * screen in this application reads in.
   *
   * `Open Conflicts` stays, demoted to one link, because the bottom panel is
   * still where the list is read *while* looking at the tree that caused it.
   * Duplication was never the objection; a screen made only of navigation was.
   */
  protected renderValidation(): React.ReactNode {
    const diagnostics = worstFirst(this.store.current.diagnostics);
    const errors = errorsIn(diagnostics);
    const warnings = diagnostics.filter((d) => d.severity === "warning").length;
    return (
      <div className="gbx-validation" data-product-validation>
        <div className="gbx-validation-head">
          <span className="gbx-conflicts-summary">{errors > 0 ? `${errors} blocking errors` : "No blocking errors"}</span>
          <div className="gbx-kv">
            <span>errors</span>
            <span data-validation-errors={errors}>{errors}</span>
          </div>
          <div className="gbx-kv">
            <span>warnings</span>
            <span data-validation-warnings={warnings}>{warnings}</span>
          </div>
        </div>
        {diagnostics.length === 0 ? (
          this.renderNothingToReport()
        ) : (
          <>
            <DiagnosticsList
              diagnostics={diagnostics}
              sorted
              onReveal={(location) => void this.reveals.revealLocation(location)}
              onExplain={(selection) => this.selection.select(selection)}
              // **To the control, in one act.** `onReveal` ends in a text editor
              // and `onExplain` ends in a panel saying why; neither is the box
              // that sets the value. Without this the way from a warning about
              // `mode` to the field named `mode` was to remember the gear, go to
              // Composition, and find it again.
              onConfigure={(gear, field) => {
                this.selection.select({ kind: "gear", id: gear });
                this.showSection("composition");
                // **The field when the diagnostic names one.** Focusing the pane
                // put a person in front of the right form and left them to find
                // the row the message had just named. `data-config-field` is the
                // same hook the suite addresses controls by, so this is reading
                // an existing contract rather than adding a second one.
                requestAnimationFrame(() => {
                  const pane = document.querySelector<HTMLElement>(".gbx-composition-settings");
                  const control =
                    field === undefined
                      ? null
                      : pane?.querySelector<HTMLElement>(
                          `[data-config-field="${field}"] input, [data-config-field="${field}"] select`,
                        ) ?? null;
                  if (control === null) {
                    pane?.focus();
                    return;
                  }
                  control.scrollIntoView({ block: "center" });
                  control.focus();
                });
              }}
            />
            <button
              type="button"
              className="gbx-choice"
              data-validation-open-conflicts
              title="The same list in the bottom panel, readable beside the tree"
              onClick={() => void this.commands.executeCommand("gearbox.conflicts.show")}
            >
              Open beside the tree
            </button>
          </>
        )}
      </div>
    );
  }

  /**
   * The empty half of Validation, which is only empty for one reason.
   *
   * **An empty array is not a clean bill of health.** This rendered "this
   * profile resolved with nothing to report" from `diagnostics.length === 0`
   * alone, and three states produce an empty array without meaning it: `open()`
   * clears the array while `status` is `loading`, `resolveCurrent` sets
   * `resolving` without clearing anything, and `fail()` stores
   * `diagnosticsOf(error) ?? []` -- so an engine error carrying no structured
   * diagnostics rendered as success.
   *
   * Observed as `0 errors / 0 warnings` and the success sentence, with three
   * warnings arriving a moment later. A screen whose job is to say whether
   * anything is wrong must not say "no" while it is still finding out.
   */
  protected renderNothingToReport(): React.ReactNode {
    const { status, error } = this.store.current;
    if (status === "loading" || status === "resolving") {
      return (
        <div className="gbx-empty" role="status" data-validation-pending={status}>
          {status === "loading" ? "Reading the description…" : "Resolving this profile…"} Nothing is
          known about this profile yet.
        </div>
      );
    }
    if (status === "error") {
      return (
        <div className="gbx-empty gbx-error" role="alert" data-validation-failed>
          This profile could not be resolved, so there is nothing to report *yet* rather than
          nothing to report. {error ?? "The engine gave no reason."}
        </div>
      );
    }
    return (
      <div className="gbx-empty" data-validation-clean>
        This profile resolved with nothing to report. Another profile may not: the same description
        resolves differently under each one.
      </div>
    );
  }

  /**
   * One top-level branch: an icon, a name, a count, and a fold.
   *
   * The same fold idiom as the catalogue's categories, deliberately -- two panels
   * in one application should not invent two ways to collapse a list.
   */
  protected renderBranch(
    id: string,
    icon: string,
    title: string,
    count: number,
    children: React.ReactNode,
  ): React.ReactNode {
    const folded = this.collapsed.has(id);
    return (
      <div className="gbx-branch" key={id} data-branch={id}>
        <div
          className="gbx-group-label"
          role="button"
          tabIndex={0}
          aria-expanded={!folded}
          data-collapsed={folded ? "true" : "false"}
          onClick={() => this.toggle(id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              this.toggle(id);
            }
          }}
        >
          <span className={`gbx-twistie codicon codicon-chevron-${folded ? "right" : "down"}`} />
          <span className={`gbx-branch-icon codicon codicon-${icon}`} />
          {title}
          <span className="gbx-group-count">{count}</span>
        </div>
        {!folded && <div className="gbx-branch-body">{children}</div>}
      </div>
    );
  }

  /** Fold or unfold one branch of the topology tree. */
  protected toggle(id: string): void {
    if (!this.collapsed.delete(id)) {
      this.collapsed.add(id);
    }
    this.update();
  }

  protected renderApplication(application: ResolvedApplication): React.ReactNode {
    const focus = this.store.focus;
    const selected = focus?.kind === "application" && focus.id === application.name;
    return (
      <div
        className={`gbx-row gbx-application ${selected ? "gbx-selected" : ""}`}
        key={application.name}
        data-application={application.name}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={() => this.store.setFocus({ kind: "application", id: application.name })}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.store.setFocus({ kind: "application", id: application.name });
          }
        }}
      >
        <span className="gbx-row-name">{application.name}</span>
        <span className="gbx-badge">{application.kind}</span>
        {application.replicas > 1 && <span className="gbx-badge">×{application.replicas}</span>}
        {/* The gears are listed rather than counted because they may overlap
            another application: co-location is a closure, not a partition, and a
            count hides the gear that is linked into two binaries. */}
        <span className="gbx-application-gears">{selected ? application.gears.join(", ") : `${application.gears.length} gears`}</span>
      </div>
    );
  }

  protected renderBinding(binding: ResolvedBinding): React.ReactNode {
    const focus = this.store.focus;
    const selected =
      focus?.kind === "binding" &&
      focus.consumer === binding.consumer &&
      focus.contract === binding.contract;
    return (
      <div
        className={`gbx-row gbx-binding ${selected ? "gbx-selected" : ""}`}
        key={`${binding.consumer}/${binding.contract}`}
        data-binding={`${binding.consumer}/${binding.contract}`}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={() =>
          this.store.setFocus({
            kind: "binding",
            consumer: binding.consumer,
            contract: binding.contract,
          })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.store.setFocus({
              kind: "binding",
              consumer: binding.consumer,
              contract: binding.contract,
            });
          }
        }}
      >
        <span className="gbx-row-name">
          {binding.consumer} → {binding.provider}
        </span>
        <span className="gbx-id">{binding.contract}</span>
        {/* `mode` is derived from placement and never configured, so showing it
            beside the transport is showing a conclusion, not an echo of the
            description (`cpt-gearbox-fr-derive-binding-from-placement`). */}
        {selected && <>
        <span className="gbx-badge" data-mode={binding.mode}>
          {binding.mode}
        </span>
        <span className="gbx-badge">{binding.transport}</span>
        {/* The mechanism names the real code path rather than an abstraction over
            it, which is what lets a reader check the lock against what the
            runtime does. */}
        <span className="gbx-badge" data-mechanism={binding.mechanism}>
          {binding.mechanism}
        </span>
        {binding.critical && <span className="gbx-badge">critical</span>}
        {/* "You asked for X and got Y, because GBXnnnn." The request lives beside
            the outcome precisely so this is an explanation rather than a
            surprise; the full narrative is Explain's job. */}
        {binding.selected.downgraded_by !== null &&
          binding.selected.downgraded_by !== undefined && (
            <span className="gbx-badge gbx-downgraded" data-downgraded-by={binding.selected.downgraded_by}>
              asked {describeChoice(binding.selected.selected)} · {binding.selected.downgraded_by}
            </span>
          )}
        </>}
      </div>
    );
  }
}

/**
 * The fields a profile of this kind has, with the values it holds.
 *
 * `choices` is what turns a text box into a select. It is only ever a closed set
 * the wire already declares -- `Discovery` is `"static" | "directory"` -- and the
 * point is not tidiness: a free-text field for a two-valued enum invites a typo
 * that reaches the description, and the refusal for it comes from the evaluator
 * on the next resolve rather than from the control.
 *
 * **`required` is why a control may not offer to clear itself.** These three --
 * `self_hosted`'s `host` and `worker_discovery`, `kubernetes`'s `discovery` --
 * are non-`Option` named arguments in `gearbox-gdl`'s `product.rs`, so starlark
 * refuses the call outright when one is missing and the product stops opening.
 * Unsetting a field *removes* the argument, so for these the control was a way
 * to make the open product unopenable, on a screen that then stopped rendering:
 * the form was gone, and with it the only way to put the value back.
 *
 * Mirror of `gearbox_gdl::edit_call::required_profile_fields`, which is also
 * where the scaffold values live, and which now refuses the same removal on the
 * engine side for callers that are not this form. Stated twice because one is a
 * form and the other is a grammar, and they must not disagree -- the same
 * arrangement `isSecretConfigKey` has with `is_secret_config_key`.
 */
function profileFields(
  profile: DeploymentProfileDecl,
): ReadonlyArray<{
  wire: string;
  label: string;
  value: string | null | undefined;
  choices?: readonly string[];
  required?: boolean;
}> {
  // Named once: both profile kinds carry a `discovery`, under two different wire
  // names, and the set of values is the same `Discovery` in both.
  const discovery: readonly Discovery[] = ["static", "directory"];
  switch (profile.profile) {
    case "embedded":
      return [];
    case "self_hosted":
      return [
        { wire: "host", label: "host", value: profile.host, required: true },
        {
          wire: "worker_discovery",
          label: "worker_discovery",
          value: profile.discovery,
          choices: discovery,
          required: true,
        },
        { wire: "target_dir", label: "target_dir", value: profile.target_dir },
        { wire: "cargo_profile", label: "cargo_profile", value: profile.cargo_profile },
      ];
    case "kubernetes":
      return [
        {
          wire: "discovery",
          label: "discovery",
          value: profile.discovery,
          choices: discovery,
          required: true,
        },
        { wire: "namespace", label: "namespace", value: profile.namespace },
        { wire: "image_registry", label: "image_registry", value: profile.image_registry },
      ];
  }
}

/**
 * `sdk-cas-default` is not a provider, and saying "provider: x" for it would be
 * wrong in the one case worth noticing: the SDK's content-addressed default
 * layered over a cache, which is what a `dev` profile gets when nothing declared
 * a provider.
 */
function describeClusterResolution(resolution: ClusterResolution): string {
  switch (resolution.via) {
    case "provider":
      return resolution.name;
    case "sdk-cas-default":
      return `sdk cas default over ${resolution.over_cache}`;
    // A named provider with an empty name used to stand here, which read as a
    // provider called nothing. A switch rather than a ternary so the next
    // variant is a compile error in this file instead of a blank cell.
    case "unsatisfied":
      return "unsatisfied";
  }
}

/** `auto` means "you decide", so it has no value to print. */
function describeChoice(choice: Choice<unknown>): string {
  return choice.choice === "explicit" ? String(choice.value) : "auto";
}

/**
 * A summary that leads to the conflicts, rather than the conflicts themselves.
 *
 * This used to print every diagnostic under the tree, and the Conflicts screen now
 * prints the same ones with the parts that matter for acting on them -- the help
 * sentence, the related locations, the evidence, the subject to explain. Two full
 * lists is duplication, and the version squeezed under a tree was the one nobody
 * could act on. eCos's Config Tool makes conflicts a screen for exactly this
 * reason.
 *
 * §9 asks the Product view for "a diagnostics summary", which is what this is: a
 * count, the worst severity, and the way to the detail.
 */
/**
 * The four steps of an open, and which one it is on.
 *
 * **A checklist rather than a spinner, because three seconds is long enough for
 * "which three seconds" to matter.** Opening a product restarts the engine twice
 * and loads a catalogue; a person watching one line that says `Loading
 * payments-demo…` cannot tell a slow catalogue from a description that will
 * never evaluate. Each step says what it is waiting for, in the words a person
 * would use rather than the method names underneath.
 *
 * And a refusal stops the list at the step that refused, with its reason. The
 * message service still gets it -- a refusal nobody saw looks like a hang -- but
 * the screen that was counting the steps is where the answer belongs, rather
 * than the screen reverting to a picker as though nothing had been tried.
 */
type StepState = "done" | "busy" | "waiting" | "failed";

/**
 * The icon per step state, as literal `codicon(...)` calls.
 *
 * A table rather than a conditional inside the call, so that the names are
 * statically visible: `regression.spec.ts` reads `codicon("x")` out of these
 * sources and checks each against the codicon stylesheet, and a name assembled
 * from a ternary escapes that check silently.
 *
 * `waiting` is an outline and `done` is a tick, and the difference is the point:
 * a checklist that pre-ticks its steps is a progress bar in a costume.
 */
const STEP_ICON: Readonly<Record<StepState, string>> = {
  done: codicon("pass"),
  busy: codicon("circle-large-outline"),
  waiting: codicon("circle-large-outline"),
  failed: codicon("error"),
};

/** `GenerateWidget.ID`, named rather than imported: that view imports this one's commands. */
const GENERATE_WIDGET_ID = "gearbox.generate";

function openingSentence(stage: OpeningStage): string {
  const label = OPENING_LABEL[stage];
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}…`;
}

function renderOpening(
  opening: Exclude<OpeningState, { status: "idle" }>,
  previous: ProductRef | undefined,
  leave: (previous: ProductRef | undefined) => void,
): React.ReactNode {
  const at = OPENING_STAGES.indexOf(opening.stage);
  const failed = opening.status === "failed";
  return (
    <div
      className="gbx-opening"
      data-product-opening={opening.product.label}
      data-opening-stage={opening.stage}
      data-opening-status={opening.status}
      aria-busy={!failed}
      role={failed ? "alert" : "status"}
    >
      <div className="gbx-opening-head">
        {failed ? `Could not open ${opening.product.label}` : `Opening ${opening.product.label}…`}
      </div>
      <ol className="gbx-opening-steps">
        {OPENING_STAGES.map((stage, index) => {
          // Three states, and the third is why this is not a progress bar: done,
          // the one in flight, and not yet reached. A step that never ran must
          // not read as a step that passed.
          const state: StepState =
            index < at ? "done" : index === at ? (failed ? "failed" : "busy") : "waiting";
          return (
            <li key={stage} className={`gbx-opening-step gbx-opening-${state}`} data-step={stage}>
              <span className={`${STEP_ICON[state]} gbx-opening-icon`} />
              <span>{OPENING_LABEL[stage]}</span>
              {/* Constructor Studio: the long step says how far it has got -- the
                  catalogue, or the load a kept engine finishes first. */}
              {state === "busy" && opening.status === "opening" &&
                projectionProgress(opening.progress) !== "" && (
                  <span className="gbx-opening-progress" data-opening-progress>
                    {" — "}{projectionProgress(opening.progress)}
                  </span>
                )}
            </li>
          );
        })}
      </ol>
      {failed && (
        <>
          <div className="gbx-error" data-opening-reason>
            {opening.reason}
          </div>
          {/* A refusal is left standing, which means it has to be leavable: with
              another product still open in the store, this screen is the only
              thing between a person and the product they had -- and getting back
              to it means re-opening it, not just clearing this. See
              `leaveFailedOpen`. */}
          <button
            type="button"
            className="gbx-choice"
            data-opening-dismiss
            data-opening-reopen={previous?.path ?? ""}
            onClick={() => leave(previous)}
          >
            {previous === undefined ? "Dismiss" : `Back to ${previous.label}`}
          </button>
        </>
      )}
      {!failed && (
        <div className="gbx-skeleton" aria-hidden="true">
          <span className="gbx-skeleton-row" />
          <span className="gbx-skeleton-row" />
          <span className="gbx-skeleton-row" />
        </div>
      )}
    </div>
  );
}

function renderDiagnosticsSummary(
  diagnostics: readonly Diagnostic[],
  show: () => void,
): React.ReactNode {
  if (diagnostics.length === 0) return undefined;
  const errors = errorsIn(diagnostics);
  // `worstOf`, not `diagnostics[0].severity`. The engine orders by `(code,
  // message)` for determinism, so the first element is the lowest code: a
  // product carrying `GBX0504` (info) and `GBX0602` (warning) painted itself
  // info-coloured. The `errors > 0` branch was covering for that and only for
  // the top severity.
  const worst = worstOf(diagnostics) ?? "info";
  return (
    <div className={`gbx-diagnostics gbx-diagnostics-${String(worst).toLowerCase()}`}>
      <div className="gbx-diagnostics-label">
        {diagnostics.length} diagnostic(s)
        {errors > 0 && `, ${errors} blocking`}
      </div>
      <button type="button" className="gbx-choice" data-show-conflicts onClick={show}>
        Show conflicts
      </button>
    </div>
  );
}
