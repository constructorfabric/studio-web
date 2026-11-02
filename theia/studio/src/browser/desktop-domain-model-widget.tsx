// The desktop's Domain model view: the portal's project tab Domain model, for
// the person writing the documents it is read from (docs/desktop-studio.md).
//
// Four views of one model, the document in front first:
//   - This document: what the model reads in the file in front, and finds
//     about it -- the question a writer has while writing;
//   - To resolve: every finding, undecided first, each with ✓/✗;
//   - Entities: what the application is, entity by entity, each fact with
//     the passage it rests on;
//   - Glossary: the names the project uses, as members decided them.
// Every passage opens in the file on this machine, found by its quote.
// Proposing fixes, the model map, requirements and the rest stay in the
// portal: the view links there by saying so rather than redrawing it.

import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { DesktopDomainModelController, DomainModelState, sideKey } from './desktop-domain-model-controller';
import {
    DomainModelFact, DomainModelFinding, DomainModelSide, buildLine, entitiesOf, factsByKind, orderFindings,
    readingOf, ruleLabel, sideLabel, unreadNote,
} from '../common/desktop-domain-model';

export type DomainModelTab = 'document' | 'resolve' | 'entities' | 'glossary';

const TABS: readonly { id: DomainModelTab; label: string }[] = [
    { id: 'document', label: 'This document' },
    { id: 'resolve', label: 'To resolve' },
    { id: 'entities', label: 'Entities' },
    { id: 'glossary', label: 'Glossary' },
];

@injectable()
export class DesktopDomainModelWidget extends ReactWidget {
    static readonly ID = 'studio.domain-model';
    static readonly LABEL = 'Domain model';

    @inject(DesktopDomainModelController)
    protected readonly controller!: DesktopDomainModelController;

    protected tab: DomainModelTab = 'document';
    /** The entity unfolded under Entities. */
    protected openEntity: string | undefined;

    @postConstruct()
    protected init(): void {
        this.id = DesktopDomainModelWidget.ID;
        this.title.label = DesktopDomainModelWidget.LABEL;
        this.title.caption = 'What the project\'s documents say the application is, and where they disagree';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-symbol-class';
        this.addClass('studio-domain-model');
        this.node.tabIndex = 0;
        this.toDispose.push(this.controller.onDidChange(() => this.update()));
        this.update();
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        // Asked for the first time when first shown: a window that never opens
        // the view never asks Studio for a model.
        if (this.controller.getState().status === 'idle') {
            void this.controller.refresh();
        }
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }

    protected render(): React.ReactNode {
        const state = this.controller.getState();
        return (
            <div className='studio-domain-model__body' data-testid='domain-model'>
                {this.renderHeader(state)}
                {this.renderContent(state)}
            </div>
        );
    }

    protected renderHeader(state: DomainModelState): React.ReactNode {
        const build = state.model?.build;
        const running = !!build?.running;
        const path = state.current?.modelPath;
        return (
            <header className='studio-domain-model__header'>
                <div className='studio-domain-model__line' role='status' data-testid='domain-model-build'>
                    {build ? buildLine(build) : undefined}
                </div>
                <div className='studio-domain-model__actions'>
                    <button className='theia-button secondary' data-testid='domain-model-refresh'
                        disabled={state.status === 'loading'} onClick={() => void this.controller.refresh()}
                        title='Ask Studio again'>Refresh</button>
                    {path && state.model
                        ? <button className='theia-button secondary' data-testid='domain-model-read-document' disabled={running}
                            onClick={() => void this.controller.build(path)}
                            title={`Read ${path} again, as pushed, on your own model key`}>Read this document again</button>
                        : undefined}
                    {state.model
                        ? <button className='theia-button' data-testid='domain-model-build-button' disabled={running}
                            onClick={() => void this.controller.build()}
                            title='Read every document not read at its revision, on your own model key'>
                            {running ? 'Building…' : 'Build the model'}
                        </button>
                        : undefined}
                </div>
            </header>
        );
    }

    protected renderContent(state: DomainModelState): React.ReactNode {
        if (state.status === 'idle' || (state.status === 'loading' && !state.model)) {
            return <p className='studio-domain-model__note'>Reading the domain model…</p>;
        }
        if (state.status === 'no-project') {
            return <p className='studio-domain-model__note' data-testid='domain-model-no-project'>
                Open a Constructor Studio project (the Studio view) to see its domain model.
            </p>;
        }
        if (state.status === 'error' && !state.model) {
            return <p className='studio-domain-model__note studio-domain-model__note--error' data-testid='domain-model-error'>{state.error}</p>;
        }
        const model = state.model!;
        const unread = unreadNote(model);
        return (
            <>
                {state.error ? <p className='studio-domain-model__note studio-domain-model__note--error'>{state.error}</p> : undefined}
                {unread ? <p className='studio-domain-model__note' data-testid='domain-model-unread'>{unread}</p> : undefined}
                <p className='studio-domain-model__hint'>
                    The model reads the documents as pushed. A passage edited here since is marked; share the edit and build again to read it.
                </p>
                <nav className='studio-domain-model__tabs' role='tablist'>
                    {TABS.map(tab => (
                        <button key={tab.id} role='tab' aria-selected={this.tab === tab.id} data-testid={`domain-model-tab-${tab.id}`}
                            className={`studio-domain-model__tab${this.tab === tab.id ? ' studio-domain-model__tab--active' : ''}`}
                            onClick={() => this.selectTab(tab.id)}>
                            {tab.label}{this.count(tab.id, state)}
                        </button>
                    ))}
                </nav>
                <div className='studio-domain-model__panel' role='tabpanel'>
                    {this.tab === 'document' ? this.renderDocument(state)
                        : this.tab === 'resolve' ? this.renderFindings(orderFindings(state.findings), state)
                            : this.tab === 'entities' ? this.renderEntities(state)
                                : this.renderGlossary(state)}
                </div>
            </>
        );
    }

    protected count(tab: DomainModelTab, state: DomainModelState): string {
        if (tab === 'resolve') {
            const open = state.findings.filter(f => !f.decision).length;
            return open ? ` (${open})` : '';
        }
        if (tab === 'document' && state.current?.modelPath && state.model) {
            const n = readingOf(state.current.modelPath, state.model, state.findings).findings.filter(f => !f.decision).length;
            return n ? ` (${n})` : '';
        }
        return '';
    }

    protected selectTab(tab: DomainModelTab): void {
        this.tab = tab;
        this.update();
    }

    protected renderDocument(state: DomainModelState): React.ReactNode {
        const current = state.current;
        if (!current) {
            return <p className='studio-domain-model__note'>Open a document to see what the model reads in it.</p>;
        }
        if (!current.modelPath) {
            return <p className='studio-domain-model__note' data-testid='domain-model-not-read'>
                The model has not read {current.label}: it reads the project's typed documents, as pushed. Type it in the portal (the project's Specs tab), push it, then build the model.
            </p>;
        }
        const reading = readingOf(current.modelPath, state.model!, state.findings);
        const doc = reading.document;
        return (
            <div data-testid='domain-model-document'>
                <p className='studio-domain-model__meta'>
                    {current.modelPath}
                    {doc ? ` · ${doc.state === 'extracted' ? 'read' : doc.state}${doc.revision ? ` at ${doc.revision.slice(0, 8)}` : ''} · ${doc.facts} fact(s)` : ''}
                    {doc?.error ? ` · ${doc.error}` : ''}
                </p>
                <h3 className='studio-domain-model__heading'>Findings</h3>
                {reading.findings.length
                    ? this.renderFindings(reading.findings, state)
                    : <p className='studio-domain-model__note'>Nothing the model finds about this document.</p>}
                <h3 className='studio-domain-model__heading'>What the model reads in it</h3>
                {reading.facts.length
                    ? factsByKind(reading.facts).map(group => (
                        <section key={group.kind}>
                            <div className='studio-domain-model__kind'>{group.kind}</div>
                            {group.facts.map((fact, i) => this.renderFact(fact, i, true))}
                        </section>
                    ))
                    : <p className='studio-domain-model__note'>No facts read from it yet.</p>}
            </div>
        );
    }

    protected renderFindings(findings: readonly DomainModelFinding[], state: DomainModelState): React.ReactNode {
        if (!findings.length) {
            return <p className='studio-domain-model__note'>The documents agree: nothing to resolve.</p>;
        }
        return (
            <ul className='studio-domain-model__list' data-testid='domain-model-findings'>
                {findings.map(finding => (
                    <li key={finding.fingerprint} data-testid='domain-model-finding'
                        className={`studio-domain-model__finding studio-domain-model__finding--${finding.severity}${finding.decision ? ` studio-domain-model__finding--${finding.decision}` : ''}`}>
                        <div className='studio-domain-model__finding-head'>
                            <span className='studio-domain-model__rule'>{ruleLabel(finding.rule)}</span>
                            <span className='studio-domain-model__severity'>{finding.severity}</span>
                            {finding.decision ? <span className='studio-domain-model__decided'>{finding.decision}</span> : undefined}
                            <span className='studio-domain-model__decide'>
                                <button className='theia-button secondary' title='This is a real problem in the documents'
                                    data-testid='domain-model-confirm'
                                    disabled={state.deciding === finding.fingerprint || finding.decision === 'confirmed'}
                                    onClick={() => void this.controller.decide(finding, 'confirmed')}>✓</button>
                                <button className='theia-button secondary' title='Not a problem: hide it from the files'
                                    data-testid='domain-model-dismiss'
                                    disabled={state.deciding === finding.fingerprint || finding.decision === 'dismissed'}
                                    onClick={() => void this.controller.decide(finding, 'dismissed')}>✗</button>
                            </span>
                        </div>
                        <div className='studio-domain-model__message'>{finding.message}</div>
                        {finding.sides.map((side, i) => this.renderSide(side, i, state))}
                        {finding.decide.length
                            ? <ul className='studio-domain-model__questions'>{finding.decide.map(q => <li key={q}>{q}</li>)}</ul>
                            : undefined}
                    </li>
                ))}
            </ul>
        );
    }

    protected renderSide(side: DomainModelSide, key: number, state: DomainModelState): React.ReactNode {
        const here = state.passages?.get(sideKey(side));
        return (
            <div key={key} className='studio-domain-model__side'>
                <button className='studio-domain-model__link' data-testid='domain-model-side' title='Open the passage'
                    onClick={() => void this.controller.openSide(side)}>{sideLabel(side)}</button>
                {here === 'gone'
                    ? <span className='studio-domain-model__gone' data-testid='domain-model-gone' title='The quoted passage is not in the file here any more'>edited since</span>
                    : undefined}
                {side.quote ? <blockquote className='studio-domain-model__quote'>{side.quote}</blockquote> : undefined}
            </div>
        );
    }

    protected renderFact(fact: DomainModelFact, key: number, inDocument = false): React.ReactNode {
        return (
            <div key={key} className={`studio-domain-model__fact${fact.status !== 'active' ? ' studio-domain-model__fact--inactive' : ''}`}>
                <button className='studio-domain-model__link' title={fact.source.quote ?? 'Open the passage'}
                    onClick={() => void this.controller.openSide(fact.source)}>
                    {inDocument ? fact.subject : sideLabel(fact.source)}
                </button>
                <span> {fact.text}</span>
                {fact.status !== 'active' ? <span className='studio-domain-model__status' title={fact.status_because}> · {fact.status}</span> : undefined}
            </div>
        );
    }

    protected renderEntities(state: DomainModelState): React.ReactNode {
        const entities = entitiesOf(state.model!.facts, state.glossary);
        if (!entities.length) {
            return <p className='studio-domain-model__note'>No entities read yet. Build the model.</p>;
        }
        return (
            <ul className='studio-domain-model__list' data-testid='domain-model-entities'>
                {entities.map(entity => {
                    const open = this.openEntity === entity.key;
                    return (
                        <li key={entity.key} className='studio-domain-model__entity'>
                            <button className='studio-domain-model__entity-head' aria-expanded={open} data-testid='domain-model-entity'
                                onClick={() => { this.openEntity = open ? undefined : entity.key; this.update(); }}>
                                <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
                                <strong>{entity.name}</strong>
                                <span className='studio-domain-model__meta'> {entity.facts.length} fact(s) in {entity.documents} document(s)</span>
                            </button>
                            {open
                                ? factsByKind(entity.facts).map(group => (
                                    <section key={group.kind}>
                                        <div className='studio-domain-model__kind'>{group.kind}</div>
                                        {group.facts.map((fact, i) => this.renderFact(fact, i))}
                                    </section>
                                ))
                                : undefined}
                        </li>
                    );
                })}
            </ul>
        );
    }

    protected renderGlossary(state: DomainModelState): React.ReactNode {
        if (!state.glossary.length) {
            return <p className='studio-domain-model__note'>No glossary yet: it is made from the model's entities once it is built.</p>;
        }
        return (
            <table className='studio-domain-model__glossary' data-testid='domain-model-glossary'>
                <thead><tr><th>Name</th><th>Also written</th><th>Facts</th></tr></thead>
                <tbody>
                    {[...state.glossary].sort((a, b) => a.name.localeCompare(b.name)).map(entry => (
                        <tr key={entry.key}>
                            <td>{entry.name}{entry.chosen ? <span className='studio-domain-model__meta' title='A member chose this name'> · chosen</span> : undefined}</td>
                            <td>{[...entry.aliases.map(a => a.name), ...entry.spellings.filter(s => s !== entry.name)].join(', ')}</td>
                            <td>{entry.facts} in {entry.documents} doc(s)</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        );
    }
}
