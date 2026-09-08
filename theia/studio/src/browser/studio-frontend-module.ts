import { ContainerModule } from '@theia/core/shared/inversify';
import { StudioWidget } from './studio-widget';
import { StudioContribution } from './studio-contribution';
import { ApplicationShell, bindViewContribution, FrontendApplicationContribution, LabelProviderContribution, OpenHandler, SaveableService, WidgetFactory, WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { StudioRuntimeService, studioRuntimeServicePath } from '../common/studio-protocol';
import { FilesystemSaveableService } from '@theia/filesystem/lib/browser/filesystem-saveable-service';
import { GitOperationsContribution, GitOperationsFrontendController } from './git-operations-contribution';
import { GitOperationsWidget } from './git-operations-widget';
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
import { WorkspaceGraphContribution } from './workspace-graph-contribution';
import { ArtifactGraphContribution } from './artifact-graph-contribution';
import { ArtifactGraphWidget } from './artifact-graph-widget';
import { WorkspaceGraphFrontendController, WorkspaceGraphWidget } from './workspace-graph-widget';
import { WorkspaceGraphService, workspaceGraphServicePath } from '../common/graph-model';
import { AnalyzeApplicationShellProvider, AnalyzeFrontendController } from './analyze-controller';
import { AnalyzeContribution } from './analyze-contribution';
import { AnalyzeWidget } from './analyze-widget';
import { AuditWidget } from './audit-widget';
import { AuditContribution } from './audit-contribution';
import { AuditFrontendController } from './audit-controller';
import { StudioRuntimeFrontendClient } from './studio-runtime-client';
import { WorkspaceSourcesFrontendController } from './workspace-sources-controller';
import { OpenInEditorFrontendController } from './open-in-editor-controller';
import { WorkspaceSourcesContribution } from './workspace-sources-contribution';
import { WorkspaceSourcesWidget } from './workspace-sources-widget';
import { WorkspaceSourceRootDecorator, WorkspaceSourceRootService } from './workspace-source-root-decorator';
import { PortalBridgeContribution } from './portal-bridge-contribution';
import { OrcaContribution } from './orca-contribution';
import { OrcaWidget } from './orca-widget';
import { OrcaService, orcaServicePath } from '../common/orca-protocol';

import '../../src/browser/style/index.css';
import '../../src/browser/markdown-editor/markdown-editor.css';
import '../../src/browser/workspace-sources.css';
import '../../src/browser/orca.css';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
    rebind(ScmHistoryGraphWidget).to(StudioScmHistoryGraphWidget);
    bind(ExplorerPresentationService).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ExplorerPresentationService);
    bind(StudioExplorerFilter).toSelf().inSingletonScope();
    rebind(FileNavigatorFilter).toService(StudioExplorerFilter);
    bind(FrontendApplicationContribution).toService(StudioExplorerFilter);
    bind(StudioFileTreeLabelProvider).toSelf().inSingletonScope();
    bind(LabelProviderContribution).toService(StudioFileTreeLabelProvider);
    bind(ExplorerModeContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(ExplorerModeContribution);
    bind(TabBarToolbarContribution).toService(ExplorerModeContribution);
    bind(FrontendApplicationContribution).toService(ExplorerModeContribution);
    bind(GitOperationsFrontendController).toSelf().inSingletonScope();
    bind(AuditFrontendController).toSelf().inSingletonScope();
    bind(OpenInEditorFrontendController).toSelf().inSingletonScope();
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
    bind(MarkdownEditorOpenHandler).toSelf().inSingletonScope();
    bind(OpenHandler).toService(MarkdownEditorOpenHandler);
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
    bindViewContribution(bind, StudioContribution);
    bind(FrontendApplicationContribution).toService(StudioContribution);
    bindViewContribution(bind, GitOperationsContribution);
    bind(FrontendApplicationContribution).toService(GitOperationsContribution);
    bind(FrontendApplicationContribution).toService(AuditFrontendController);
    bindViewContribution(bind, AuditContribution);
    bind(FrontendApplicationContribution).toService(AuditContribution);
    bindViewContribution(bind, WorkspaceSourcesContribution);
    bind(FrontendApplicationContribution).toService(WorkspaceSourcesContribution);
    // Orca agents panel. The service is a plain proxy — the runtime pushes
    // nothing at us yet, so the panel polls on open and on demand.
    bind(OrcaService).toDynamicValue(ctx =>
        ctx.container.get(WebSocketConnectionProvider).createProxy<OrcaService>(orcaServicePath)
    ).inSingletonScope();
    bindViewContribution(bind, OrcaContribution);
    bind(StudioWidget).toSelf();
    bind(GitOperationsWidget).toSelf();
    bind(WorkspaceGraphWidget).toSelf();
    bind(AnalyzeWidget).toSelf();
    bind(ObjectDetailsWidget).toSelf();
    bind(AuditWidget).toSelf();
    bind(WorkspaceSourcesWidget).toSelf();
    bind(OrcaWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: StudioWidget.ID,
        createWidget: () => ctx.container.get<StudioWidget>(StudioWidget)
    })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: GitOperationsWidget.ID,
        createWidget: () => ctx.container.get<GitOperationsWidget>(GitOperationsWidget)
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
        id: AuditWidget.ID,
        createWidget: () => ctx.container.get<AuditWidget>(AuditWidget)
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
