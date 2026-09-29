// Where the two views live in the shell, and the commands that open them.

import {
  AbstractViewContribution,
  FrontendApplicationContribution,
  codicon,
} from "@theia/core/lib/browser";
import { FrontendApplicationStateService } from "@theia/core/lib/browser/frontend-application-state";
import {
  ConnectionStatus,
  ConnectionStatusService,
} from "@theia/core/lib/browser/connection-status-service";
import { CommonMenus } from "@theia/core/lib/browser/common-menus";
import { Command, CommandRegistry, MenuModelRegistry } from "@theia/core/lib/common";
import { Widget } from "@theia/core/shared/@lumino/widgets";
import { inject, injectable } from "@theia/core/shared/inversify";

import { CatalogueStore } from "./catalogue-store";
import { CatalogueWidget } from "./catalogue/catalogue-widget";
import { ConflictsWidget } from "./conflicts/conflicts-widget";
import { CreateProductWidget, type CreateProductState } from "./create/create-product-widget";
import { CreateGearWidget, type CreateGearState } from "./create/create-gear-widget";
import { AddGearDialog, type AddGearChoice } from "./add-gear/add-gear-dialog";
import { ProductEditService } from "./product-edit-service";
import { GraphWidget } from "./graph/graph-widget";
import { InspectorWidget } from "./inspector/inspector-widget";
import { GenerateWidget } from "./generate/generate-widget";
import { LockWidget } from "./lock/lock-widget";
import { GearboxMenus, VIEW_CATALOGUE } from "./menus";
import { ProductStore } from "./product-store";
import { ProductWidget } from "./product/product-widget";
import { GearAuthorWidget } from "./gear/gear-author-widget";
import { EngineConnectionService } from "./shell/engine-connection-service";
import { ProductSessionService } from "./shell/product-session-service";
import {
  ADD_GEAR,
  BROWSE_CATALOGUE,
  NEW_PRODUCT,
  SHOW_CONFLICTS,
  SHOW_GENERATE,
  SHOW_PRODUCT,
} from "./shell/session-command-ids";
import {
  ENGINE_DOWN,
  NO_PRODUCT,
  addGearEntrance,
  explained,
  productCommandRefusal,
  type ProductCommandState,
} from "./shell/command-availability";
import { PendingCreate } from "./create/pending-create";
import { SelectionService } from "./shell/selection-service";
import {
  availableIn,
  focusScreens,
  identityOf,
  whenClauseFor,
  type ContextIdentity,
  type OwnedWidget,
} from "./shell/screens";
import { FocusModeService } from "./shell/focus-mode-service";
import {
  HAS_SELECTION_KEY,
  STUDIO_CONTEXT_KEY,
  StudioContextService,
} from "./shell/studio-context-service";
import { StartWidget } from "./start/start-widget";

export const RELOAD_CATALOGUE: Command = {
  id: "gearbox.catalogue.reload",
  label: "Gearbox: Reload Catalogue",
  shortTitle: "Reload Catalogue",
  iconClass: codicon("refresh"),
};

export const RESOLVE_PRODUCT: Command = {
  id: "gearbox.product.resolve",
  label: "Gearbox: Resolve Product",
  shortTitle: "Resolve",
  iconClass: codicon("sync"),
};

/**
 * A view that belongs to a context, and knows which entrance opened it.
 *
 * `AbstractViewContribution` registers three things per view and gates none of
 * them: an always-enabled toggle command, a `when`-less entry in `View > Views`,
 * and a `when`-less item in `Open View...`. That is why a UX pass found
 * `View > Add Gear` live with no product open, and why it opened an empty panel:
 * three surfaces, one of which nobody had thought to check.
 *
 * **Four surfaces, because four different pieces of code read them.** The menu
 * re-evaluates `when` as it opens; the palette filters on `isVisible &&
 * isEnabled` (`quick-command-service.js:191`); a keybinding reaches the handler
 * directly; and `Open View...` reads neither menus nor commands -- it filters
 * `QuickViewItem.when` and *nothing else*, which is why a gate that must reach
 * it has to be a context key rather than a predicate.
 *
 * **This class never chains to `AbstractViewContribution`'s versions**, and a
 * subclass must not reach past it either. `CommandRegistry.registerCommand` on
 * an id that already exists logs `is already registered` and keeps the *first*
 * handler, and `registerMenuAction` does not deduplicate at all -- so
 * registering both would install the ungated pair and then quietly win with
 * them. Two claims in `tests/regression.spec.ts` assert that pair of symptoms.
 * A subclass calling `super.registerCommands(...)` is calling *this* class and
 * is correct.
 */
@injectable()
export abstract class ScopedViewContribution<T extends Widget> extends AbstractViewContribution<T> {
  @inject(StudioContextService) protected readonly contexts!: StudioContextService;
  @inject(FocusModeService) protected readonly focus!: FocusModeService;

  /**
   * Whether this view may be opened in the context that is current.
   *
   * Structural: it answers "does this screen exist here at all", and it is what
   * hides the entry rather than greying it out.
   */
  protected availableHere(): boolean {
    return availableIn(this.viewId, this.contexts.current.kind);
  }

  /**
   * A further gate a subclass adds -- the engine being up, a selection existing.
   *
   * Separate from `availableHere` because the two deserve different treatment:
   * a screen that does not belong here is *absent*, and one that belongs here
   * but cannot act yet is *disabled*. A Generate entry that vanishes when the
   * websocket blinks reads as a broken application.
   */
  protected canOpen(): boolean {
    return true;
  }

  /**
   * The `when` clause for the two surfaces that take one.
   *
   * Availability by default; a subclass whose gate is not the context overrides
   * it -- see `InspectorViewContribution`, whose emptiness is about a selection.
   */
  protected whenClause(): string | undefined {
    return whenClauseFor(this.viewId, STUDIO_CONTEXT_KEY);
  }

  /**
   * What a **generic** entrance does: `Open View...`, the palette, a keybinding.
   *
   * Toggling, for an ordinary view. A stateful screen overrides this to *reveal*
   * without re-seeding, because seeding is a reset -- see the `open*`/`reveal*`
   * pair on the three wizards.
   */
  protected revealView(): Promise<unknown> {
    return this.toggleView();
  }

  protected registerScopedToggle(commands: CommandRegistry, overrides?: Partial<Command>): void {
    const toggle = this.toggleCommand;
    if (toggle === undefined) return;
    commands.registerCommand(
      { ...toggle, ...overrides },
      {
        execute: () => void this.revealView(),
        isEnabled: () => this.availableHere() && this.canOpen(),
        // Availability only. See `canOpen`: a transient refusal stays visible.
        isVisible: () => this.availableHere(),
      },
    );
    this.quickView?.registerItem({
      label: this.viewLabel,
      when: this.whenClause(),
      open: () => void this.revealView(),
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    this.registerScopedToggle(commands);
  }

  override registerMenus(menus: MenuModelRegistry): void {
    const toggle = this.toggleCommand;
    if (toggle === undefined) return;
    menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
      commandId: toggle.id,
      label: this.viewLabel,
      when: this.whenClause(),
    });
  }

  /**
   * Record which subject opened a screen, so the sweep can withdraw it.
   *
   * Called from the `open*` path and never from `reveal*`: a widget that already
   * exists keeps the owner it was opened with. One owned by another subject
   * would have been withdrawn already, so there is nothing to re-stamp.
   */
  protected stampOwner(widget: OwnedWidget): void {
    widget.ownerIdentity = this.currentIdentity();
  }

  protected currentIdentity(): ContextIdentity {
    return identityOf(this.contexts.current);
  }

  /**
   * Open this view, folding the side panels first when it is a screen that
   * wants the room.
   *
   * **Before, and awaited.** Folding after the widget is on screen relayouts it
   * under whatever the person is already doing, and a collapse that replaces the
   * node between mousedown and mouseup produces no click at all -- measured on
   * the Graph's own view switch. Arranging the room first is the same rule the
   * context preset follows for the same reason.
   */
  protected async openFocused(args?: Parameters<this["openView"]>[0]): Promise<void> {
    if (focusScreens().includes(this.viewId)) {
      this.focus.enterFocus(this.viewId);
    }
    await this.openView(args ?? { activate: true, reveal: true });
  }
}

@injectable()
export class CatalogueViewContribution
  extends ScopedViewContribution<CatalogueWidget>
  implements FrontendApplicationContribution
{
  @inject(CatalogueStore) protected readonly store!: CatalogueStore;
  @inject(ConnectionStatusService)
  protected readonly connection!: ConnectionStatusService;
  // Reached from here because the reconnect edge is one event and both stores
  // went stale on it. The alternative -- a second contribution listening to the
  // same event -- would also have to know to run after this one, since it is
  // `CatalogueStore.load()` that calls `initialize` and so respawns the engine
  // a product resolve needs.
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;

  constructor() {
    super({
      widgetId: CatalogueWidget.ID,
      widgetName: CatalogueWidget.LABEL,
      defaultWidgetOptions: { area: "left", rank: 100 },
      toggleCommandId: "gearbox.catalogue.toggle",
    });
  }

  /**
   * Start the one load, here rather than in the widget.
   *
   * The widget is closable and transient, so a load in its `postConstruct` ran
   * again every time the panel was reopened -- including in the middle of a
   * projection, where the first load's pending set would land on top of the
   * second's already-projected rows. The application starts exactly one; the
   * reload command starts the rest.
   *
   * `onStart` and not `initializeLayout`: the latter is skipped entirely when
   * there is a saved layout, which would leave a returning user with a panel
   * that never loads.
   */
  onStart(): void {
    // `load()` does not reject -- a failure becomes the store's error state,
    // which the panel renders.
    void this.store.load();
    this.reloadOnReconnect();
  }

  /**
   * Load again after the backend connection comes back.
   *
   * Not a nicety. `frontendConnectionTimeout` is `0`, so a closed socket
   * disposes the backend contribution at once, and
   * `gearbox-studio-backend-module.ts` disposes the service -- and its engine --
   * with it. The frontend, meanwhile, reconnects in place: same page, same
   * stores, same rendered tree, now backed by a fresh `GearboxServiceImpl` that
   * has never seen `initialize`. Nothing called `initialize` a second time,
   * because the only caller is `onStart` and the application already started.
   * The result was a panel showing a complete catalogue where every action
   * answered "the engine is not running", until someone thought to hit Reload.
   *
   * Reloading rather than raising the timeout or setting `reloadOnReconnect`:
   * both of those are decisions about the whole application -- a longer timeout
   * keeps every backend contribution alive for a window that may never return,
   * and `reloadOnReconnect` throws away editor state to fix a catalogue. The
   * thing that actually went stale is this store, and it knows how to refill
   * itself.
   */
  protected reloadOnReconnect(): void {
    let offline = this.connection.currentStatus === ConnectionStatus.OFFLINE;
    this.connection.onStatusChange((status) => {
      if (status === ConnectionStatus.OFFLINE) {
        offline = true;
        // Theia is offline; the engine process behind the socket is gone with it.
        // Mark that before the reconnect load so New Product / Resolve / Generate
        // do not stay enabled against a dead session.
        this.engine.markDisconnected("backend connection lost");
        return;
      }
      // Only the offline-to-online edge. `onStatusChange` also fires for
      // ONLINE-to-ONLINE on some paths, and a load per ping is not a load.
      if (offline) {
        offline = false;
        void this.store.load().then(() => {
          // Only if a product was open. Discovering one here would open a panel
          // nobody asked for, on the strength of a dropped websocket.
          if (this.products.current.open !== undefined) {
            void this.products.reload();
          }
        });
      }
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(RELOAD_CATALOGUE, {
      execute: () => this.store.load(),
    });
    // Opens rather than toggles: Start's "Browse Catalogue" must never hide an
    // already-open panel the way the View toggle would.
    commands.registerCommand(BROWSE_CATALOGUE, {
      execute: () => this.openView({ activate: true, reveal: true }),
    });
  }

  /**
   * `Reload Catalogue` under **View**, beside the panel it acts on.
   *
   * It was under Product, on the rule that "View lists panels and Product lists
   * things to do". The rule survives; the placement does not. Re-reading the
   * source roots is not a verb on a product -- it works with none open, and it is
   * about the catalogue -- and having it in the Product menu is part of what made
   * that menu look like it had work to offer with no product. `View > Catalogue`
   * is where the panel already lives.
   *
   * The panel *toggle* is still not registered here: `AbstractViewContribution`
   * puts every toggle under `View > Views`, and registering it twice under two
   * different words was the original duplication.
   */
  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(VIEW_CATALOGUE, {
      commandId: RELOAD_CATALOGUE.id,
      label: "Reload Catalogue",
      order: "2",
    });
  }

  /**
   * Open the catalogue by default: it is the reason this application exists.
   *
   * `initializeLayout`, not `onStart`. Two reasons, and the first was a real bug:
   * `onStart` runs before the shell is attached, so the panel was opened and then
   * left collapsed by layout setup -- the widget stayed in the DOM, queryable and
   * invisible. And `initializeLayout` only runs when there is no saved layout, so
   * a person who closes the panel does not get it forced back open next time.
   */
  async initializeLayout(): Promise<void> {
    await this.openView({ activate: true, reveal: true });
  }
}

/**
 * The Home screen.
 *
 * **It no longer opens itself, and that is the point of the change.** It used to
 * subscribe to the context and open on every change to Home, which fired
 * *before* the perspective switch had applied its layout -- so it raced the very
 * reconciliation that now owns this. `ScreenScopeService.reassertPrimary` calls
 * `openView` here once the layout has settled, and it is the only thing that
 * does; a second owner of "what is in front", however well guarded, is what
 * produced the front-stealing ADR-0011 records.
 *
 * It deliberately does **not** open from `initializeLayout` either: that runs
 * before a saved product layout is restored and would park Start behind a
 * product the restorer still intends to show.
 */
@injectable()
export class StartViewContribution extends ScopedViewContribution<StartWidget> {
  constructor() {
    super({
      widgetId: StartWidget.ID,
      widgetName: StartWidget.LABEL,
      defaultWidgetOptions: { area: "main" },
      // **No toggle command, and therefore no entry in `View`.** Every other view
      // is something a person chooses to look at; this one is what the shell shows
      // when there is nothing open, and it arrives by closing a product rather than
      // by being picked from a list. A toggle would also have read as
      // `Gearbox Studio` among seven `Gearbox <noun>` views -- the application's
      // own name sitting in a list of its panels.
    });
  }

  // **Closed when the context leaves Home, and this is the fourth attempt.** The
  // three before it failed for two recorded reasons, and both are gone. Closing
  // while a perspective switch is applying a layout lost a race with
  // `setLayoutData` and poisoned the snapshot -- the withdrawal now runs after
  // `StudioContextService.settled()`, which waits for the *latest* switch rather
  // than the one that happened to be pending. And closing after the layout
  // settled let Lumino's "activate a sibling when the active widget goes" rule
  // take the front from whatever the person had since opened -- the withdrawal
  // now ends by re-asserting the context's own screen, through the contribution
  // that owns the rule.
  //
  // What made the previous attempts necessary is unchanged: a Start screen in
  // front of an open product is a hybrid state. What changed is that "behind the
  // product" is no longer the only way to express that, because there is now one
  // component deciding what may be on screen at all.
}

@injectable()
export class CreateProductViewContribution extends ScopedViewContribution<CreateProductWidget> {
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;

  constructor() {
    super({
      widgetId: CreateProductWidget.ID,
      widgetName: CreateProductWidget.LABEL,
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.product.create.toggle",
    });
  }

  /**
   * The toggle is gated on the engine too, and that was a hole a claim found.
   *
   * `NEW_PRODUCT` refuses while the engine is down, but
   * `AbstractViewContribution` also registers `View: Toggle New Product`, which
   * opened the same wizard by the same door -- the blank tab the UX report
   * described. Gating one command and leaving its twin in the palette is the
   * palette lesson from ADR-0011 in miniature: a surface is only suppressed on
   * the surfaces somebody checked. `ScopedViewContribution` now registers the
   * toggle; this only says what else has to be true.
   */
  protected override canOpen(): boolean {
    return this.engine.isConnected;
  }

  /**
   * A generic entrance reveals; it does not re-seed.
   *
   * `openWith(undefined)` is a *reset* -- it clears the clone source, the git
   * fields and the destination -- so routing `Open View...` through `openCreate`
   * would destroy a half-filled form. The domain commands keep calling
   * `openCreate`, which is where seeding belongs.
   */
  protected override async revealView(): Promise<unknown> {
    if (this.tryGetWidget() !== undefined) {
      return this.openFocused();
    }
    return this.openCreate();
  }

  async openCreate(state?: CreateProductState): Promise<void> {
    // **Seeded before the view is activated.** `openView` then `openWith`
    // painted the panel once with whatever the last visit left in it -- or empty
    // on a first open -- and then again with the state that was asked for, which
    // a UX pass saw as a blank tab that filled in a moment later. `getOrCreateWidget`
    // is what `openView` uses internally, so this costs one lookup and no
    // second construction.
    const widget = await this.widgetManager.getOrCreateWidget<CreateProductWidget>(
      CreateProductWidget.ID,
    );
    this.stampOwner(widget);
    widget.openWith(state);
    await this.openFocused();
  }
}

@injectable()
export class CreateGearViewContribution extends ScopedViewContribution<CreateGearWidget> {
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;

  constructor() {
    super({
      widgetId: CreateGearWidget.ID,
      widgetName: CreateGearWidget.LABEL,
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.gear.create.toggle",
    });
  }

  /** Gated like the product wizard's toggle, and for the same reason. */
  protected override canOpen(): boolean {
    return this.engine.isConnected;
  }

  /** Reveals rather than re-seeds -- see the product wizard's `revealView`. */
  protected override async revealView(): Promise<unknown> {
    if (this.tryGetWidget() !== undefined) {
      return this.openFocused();
    }
    return this.openCreate();
  }

  async openCreate(state?: CreateGearState): Promise<void> {
    // Seeded first -- see `CreateProductViewContribution.openCreate`.
    const widget = await this.widgetManager.getOrCreateWidget<CreateGearWidget>(CreateGearWidget.ID);
    this.stampOwner(widget);
    widget.openWith(state);
    await this.openFocused();
  }
}

@injectable()
export class GearAuthorViewContribution extends ScopedViewContribution<GearAuthorWidget> {
  constructor() {
    super({
      widgetId: GearAuthorWidget.ID,
      widgetName: GearAuthorWidget.LABEL,
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.gear.author.toggle",
    });
  }
}

@injectable()
export class AddGearViewContribution extends ScopedViewContribution<Widget> {
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  // Handed to the dialog, which needs a way back when the engine stops while it
  // is open: a modal dialog covers the panel's own Reconnect button, so
  // recovery has to be reachable from inside the thing that is on top.
  @inject(ProductSessionService) protected readonly addSession!: ProductSessionService;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(CommandRegistry) protected readonly compositionCommands!: CommandRegistry;
  private dialog?: AddGearDialog;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;
  @inject(PendingCreate) protected readonly pendingCreate!: PendingCreate;

  /**
   * **A contribution with no widget of its own, deliberately.**
   *
   * Adding a gear is a modal dialog now, so there is nothing for the layout to
   * restore and nothing for `openView` to build -- `revealView` below opens the
   * dialog instead, and that is every entrance this contribution has.
   *
   * `widgetId` stays `gearbox.add-gear` all the same, because it is the key the
   * scoping tables are written against and what they scope is the *entrance*,
   * which still exists: `availableIn` and `whenClauseFor` read it to keep
   * `View > Add Gear` and `Open View...` off Home. An id absent from `SCREENS`
   * reads as "not ours" and is permitted everywhere, which is the hole this
   * pair was written to close.
   *
   * `defaultWidgetOptions` is required by Theia's own options type and means
   * nothing here: only `openView` reads it, and `revealView` never reaches it.
   */
  constructor() {
    super({
      widgetId: "gearbox.add-gear",
      widgetName: "Add Gear",
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.product.addGear.toggle",
    });
  }

  protected override canOpen(): boolean {
    return this.engine.isConnected;
  }

  protected override async revealView(): Promise<unknown> { return this.openAdd(); }

  /** Whether a product is open, being opened, and the engine up -- what Add gear decides by. */
  protected productState(): ProductCommandState {
    return {
      productOpen: this.products.current.open !== undefined,
      opening: this.addSession.opening !== undefined,
      engineConnected: this.engine.isConnected,
    };
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    // With no product open this creates one instead -- see `addGearEntrance`.
    // The menu entry below stays gated on a product; the palette and Studio's
    // ribbon reach this with none, and New Product is the useful answer there.
    commands.registerCommand(ADD_GEAR, explained({
      execute: (state?: AddGearChoice) => {
        if (addGearEntrance(this.productState()).kind === "create-product") {
          this.pendingCreate.state = { note: "No product is open. Create one here, then add gears to it." };
          return void commands.executeCommand(NEW_PRODUCT.id);
        }
        return void this.openAdd(state);
      },
      isEnabled: () => addGearEntrance(this.productState()).kind !== "unavailable",
      disabledReason: () => {
        const entrance = addGearEntrance(this.productState());
        return entrance.kind === "unavailable" ? entrance.reason : undefined;
      },
    }));
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_RESOLVE, {
      commandId: ADD_GEAR.id,
      label: "Add Gear…",
      order: "0",
      when: `${STUDIO_CONTEXT_KEY} == 'product'`,
    });
  }

  async openAdd(state?: AddGearChoice): Promise<void> {
    if (!this.products.current.open || !this.engine.isConnected) return;
    if (this.dialog && !this.dialog.isDisposed) { this.dialog.activate(); return; }
    const dialog = new AddGearDialog(this.catalogue, this.products, this.edits, this.selection, this.compositionCommands, this.addSession, state);
    this.dialog = dialog;
    try {
      const added = await dialog.open();
      // **Only when nothing was added.** A successful add moves the focus to
      // the settings pane on purpose -- the gear is in the product and the next
      // thing to do is configure it -- so restoring here would fight it.
      if (added !== true) this.returnFocus(state);
    } finally { dialog.dispose(); if (this.dialog === dialog) this.dialog = undefined; }
  }

  /**
   * Put the keyboard back where it was when the dialog opened.
   *
   * **Theia already does this and it does not survive a re-render.**
   * `AbstractDialog` saves `document.activeElement` at `open()` and focuses it
   * on `close()`; but the Composition tree re-renders while the dialog is up --
   * a resolve arrives, a draft changes -- so the node it saved is detached by
   * then, focusing a detached element does nothing, and focus falls to the body.
   * Escape closed the dialog and left the keyboard nowhere.
   *
   * So the control is found again by what it *is* rather than by the node it
   * was, which is the same reason the conformance fixtures address controls by
   * `data-*`. The choice that opened the dialog says which control that is.
   */
  protected returnFocus(state?: AddGearChoice): void {
    const selector =
      state?.host !== undefined && state.point !== undefined
        ? `[data-add-plugin-for="${state.host}:${state.point}"]`
        : state?.gearId !== undefined
          ? `[data-toggle-gear="${state.gearId}"]`
          : "[data-add-gear]";
    requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
  }
}

@injectable()
export class GraphViewContribution extends ScopedViewContribution<GraphWidget> {
  /** The graph is a drawing; it takes the room, like the wizards. */
  protected override async revealView(): Promise<unknown> {
    if (this.tryGetWidget()?.isVisible === true) return this.closeView();
    return this.openFocused();
  }

  constructor() {
    super({
      widgetId: GraphWidget.ID,
      widgetName: GraphWidget.LABEL,
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.graph.toggle",
    });
  }
}

/**
 * The one panel that answers about a selection.
 *
 * Replaces `DetailViewContribution` and `ExplainViewContribution`. They opened
 * two bottom tabs that answered about two different selections, so the second one
 * was empty in the ordinary case -- see `InspectorWidget` for why that was worth
 * merging rather than wiring together.
 */
@injectable()
export class InspectorViewContribution
  extends ScopedViewContribution<InspectorWidget>
  implements FrontendApplicationContribution
{
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(FrontendApplicationStateService)
  protected readonly appState!: FrontendApplicationStateService;

  constructor() {
    super({
      widgetId: InspectorWidget.ID,
      widgetName: InspectorWidget.LABEL,
      // **The right panel, since 2026-09-07.** It was the bottom area, so that
      // the tree, the graph and the answer were readable at once, and the reason
      // given for not using a side panel was that this content was clipped there
      // -- which was true of a two-column layout in a narrow panel, and is what
      // the single-column rules in `index.css` answer. What the bottom strip cost
      // was worse and was measured by a UX pass: at an ordinary window height one
      // configuration field is visible and the rest needs an inner scroll, in the
      // panel that *is* the gear configurator. A configurator's properties area
      // belongs beside the tree it is about, which is where every tool in this
      // class puts it.
      //
      // Conflicts stays in the bottom area: it is read *while* looking at the
      // tree that caused the complaint, and it is a list rather than a form.
      defaultWidgetOptions: { area: "right", rank: 100 },
      toggleCommandId: "gearbox.inspector.toggle",
    });
  }

  /**
   * Gated on its *subject*, not on the context.
   *
   * This panel belongs to all three contexts -- a catalogue row is worth
   * explaining on Home -- so availability is the wrong axis. What makes it empty
   * is an absent selection, and that is what the gate says. The context key
   * rather than `canOpen()` alone because `Open View...` reads `when` and
   * nothing else.
   */
  protected override whenClause(): string | undefined {
    return HAS_SELECTION_KEY;
  }

  protected override canOpen(): boolean {
    return this.selection.current !== undefined;
  }

  onStart(): void {
    // **Opens for the acts it can explain, and not for the one that configures.**
    //
    // This opened on every selection change, which over the Composition stage
    // expanded a second editable copy of the form the person was already using,
    // over one draft, and took the focus doing it. The fix before this one
    // suppressed the open while the Composition pane was the current main
    // widget -- one widget asking another which stage it was on, to work around
    // a selection that stood for two different acts.
    //
    // The selection says which act it is now, so the question is answerable
    // where it is asked. `gear` and `plugin` are the Composition tree's own
    // acts: the pane beside that tree is already showing what was chosen, and a
    // panel expanding over it says nothing new. Everything else -- a catalogue
    // gear, an application, a binding -- is chosen somewhere that does not
    // explain it, and the Inspector is where the explanation is.
    //
    // A `catalogue-row` is skipped for the older reason: it has no descriptor
    // join yet, and stealing focus for an empty "still parsing" panel is worse
    // than waiting for the projected gear.
    this.selection.onDidChange((current) => {
      if (current === undefined) return;
      if (current.kind === "catalogue-row") return;
      if (current.kind === "gear" || current.kind === "plugin") return;
      void this.openView({ activate: true, reveal: true });
    });


    // After a reload the layout restorer may leave the panel empty while
    // `initializeLayout` is skipped (a saved layout exists). Re-open without
    // stealing focus so the Inspector stays reachable.
    //
    // **Not on Home, and not revealed.** On Home nothing is selected, so this
    // used to open a panel whose whole content is "select something" -- which
    // §9.1 already calls worse than an absent one -- and now that the panel is
    // the right side, revealing it would expand a side panel over the Start
    // screen. `reveal: false` still creates and attaches the widget, which is
    // what the boot-completeness check in the fixture waits for.
    void this.appState.reachedState("ready").then(() => {
      if (this.contexts.current.kind === "home") return;
      void this.openView({ activate: false, reveal: false });
    });
  }

  async initializeLayout(): Promise<void> {
    // Not activated: whatever the person is choosing from keeps focus, because
    // making a selection is what fills this panel.
    await this.openView({ activate: false, reveal: true });
  }
}

/**
 * The Product workspace, opened by the act of opening a product.
 *
 * This was deliberately *not* a `FrontendApplicationContribution`, on the
 * argument that it "opens on request" and so had no member of that interface to
 * implement. That reasoning was sound about `initializeLayout` and wrong about
 * the request: the only thing that ever opened this view was the Product
 * perspective's `onActivate`, and a perspective switch is silently skipped when
 * the shell already believes that perspective is active -- which it does after
 * any reload with a product open (`StudioContextService.recompute` records the
 * mechanism). So opening a product updated the header, the catalogue and the
 * status, and left Home in the centre.
 *
 * It now opens itself for the same reason `StartViewContribution` does, and by
 * the same means: from a session signal rather than from a layout event. Two
 * signals, because they answer different questions -- `onDidChangeOpening` puts
 * the view up *while* the engine restarts twice (~3 s), and `onDidChange` covers
 * a product that arrives without going through this client's open path.
 */
@injectable()
export class ProductViewContribution
  extends ScopedViewContribution<ProductWidget>
  implements FrontendApplicationContribution
{
  @inject(ProductStore) protected readonly store!: ProductStore;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;

  constructor() {
    super({
      widgetId: ProductWidget.ID,
      widgetName: ProductWidget.LABEL,
      // The main area: a product is an object of work in its own right, not a
      // detail of the catalogue. The Product perspective opens it; the toggle
      // still opens it on request from Catalogue, so a person is not forced
      // through the switch to look at one description.
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.product.toggle",
    });
  }

  onStart(): void {
    // **The opening signal only.** This used to listen to the context as well,
    // and that second subscription is now `ScreenScopeService.reassertPrimary`'s
    // job -- keeping both meant two components activating this view for the same
    // transition, at different points in the same second, and the second one
    // re-rendered the panel under whatever the person had just clicked. Measured
    // as the Product view's own stage tabs refusing to switch.
    //
    // What stays is the part the context cannot express: `onDidChangeOpening`
    // fires *before* there is a product, so the panel can say which product it is
    // waiting for during the two engine spawns an open costs.
    this.session.onDidChangeOpening(() => void this.openIfProduct());
  }

  /**
   * Put the Product workspace on screen, unless the person is looking at
   * something they chose.
   *
   * Opened, never merely activated: `activateWidget` on a widget nobody has
   * built is a silent no-op, which is the trap §9.1 records three times.
   * `openView` is idempotent, so the ordinary case costs one lookup.
   *
   * **Public, and called by the Product perspective too**, so that the rule below
   * has one definition. Two callers wanting the same view in front for two
   * reasons is how a late activation ends up stealing the front from a panel a
   * person opened a moment ago.
   */
  async openIfProduct(): Promise<void> {
    if (this.session.opening === undefined && this.store.current.open === undefined) return;
    if (!this.mayTakeTheFront()) {
      // Still opened -- the context is a product and this view must exist -- but
      // not brought forward.
      await this.openView({ activate: false, reveal: false });
      return;
    }
    await this.openView({ activate: true, reveal: true });
  }

  /**
   * Whether the Product view may become the current tab in the main area.
   *
   * The Start screen loses to it -- that is the whole point of opening a
   * product. An editor loses to it too: a restored layout parks one over the
   * Product view, and the subject of the context should win that. **Another
   * Gearbox surface wins**, because Add Gear, Generate, Lock and the Graph are
   * things a person navigated to on purpose, and this method can run seconds
   * after they did: `ApplicationShell.activateWidget` waits on `waitForRevealed`
   * (polls with no timeout) and `waitForActivation` (2.25 s), so a perspective
   * switch that activates several widgets lands its last one long after the
   * interaction that started it. Measured at 2.5 s, which was long enough to
   * take every Add Gear claim down at once.
   */
  protected mayTakeTheFront(): boolean {
    const current = this.shell.getCurrentWidget("main");
    if (current === undefined) return true;
    if (current.id === ProductWidget.ID || current.id === StartWidget.ID) return true;
    return !current.id.startsWith("gearbox.");
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    // **Shows, never toggles**, and exists for the wizards. Both of them end by
    // opening or editing a product and then closing themselves, and the panel
    // that should be in front afterwards is the product's. Asking for it by
    // command rather than by injection keeps the wizards free of a dependency on
    // this contribution -- and `mayTakeTheFront` deliberately refuses to steal
    // the front from a Gearbox surface, so a wizard has to *ask*.
    commands.registerCommand(SHOW_PRODUCT, explained({
      execute: async (section?: import("./product/product-widget").ProductSection) => { const widget = await this.openView({ activate: true, reveal: true }); if (section) widget.showSection(section); },
      isEnabled: () => this.store.current.open !== undefined,
      disabledReason: () => productCommandRefusal({
        productOpen: this.store.current.open !== undefined,
        opening: this.session.opening !== undefined,
        engineConnected: this.engine.isConnected,
      }),
    }));
    commands.registerCommand(RESOLVE_PRODUCT, {
      // Re-resolves whatever is open for whatever profile is selected, which is
      // what "resolve" means once a product is on screen. Opening one is the
      // toggle command's job.
      execute: () => this.store.reload(),
      isEnabled: () => this.store.current.open !== undefined && this.engine.isConnected,
    });
  }

  /**
   * `Resolve Product`, and not the panel toggle -- see `CatalogueViewContribution`
   * for the rule. The Product view is reached from `View`, or by opening a product,
   * which is what the Product perspective is for.
   */
  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_RESOLVE, {
      commandId: RESOLVE_PRODUCT.id,
      label: "Resolve Product",
      order: "2",
      // **Every entry in this menu carries the gate, not just some.** The
      // submenu's own `when` did not hide it: a UX pass found `Product` in the
      // bar with no product open, offering Conflicts, Lock and Generate as
      // though they had a subject. Theia's menu bar omits a submenu whose items
      // are all invisible, so gating the items is what actually removes it -- and
      // the claim in `adr-0011-ide-shell.spec.ts` now asserts the absence rather
      // than only naming it.
      when: `${STUDIO_CONTEXT_KEY} == 'product'`,
    });
  }
}

/**
 * Conflicts, in the bottom area beside the Inspector.
 *
 * Bottom rather than main: it is read *while* looking at the tree that caused the
 * complaint, and a conflict list that replaces the product is a list you cannot
 * act on. Not opened by `initializeLayout` either -- a panel that appears at
 * startup to say "no conflicts" is a panel that says nothing.
 */
@injectable()
export class ConflictsViewContribution extends ScopedViewContribution<ConflictsWidget> {
  constructor() {
    super({
      widgetId: ConflictsWidget.ID,
      widgetName: ConflictsWidget.LABEL,
      defaultWidgetOptions: { area: "bottom" },
      toggleCommandId: "gearbox.conflicts.toggle",
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    // Opens rather than toggles -- see `SHOW_CONFLICTS`. Gated like the toggle
    // beside it: leaving the *show* command ungated is the same hole the
    // `View: Toggle New Product` twin was, one command along.
    commands.registerCommand(SHOW_CONFLICTS, explained({
      execute: () => this.openView({ activate: true, reveal: true }),
      isEnabled: () => this.availableHere(),
      disabledReason: () => (this.availableHere() ? undefined : NO_PRODUCT),
    }));
  }

  /**
   * In the Product menu, because looking at what the resolution could not decide
   * is one of the few things there is to *do* to a product -- the exception to
   * "View lists panels" that the rule was written to allow.
   */
  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_RESOLVE, {
      // `SHOW_CONFLICTS`, not the toggle: a menu entry that hides the screen when
      // the screen is open is the `BROWSE_CATALOGUE` defect again. The toggle
      // stays in `View > Views`, where toggling a panel is the point.
      commandId: SHOW_CONFLICTS.id,
      label: "Conflicts",
      order: "3",
      when: `${STUDIO_CONTEXT_KEY} == 'product'`,
    });
  }
}

@injectable()
export class LockViewContribution extends ScopedViewContribution<LockWidget> {
  constructor() {
    super({
      widgetId: LockWidget.ID,
      widgetName: LockWidget.LABEL,
      // The main area, beside Product: the lock is the same object seen at full
      // fidelity, and reading it means scrolling a few hundred lines. In the
      // bottom strip it would be a keyhole.
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.lock.toggle",
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_RESOLVE, {
      commandId: this.toggleCommand?.id ?? "",
      label: "Resolution Lock",
      order: "4",
      when: `${STUDIO_CONTEXT_KEY} == 'product'`,
    });
  }
}

@injectable()
export class GenerateViewContribution extends ScopedViewContribution<GenerateWidget> {
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;

  constructor() {
    super({
      widgetId: GenerateWidget.ID,
      widgetName: GenerateWidget.LABEL,
      // The main area, beside Product and Lock: the plan is a tree of paths
      // and a Monaco diff, and both need width. In the bottom strip the
      // diff would be a keyhole.
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.generate.toggle",
    });
  }

  protected override canOpen(): boolean {
    return this.engine.isConnected;
  }

  override registerCommands(commands: CommandRegistry): void {
    // `shortTitle` as an override rather than a special case in the toolbar: the
    // header renders `shortTitle ?? label`, so this is the one place that decides
    // the button says `Generate` while the View menu keeps the toggle's own
    // phrasing. A mapping from command id to caption inside `ToolbarWidget` would
    // break the rule that file states in its first paragraph -- actions come from
    // the registry and cannot drift from the menu.
    //
    // The bespoke `quickView.registerItem` that used to sit here is gone:
    // `registerScopedToggle` registers it *with* a `when`, which is the only
    // gate `Open View...` reads.
    this.registerScopedToggle(commands, { shortTitle: "Generate" });
    // Opens rather than toggles -- see `SHOW_GENERATE`. Gated on the product as
    // well as the engine: a plan is a product's plan.
    commands.registerCommand(SHOW_GENERATE, explained({
      execute: () => this.openView({ activate: true, reveal: true }),
      isEnabled: () => this.availableHere() && this.engine.isConnected,
      disabledReason: () => (!this.availableHere() ? NO_PRODUCT : this.engine.isConnected ? undefined : ENGINE_DOWN),
    }));
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_GENERATE, {
      // `SHOW_GENERATE`, not the toggle: a menu entry that hides the plan when
      // the plan is open is the Product-strip defect again. The toggle stays in
      // `View > Views`, where toggling a panel is the point.
      commandId: SHOW_GENERATE.id,
      label: "Generate",
      order: "1",
      when: `${STUDIO_CONTEXT_KEY} == 'product'`,
    });
  }
}
