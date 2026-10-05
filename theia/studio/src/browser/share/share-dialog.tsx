// The "Share with the team" window: what is not shared, chosen with a tick,
// said in one line, sent with one button. Everything git would ask — a commit
// message, a branch, a pull — is answered for the person; the one question
// that is theirs (whose wording to keep, when a colleague changed the same
// lines) is asked in their terms, beside a way to look at both.

import * as React from '@theia/core/shared/react';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { Message } from '@theia/core/lib/browser';
import type { DocumentShareService, ShareDocument, ShareOutcome, ShareRepository } from '../../common/document-share-protocol';
import { coAuthorsOf, defaultMessage, describeOutcome, Person, Said, splitDocuments } from './share-model';

export interface ShareDialogContext {
    readonly service: DocumentShareService;
    readonly repositories: readonly ShareRepository[];
    readonly me: Person | undefined;
    /** Open a document's changes against what was last shared. */
    showChanges(document: ShareDocument): void;
    /** Open a conflicted document: the team's version beside mine. */
    showConflict(repository: ShareRepository, path: string, theirs: string | undefined): void;
    /** Open a link (a review request) outside the IDE. */
    openLink(url: string): void;
    /** Said once the window is closed: the toast after a share. */
    report(said: Said): void;
}

interface RepositoryState {
    readonly selected: Set<string>;
    readonly message: string;
    readonly outcome?: ShareOutcome;
}

export class ShareDialog extends ReactDialog<void> {
    protected readonly states = new Map<string, RepositoryState>();
    protected busy = false;

    constructor(protected readonly context: ShareDialogContext) {
        super({ title: 'Share with the team' });
        for (const repository of context.repositories) {
            const { mine } = splitDocuments(repository, context.me);
            this.states.set(repository.root, { selected: new Set(mine.map(document => document.path)), message: defaultMessage(mine) });
        }
        this.appendCloseButton('Close');
        this.addClass('studio-share-dialog');
    }

    protected override onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.update();
    }

    // Enter in the message box is a new line, not "Share".
    protected override handleEnter(event: KeyboardEvent): boolean | void {
        if ((event.target as HTMLElement | null)?.tagName === 'TEXTAREA') {
            return false;
        }
        return super.handleEnter(event);
    }

    get value(): void {
        return undefined;
    }

    protected render(): React.ReactNode {
        const { repositories } = this.context;
        const total = repositories.reduce((sum, repository) => sum + repository.documents.length + repository.unsent, 0);
        if (!total) {
            return <div className='studio-share-empty'>Everything is already shared.</div>;
        }
        return <div className='studio-share'>
            {repositories.filter(repository => repository.documents.length || repository.unsent).map(repository => this.renderRepository(repository))}
        </div>;
    }

    protected renderRepository(repository: ShareRepository): React.ReactNode {
        const state = this.states.get(repository.root)!;
        const { mine, others } = splitDocuments(repository, this.context.me);
        const several = this.context.repositories.filter(r => r.documents.length || r.unsent).length > 1;
        const conflict = state.outcome?.kind === 'conflict' ? state.outcome : undefined;
        return <section key={repository.root} className='studio-share-repository'>
            {several && <h3>{repository.name}</h3>}
            {mine.length > 0 && <>
                <div className='studio-share-heading'>Your documents</div>
                {mine.map(document => this.renderDocument(repository, document))}
            </>}
            {others.length > 0 && <>
                <div className='studio-share-heading'>Edited by others <span className='studio-share-hint'>— left for them to share, unless you tick them</span></div>
                {others.map(document => this.renderDocument(repository, document))}
            </>}
            {repository.unsent > 0 && repository.documents.length === 0 &&
                <div className='studio-share-note'>A change you shared earlier has not reached the team yet.</div>}
            {conflict ? this.renderConflict(repository, conflict) : <>
                <label className='studio-share-label' htmlFor={`studio-share-message-${repository.name}`}>What changed?</label>
                <textarea
                    id={`studio-share-message-${repository.name}`}
                    className='theia-input studio-share-message'
                    rows={2}
                    value={state.message}
                    placeholder='A sentence the team will read'
                    onChange={event => this.setState(repository, { message: event.currentTarget.value })}
                />
                {state.outcome && state.outcome.kind !== 'shared' && this.renderOutcome(state.outcome, state.selected.size)}
                <div className='studio-share-actions'>
                    <button
                        className='theia-button main'
                        disabled={this.busy || (state.selected.size === 0 && repository.unsent === 0)}
                        onClick={() => void this.share(repository)}
                    >{this.busy ? 'Sharing…' : shareLabel(state.selected.size)}</button>
                </div>
            </>}
        </section>;
    }

    protected renderDocument(repository: ShareRepository, document: ShareDocument): React.ReactNode {
        const state = this.states.get(repository.root)!;
        const checked = state.selected.has(document.path);
        const editedBy = document.editors.filter(name => name !== this.context.me?.name);
        return <div key={document.path} className='studio-share-document'>
            <input
                type='checkbox'
                id={`studio-share-${repository.name}-${document.path}`}
                checked={checked}
                disabled={this.busy}
                onChange={() => {
                    const selected = new Set(state.selected);
                    if (checked) { selected.delete(document.path); } else { selected.add(document.path); }
                    this.setState(repository, { selected });
                }}
            />
            <label htmlFor={`studio-share-${repository.name}-${document.path}`} className='studio-share-document-text'>
                <span className='studio-share-title'>{document.title}</span>
                <span className='studio-share-path'>
                    {document.path}
                    {document.state === 'added' ? ' · new' : document.state === 'deleted' ? ' · deleted' : ''}
                    {editedBy.length > 0 ? ` · edited by ${editedBy.join(', ')}` : ''}
                    {document.companions.length > 0 ? ` · ${companionsLabel(document)}` : ''}
                </span>
            </label>
            {document.state !== 'deleted' &&
                <button className='theia-button secondary studio-share-see' onClick={() => this.context.showChanges(document)}>See changes</button>}
        </div>;
    }

    protected renderConflict(repository: ShareRepository, outcome: ShareOutcome): React.ReactNode {
        const conflicts = outcome.conflicts ?? [];
        const titleOf = (path: string) => repository.documents.find(document => document.path === path)?.title ?? path;
        return <div className='studio-share-conflict'>
            <p>Someone changed the same part of {conflicts.length === 1 ? <b>{titleOf(conflicts[0])}</b> : 'these documents'} since you started.
                Nothing was sent yet. Look at both, then choose whose wording to keep where you both wrote —
                everything else either of you changed is kept.</p>
            {conflicts.map(path => <div key={path} className='studio-share-document'>
                <span className='studio-share-title'>{titleOf(path)}</span>
                <button className='theia-button secondary studio-share-see'
                    onClick={() => this.context.showConflict(repository, path, outcome.theirs)}>Compare</button>
            </div>)}
            <div className='studio-share-actions'>
                <button className='theia-button main' disabled={this.busy} onClick={() => void this.share(repository, 'mine')}>Keep my wording</button>
                <button className='theia-button secondary' disabled={this.busy} onClick={() => void this.share(repository, 'theirs')}>Keep theirs</button>
            </div>
        </div>;
    }

    protected renderOutcome(outcome: ShareOutcome, documents: number): React.ReactNode {
        const said = describeOutcome(outcome, documents);
        return <div className={`studio-share-outcome ${said.level}`}>
            {said.text}
            {outcome.kind === 'review' && outcome.reviewUrl &&
                <button className='theia-button secondary' onClick={() => this.context.openLink(outcome.reviewUrl!)}>Ask for review</button>}
            {outcome.kind === 'failed' && outcome.detail &&
                <button className='theia-button secondary' onClick={() => void navigator.clipboard?.writeText(outcome.detail!)}>Copy details</button>}
        </div>;
    }

    protected setState(repository: ShareRepository, patch: Partial<RepositoryState>): void {
        this.states.set(repository.root, { ...this.states.get(repository.root)!, ...patch });
        this.update();
    }

    protected async share(repository: ShareRepository, prefer?: 'mine' | 'theirs'): Promise<void> {
        const state = this.states.get(repository.root)!;
        const chosen = repository.documents.filter(document => state.selected.has(document.path));
        this.busy = true;
        this.update();
        let outcome: ShareOutcome;
        try {
            outcome = await this.context.service.share({
                root: repository.root,
                // After a conflict the documents are already committed; only the choice remains.
                documents: prefer ? [] : chosen.map(document => document.path),
                message: state.message,
                ...(this.context.me ? { author: this.context.me } : {}),
                coAuthors: coAuthorsOf(chosen, this.context.me),
                ...(prefer ? { prefer } : {}),
            });
        } catch (error) {
            outcome = { kind: 'failed', detail: error instanceof Error ? error.message : String(error) };
        }
        this.busy = false;
        this.setState(repository, { outcome });
        const done = outcome.kind === 'shared' || outcome.kind === 'review' || outcome.kind === 'nothing';
        const everyDone = Array.from(this.states.entries()).every(([root, s]) =>
            root === repository.root ? done : !this.context.repositories.find(r => r.root === root)?.documents.length || s.outcome?.kind === 'shared');
        if (done && everyDone && outcome.kind !== 'review') {
            this.context.report(describeOutcome(outcome, chosen.length));
            this.close();
        }
    }
}

function shareLabel(count: number): string {
    return count === 0 ? 'Share' : count === 1 ? 'Share 1 document' : `Share ${count} documents`;
}

function companionsLabel(document: ShareDocument): string {
    const kinds = new Set(document.companions.map(file => file.split('/')[1]));
    const names: string[] = [];
    if (kinds.has('comments')) { names.push('comments'); }
    if (kinds.has('changes')) { names.push('suggestions'); }
    if (kinds.has('history')) { names.push('history'); }
    return `with its ${names.join(' and ')}`;
}
