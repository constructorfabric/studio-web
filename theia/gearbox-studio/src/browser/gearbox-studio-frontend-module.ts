// Frontend wiring for Gearbox inside Constructor Studio.
//
// Ported from Gearbox Studio (github.com/MikeFalcon77/gearbox@3b64969,
// ide/gearbox-studio). The domain — the catalogue, the product, its edits, the
// graph, the inspector, the lock, conflicts, generation, the wizards — is
// bound as it was. What Gearbox Studio did to the shell is not: it was a whole
// IDE and narrowed Theia by rebinding (ADR-0011 there), which here would hide
// Studio's own views. Those rebinds are not ported, and every service that
// still arranges panels asks `gearboxOwnsLayout` first (shell/gearbox-shell-gate.ts).
//
// Phased (see theia/gearbox-studio/README.md). The `@Gearbox` chat agent (P5)
// answers on Studio's own model; it is one agent among Studio's, reached by
// mention, never the default. Nothing here opens a view on its own except the
// Product view, when a person opens a product.

import { FrontendApplicationContribution, LabelProviderContribution, bindViewContribution } from "@theia/core/lib/browser";
import { Agent, AIVariableContribution, bindToolProvider } from "@theia/ai-core";
import { ChatAgent } from "@theia/ai-chat";
import { GearboxChatAgent } from "./ai/gearbox-chat-agent";
import { GearboxMenuContribution } from "./menus";
import { GearboxContextContribution } from "./ai/gearbox-context";
import { GearboxSelectionChip, GearboxVariableLabelProvider } from "./ai/gearbox-selection-chip";
import { GEARBOX_TOOLS } from "./ai/gearbox-tools";
import { ProductGearTool } from "./ai/product-tools";
import { WebSocketConnectionProvider } from "@theia/core/lib/browser/messaging";
import { PerspectiveContribution } from "@theia/core/lib/browser/perspective-service";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { ContainerModule, injectable } from "@theia/core/shared/inversify";
import { MonacoEditorProvider } from "@theia/monaco/lib/browser/monaco-editor-provider";
import { LanguageGrammarDefinitionContribution } from "@theia/monaco/lib/browser/textmate/textmate-contribution";

import { GEARBOX_SERVICE_PATH, GearboxClient, GearboxService } from "../common/protocol";
import { CatalogueStore } from "./catalogue-store";
import { GenerateService } from "./generate/generate-service";
import { ProductTerminals } from "./generate/product-terminals";
import { ProductEditService } from "./product-edit-service";
import { ProductStore } from "./product-store";
import { ResolutionMarkers } from "./resolution-markers";
import { bindWidget } from "./contribution";
import { ReadOnlyLockEditorProvider } from "./theia/monaco/read-only-lock-editor-provider";
import { RevealService } from "./reveal-service";
import { CataloguePicker } from "./catalogue/catalogue-picker";
import { CatalogueWidget } from "./catalogue/catalogue-widget";
import { ConflictsWidget } from "./conflicts/conflicts-widget";
import { CatalogueDiagnosticsWidget } from "./diagnostics/catalogue-diagnostics-widget";
import { ConfigureSourcesContribution } from "./shell/configure-sources-contribution";
import { StudioWindowTitleUpdater } from "./shell/studio-window-title-updater";
import { WindowTitleUpdater } from "@theia/core/lib/browser/window/window-title-updater";
import { CreateProductWidget } from "./create/create-product-widget";
import { CreateGearWidget } from "./create/create-gear-widget";
import { PendingCreate } from "./create/pending-create";
import { PendingCreateGear } from "./create/pending-create-gear";
import {
  AddGearViewContribution,
  CatalogueViewContribution,
  ConflictsViewContribution,
  CatalogueDiagnosticsViewContribution,
  CreateGearViewContribution,
  CreateProductViewContribution,
  GearAuthorViewContribution,
  GenerateViewContribution,
  GraphViewContribution,
  InspectorViewContribution,
  LockViewContribution,
  ProductViewContribution,
  StartViewContribution,
} from "./view-contributions";
import { GraphWidget } from "./graph/graph-widget";
import { InspectorWidget } from "./inspector/inspector-widget";
import { GenerateWidget } from "./generate/generate-widget";
import { LockWidget } from "./lock/lock-widget";
import { ProductWidget } from "./product/product-widget";
import { GearAuthorWidget } from "./gear/gear-author-widget";
import { StartWidget } from "./start/start-widget";
import { BuildingStartPage } from "./start/building-start-page";
import { DescriptionMarkers } from "./gdl/description-markers";
import { GdlAssistContribution } from "./gdl/gdl-assist-contribution";
import { GdlLanguageContribution } from "./gdl/gdl-language-contribution";
import { ProductFileChecks } from "./gdl/product-file-checks";
import { GearSessionService } from "./shell/gear-session-service";
import { ProductSessionService } from "./shell/product-session-service";
import { EngineConnectionService } from "./shell/engine-connection-service";
import { SelectionService } from "./shell/selection-service";
import { SessionCommands } from "./shell/session-commands";
import { FocusModeService } from "./shell/focus-mode-service";
import { DescriptionWatchService } from "./shell/description-watch-service";
import { ScreenScopeService } from "./shell/screen-scope-service";
import { StudioScreenScopeService } from "./shell/studio-screen-scope";
import { StudioContextService } from "./shell/studio-context-service";
import { StudioGearboxPerspective } from "./shell/studio-gearbox-perspective";
import { GearLocator } from "./shell/gear-locator";
import { PortalLinkContribution } from "./shell/portal-link";

import "../../src/browser/style/index.css";

/**
 * Constructor Studio: the catalogue loads with the application and opens only
 * when asked. Gearbox Studio also opened it from `initializeLayout` on a first
 * run, which here would put a Gearbox panel in front of Studio's Explorer for
 * every project, product or not.
 */
@injectable()
class StudioCatalogueViewContribution extends CatalogueViewContribution {
  override async initializeLayout(): Promise<void> {}
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  // `product.lock` opens read-only. Additive: nothing else in Studio rebinds
  // the Monaco editor provider, and every other file opens as before.
  rebind(MonacoEditorProvider).to(ReadOnlyLockEditorProvider).inSingletonScope();

  // The window names the product Building is on (`studio-window-title-updater.ts`);
  // outside a Gearbox perspective it is Theia's own title.
  rebind(WindowTitleUpdater).to(StudioWindowTitleUpdater).inSingletonScope();

  // One selection for every Gearbox view, bound before the stores that inject it.
  bind(SelectionService).toSelf().inSingletonScope();
  bind(EngineConnectionService).toSelf().inSingletonScope();

  bind(CatalogueStore).toSelf().inSingletonScope();
  bind(ProductStore).toSelf().inSingletonScope();
  bind(ProductEditService).toSelf().inSingletonScope();
  bind(PendingCreate).toSelf().inSingletonScope();
  bind(PendingCreateGear).toSelf().inSingletonScope();
  bind(GenerateService).toSelf().inSingletonScope();
  // Build and Run's two terminals per product, under Generate.
  bind(ProductTerminals).toSelf().inSingletonScope();
  bind(RevealService).toSelf().inSingletonScope();
  bind(GearboxClient).toService(CatalogueStore);

  // Resolution diagnostics into the Problems view, under their own owner.
  bind(ResolutionMarkers).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ResolutionMarkers);

  // The `.gdl` language, natively: the grammar (Monaco has no other), the
  // description markers from the engine's `textDocument/*` surface, completion
  // and hover, and the catalogue checks on any product.gdl opened as a file.
  // These replace theia/gdl-language, so one engine serves the editor and the
  // views instead of two.
  bind(LanguageGrammarDefinitionContribution).to(GdlLanguageContribution).inSingletonScope();
  bind(DescriptionMarkers).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(DescriptionMarkers);
  bind(GdlAssistContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(GdlAssistContribution);
  bind(ProductFileChecks).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ProductFileChecks);

  bind(ProductSessionService).toSelf().inSingletonScope();
  bind(GearSessionService).toSelf().inSingletonScope();

  // The Gearbox top-level menu's label -- see `GearboxMenuContribution`.
  bind(GearboxMenuContribution).toSelf().inSingletonScope();
  bind(MenuContribution).toService(GearboxMenuContribution);

  // Open, New and Close Product under File.
  bind(SessionCommands).toSelf().inSingletonScope();
  bind(CommandContribution).toService(SessionCommands);
  bind(MenuContribution).toService(SessionCommands);

  // The context keys (`gearbox.context`, `gearbox.hasSelection`) and the
  // change events the views follow. Its perspective switch is gated.
  bind(StudioContextService).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(StudioContextService);

  // Re-resolve when a description is saved.
  bind(DescriptionWatchService).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(DescriptionWatchService);

  // Injected by the views; neither acts outside a Gearbox perspective.
  // `FocusModeService` is not an application contribution, so it folds panels
  // only when a focus screen asks. The screen scope is started (P6b), as
  // Studio's subclass: it withdraws a closed or replaced product's screens, only
  // while a Gearbox perspective is active, and neither folds panels nor opens
  // Start -- see `studio-screen-scope.ts`.
  bind(FocusModeService).toSelf().inSingletonScope();
  bind(StudioScreenScopeService).toSelf().inSingletonScope();
  bind(ScreenScopeService).toService(StudioScreenScopeService);
  bind(FrontendApplicationContribution).toService(StudioScreenScopeService);

  // The Gearbox perspective beside Workbench and Documents, and the command
  // the portal's `studio.openProduct` runs to land in it with a product open.
  // From a gear here to its page in the portal's component catalogue.
  bind(PortalLinkContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(PortalLinkContribution);

  bind(GearLocator).toSelf().inSingletonScope();
  bind(StudioGearboxPerspective).toSelf().inSingletonScope();
  bind(PerspectiveContribution).toService(StudioGearboxPerspective);
  bind(CommandContribution).toService(StudioGearboxPerspective);

  bind(GearboxService)
    .toDynamicValue(({ container }) => {
      const provider = container.get(WebSocketConnectionProvider);
      // The client is reached through a forwarder, not resolved here: the store
      // injects the service and the service needs a client, a cycle inversify
      // refuses in toDynamicValue bindings.
      const forwarder: GearboxClient = {
        onCatalogueChanged: (event) => container.get(CatalogueStore).onCatalogueChanged(event),
        onCatalogueDiagnostics: (event) => container.get(CatalogueStore).onCatalogueDiagnostics(event),
        onProgress: (event) => container.get(CatalogueStore).onProgress(event),
        onLog: (message) => container.get(CatalogueStore).onLog(message),
        onEngineExit: (reason) => container.get(CatalogueStore).onEngineExit(reason),
        onDocumentDiagnostics: (params) => container.get(DescriptionMarkers).onDocumentDiagnostics(params),
      };
      return provider.createProxy<GearboxService>(GEARBOX_SERVICE_PATH, forwarder);
    })
    .inSingletonScope();

  // `Find Gear…` and `Add Gear…`.
  bind(CataloguePicker).toSelf().inSingletonScope();
  bind(CommandContribution).toService(CataloguePicker);
  bind(ConfigureSourcesContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ConfigureSourcesContribution);
  bind(MenuContribution).toService(CataloguePicker);

  bindWidget(bind, CatalogueWidget);
  bindWidget(bind, GraphWidget);
  bindWidget(bind, ProductWidget);
  bindWidget(bind, InspectorWidget);
  bindWidget(bind, ConflictsWidget);
  bindWidget(bind, CatalogueDiagnosticsWidget);
  bindWidget(bind, StartWidget);
  bindWidget(bind, CreateProductWidget);
  bindWidget(bind, CreateGearWidget);
  bindWidget(bind, GearAuthorWidget);
  bindWidget(bind, LockWidget);
  bindWidget(bind, GenerateWidget);

  // Every view is reachable from View → Views and its command. None opens at
  // start-up: `initializeLayout` and `onStart` belong to a view contribution
  // only when it is also bound as an application contribution, and only the
  // Product view is — it opens when a person opens a product.
  // Loaded at start (its `onStart` starts the engine and the staged load, and
  // reloads after a reconnect), opened only when asked: see the subclass.
  bindViewContribution(bind, StudioCatalogueViewContribution);
  bind(FrontendApplicationContribution).toService(StudioCatalogueViewContribution);
  bindViewContribution(bind, InspectorViewContribution);
  bindViewContribution(bind, GraphViewContribution);
  bindViewContribution(bind, ProductViewContribution);
  bind(FrontendApplicationContribution).toService(ProductViewContribution);
  bindViewContribution(bind, StartViewContribution);
  // Building's page in the empty main dock (product-ext paints it; see start/building-start-page.ts).
  bind(BuildingStartPage).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(BuildingStartPage);
  bindViewContribution(bind, CreateProductViewContribution);
  bindViewContribution(bind, CreateGearViewContribution);
  bindViewContribution(bind, GearAuthorViewContribution);
  bindViewContribution(bind, AddGearViewContribution);
  bindViewContribution(bind, ConflictsViewContribution);
  bindViewContribution(bind, CatalogueDiagnosticsViewContribution);
  bindViewContribution(bind, LockViewContribution);
  bindViewContribution(bind, GenerateViewContribution);

  // ── P5: the `@Gearbox` chat agent ──────────────────────────────────────────
  //
  // As Gearbox Studio binds it, minus two things that were its shell's:
  //
  //  * **Not the default agent.** Gearbox Studio bound `DefaultChatAgentId` and
  //    `FallbackChatAgentId` to itself, being the only agent there was. Studio
  //    has Codex and Claude Code and chooses its default in the portal bridge
  //    (`ai-features.chat.defaultChatAgent`), so `@Gearbox` is asked by name.
  //  * **The chat stays where Studio puts it.** `ChatInTheBottomPanel` (a
  //    rebind of `AIChatContribution`) is not ported.
  //
  // The model is Studio's: the agent asks for `default/universal`, which the
  // bridge aliases to `studio-llm` when the portal hands over its token.
  bind(GearboxChatAgent).toSelf().inSingletonScope();
  bind(Agent).toService(GearboxChatAgent);
  bind(ChatAgent).toService(GearboxChatAgent);

  // The eight read tools, and the one write verb. The write goes through the
  // same `ProductEditService.toggle` the catalogue control uses, so its diff
  // preview and its refusal on unsaved edits are the ones already in place.
  for (const tool of GEARBOX_TOOLS) bindToolProvider(tool, bind);
  bindToolProvider(ProductGearTool, bind);

  // Context the chat gets without being told -- selection, product,
  // diagnostics, topology, the selected gear's configuration -- read from the
  // stores the views render from.
  bind(GearboxContextContribution).toSelf().inSingletonScope();
  bind(AIVariableContribution).toService(GearboxContextContribution);

  // Without a label provider a context chip renders as an empty pill.
  bind(GearboxVariableLabelProvider).toSelf().inSingletonScope();
  bind(LabelProviderContribution).toService(GearboxVariableLabelProvider);

  // One selection chip on the chat input, only while in the Gearbox
  // perspective (see the gate in `GearboxSelectionChip.sync`).
  bind(GearboxSelectionChip).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(GearboxSelectionChip);
});
