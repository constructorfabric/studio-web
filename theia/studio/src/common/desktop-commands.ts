/**
 * What a desktop window does with a command the portal sent it (ADR-0027 §5).
 * The node side hears it on `studio-events` (`node/desktop-bridge.ts`); the
 * window showing the workspace runs it and reports how it went.
 */

/** A command as the window receives it. */
export interface WindowCommand {
    readonly commandId: string;
    readonly command: string;
    readonly params: Record<string, unknown>;
}

/** What to do about one command. */
export type CommandPlan =
    | { readonly kind: 'open'; readonly relativePath: string; readonly preview: boolean }
    | { readonly kind: 'refuse'; readonly detail: string };

/**
 * The plan for `command`. A path must stay inside the workspace: absolute,
 * drive-lettered or `..`-climbing ones are refused, since a portal command
 * names a file of the project, never a place on the member's disk.
 */
export function planCommand(command: WindowCommand): CommandPlan {
    if (command.command === 'open_in_editor') {
        const raw = command.params.relativePath;
        if (typeof raw !== 'string' || raw.trim() === '') {
            return { kind: 'refuse', detail: 'no relativePath to open' };
        }
        const relativePath = raw.trim().replace(/\\/g, '/');
        const parts = relativePath.split('/');
        if (relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath) || parts.includes('..')) {
            return { kind: 'refuse', detail: `${raw} is not a path inside the workspace` };
        }
        const clean = parts.filter(p => p !== '' && p !== '.').join('/');
        if (!clean) {
            return { kind: 'refuse', detail: 'no relativePath to open' };
        }
        return { kind: 'open', relativePath: clean, preview: command.params.preview === true };
    }
    if (command.command === 'enqueue_operation' || command.command === 'retry_operation') {
        return {
            kind: 'refuse',
            detail: 'a desktop has no operation queue: its changes reach Studio when the member pushes them',
        };
    }
    return { kind: 'refuse', detail: `a desktop does not know the command ${command.command}` };
}
