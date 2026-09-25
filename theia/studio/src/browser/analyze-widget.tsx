import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ANALYZE_WIDGET_ID, AnalyzeFrontendController, AnalyzeMetric, AnalyzeViewModel } from './analyze-controller';

/**
 * The Analyze panel: Spec Quality's recorded view of the document in front,
 * and the button that asks it again about the text on screen.
 *
 * No trend. There is one finding per detector per document — a re-run
 * replaces it — so there is no history to draw, and an empty chart would say
 * there was.
 */
@injectable()
export class AnalyzeWidget extends ReactWidget {
    static readonly ID = ANALYZE_WIDGET_ID;
    static readonly LABEL = 'Analyze';

    @inject(AnalyzeFrontendController)
    protected readonly controller!: AnalyzeFrontendController;

    @postConstruct()
    protected init(): void {
        this.id = AnalyzeWidget.ID;
        this.title.label = AnalyzeWidget.LABEL;
        this.title.caption = AnalyzeWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-graph';
        this.node.tabIndex = 0;
        this.toDispose.push(this.controller.onDidChange(() => this.update()));
        this.update();
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }

    protected render(): React.ReactNode {
        const model = this.controller.getViewModel();
        return (
            <div className='studio-analyze' data-testid='analyze-widget'>
                <header className='studio-analyze__header'>
                    <div className='studio-analyze__heading'>
                        <div className='studio-analyze__eyebrow'>Spec Quality</div>
                        <h2 className='studio-analyze__title'>{model.documentLabel ?? 'Document analysis'}</h2>
                        {model.knownAs && model.knownAs !== model.documentLabel
                            ? <div className='studio-analyze__meta' data-testid='analyze-known-as'>{model.knownAs}</div>
                            : undefined}
                    </div>
                    <button
                        className='theia-button studio-analyze__action'
                        data-testid='analyze-run'
                        disabled={!model.canAnalyze}
                        title={model.canAnalyze
                            ? 'Send the text on screen to Spec Quality: purpose, leak, bloat and traceability'
                            : undefined}
                        onClick={() => void this.controller.analyze()}
                    >
                        {model.status === 'running' ? 'Analyzing…' : 'Analyze'}
                    </button>
                </header>
                {this.renderStatusRow(model)}
                {this.renderBody(model)}
            </div>
        );
    }

    protected renderStatusRow(model: AnalyzeViewModel): React.ReactNode {
        if (model.status === 'empty') {
            return undefined;
        }
        return (
            <div className='studio-analyze__status-row'>
                <span className={`studio-analyze__badge studio-analyze__badge--${model.status}`} data-testid='analyze-status'>
                    {this.getStatusLabel(model.status)}
                </span>
                {model.typeKey ? <span className='studio-analyze__meta'>Type: {model.typeKey}</span> : undefined}
                {model.status === 'stale'
                    ? <span className='studio-analyze__meta'>Edited since these results — Analyze checks the text on screen.</span>
                    : undefined}
                {model.progress
                    ? <span className='studio-analyze__meta' data-testid='analyze-progress' role='status'>{model.progress}</span>
                    : undefined}
            </div>
        );
    }

    protected renderBody(model: AnalyzeViewModel): React.ReactNode {
        switch (model.status) {
            case 'empty':
                return (
                    <section className='studio-analyze__empty' data-testid='analyze-empty-state'>
                        <h3>{model.emptyStateTitle}</h3>
                        <p>{model.emptyStateDescription}</p>
                    </section>
                );
            case 'loading':
                return (
                    <section className='studio-analyze__empty' data-testid='analyze-loading'>
                        <p>Reading what Studio knows about this document…</p>
                    </section>
                );
            case 'unknown':
            case 'error':
                return (
                    <section className='studio-analyze__empty' data-testid='analyze-message'>
                        <p>{model.message}</p>
                    </section>
                );
            default:
                return (
                    <div className='studio-analyze__body'>
                        {model.note ? <p className='studio-analyze__note' data-testid='analyze-note'>{model.note}</p> : undefined}
                        <section className='studio-analyze__metrics'>
                            {model.metrics.map(metric => this.renderMetricCard(metric))}
                        </section>
                    </div>
                );
        }
    }

    protected renderMetricCard(metric: AnalyzeMetric): React.ReactNode {
        return (
            <article
                key={metric.key}
                className={`studio-analyze__metric${metric.analysed ? '' : ' studio-analyze__metric--pending'}`}
                data-testid={`analyze-metric-${metric.key}`}
                aria-label={metric.ariaText}
            >
                <div className='studio-analyze__metric-top'>
                    <div>
                        <h3>{metric.label}</h3>
                        <div className='studio-analyze__metric-direction'>
                            {metric.direction === 'higher-better' ? 'Higher is better' : 'Lower is better'}
                        </div>
                    </div>
                    <div className='studio-analyze__metric-summary'>
                        {metric.scoreText
                            ? <span className='studio-analyze__metric-score' data-testid={`analyze-score-${metric.key}`}>{metric.scoreText}</span>
                            : undefined}
                        {metric.level
                            ? <span className={`studio-analyze__metric-level studio-analyze__metric-level--${metric.level.toLowerCase()}`}>
                                {metric.level}
                            </span>
                            : undefined}
                    </div>
                </div>
                {metric.percent !== undefined && metric.level ? (
                    <div className='studio-analyze__gauge studio-analyze__gauge--horizontal' aria-hidden='true'>
                        <div className='studio-analyze__gauge-track'>
                            <div
                                className={`studio-analyze__gauge-fill studio-analyze__gauge-fill--${metric.level.toLowerCase()}`}
                                style={{ width: `${metric.percent}%` }}
                            />
                        </div>
                    </div>
                ) : undefined}
                <div className='studio-analyze__metric-copy'>
                    <p className='studio-analyze__metric-definition'>{metric.definition}</p>
                    <p className='studio-analyze__metric-interpretation' data-testid={`analyze-interpretation-${metric.key}`}>
                        {metric.interpretation}
                    </p>
                    {metric.recordedAt
                        ? <p className='studio-analyze__meta' data-testid={`analyze-recorded-${metric.key}`}>
                            Recorded {this.formatWhen(metric.recordedAt)}
                        </p>
                        : undefined}
                </div>
            </article>
        );
    }

    protected formatWhen(iso: string): string {
        const when = new Date(iso);
        return Number.isNaN(when.getTime()) ? iso : when.toLocaleString();
    }

    protected getStatusLabel(status: AnalyzeViewModel['status']): string {
        switch (status) {
            case 'ready':
                return 'Recorded';
            case 'stale':
                return 'Edited';
            case 'running':
                return 'Analyzing';
            case 'loading':
                return 'Loading';
            case 'unknown':
                return 'Not a known spec';
            case 'error':
                return 'Unavailable';
            case 'empty':
            default:
                return 'Idle';
        }
    }
}
