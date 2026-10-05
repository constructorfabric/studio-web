// What the rendered markdown comparison asks git that vscode.git's file system
// provider cannot answer: which branches and tags a document's repository
// has, and where a branch left the one checked out. Reading a document AT a
// ref stays vscode.git's (`git:` uris, browser/markdown-diff/markdown-diff-uri.ts).

export const markdownDiffGitServicePath = '/services/studio-markdown-diff-git';

export const MarkdownDiffGitService = Symbol('MarkdownDiffGitService');

export interface MarkdownDiffRef {
    /** As git abbreviates it: `main`, `origin/alice/spec`, `v1.2`. */
    readonly name: string;
    readonly kind: 'branch' | 'remote' | 'tag';
    readonly sha: string;
    /** ISO-8601, the ref's last commit. */
    readonly date: string;
    readonly author: string;
}

export interface MarkdownDiffRefs {
    /** The branch checked out, when one is. */
    readonly current?: string;
    /** Most recently committed first. */
    readonly refs: readonly MarkdownDiffRef[];
}

export interface MarkdownDiffGitService {
    /** The refs of the repository that holds `file` (a file uri); none outside a repository. */
    listRefs(file: string): Promise<MarkdownDiffRefs>;
    /** Where `ref` and the checked-out HEAD diverged — the start of what that branch changed. */
    mergeBase(file: string, ref: string): Promise<string | undefined>;
}
