/**
 * @jest-environment node
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { AssistantPin } from '../common/desktop-assistants';
import {
    AssistantStore, Download, executableEntry, renameWhenFree, safeEntryName, sha256File, skippedEntry, unpackVsix
} from './desktop-assistants-store';
import { assistantsConfigFrom } from './desktop-assistants';

/**
 * A stored (uncompressed) zip, enough for yauzl: local headers, central directory, end record.
 * `modes` records a Unix mode for an entry, as a POSIX archiver does.
 */
function zip(files: Record<string, string>, modes: Record<string, number> = {}): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content);
        const nameBuf = Buffer.from(name);
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        if (modes[name] !== undefined) {
            central.writeUInt16LE((3 << 8) | 20, 4);
            central.writeUInt32LE(((0o100000 | modes[name]) << 16) >>> 0, 38);
        }
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, data);
        centrals.push(central, nameBuf);
        offset += local.length + nameBuf.length + data.length;
    }
    const dir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, end]);
}

const VSIX = zip({
    'extension.vsixmanifest': '<PackageManifest/>',
    'extension/package.json': JSON.stringify({ name: 'chatgpt', publisher: 'openai', version: '2.0.0', engines: { vscode: '^1.90.0' } }),
    'extension/bin/windows-x86_64/codex.exe': 'win',
    'extension/bin/linux-x86_64/codex': 'linux',
});
const DIGEST = createHash('sha256').update(VSIX).digest('hex');

function pin(extra: Partial<AssistantPin> = {}): AssistantPin {
    return {
        id: 'openai.chatgpt', label: 'Codex', version: '2.0.0', target: 'win32-x64',
        url: 'https://open-vsx.org/api/openai/chatgpt/win32-x64/2.0.0/file/openai.chatgpt-2.0.0@win32-x64.vsix',
        sha256: DIGEST, ...extra,
    };
}

/** A download that writes the given bytes, in two chunks, reporting progress. */
function serving(bytes: Buffer, calls: string[] = []): Download {
    return async (url, file, progress) => {
        calls.push(url);
        const half = Math.floor(bytes.length / 2);
        fs.writeFileSync(file, bytes.subarray(0, half));
        progress(half, bytes.length);
        fs.appendFileSync(file, bytes.subarray(half));
        progress(bytes.length, bytes.length);
    };
}

describe('the desktop assistant store', () => {
    let dir: string;
    let deployed: string[];
    const log = (): void => undefined;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-'));
        deployed = [];
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const deploy = async (entry: string): Promise<void> => { deployed.push(entry); };

    it('downloads, verifies, unpacks into its version folder and deploys it live', async () => {
        const seen: number[] = [];
        const store = new AssistantStore({
            pluginsDir: dir, pins: [pin()], deploy, log,
            download: async (url, file, progress) => serving(VSIX)(url, file, (r, t) => {
                progress(r, t);
                seen.push(store.status().assistants[0].percent ?? -1);
            }),
        });
        expect(store.status().assistants[0].state).toBe('missing');
        await store.ensure();
        const folder = path.join(dir, 'openai.chatgpt-2.0.0');
        expect(store.status().assistants[0]).toMatchObject({ state: 'ready' });
        expect(deployed).toEqual([`local-dir:${folder}`]);
        expect(fs.existsSync(path.join(folder, 'openai.chatgpt', 'extension', 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(folder, 'openai.chatgpt', 'extension', 'bin', 'windows-x86_64', 'codex.exe'))).toBe(true);
        // The linux binaries are only for "run in WSL", off by default.
        expect(fs.existsSync(path.join(folder, 'openai.chatgpt', 'extension', 'bin', 'linux-x86_64'))).toBe(false);
        expect(seen).toEqual([50, 100]);
        expect(fs.readdirSync(dir)).toEqual(['openai.chatgpt-2.0.0']);
    });

    it('discards a download whose digest is not the pinned one, and deploys nothing', async () => {
        const store = new AssistantStore({ pluginsDir: dir, pins: [pin({ sha256: '0'.repeat(64) })], deploy, log, download: serving(VSIX) });
        await store.ensure();
        const status = store.status().assistants[0];
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/did not match its pinned checksum/);
        expect(deployed).toEqual([]);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('says what to do when the download cannot be made (offline)', async () => {
        const store = new AssistantStore({
            pluginsDir: dir, pins: [pin()], deploy, log,
            download: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND open-vsx.org') }); },
        });
        await store.ensure();
        const status = store.status().assistants[0];
        expect(status.state).toBe('failed');
        expect(status.error).toContain('open-vsx.org could not be reached (getaddrinfo ENOTFOUND open-vsx.org)');
        expect(status.error).toContain(`put openai.chatgpt-2.0.0@win32-x64.vsix into ${dir}`);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('uses a VSIX put in place by hand, when its digest is the pinned one', async () => {
        const drop = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-'));
        try {
            fs.writeFileSync(path.join(drop, 'openai.chatgpt-2.0.0@win32-x64.vsix'), VSIX);
            const calls: string[] = [];
            const store = new AssistantStore({ pluginsDir: dir, dropDirs: [drop], pins: [pin()], deploy, log, download: serving(VSIX, calls) });
            await store.ensure();
            expect(calls).toEqual([]);
            expect(store.status().assistants[0].state).toBe('ready');
        } finally {
            fs.rmSync(drop, { recursive: true, force: true });
        }
    });

    it('ignores a hand-placed VSIX with another digest, and downloads instead', async () => {
        fs.writeFileSync(path.join(dir, 'openai.chatgpt-2.0.0@win32-x64.vsix'), 'not it');
        const calls: string[] = [];
        const store = new AssistantStore({ pluginsDir: dir, pins: [pin()], deploy, log, download: serving(VSIX, calls) });
        await store.ensure();
        expect(calls).toHaveLength(1);
        expect(store.status().assistants[0].state).toBe('ready');
    });

    it('removes an older version only once the pinned one has deployed', async () => {
        const old = path.join(dir, 'openai.chatgpt-1.0.0', 'openai.chatgpt', 'extension');
        fs.mkdirSync(old, { recursive: true });
        fs.writeFileSync(path.join(old, 'package.json'), '{}');
        const failing = new AssistantStore({
            pluginsDir: dir, pins: [pin()], log, download: serving(VSIX),
            deploy: async () => { throw new Error('deploy failed'); },
        });
        await failing.ensure();
        expect(failing.status().assistants[0].state).toBe('failed');
        expect(fs.existsSync(path.join(dir, 'openai.chatgpt-1.0.0'))).toBe(true);

        const store = new AssistantStore({ pluginsDir: dir, pins: [pin()], deploy, log, download: serving(VSIX) });
        await store.ensure();
        expect(store.status().assistants[0].state).toBe('ready');
        expect(fs.readdirSync(dir).sort()).toEqual(['openai.chatgpt-2.0.0']);
    });

    it('takes a copy fetched on an earlier run as ready, and clears what an interrupted run left', async () => {
        const installed = path.join(dir, 'openai.chatgpt-2.0.0', 'openai.chatgpt', 'extension');
        fs.mkdirSync(installed, { recursive: true });
        fs.writeFileSync(path.join(installed, 'package.json'), '{}');
        fs.mkdirSync(path.join(dir, '.partial-openai.chatgpt-2.0.0-abcd'));
        fs.writeFileSync(path.join(dir, '.partial-openai.chatgpt-2.0.0-abcd.vsix'), 'half');
        const calls: string[] = [];
        const store = new AssistantStore({ pluginsDir: dir, pins: [pin()], deploy, log, download: serving(VSIX, calls) });
        expect(store.status().assistants[0].state).toBe('ready');
        await store.ensure();
        expect(calls).toEqual([]);
        expect(deployed).toEqual([]);
        expect(fs.readdirSync(dir)).toEqual(['openai.chatgpt-2.0.0']);
    });

    it('tries a failed one again on retry', async () => {
        let online = false;
        const store = new AssistantStore({
            pluginsDir: dir, pins: [pin()], deploy, log,
            download: async (url, file, progress) => {
                if (!online) { throw new Error('offline'); }
                return serving(VSIX)(url, file, progress);
            },
        });
        await store.ensure();
        expect(store.status().assistants[0].state).toBe('failed');
        await store.ensure();
        expect(store.status().assistants[0].state).toBe('failed');
        online = true;
        await store.retry('openai.chatgpt');
        expect(store.status().assistants[0].state).toBe('ready');
    });

    it('joins a run in progress instead of starting a second one', async () => {
        const calls: string[] = [];
        const store = new AssistantStore({ pluginsDir: dir, pins: [pin()], deploy, log, download: serving(VSIX, calls) });
        await Promise.all([store.ensure(), store.ensure()]);
        expect(calls).toHaveLength(1);
        expect(deployed).toHaveLength(1);
    });

    it('refuses an archive that is not an extension', async () => {
        const bad = zip({ 'readme.txt': 'hello' });
        const store = new AssistantStore({
            pluginsDir: dir, pins: [pin({ sha256: createHash('sha256').update(bad).digest('hex') })], deploy, log, download: serving(bad),
        });
        await store.ensure();
        expect(store.status().assistants[0].error).toMatch(/not a VS Code extension/);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
});

describe('unpacking a VSIX', () => {
    it('refuses entries that leave the folder', async () => {
        expect(safeEntryName('extension/package.json')).toBe(true);
        expect(safeEntryName('../evil')).toBe(false);
        expect(safeEntryName('extension/../../evil')).toBe(false);
        expect(safeEntryName('/etc/passwd')).toBe(false);
        expect(safeEntryName('C:/Windows/evil')).toBe(false);
        expect(safeEntryName('extension\\..\\..\\evil')).toBe(false);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpack-'));
        try {
            const file = path.join(dir, 'x.vsix');
            fs.writeFileSync(file, zip({ '../evil.txt': 'x' }));
            await expect(unpackVsix(file, path.join(dir, 'out'))).rejects.toThrow();
            expect(fs.existsSync(path.join(dir, 'evil.txt'))).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    (process.platform === 'win32' ? it.skip : it)('keeps an entry executable when the archive says it is', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpack-'));
        try {
            const file = path.join(dir, 'x.vsix');
            fs.writeFileSync(file, zip({ 'extension/bin/gearbox': 'engine', 'extension/README.md': 'text' }, { 'extension/bin/gearbox': 0o755, 'extension/README.md': 0o644 }));
            await unpackVsix(file, path.join(dir, 'out'));
            expect(fs.statSync(path.join(dir, 'out', 'extension', 'bin', 'gearbox')).mode & 0o111).not.toBe(0);
            expect(fs.statSync(path.join(dir, 'out', 'extension', 'README.md')).mode & 0o111).toBe(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reads the executable bit from an entry', () => {
        expect(executableEntry({ externalFileAttributes: (0o100755 << 16) >>> 0 })).toBe(true);
        expect(executableEntry({ externalFileAttributes: (0o100644 << 16) >>> 0 })).toBe(false);
        // A Windows archiver records no mode.
        expect(executableEntry({ externalFileAttributes: 0x20 })).toBe(false);
    });

    it('leaves out linux binaries only for a windows target', () => {
        expect(skippedEntry('extension/bin/linux-x86_64/codex', 'win32-x64')).toBe(true);
        expect(skippedEntry('extension/bin/windows-x86_64/codex.exe', 'win32-x64')).toBe(false);
        expect(skippedEntry('extension/bin/linux-x86_64/codex', 'linux-x64')).toBe(false);
    });

    it('hashes a file', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-'));
        try {
            fs.writeFileSync(path.join(dir, 'f'), VSIX);
            expect(await sha256File(path.join(dir, 'f'))).toBe(DIGEST);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('assistantsConfigFrom', () => {
    it('is nothing without a manifest, as in a browser session', () => {
        expect(assistantsConfigFrom({})).toBeUndefined();
    });

    it('reads the manifest, the plugins folder and the drop-in folders', () => {
        const config = assistantsConfigFrom({
            STUDIO_DESKTOP_ASSISTANTS: '/app/resources/assistants.json',
            STUDIO_DESKTOP_PLUGINS: '/home/m/ConstructorStudio/plugins',
            STUDIO_DESKTOP_VSIX_DIRS: ['/app', '/media/usb'].join(path.delimiter),
        });
        expect(config).toEqual({
            manifest: '/app/resources/assistants.json',
            pluginsDir: '/home/m/ConstructorStudio/plugins',
            dropDirs: ['/app', '/media/usb'],
        });
        expect(assistantsConfigFrom({ STUDIO_DESKTOP_ASSISTANTS: 'm.json' })?.pluginsDir)
            .toBe(path.join(os.homedir(), 'ConstructorStudio', 'plugins'));
    });
});

describe('moving an unpacked extension into place', () => {
    const busy = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

    it('waits out a folder the antivirus still holds (EPERM on Windows), then renames it', async () => {
        const rename = jest.fn()
            .mockRejectedValueOnce(busy('EPERM'))
            .mockRejectedValueOnce(busy('EBUSY'))
            .mockResolvedValueOnce(undefined);
        const waits: number[] = [];
        await renameWhenFree('a', 'b', { rename, wait: async ms => { waits.push(ms); } });
        expect(rename).toHaveBeenCalledTimes(3);
        expect(waits).toEqual([100, 200]);
    });

    it('gives up with the last error once its budget is spent', async () => {
        const rename = jest.fn().mockRejectedValue(busy('EPERM'));
        await expect(renameWhenFree('a', 'b', { rename, budgetMs: 1_000, wait: async () => undefined }))
            .rejects.toMatchObject({ code: 'EPERM' });
        expect(rename.mock.calls.length).toBeGreaterThan(2);
    });

    it('does not retry an error that waiting cannot fix', async () => {
        const rename = jest.fn().mockRejectedValue(busy('ENOENT'));
        await expect(renameWhenFree('a', 'b', { rename, wait: async () => undefined })).rejects.toMatchObject({ code: 'ENOENT' });
        expect(rename).toHaveBeenCalledTimes(1);
    });

    it('renames a real folder', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-when-free-'));
        fs.mkdirSync(path.join(dir, 'from'));
        fs.writeFileSync(path.join(dir, 'from', 'x'), 'x');
        await renameWhenFree(path.join(dir, 'from'), path.join(dir, 'to'));
        expect(fs.readFileSync(path.join(dir, 'to', 'x'), 'utf8')).toBe('x');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
