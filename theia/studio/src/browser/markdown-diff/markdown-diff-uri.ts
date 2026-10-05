// The address of one rendered comparison, so a comparison is opened, found
// again and restored with the layout like any other editor tab.
//
// `studio-md-diff:<title>?<json>` — the same shape as Theia's own `diff:` URI
// (DiffUris), with a label per side and the file relative images resolve
// against, which a `diff:` URI has no room for.

import URI from '@theia/core/lib/common/uri';
import { OS } from '@theia/core/lib/common/os';

export const MARKDOWN_DIFF_SCHEME = 'studio-md-diff';

export interface MarkdownDiffSide {
    /** Where this version is read from: a file, a `git:` revision, an in-memory snapshot. */
    readonly uri: string;
    /** What the column is called: `HEAD`, `Working Tree`, `On disk`, a date. */
    readonly label: string;
}

/** A discussion anchored in the document: the passage it quotes, and what to call it. */
export interface MarkdownDiffNote {
    readonly quote: string;
    readonly label: string;
}

export interface MarkdownDiffInput {
    readonly title: string;
    readonly left: MarkdownDiffSide;
    readonly right: MarkdownDiffSide;
    /** The file the document lives in, for its relative images and links. */
    readonly base?: string;
    /** Open discussions, marked where their passage is — and where it no longer is. */
    readonly notes?: readonly MarkdownDiffNote[];
}

export function encodeMarkdownDiffUri(input: MarkdownDiffInput): URI {
    return new URI().withScheme(MARKDOWN_DIFF_SCHEME).withPath(input.title).withQuery(JSON.stringify({
        left: input.left,
        right: input.right,
        base: input.base,
        ...(input.notes && input.notes.length ? { notes: input.notes } : {}),
    }));
}

export function decodeMarkdownDiffUri(uri: URI): MarkdownDiffInput {
    if (uri.scheme !== MARKDOWN_DIFF_SCHEME) {
        throw new Error(`Not a rendered markdown comparison: ${uri.toString()}`);
    }
    const { left, right, base, notes } = JSON.parse(uri.query) as Omit<MarkdownDiffInput, 'title'>;
    return { title: uri.path.toString(), left, right, base, ...(notes ? { notes } : {}) };
}

export function isMarkdownUri(uri: URI): boolean {
    const extension = uri.path.ext.toLowerCase();
    return extension === '.md' || extension === '.markdown';
}

/**
 * A file at a git revision, as the built-in `vscode.git` extension addresses
 * it (its `toGitUri`): the same path under the `git` scheme, and the query
 * `{"path": <fsPath>, "ref": <ref>}`. That extension's file system provider
 * reads it — `HEAD` is the last commit, `~` the index — so the comparison
 * works wherever that extension runs, in the portal's session and on the
 * desktop alike.
 */
export function toGitUri(file: URI, ref: string, backendIsWindows = OS.backend.isWindows): URI {
    return file.withScheme('git').withQuery(JSON.stringify({ path: backendFsPath(file, backendIsWindows), ref }));
}

/**
 * The file system path of a file uri as the BACKEND spells it — vscode-uri's
 * `fsPath`, for the plugin host's operating system. Not FileUri.fsPath: that
 * one answers for the browser's, and a portal session opened from Windows then
 * names a Linux file `\\workspace\\docs\\spec.md`, which vscode.git cannot
 * place in any repository.
 */
export function backendFsPath(file: URI, backendIsWindows: boolean): string {
    let path = file.path.toString();
    if (file.authority && path.length > 1) {
        path = `//${file.authority}${path}`;
    } else if (/^\/[a-zA-Z]:/.test(path)) {
        path = path.charAt(1).toLowerCase() + path.slice(2);
    }
    return backendIsWindows ? path.replace(/\//g, '\\') : path;
}

/** The label a column gets when nothing better was given. */
export function sideLabel(uri: URI): string {
    if (uri.scheme === 'git') {
        try {
            const { ref } = JSON.parse(uri.query) as { ref?: string };
            if (ref === '~' || ref === '') {
                return 'Index';
            }
            if (ref) {
                return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
            }
        } catch {
            // Not one of vscode.git's; fall through to the name.
        }
    }
    if (uri.scheme === 'file') {
        return 'Working Tree';
    }
    return uri.path.base;
}
