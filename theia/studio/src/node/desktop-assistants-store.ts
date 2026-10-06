import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, Transform, Writable } from 'stream';
import * as yauzl from 'yauzl';
import {
    AssistantPin, AssistantStatus, AssistantsStatus, assistantFolderName, assistantVsixName
} from '../common/desktop-assistants';

/**
 * Fetching, checking and unpacking the pinned assistant extensions on a
 * desktop (#480). No Theia here: `DesktopAssistantsContribution` wires this to
 * the plugin deployer and the routes, so all of it is testable with a folder
 * and a fake download.
 *
 * On disk, under the plugins directory (`~/ConstructorStudio/plugins`):
 *
 *     anthropic.claude-code-2.1.227/            one pinned version
 *       anthropic.claude-code/                  the unpacked VSIX
 *         extension.vsixmanifest
 *         extension/package.json …
 *
 * The extra level is what Theia's `local-dir:` resolver wants: it deploys each
 * child of the folder it is given, so `local-dir:<version folder>` deploys
 * exactly that version and nothing else — at start (desktop-main.js) and live
 * (`PluginServer.install`) alike. Work in progress is a `.partial-*` entry
 * beside them, which is never a plugin and is removed on the next start.
 */

/** Streams `url` into `file`, reporting bytes as they arrive. */
export type Download = (url: string, file: string, progress: (received: number, total?: number) => void) => Promise<void>;
/** Deploys a `local-dir:` entry into the running app. */
export type Deploy = (entry: string) => Promise<void>;

export interface AssistantStoreOptions {
    readonly pluginsDir: string;
    readonly pins: readonly AssistantPin[];
    /** Where a member may put a VSIX by hand, looked at before the network. */
    readonly dropDirs?: readonly string[];
    readonly download?: Download;
    readonly deploy: Deploy;
    readonly log?: (line: string) => void;
}

const PARTIAL = '.partial-';

/** `source.pipe(...)` into `sink`, settled when the sink has flushed or anything fails. */
function pump(source: Readable, sink: Writable, via?: Transform): Promise<void> {
    return new Promise((resolve, reject) => {
        const fail = (error: Error): void => { source.destroy(); sink.destroy(); reject(error); };
        source.on('error', fail);
        via?.on('error', fail);
        sink.on('error', fail);
        sink.on('finish', () => resolve());
        (via ? source.pipe(via) : source).pipe(sink);
    });
}

/** Lower-case hex SHA-256 of a file, streamed. */
export async function sha256File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        fs.createReadStream(file)
            .on('data', chunk => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/** Whether a zip entry's name stays inside the folder it is unpacked into. */
export function safeEntryName(name: string): boolean {
    const normal = name.replace(/\\/g, '/');
    return normal !== '' && !normal.startsWith('/') && !/^[A-Za-z]:/.test(normal)
        && !normal.split('/').some(part => part === '..');
}

/**
 * The entries a target leaves out. Codex's win32 VSIX also carries its linux
 * binaries (361 MB unpacked), used only for "run Codex in WSL", which is off by
 * default; the installer used to drop them too.
 */
export function skippedEntry(name: string, target: string): boolean {
    return target.startsWith('win32-') && /^extension\/bin\/linux-[^/]+\//.test(name.replace(/\\/g, '/'));
}

/**
 * Whether a zip entry is executable: the Unix mode its archiver recorded, in
 * the high half of the external attributes. The gearbox engine, the CLI's
 * Python and its `cfs` shim are; on macOS and Linux they run only with the bit.
 */
export function executableEntry(entry: Pick<yauzl.Entry, 'externalFileAttributes'>): boolean {
    return ((entry.externalFileAttributes >>> 16) & 0o111) !== 0;
}

/**
 * Unpacks a VSIX (a zip) into `dest`, refusing any entry that would land
 * outside it. An entry the archive marks executable stays executable.
 */
export function unpackVsix(vsix: string, dest: string, skip: (name: string) => boolean = () => false): Promise<void> {
    return new Promise((resolve, reject) => {
        yauzl.open(vsix, { lazyEntries: true, autoClose: true }, (openError, zip) => {
            if (openError || !zip) {
                reject(openError ?? new Error('not a zip file'));
                return;
            }
            const fail = (error: Error): void => { zip.close(); reject(error); };
            zip.on('error', fail);
            zip.on('end', () => resolve());
            zip.on('entry', (entry: yauzl.Entry) => {
                const name = entry.fileName;
                if (!safeEntryName(name)) {
                    fail(new Error(`the archive names a path outside its folder: ${name}`));
                    return;
                }
                const target = path.join(dest, name);
                if (name.endsWith('/') || skip(name)) {
                    if (name.endsWith('/') && !skip(name)) {
                        fs.mkdirSync(target, { recursive: true });
                    }
                    zip.readEntry();
                    return;
                }
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) {
                        fail(streamError ?? new Error(`cannot read ${name}`));
                        return;
                    }
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    const mode = executableEntry(entry) ? 0o755 : 0o644;
                    pump(stream, fs.createWriteStream(target, { mode }))
                        // Past the umask, and over a file an earlier attempt left.
                        .then(() => process.platform === 'win32' ? undefined : fs.promises.chmod(target, mode))
                        .then(() => zip.readEntry(), fail);
                });
            });
            zip.readEntry();
        });
    });
}

/** The errors Windows gives a rename while something still holds a file under the folder. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * `fs.rename`, tried again while Windows says the folder is busy. An unpacked
 * extension holding an executable (the Gearbox engine's `gearbox.exe`) is
 * opened by the antivirus the moment it is written, and a rename of the folder
 * around it fails with EPERM until that scan lets go — a second or several.
 * graceful-fs retries the same way. Anything else fails at once.
 */
export async function renameWhenFree(
    from: string, to: string,
    { budgetMs = 30_000, rename = fs.promises.rename, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }: {
        budgetMs?: number;
        rename?: (from: string, to: string) => Promise<void>;
        wait?: (ms: number) => Promise<void>;
    } = {},
): Promise<void> {
    let delay = 100;
    let spent = 0;
    for (;;) {
        try {
            await rename(from, to);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (!code || !BUSY.has(code) || spent >= budgetMs) {
                throw error;
            }
            await wait(delay);
            spent += delay;
            delay = Math.min(delay * 2, 2_000);
        }
    }
}

/** The default download: Node's fetch, streamed, abandoned when nothing arrives for a minute. */
export const fetchDownload: Download = async (url, file, progress) => {
    const controller = new AbortController();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
        if (idle) { clearTimeout(idle); }
        idle = setTimeout(() => controller.abort(new Error('the download stalled')), 60_000);
    };
    arm();
    try {
        const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        if (!response.ok || !response.body) {
            throw new Error(`${new URL(url).host} answered ${response.status}`);
        }
        const length = Number(response.headers.get('content-length'));
        const total = Number.isFinite(length) && length > 0 ? length : undefined;
        let received = 0;
        const count = new Transform({
            transform(chunk: Buffer, _encoding, done): void {
                received += chunk.length;
                arm();
                progress(received, total);
                done(undefined, chunk);
            },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await pump(Readable.fromWeb(response.body as any), fs.createWriteStream(file), count);
    } finally {
        if (idle) { clearTimeout(idle); }
    }
};

/** Why a download failed, in words that say what to do. */
function describeFailure(error: unknown, pin: AssistantPin, pluginsDir: string): string {
    const inner = (error as { cause?: unknown } | undefined)?.cause;
    const cause = inner instanceof Error ? inner.message : error instanceof Error ? error.message : String(error);
    const host = (() => { try { return new URL(pin.url).host; } catch { return pin.url; } })();
    return `${host} could not be reached (${cause}). Check the connection and try again, `
        + `or put ${assistantVsixName(pin)} into ${pluginsDir} and try again`;
}

interface Entry {
    status: AssistantStatus;
    running?: Promise<void>;
}

export class AssistantStore {
    protected readonly entries = new Map<string, Entry>();
    protected readonly download: Download;
    protected readonly log: (line: string) => void;

    constructor(protected readonly options: AssistantStoreOptions) {
        this.download = options.download ?? fetchDownload;
        this.log = options.log ?? (line => console.info(`[studio-desktop] ${line}`));
        for (const pin of options.pins) {
            this.entries.set(pin.id, {
                status: { id: pin.id, label: pin.label, version: pin.version, state: this.isInstalled(pin) ? 'ready' : 'missing' },
            });
        }
    }

    /** The folder one pinned version lives in. */
    folderOf(pin: AssistantPin): string {
        return path.join(this.options.pluginsDir, assistantFolderName(pin));
    }

    isInstalled(pin: AssistantPin): boolean {
        return fs.existsSync(path.join(this.folderOf(pin), pin.id, 'extension', 'package.json'));
    }

    status(): AssistantsStatus {
        return { assistants: this.options.pins.map(pin => this.entries.get(pin.id)!.status) };
    }

    /**
     * Fetches whatever is missing, one at a time in manifest order, and
     * removes what an earlier start left half done or out of date. Safe to
     * call again while it runs: it joins the run in progress.
     */
    async ensure(): Promise<void> {
        this.removePartials();
        for (const pin of this.options.pins) {
            await this.ensureOne(pin);
        }
    }

    /** Tries a failed one again (or all of them). */
    async retry(id?: string): Promise<void> {
        for (const pin of this.options.pins) {
            const entry = this.entries.get(pin.id)!;
            if ((!id || id === pin.id) && entry.status.state === 'failed') {
                entry.status = { ...entry.status, state: 'missing', error: undefined };
            }
        }
        await this.ensure();
    }

    protected ensureOne(pin: AssistantPin): Promise<void> {
        const entry = this.entries.get(pin.id)!;
        if (entry.running) {
            return entry.running;
        }
        if (entry.status.state === 'ready') {
            this.removeOtherVersions(pin);
            return Promise.resolve();
        }
        if (entry.status.state === 'failed') {
            return Promise.resolve();
        }
        entry.running = this.install(pin, entry).finally(() => { entry.running = undefined; });
        return entry.running;
    }

    protected set(entry: Entry, status: Partial<AssistantStatus>): void {
        entry.status = { ...entry.status, ...status };
    }

    protected async install(pin: AssistantPin, entry: Entry): Promise<void> {
        const dir = this.options.pluginsDir;
        const partial = path.join(dir, `${PARTIAL}${assistantFolderName(pin)}-${randomBytes(4).toString('hex')}`);
        const vsix = `${partial}.vsix`;
        try {
            fs.mkdirSync(dir, { recursive: true });
            this.set(entry, { state: 'downloading', percent: undefined, error: undefined });
            const source = await this.droppedVsix(pin);
            if (source) {
                this.log(`${pin.label} ${pin.version}: using ${source}`);
            } else {
                this.log(`${pin.label} ${pin.version}: downloading ${pin.url}`);
                try {
                    await this.download(pin.url, vsix, (received, total) => {
                        if (total) {
                            this.set(entry, { percent: Math.min(100, Math.floor(received * 100 / total)) });
                        }
                    });
                } catch (error) {
                    throw new Error(describeFailure(error, pin, dir));
                }
                const digest = await sha256File(vsix);
                if (digest !== pin.sha256) {
                    throw new Error(`the download did not match its pinned checksum (got ${digest.slice(0, 12)}…), so it was discarded. Try again later`);
                }
            }
            this.set(entry, { state: 'installing', percent: undefined });
            await unpackVsix(source ?? vsix, path.join(partial, pin.id), name => skippedEntry(name, pin.target));
            if (!fs.existsSync(path.join(partial, pin.id, 'extension', 'package.json'))) {
                throw new Error('the archive is not a VS Code extension (no extension/package.json)');
            }
            const folder = this.folderOf(pin);
            fs.rmSync(folder, { recursive: true, force: true });
            await renameWhenFree(partial, folder);
            await this.options.deploy(`local-dir:${folder}`);
            this.set(entry, { state: 'ready' });
            this.log(`${pin.label} ${pin.version}: installed in ${folder}`);
            this.removeOtherVersions(pin);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.set(entry, { state: 'failed', percent: undefined, error: message });
            this.log(`${pin.label} ${pin.version}: failed: ${message}`);
            fs.rmSync(partial, { recursive: true, force: true });
        } finally {
            fs.rmSync(vsix, { force: true });
        }
    }

    /** A VSIX the member put in place by hand, when its digest is the pinned one. */
    protected async droppedVsix(pin: AssistantPin): Promise<string | undefined> {
        for (const dir of [this.options.pluginsDir, ...(this.options.dropDirs ?? [])]) {
            const file = path.join(dir, assistantVsixName(pin));
            if (!fs.existsSync(file)) {
                continue;
            }
            const digest = await sha256File(file);
            if (digest === pin.sha256) {
                return file;
            }
            this.log(`${file} is not the pinned ${pin.label} ${pin.version} (checksum differs); ignored`);
        }
        return undefined;
    }

    /** Other versions of the same extension: only once the pinned one is in place. */
    protected removeOtherVersions(pin: AssistantPin): void {
        const keep = assistantFolderName(pin);
        for (const name of this.list()) {
            if (name !== keep && name.startsWith(`${pin.id}-`) && /^\d/.test(name.slice(pin.id.length + 1))) {
                this.log(`removing ${name}, replaced by ${pin.version}`);
                fs.rmSync(path.join(this.options.pluginsDir, name), { recursive: true, force: true });
            }
        }
    }

    /** What an interrupted run left behind. */
    protected removePartials(): void {
        for (const name of this.list()) {
            if (name.startsWith(PARTIAL) && ![...this.entries.values()].some(e => e.running)) {
                fs.rmSync(path.join(this.options.pluginsDir, name), { recursive: true, force: true });
            }
        }
    }

    protected list(): string[] {
        try {
            return fs.readdirSync(this.options.pluginsDir);
        } catch {
            return [];
        }
    }
}
