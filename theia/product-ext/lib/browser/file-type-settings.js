/*
 * Per-repository file-type visibility.
 *
 * Why not `files.exclude`: it IS folder-scoped (filesystem-preferences.ts:54),
 * but FileNavigatorFilter reads it with no resource argument
 * (navigator-filter.ts:55) — so one root's value would silently apply to every
 * root. A per-repo setting therefore needs its own filter.
 *
 * Settings live in the repository at <root>/.studio/settings.json, matching the
 * comments sidecar convention: the choice is committed with the repo rather
 * than being per-machine UI state.
 */

const DEFAULT_ON = ['md', 'html', 'txt', 'json', 'csv', 'tsv'];

// Offered in the settings UI. Anything not listed and not in DEFAULT_ON is
// still hidden unless the user adds it, so the list doubles as the vocabulary.
const KNOWN_TYPES = [
    'md', 'html', 'txt', 'json', 'csv', 'tsv',
    'yaml', 'yml', 'xml', 'svg', 'png', 'jpg', 'pdf',
    'ts', 'js', 'tsx', 'jsx', 'py', 'sh', 'css', 'scss'
];

const SETTINGS_PATH = '.studio/settings.json';

class FileTypeSettings {

    constructor() {
        this.byRoot = new Map();          // root uri string -> Set(ext)
        // The whole parsed settings object per root, so writing one key never
        // discards another. The file is committed to the repository, so it can
        // legitimately contain keys a given build does not know about.
        this.rawByRoot = new Map();
        this.listeners = [];
        this.fileService = undefined;
        this.workspaceService = undefined;
    }

    init(fileService, workspaceService) {
        this.fileService = fileService;
        this.workspaceService = workspaceService;
        this.reloadAll();
        workspaceService.onWorkspaceChanged(() => this.reloadAll());
    }

    onChanged(fn) { this.listeners.push(fn); }
    fireChanged() { this.listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }

    settingsUri(rootUri) {
        const { URI } = require('@theia/core/lib/common/uri');
        return new URI(rootUri.toString() + '/' + SETTINGS_PATH);
    }

    async reloadAll() {
        if (!this.workspaceService) { return; }
        const roots = await this.workspaceService.roots;
        await Promise.all(roots.map(r => this.loadRoot(r.resource)));
        this.fireChanged();
    }

    async loadRoot(rootUri) {
        const key = rootUri.toString();
        try {
            const uri = this.settingsUri(rootUri);
            if (await this.fileService.exists(uri)) {
                const parsed = JSON.parse((await this.fileService.read(uri)).value);
                this.rawByRoot.set(key, parsed && typeof parsed === 'object' ? parsed : {});
                if (Array.isArray(parsed.visibleExtensions)) {
                    this.byRoot.set(key, new Set(parsed.visibleExtensions.map(e => e.toLowerCase())));
                    return;
                }
            }
        } catch (e) {
            console.warn('[studio] could not read', SETTINGS_PATH, 'for', key, e);
        }
        this.byRoot.set(key, new Set(DEFAULT_ON));
    }

    forRoot(rootUri) {
        return this.byRoot.get(rootUri.toString()) || new Set(DEFAULT_ON);
    }

    /*
     * Read-modify-write against DISK, not just the in-memory copy.
     *
     * The file is committed to the repository, so it can be edited outside the
     * app or written by another root's load ordering — and the in-memory copy
     * is only as good as the last load. Re-reading here is what stops writing
     * one key (`autosave`) from dropping another (`visibleExtensions`).
     */
    async writeRoot(rootUri, patch) {
        const key = rootUri.toString();
        let current = this.rawByRoot.get(key);
        try {
            const uri = this.settingsUri(rootUri);
            if (await this.fileService.exists(uri)) {
                const parsed = JSON.parse((await this.fileService.read(uri)).value);
                if (parsed && typeof parsed === 'object') { current = { ...(current || {}), ...parsed }; }
            }
        } catch (e) {
            console.warn('[studio] could not re-read', SETTINGS_PATH, 'before writing', e);
        }
        const merged = { ...(current || {}), ...patch };
        this.rawByRoot.set(key, merged);
        const uri = this.settingsUri(rootUri);
        const body = JSON.stringify(merged, undefined, 2) + '\n';
        try {
            await this.fileService.write(uri, body);
        } catch (e) {
            const { BinaryBuffer } = require('@theia/core/lib/common/buffer');
            await this.fileService.createFile(uri, BinaryBuffer.fromString(body), { overwrite: true });
        }
        this.fireChanged();
    }

    async setForRoot(rootUri, extensions) {
        const key = rootUri.toString();
        this.byRoot.set(key, new Set(extensions.map(e => e.toLowerCase())));
        await this.writeRoot(rootUri, { visibleExtensions: [...this.byRoot.get(key)].sort() });
    }

    /*
     * Requirement 11's "configured workspace policy". Autosave is the default
     * because that is what the product's editors already did; a project that
     * wants explicit saves opts out, and the choice travels with the repo
     * rather than being per-machine UI state.
     */
    autosaveFor(rootUri) {
        const raw = rootUri && this.rawByRoot.get(rootUri.toString());
        return !raw || raw.autosave === undefined ? true : !!raw.autosave;
    }

    async setAutosave(rootUri, enabled) {
        await this.writeRoot(rootUri, { autosave: !!enabled });
    }

    /*
     * Authoring modes: OFF by default, per project.
     *
     * The Rich / Split / Raw switch is a power feature, not the product's normal
     * way of editing. A document product's promise is that you edit the document,
     * and two of the three modes show Markdown source — useful when you need it,
     * a permanent invitation to leave the rendered surface when you do not. So the
     * default is Rich only and the switch is not rendered at all; a project that
     * wants source editing turns it on, and the choice travels with the repo
     * exactly like the file filter and the saving policy.
     *
     * Absent means false here, unlike `autosave` above, where absent means true.
     * Both defaults are the safe one for their own setting: a project that has
     * never been configured saves your work and does not offer to open a source
     * pane.
     */
    authoringModesFor(rootUri) {
        const raw = rootUri && this.rawByRoot.get(rootUri.toString());
        return !!(raw && raw.authoringModes);
    }

    async setAuthoringModes(rootUri, enabled) {
        await this.writeRoot(rootUri, { authoringModes: !!enabled });
    }

    /*
     * How a pending proposal is reviewed. Two styles, one pipeline.
     *
     *   'queue'  — the diff queue. Hunks in the rail with `+`/`−` gutters, the
     *              document held at its reviewed state beside them.
     *   'inline' — tracked changes. The document itself carries the deletions
     *              and insertions, and the rail carries one card per change.
     *
     * A project setting rather than a per-document or per-machine one, for the
     * same reason as the two above it: it decides how this project is reviewed,
     * and two people reviewing the same proposal should be looking at the same
     * thing. It travels with the branch.
     *
     * 'queue' is the default because it is what every existing project already
     * behaves like, and a settings key appearing in a build must not silently
     * change how work already in flight is presented.
     *
     * Anything unrecognised in the file reads as 'queue' rather than throwing.
     * The file is committed and hand-editable, so a typo has to degrade to the
     * conservative style, not to a broken review surface.
     */
    changeReviewFor(rootUri) {
        const raw = rootUri && this.rawByRoot.get(rootUri.toString());
        return raw && raw.changeReview === 'inline' ? 'inline' : 'queue';
    }

    async setChangeReview(rootUri, style) {
        await this.writeRoot(rootUri, { changeReview: style === 'inline' ? 'inline' : 'queue' });
    }

    /** Review style for the root that owns `uri`. */
    changeReviewForFile(uri) {
        const key = this.rootOf(uri);
        if (!key) { return 'queue'; }
        const raw = this.rawByRoot.get(key);
        return raw && raw.changeReview === 'inline' ? 'inline' : 'queue';
    }

    /** Authoring-modes policy for the root that owns `uri`. */
    authoringModesForFile(uri) {
        const key = this.rootOf(uri);
        if (!key) { return false; }
        const raw = this.rawByRoot.get(key);
        return !!(raw && raw.authoringModes);
    }

    /** Autosave policy for the root that owns `uri`. */
    autosaveForFile(uri) {
        const key = this.rootOf(uri);
        if (!key) { return true; }
        const raw = this.rawByRoot.get(key);
        return !raw || raw.autosave === undefined ? true : !!raw.autosave;
    }

    /**
     * Set the policy from a document, which is where the control that changes
     * it lives — callers there hold a file URI, not a workspace root.
     */
    async setAutosaveForFile(uri, enabled) {
        const key = this.rootOf(uri);
        if (!key) { return false; }
        const { URI } = require('@theia/core/lib/common/uri');
        await this.setAutosave(new URI(key), enabled);
        return true;
    }

    /** Root URI that owns `uri`, or undefined. */
    rootOf(uri) {
        let best;
        for (const key of this.byRoot.keys()) {
            if (uri.toString().startsWith(key) && (!best || key.length > best.length)) { best = key; }
        }
        return best;
    }

    /** True when the navigator should show this file. Directories always pass. */
    allows(uri, isDirectory) {
        if (isDirectory) { return true; }
        const rootKey = this.rootOf(uri);
        const allowed = rootKey ? this.byRoot.get(rootKey) : undefined;
        if (!allowed) { return true; }              // settings not loaded yet — do not hide anything
        const ext = (uri.path.ext || '').replace(/^\./, '').toLowerCase();
        if (!ext) { return false; }                 // extension-less files are "other"
        return allowed.has(ext);
    }
}

const fileTypeSettings = new FileTypeSettings();

/*
 * Compose our predicate onto the navigator's filter, preserving its built-in
 * `files.exclude` behaviour rather than replacing it.
 *
 * HONEST CAVEAT: this patches the resolved singleton's `filterItem` rather than
 * rebinding the class. Rebinding to `container.resolve(FileNavigatorFilter)`
 * self-recurses ("circular dependency in one of the toDynamicValue bindings"),
 * and reconstructing the object by hand means hard-coding its private property
 * names. Theia exposes no contribution point for navigator filters, so this is
 * the one unsupported seam in this build. A production version should upstream
 * a `FileNavigatorFilterContribution` or subclass the filter in TypeScript.
 */
function patchNavigatorFilter(container) {
    const { FileNavigatorFilter } = require('@theia/navigator/lib/browser/navigator-filter');
    const { FileStatNode } = require('@theia/filesystem/lib/browser');

    const filter = container.get(FileNavigatorFilter);
    if (filter.__studioPatched) { return; }
    filter.__studioPatched = true;

    const inherited = filter.filterItem.bind(filter);
    filter.filterItem = item => {
        if (!inherited(item)) { return false; }
        if (!FileStatNode.is(item)) { return true; }
        return fileTypeSettings.allows(item.uri, !!(item.fileStat && item.fileStat.isDirectory));
    };
    fileTypeSettings.onChanged(() => filter.fireFilterChanged());
}

module.exports = { fileTypeSettings, patchNavigatorFilter, DEFAULT_ON, KNOWN_TYPES };
