// What "Share with the team" says and preselects, kept apart from the dialog
// so it can be read and tested on its own. The people this is for are not
// developers: nothing here says commit, push, branch or rebase unless git left
// no other way to put it, and then only as a detail they can copy.

import type { ShareDocument, ShareOutcome, ShareRepository } from '../../common/document-share-protocol';

export interface Person {
    readonly name: string;
    readonly email?: string;
}

/**
 * Mine, unless the document's history says only other people edited it. A
 * document with no recorded editors — edited in the text editor, or on the
 * desktop where every clone is one person's — counts as mine.
 */
export function isMine(document: ShareDocument, me: Person | undefined): boolean {
    return document.editors.length === 0 || (!!me && document.editors.includes(me.name));
}

/**
 * Mine, others', and those already in my pull request as they are — shared
 * for review, so nothing to choose until they change again.
 */
export function splitDocuments(repository: ShareRepository, me: Person | undefined): { mine: ShareDocument[]; others: ShareDocument[]; inReview: ShareDocument[] } {
    const mine: ShareDocument[] = [];
    const others: ShareDocument[] = [];
    const inReview: ShareDocument[] = [];
    for (const document of repository.documents) {
        (document.inReview ? inReview : isMine(document, me) ? mine : others).push(document);
    }
    return { mine, others, inReview };
}

/** The documents there is something to do with: not already in review as they are. */
export function toShare(repository: ShareRepository): ShareDocument[] {
    return repository.documents.filter(document => !document.inReview);
}

/** What the message box starts with: the documents, by their titles. */
export function defaultMessage(documents: readonly ShareDocument[]): string {
    if (!documents.length) {
        return '';
    }
    const titles = documents.map(document => document.title);
    const listed = titles.length <= 3 ? titles.join(', ') : `${titles.slice(0, 3).join(', ')} and ${titles.length - 3} more`;
    const verb = documents.every(document => document.state === 'added') ? 'Add' : documents.every(document => document.state === 'deleted') ? 'Remove' : 'Update';
    return `${verb} ${listed}`;
}

/** The colleagues whose edits go along in a shared document, for the co-author lines. */
export function coAuthorsOf(documents: readonly ShareDocument[], me: Person | undefined): Person[] {
    const names = new Set<string>();
    for (const document of documents) {
        for (const name of document.editors) {
            if (name !== me?.name) {
                names.add(name);
            }
        }
    }
    return Array.from(names, name => ({ name }));
}

/** How many documents are not shared, across the repositories — the status line's number. */
export function unsharedCount(repositories: readonly ShareRepository[]): number {
    return repositories.reduce((sum, repository) => {
        const documents = toShare(repository).length;
        return sum + documents + (documents === 0 && repository.unsent > 0 ? 1 : 0);
    }, 0);
}

export interface Said {
    readonly level: 'info' | 'warn' | 'error';
    readonly text: string;
}

/**
 * An outcome, as a sentence. `viaPullRequest`: the project shares through
 * pull requests, so review is the plan rather than a branch's refusal.
 */
export function describeOutcome(outcome: ShareOutcome, documents: number, viaPullRequest = false): Said {
    const what = documents === 1 ? 'Your document is' : documents > 1 ? `Your ${documents} documents are` : 'Your changes are';
    switch (outcome.kind) {
        case 'shared':
            return { level: 'info', text: `${what} shared with the team.` };
        case 'review':
            if (viaPullRequest) {
                return outcome.reviewUrl
                    ? { level: 'info', text: `${what} in your pull request, for the team to review.` }
                    : {
                        level: 'warn',
                        text: `${what} on "${outcome.branch}", but the pull request could not be opened. ${firstLine(outcome.detail)}`.trim(),
                    };
            }
            return {
                level: 'info',
                text: `The project only takes reviewed changes, so yours went to review as "${outcome.branch}".`
                    + (outcome.reviewUrl ? ' Ask a colleague to look at it.' : ''),
            };
        case 'conflict':
            return { level: 'warn', text: 'Someone changed the same part of this document since you started. Nothing was sent yet — choose whose wording to keep.' };
        case 'sign-in':
            return { level: 'error', text: 'The repository did not accept your sign-in. Sign in to Constructor Studio again, then share again.' };
        case 'offline':
            return { level: 'error', text: 'The repository could not be reached. Check the connection, then share again — your changes are kept.' };
        case 'nothing':
            return { level: 'info', text: 'Everything is already shared.' };
        default:
            return { level: 'error', text: `Your changes could not be shared. ${firstLine(outcome.detail)}`.trim() };
    }
}

function firstLine(detail: string | undefined): string {
    const line = (detail ?? '').split('\n').map(part => part.replace(/^(fatal|error):\s*/i, '').trim()).find(Boolean);
    return line ? `(${line})` : '';
}
