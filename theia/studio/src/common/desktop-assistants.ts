/**
 * The assistant extensions a desktop Studio fetches on first need (#480,
 * docs/desktop-studio.md, "Lazy assistants"). The shapes both halves share:
 * the manifest the installer carries, the status the backend reports, and the
 * sentence the member reads.
 *
 * A browser session has none of this: the session image ships the linux
 * builds, and `/studio-desktop/assistants` does not exist there.
 */

/** One pinned extension, as `resources/assistants.json` records it. */
export interface AssistantPin {
    /** `<namespace>.<name>`, lower case: `anthropic.claude-code`. */
    readonly id: string;
    /** The name the member reads: `Claude Code`. */
    readonly label: string;
    readonly version: string;
    /** The open-vsx target: `win32-x64`. */
    readonly target: string;
    readonly url: string;
    /** Lower-case hex SHA-256 of the VSIX, checked at build time. */
    readonly sha256: string;
}

export type AssistantState = 'missing' | 'downloading' | 'installing' | 'ready' | 'failed';

export interface AssistantStatus {
    readonly id: string;
    readonly label: string;
    readonly version: string;
    readonly state: AssistantState;
    /** 0–100 while downloading, when the size is known. */
    readonly percent?: number;
    /** What went wrong, in words the member can act on. */
    readonly error?: string;
}

export interface AssistantsStatus {
    readonly assistants: readonly AssistantStatus[];
}

const ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The manifest, checked: a broken or hand-edited file must not turn into a
 * download of something else or a folder outside the plugins directory.
 * Entries that do not pass are dropped and named in `rejected`.
 */
export function parseAssistantsManifest(value: unknown): { pins: AssistantPin[]; rejected: string[] } {
    const list = Array.isArray(value) ? value : (value as { assistants?: unknown })?.assistants;
    const pins: AssistantPin[] = [];
    const rejected: string[] = [];
    if (!Array.isArray(list)) {
        return { pins, rejected: ['the manifest has no list of assistants'] };
    }
    for (const entry of list) {
        const e = (entry ?? {}) as Record<string, unknown>;
        const id = typeof e.id === 'string' ? e.id.toLowerCase() : '';
        const ok = ID.test(id)
            && typeof e.version === 'string' && VERSION.test(e.version)
            && typeof e.target === 'string' && VERSION.test(e.target)
            && typeof e.url === 'string' && /^https:\/\//.test(e.url)
            && typeof e.sha256 === 'string' && SHA256.test(e.sha256.toLowerCase());
        if (!ok || pins.some(p => p.id === id)) {
            rejected.push(typeof e.id === 'string' ? e.id : JSON.stringify(entry));
            continue;
        }
        pins.push({
            id,
            label: typeof e.label === 'string' && e.label.trim() ? e.label.trim() : id,
            version: e.version as string,
            target: e.target as string,
            url: e.url as string,
            sha256: (e.sha256 as string).toLowerCase(),
        });
    }
    return { pins, rejected };
}

/** The folder one pinned version lives in, under the plugins directory. */
export function assistantFolderName(pin: Pick<AssistantPin, 'id' | 'version'>): string {
    return `${pin.id}-${pin.version}`;
}

/** The file name the download has, which is also what a member drops in by hand. */
export function assistantVsixName(pin: Pick<AssistantPin, 'id' | 'version' | 'target'> & { readonly url?: string }): string {
    try {
        const last = decodeURIComponent(new URL(pin.url ?? '').pathname.split('/').pop() ?? '');
        if (/^[^\\/:*?"<>|]+\.vsix$/i.test(last)) {
            return last;
        }
    } catch {
        // no usable URL: the name below
    }
    return `${pin.id}-${pin.version}@${pin.target}.vsix`;
}

/**
 * What the rail says when an assistant cannot open yet, or undefined when the
 * desktop has nothing to add (it is ready, or not one it fetches).
 */
export function assistantUnavailableMessage(label: string, status: AssistantStatus | undefined): string | undefined {
    switch (status?.state) {
        case 'downloading':
            return status.percent === undefined
                ? `${label} is downloading. It opens here once it is installed.`
                : `${label} is downloading (${status.percent} %). It opens here once it is installed.`;
        case 'missing':
            return `${label} is not downloaded yet. It is being fetched now.`;
        case 'installing':
            return `${label} is being installed. It opens here in a moment.`;
        case 'failed':
            return `${label} could not be installed: ${status.error ?? 'unknown error'}.`;
        default:
            return undefined;
    }
}

/** The progress line for what is on its way, or undefined when nothing is. */
export function progressLine(statuses: readonly AssistantStatus[]): { text: string; percent?: number } | undefined {
    const busy = statuses.find(s => s.state === 'downloading' || s.state === 'installing' || s.state === 'missing');
    if (!busy) {
        return undefined;
    }
    if (busy.state === 'installing') {
        return { text: `Installing ${busy.label}…` };
    }
    return { text: `Downloading ${busy.label} ${busy.version}…`, percent: busy.percent };
}

/** The command the rail asks, with a rail assistant's extension id, for the sentence above. */
export const DESKTOP_ASSISTANT_MESSAGE_COMMAND = 'studio.desktop.assistantMessage';
