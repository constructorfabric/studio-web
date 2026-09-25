import { ContainerModule } from '@theia/core/shared/inversify';
import { StudioContribution } from './studio-contribution';
import { ApplicationShell, bindViewContribution, FrontendApplicationContribution, LabelProviderContribution, OpenHandler, SaveableService, WidgetFactory, WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { PerspectiveContribution } from '@theia/core/lib/browser/perspective-service';
import { ResourceResolver } from '@theia/core/lib/common/resource';
import { StudioRuntimeService, studioRuntimeServicePath } from '../common/studio-protocol';
import { FilesystemSaveableService } from '@theia/filesystem/lib/browser/filesystem-saveable-service';
import { GitOperationsFrontendController } from './git-operations-contribution';
import { ApplicationShellProvider, StudioSaveableService } from './studio-saveable-service';
import { FixedWorkspaceContribution } from './fixed-workspace-contribution';
import { ScmHistoryGraphWidget } from '@theia/scm/lib/browser/scm-history-graph-widget';
import { StudioScmHistoryGraphWidget } from './studio-scm-history-graph-widget';
import { FileNavigatorFilter } from '@theia/navigator/lib/browser/navigator-filter';
import { NavigatorTreeDecorator } from '@theia/navigator/lib/browser/navigator-decorator-service';
import { ExplorerModeContribution, StudioExplorerFilter, StudioFileTreeLabelProvider } from './explorer-contribution';
import { ExplorerPresentationService } from './explorer-presentation-service';
import { MarkdownEditorContribution } from './markdown-editor/markdown-editor-contribution';
import { MarkdownEditorConflictService } from './markdown-editor/markdown-editor-conflict-service';
import { MarkdownEditorModel } from './markdown-editor/markdown-editor-model';
import { MarkdownEditorOpenHandler } from './markdown-editor/markdown-editor-open-handler';
import { MarkdownEditorWidget } from './markdown-editor/markdown-editor-widget';
import { GraphOpenHandler } from './graph-open-handler';
import { ObjectDetailsWidget } from './object-details-widget';
import { bindAgentCredentials } from './agent-credentials';
import { DesktopStudioWidget, DESKTOP_STUDIO_WIDGET_ID } from './desktop-studio-widget';
import { DesktopStudioContribution } from './desktop-studio-contribution';
import { DesktopLinkHandler } from './desktop-link-handler';
import { WorkspaceGraphContribution } from './workspace-graph-contribution';
import { ArtifactGraphContribution } from './artifact-graph-contribution';
import { ArtifactGraphWidget } from './artifact-graph-widget';
import { WorkspaceGraphFrontendController, WorkspaceGraphWidget } from './workspace-graph-widget';
import { WorkspaceGraphService, workspaceGraphServicePath } from '../common/graph-model';
import { AnalyzeApplicationShellProvider, AnalyzeFrontendController } from './analyze-controller';
import { AnalyzeContribution } from './analyze-contribution';
import { AnalyzeStudioClient } from './analyze-studio-client';
import { AnalyzeWidget } from './analyze-widget';
import { AuditFrontendController } from './audit-controller';
import { OperationsWidget } from './operations-widget';
import { OperationsContribution } from './operations-contribution';
import { StudioRuntimeFrontendClient } from './studio-runtime-client';
import { WorkspaceSourcesFrontendController } from './workspace-sources-controller';
import { OpenInEditorFrontendController } from './open-in-editor-controller';
import { NotifyEditorFrontendController } from './notify-editor-controller';
import { WorkspaceSourcesContribution } from './workspace-sources-contribution';
import { WorkspaceSourcesWidget } from './workspace-sources-widget';
import { WorkspaceSourceRootDecorator, WorkspaceSourceRootService } from './workspace-source-root-decorator';
import { PortalBridgeContribution } from './portal-bridge-contribution';
import { PortalPresenceContribution } from './portal-presence-contribution';
import { OrcaContribution } from './orca-contribution';
import { OrcaWidget } from './orca-widget';
import { OrcaService, orcaServicePath } from '../common/orca-protocol';
import { StudioDocumentOpener } from './studio-document-opener';
import { StudioChromeMode } from './studio-chrome-mode';
import { StudioModeBar, StudioModeBarContribution, StudioModeSwitch } from './studio-mode-bar';
import { StudioModeStatus } from './studio-mode-status';
import { StudioPerspectiveContribution } from './studio-perspectives';
import { StudioWorkspaceName } from './studio-workspace-name';
import { StudioDocumentResourceResolver } from './studio-document-resource';

import '../../src/browser/style/index.css';
import '../../src/browser/markdown-editor/markdown-editor.css';
import '../../src/browser/workspace-sources.css';
import '../../src/browser/orca.css';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
    // ADR-0030: each window's agents run on that window's person.
    bindAgentCredentials(rebind);
    rebind(ScmHistoryGraphWidget).to(StudioScmHistoryGraphWidget);
    bind(ExplorerPresentationService).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ExplorerPresentationService);
    bind(StudioExplorerFilter).toSelf().inSingletonScope();
    rebind(FileNavigatorFilter).toService(StudioExplorerFilter);
    bind(FrontendApplicationContribution).toService(StudioExplorerFilter);
    bind(StudioFileTreeLabelProvider).toSelf().inSingletonScope();
    bind(LabelProviderContribution).toService(StudioFileTreeLabelProvider);
    // The project's name, as the portal knows it, for the one node that would
    // otherwise be called after the container's directory.
    bind(StudioWorkspaceName).toSelf().inSingletonScope();
    bind(LabelProviderContribution).toService(StudioWorkspaceName);
    bind(ExplorerModeContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(ExplorerModeContribution);
    bind(TabBarToolbarContribution).toService(ExplorerModeContribution);
    bind(FrontendApplicationContribution).toService(ExplorerModeContribution);
    bind(GitOperationsFrontendController).toSelf().inSingletonScope();
    bind(AuditFrontendController).toSelf().inSingletonScope();
    bind(OpenInEditorFrontendController).toSelf().inSingletonScope();
    bind(NotifyEditorFrontendController).toSelf().inSingletonScope();
    bind(WorkspaceSourcesFrontendController).toSelf().inSingletonScope();
    bind(WorkspaceSourceRootService).toSelf().inSingletonScope();
    bind(WorkspaceSourceRootDecorator).toSelf().inSingletonScope();
    bind(NavigatorTreeDecorator).toService(WorkspaceSourceRootDecorator);
    bind(FrontendApplicationContribution).toService(WorkspaceSourcesFrontendController);
    bind(CommandContribution).toService(WorkspaceSourcesFrontendController);
    bind(StudioRuntimeFrontendClient).toSelf().inSingletonScope();
    bind(StudioRuntimeService).toDynamicValue(ctx => {
        const provider = ctx.container.get(WebSocketConnectionProvider);
        const runtime = provider.createProxy<StudioRuntimeService>(
            studioRuntimeServicePath,
            ctx.container.get(StudioRuntimeFrontendClient)
        );
        ctx.container.get(GitOperationsFrontendController).bindRuntime(runtime);
        ctx.container.get(AuditFrontendController).bindRuntime(runtime);
        ctx.container.get(WorkspaceSourcesFrontendController).bindRuntime(runtime);
        return runtime;
    }).inSingletonScope();
    bind(ApplicationShellProvider).toFactory(ctx => () => ctx.container.get(ApplicationShell));
    bind(StudioSaveableService).toSelf().inSingletonScope();
    rebind(SaveableService).toService(StudioSaveableService);
    rebind(FilesystemSaveableService).toService(StudioSaveableService);
    // Workbench modes. Registering these is also what makes Theia's own
    // "Select a perspective" command visible — it hides itself while only one
    // perspective exists.
    bind(StudioPerspectiveContribution).toSelf().inSingletonScope();
    bind(PerspectiveContribution).toService(StudioPerspectiveContribution);
    // Theia's switch is a command, and this session has no menu bar to find it
    // in. The status bar says which mode you are in and switches on a click.
    bind(StudioModeStatus).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(StudioModeStatus);
    // …and the chrome the mode implies — Theia's own menu bar in the workbench,
    // none of it while writing.
    bind(StudioChromeMode).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(StudioChromeMode);
    // The three modes, chosen explicitly, each with its own toolbar.
    bind(StudioModeBar).toSelf().inSingletonScope();
    bind(StudioModeSwitch).toSelf().inSingletonScope();
    bind(StudioModeBarContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(StudioModeBarContribution);
    bind(MarkdownEditorOpenHandler).toSelf().inSingletonScope();
    bind(OpenHandler).toService(MarkdownEditorOpenHandler);
    // Portal documents as editable resources (`studio-doc:`). Without the
    // ResourceResolver binding the scheme resolves to nothing and the editor
    // opens an empty, unsaveable tab — the resolver IS the integration.
    bind(StudioDocumentResourceResolver).toSelf().inSingletonScope();
    bind(ResourceResolver).toService(StudioDocumentResourceResolver);
    bind(StudioDocumentOpener).toSelf().inSingletonScope();
    bind(GraphOpenHandler).toSelf().inSingletonScope();
    bind(MarkdownEditorContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(MarkdownEditorContribution);
    bind(CommandContribution).toService(MarkdownEditorContribution);
    bind(MenuContribution).toService(MarkdownEditorContribution);
    bind(MarkdownEditorConflictService).toSelf().inSingletonScope();
    bind(MarkdownEditorModel).toSelf();
    bind(MarkdownEditorWidget).toSelf();
    bind(WorkspaceGraphFrontendController).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(WorkspaceGraphFrontendController);
    bind(AnalyzeApplicationShellProvider).toFactory(ctx => () => ctx.container.get(ApplicationShell));
    bind(AnalyzeStudioClient).toSelf().inSingletonScope();
    bind(AnalyzeFrontendController).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(AnalyzeFrontendController);
    bind(WorkspaceGraphService).toDynamicValue(ctx => {
        const provider = ctx.container.get(WebSocketConnectionProvider);
        return provider.createProxy<WorkspaceGraphService>(
            workspaceGraphServicePath,
            ctx.container.get(WorkspaceGraphFrontendController) as never
        );
    }).inSingletonScope();
    bindViewContribution(bind, AnalyzeContribution);
    bind(FrontendApplicationContribution).toService(AnalyzeContribution);
    bindViewContribution(bind, WorkspaceGraphContribution);
    bind(FixedWorkspaceContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(FixedWorkspaceContribution);
    // Portal bridge. Without this binding the class is dead code: Theia only
    // ever instantiates what the container knows about, so no postMessage
    // listener is installed — the portal's theme never reaches the IDE, the
    // portal-issued API token never arrives, and Theia AI stays unconfigured
    // because it is configured from that token. Standalone (non-embedded)
    // sessions are unaffected: the contribution returns early when there is
    // no parent window.
    bind(PortalBridgeContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(PortalBridgeContribution);
    bind(CommandContribution).toService(PortalBridgeContribution);

    // Reports this session into the portal's presence gear, and shows the
    // notes that come back. Bound after the bridge because it reads what the
    // bridge stores from the handshake.
    bind(PortalPresenceContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(PortalPresenceContribution);
    // The layout, not a view: nothing to toggle, so nothing to bind a view
    // contribution for.
    bind(StudioContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(StudioContribution);
    bindViewContribution(bind, OperationsContribution);
    bind(FrontendApplicationContribution).toService(OperationsContribution);
    bind(FrontendApplicationContribution).toService(AuditFrontendController);
    bindViewContribution(bind, WorkspaceSourcesContribution);
    bind(FrontendApplicationContribution).toService(WorkspaceSourcesContribution);
    // Orca agents panel. The service is a plain proxy — the runtime pushes
    // nothing at us yet, so the panel polls on open and on demand.
    bind(OrcaService).toDynamicValue(ctx =>
        ctx.container.get(WebSocketConnectionProvider).createProxy<OrcaService>(orcaServicePath)
    ).inSingletonScope();
    bindViewContribution(bind, OrcaContribution);
    bind(OperationsWidget).toSelf();
    bind(WorkspaceGraphWidget).toSelf();
    bind(AnalyzeWidget).toSelf();
    bind(ObjectDetailsWidget).toSelf();
    // ADR-0027: the desktop Studio's sign-in and workspace view; opens only when
    // the IDE backend is connected to a Studio (STUDIO_DESKTOP_URL).
    bind(DesktopStudioWidget).toSelf().inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: DESKTOP_STUDIO_WIDGET_ID,
        createWidget: () => ctx.container.get<DesktopStudioWidget>(DesktopStudioWidget)
    })).inSingletonScope();
    bindViewContribution(bind, DesktopStudioContribution);
    bind(FrontendApplicationContribution).toService(DesktopStudioContribution);
    // ADR-0027 §6: the portal's "Open in desktop" link, `cfstudio://open?...`,
    // which Theia delivers here from the operating system (`electron.uriScheme`).
    bind(DesktopLinkHandler).toSelf().inSingletonScope();
    bind(OpenHandler).toService(DesktopLinkHandler);
    bind(WorkspaceSourcesWidget).toSelf();
    bind(OrcaWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: OperationsWidget.ID,
        createWidget: () => ctx.container.get<OperationsWidget>(OperationsWidget)
    })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: WorkspaceGraphWidget.ID,
        createWidget: () => ctx.container.get<WorkspaceGraphWidget>(WorkspaceGraphWidget)
    })).inSingletonScope();
    bindViewContribution(bind, ArtifactGraphContribution);
    bind(ArtifactGraphWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ArtifactGraphWidget.ID,
        createWidget: () => ctx.container.get<ArtifactGraphWidget>(ArtifactGraphWidget)
    })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: AnalyzeWidget.ID,
        createWidget: () => ctx.container.get<AnalyzeWidget>(AnalyzeWidget)
    })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ObjectDetailsWidget.ID,
        createWidget: () => ctx.container.get<ObjectDetailsWidget>(ObjectDetailsWidget)
    })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: WorkspaceSourcesWidget.ID,
        createWidget: () => ctx.container.get<WorkspaceSourcesWidget>(WorkspaceSourcesWidget)
    })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: OrcaWidget.ID,
        createWidget: () => ctx.container.get<OrcaWidget>(OrcaWidget)
    })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: MarkdownEditorOpenHandler.ID,
        createWidget: async (options: { uri: string }) => {
            const widget = ctx.container.get<MarkdownEditorWidget>(MarkdownEditorWidget);
            await widget.configure(options);
            return widget;
        }
    })).inSingletonScope();
});
