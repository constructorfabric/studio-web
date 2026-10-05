/*
 * Watch for files that may not exist yet, anywhere below a folder that may not
 * exist yet either.
 *
 * Two traps, both measured:
 *
 *  1. A Theia watch registered on a path that does not exist is silently inert
 *     and never recovers when the path appears. comment-log.js and change-log.js
 *     each stepped back from the per-document directory to `.studio/comments`
 *     and `.studio/changes` for that reason — but in a repository nobody has
 *     commented in or suggested in, `.studio` itself does not exist, so the
 *     FIRST comment or suggestion in a project still never reached the
 *     colleague who had the document open. Seen on a stand: Bob's suggestion on
 *     disk, Alice's editor showing none until she reopened it.
 *  2. `FileService.watch` defaults to `recursive: false`, and the interesting
 *     files sit several levels below the folder watched
 *     (`.studio/changes/docs/spec.md/<author>.json`).
 *
 * So: watch the repository root, which always exists, recursively. Theia keeps
 * one watcher per root on the backend and already watches the workspace root
 * for the explorer, so this adds a subscription, not a second crawl; the
 * caller's prefix filter on `onDidFilesChange` keeps the result precise.
 */

/** @returns a disposable for the watch, or undefined when it could not be registered. */
function watchTree(fileService, rootUri, onError) {
    try {
        return fileService.watch(rootUri, { recursive: true, excludes: [] });
    } catch (e) {
        if (onError) { onError(e); }
        return undefined;
    }
}

module.exports = { watchTree };
