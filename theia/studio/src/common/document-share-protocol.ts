// "Share with the team": the one step that takes a person's edited documents
// from their editor to the project's repository, for people who do not use git.
//
// The decisions behind it (2026-10-05): changes go straight to the branch the
// project works on, and to a branch of their own for review only when that one
// refuses them; in a portal session — one checkout for everybody — a person
// shares the documents THEY edited, a colleague's edits in the same file going
// along as co-authors; and sharing is a button, never automatic.
//
// Outcomes are kinds, not git's words: the frontend says each in plain
// language, and git's own text is kept only as `detail` for whoever has to dig.

export const documentShareServicePath = '/services/studio-document-share';

export const DocumentShareService = Symbol('DocumentShareService');

export interface SharePerson {
    readonly name: string;
    readonly email?: string;
}

export interface ShareDocument {
    /** Relative to its repository, with forward slashes. */
    readonly path: string;
    /** The document's file uri. */
    readonly uri: string;
    readonly state: 'modified' | 'added' | 'deleted';
    /** Its first heading, or the file name. */
    readonly title: string;
    /** Who edited it since it was last shared, from the document's history; empty when nobody is recorded. */
    readonly editors: readonly string[];
    /** The `.studio` files that belong to it (comments, suggestions, history) and changed too. */
    readonly companions: readonly string[];
}

export interface ShareRepository {
    /** The repository's folder (a file uri). */
    readonly root: string;
    /** As a member recognises it: the folder's name. */
    readonly name: string;
    readonly branch?: string;
    readonly upstream?: string;
    /** Commits made here and not on the remote yet — a share that committed but did not arrive. */
    readonly unsent: number;
    readonly documents: readonly ShareDocument[];
}

export interface ShareStatus {
    readonly repositories: readonly ShareRepository[];
}

export interface ShareRequest {
    /** The repository's folder (a file uri), as `status` named it. */
    readonly root: string;
    /** Repository-relative paths of the documents to share; may be empty to send what is already committed. */
    readonly documents: readonly string[];
    /** What changed, in the person's words. */
    readonly message: string;
    readonly author?: SharePerson;
    readonly coAuthors?: readonly SharePerson[];
    /**
     * After a `conflict`: whose wording wins where both changed the same lines.
     * Everything else either side changed is kept either way.
     */
    readonly prefer?: 'mine' | 'theirs';
}

export type ShareOutcomeKind =
    /** On the branch the project works on. */
    | 'shared'
    /** The branch refused direct changes; they went to a branch of their own, for review. */
    | 'review'
    /** Somebody changed the same lines in the meantime; nothing was sent yet. */
    | 'conflict'
    /** The repository did not accept the person's credentials. */
    | 'sign-in'
    /** The remote could not be reached. */
    | 'offline'
    /** Nothing to share. */
    | 'nothing'
    /** Anything else; `detail` says what git said. */
    | 'failed';

export interface ShareOutcome {
    readonly kind: ShareOutcomeKind;
    readonly branch?: string;
    /** For `review`: where to ask for it, when the host printed a link. */
    readonly reviewUrl?: string;
    /** For `conflict`: the documents both sides changed. */
    readonly conflicts?: readonly string[];
    /** For `conflict`: the remote's version to compare with (a ref of the repository). */
    readonly theirs?: string;
    /** git's own words, for a failure nobody planned for. */
    readonly detail?: string;
}

export interface DocumentShareService {
    /** What is not shared yet, in the repositories under these folders (file uris). */
    status(roots: readonly string[]): Promise<ShareStatus>;
    share(request: ShareRequest): Promise<ShareOutcome>;
}
