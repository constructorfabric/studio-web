/*
 * Comment persistence — sidecar files inside the repository.
 *
 * For a document at <root>/docs/prd.md the threads live at
 *   <root>/.studio/comments/docs/prd.md.json
 *
 * Consequences of this choice, on purpose:
 *  - comments are committed with the branch they belong to;
 *  - they show up in pull requests as reviewable diffs;
 *  - no Studio-side database is needed;
 *  - and the .md file itself stays clean Markdown.
 *
 * Anchoring is by quoted text plus occurrence index, not by line number, so an
 * edit elsewhere in the document does not move every anchor. An edit to the
 * quoted text itself orphans the thread, which is surfaced rather than hidden.
 */

const { URI } = require('@theia/core/lib/common/uri');

const SIDECAR_DIR = '.studio/comments';

function sidecarUri(rootUri, docUri) {
    const rootStr = rootUri.toString();
    const docStr = docUri.toString();
    const rel = docStr.startsWith(rootStr) ? docStr.slice(rootStr.length).replace(/^\//, '') : docUri.path.base;
    return new URI(rootStr + '/' + SIDECAR_DIR + '/' + rel + '.json');
}

function newId() {
    return 'c-' + Math.abs(Date.now() ^ (performance.now() * 1000 | 0)).toString(36) +
        '-' + (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID().slice(0, 8) : Math.floor(Math.random() * 1e6).toString(36));
}

class CommentsStore {
    constructor(fileService, workspaceService) {
        this.fileService = fileService;
        this.workspaceService = workspaceService;
    }

    async rootFor(docUri) {
        const roots = await this.workspaceService.roots;
        const match = roots
            .filter(r => docUri.toString().startsWith(r.resource.toString()))
            .sort((a, b) => b.resource.toString().length - a.resource.toString().length)[0];
        return match ? match.resource : docUri.parent;
    }

    async load(docUri) {
        const root = await this.rootFor(docUri);
        const uri = sidecarUri(root, docUri);
        try {
            if (!(await this.fileService.exists(uri))) { return { version: 1, threads: [] }; }
            const content = await this.fileService.read(uri);
            const parsed = JSON.parse(content.value);
            return { version: 1, threads: Array.isArray(parsed.threads) ? parsed.threads : [] };
        } catch (e) {
            console.warn('[studio] could not read comments sidecar', uri.toString(), e);
            return { version: 1, threads: [] };
        }
    }

    async save(docUri, data) {
        const root = await this.rootFor(docUri);
        const uri = sidecarUri(root, docUri);
        const body = JSON.stringify({ version: 1, threads: data.threads }, undefined, 2) + '\n';
        try {
            await this.fileService.write(uri, body);
        } catch (e) {
            // file (or .studio/comments/…) does not exist yet
            const { BinaryBuffer } = require('@theia/core/lib/common/buffer');
            await this.fileService.createFile(uri, BinaryBuffer.fromString(body), { overwrite: true });
        }
        return uri;
    }

    relativeSidecarPath(rootUri, docUri) {
        return sidecarUri(rootUri, docUri).path.toString();
    }
}

module.exports = { CommentsStore, newId, sidecarUri };
