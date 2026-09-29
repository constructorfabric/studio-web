// What the Agents panel says about the Orca runtime, and what it offers to do.
//
// One function from the status the backend reports to the words and actions
// the panel shows, so every state is decided in one place and tested without
// a widget. The advice depends on where the IDE runs (`host`): in a portal
// session the image carries Orca and the container starts it, so the fix is
// the image or the session; on a member's own machine Orca is their install,
// so the fix is to install it, open it, or pair with it.
//
// docs/feature/orca-integration.md lists every state and its action.

import type { OrcaRuntimeStatus } from './orca-protocol';

/** Where a member gets Orca. */
export const ORCA_INSTALL_URL = 'https://github.com/stablyai/orca/releases/latest';

/**
 * The oldest Orca Studio was verified against (the session image pinned
 * 1.4.197 when the panel was built). An older one is not refused, since a
 * command may still work, but the panel says so.
 */
export const ORCA_TESTED_VERSION = '1.4.197';

export type OrcaAvailabilityKind =
    | 'checking'
    | 'ready'
    | 'not-installed'
    | 'not-running'
    | 'starting'
    | 'unreachable';

/**
 * What the panel can do about a state:
 * `install` opens the download page, `start` runs `orca open`, `retry`
 * refreshes, `pair` pairs the terminal stream.
 */
export type OrcaAction = 'install' | 'start' | 'retry' | 'pair';

export interface OrcaAvailability {
    readonly kind: OrcaAvailabilityKind;
    /** The status line after "Orca runtime:". */
    readonly headline: string;
    /** What is wrong and what to do; empty when nothing is. */
    readonly advice: string;
    readonly actions: readonly OrcaAction[];
    /** Worth saying even when the runtime works: an old Orca, no pairing yet. */
    readonly notes: readonly string[];
}

/** Compare dotted versions numerically; a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
    const parts = (v: string) => v.replace(/^v/i, '').split(/[.+-]/).map(n => Number.parseInt(n, 10));
    const left = parts(a);
    const right = parts(b);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const l = Number.isFinite(left[i]) ? left[i] : 0;
        const r = Number.isFinite(right[i]) ? right[i] : 0;
        if (l !== r) {
            return l < r ? -1 : 1;
        }
    }
    return 0;
}

export function orcaAvailability(status: OrcaRuntimeStatus | undefined): OrcaAvailability {
    if (!status) {
        return { kind: 'checking', headline: '…', advice: '', actions: [], notes: [] };
    }
    // An older backend reports no host; it only ever ran in a session.
    const local = status.host === 'local';
    const lastError = status.error ? ` Last error: ${status.error}` : '';

    if (status.reachable) {
        const notes: string[] = [];
        if (status.appVersion && compareVersions(status.appVersion, ORCA_TESTED_VERSION) < 0) {
            notes.push(
                `Orca ${status.appVersion} is older than the ${ORCA_TESTED_VERSION} Studio is tested with. ` +
                    'Update Orca if something here fails.'
            );
        }
        const actions: OrcaAction[] = ['retry'];
        if (local && status.paired === false) {
            notes.push('Agent terminals open here once Studio is paired with Orca on this computer.');
            actions.push('pair');
        }
        return {
            kind: 'ready',
            headline:
                `${status.state}${status.appVersion ? ` · ${status.appVersion}` : ''}` +
                `${status.desktopRunning ? ' · desktop' : ' · headless'}`,
            advice: '',
            actions,
            notes
        };
    }

    if (status.cliMissing) {
        return local
            ? {
                  kind: 'not-installed',
                  headline: 'not installed',
                  advice:
                      'Orca is not installed on this computer, or not where Studio looks. Install Orca, ' +
                      'open it once, then press Refresh. Installed somewhere else? Set ORCA_CLI to its ' +
                      'orca executable and restart Studio.',
                  actions: ['install', 'retry'],
                  notes: []
              }
            : {
                  kind: 'not-installed',
                  headline: 'not reachable',
                  // No binary: advising `orca serve` here sent people looking
                  // for a runtime to start in an image that never carried one.
                  advice:
                      'This session image was built without the Orca runtime. Rebuild it with ' +
                      '--build-arg STUDIO_ORCA_DEB_URL=…, or point ORCA_CLI at a binary this container has.',
                  actions: ['retry'],
                  notes: []
              };
    }

    // `orca status` answered: these are its runtime states
    // (Orca 1.4.211, out/cli/runtime/status.js).
    const state = status.state;
    if (state === 'starting' || state === 'graph_not_ready') {
        return {
            kind: 'starting',
            headline: 'starting',
            advice: 'Orca is starting. Press Refresh in a moment.',
            actions: ['retry'],
            notes: []
        };
    }
    if (state === 'not_running' || state === 'stale_bootstrap') {
        return local
            ? {
                  kind: 'not-running',
                  headline: 'not running',
                  advice:
                      'Orca is installed but not running. Start it here, or open the Orca app yourself, ' +
                      'and the panel fills in.',
                  actions: ['start', 'retry'],
                  notes: []
              }
            : {
                  kind: 'not-running',
                  headline: 'not reachable',
                  advice:
                      "The session's Orca runtime is not running. Start one with orca serve (headless) or " +
                      'restart the session; its log is orca-serve.log in the session data directory.',
                  actions: ['retry'],
                  notes: []
              };
    }

    // The CLI failed without saying why in a state: it timed out, crashed,
    // or the runtime refused it.
    return local
        ? {
              kind: 'unreachable',
              headline: 'not reachable',
              advice: `Studio could not get an answer from Orca. Open the Orca app, or start it here, then press Refresh.${lastError}`,
              actions: ['start', 'retry'],
              notes: []
          }
        : {
              kind: 'unreachable',
              headline: 'not reachable',
              advice: `Start one with orca serve (headless) or open the Orca desktop app.${lastError}`,
              actions: ['retry'],
              notes: []
          };
}

/**
 * The note under the agent buttons naming the agents Studio did not find.
 *
 * In a session that list IS what the image carries. On a member's machine it
 * is only what the IDE's own PATH shows — Orca starts an agent with its own
 * environment, which may well find it — so it is a hint, and every agent
 * stays on offer.
 */
export function missingAgentsNote(host: OrcaRuntimeStatus['host'], missing: readonly string[]): string {
    if (missing.length === 0) {
        return '';
    }
    return host === 'local'
        ? `Not found on the PATH Studio sees: ${missing.join(', ')}. Orca may still find them; install them if a start fails.`
        : `Not in this image: ${missing.join(', ')}`;
}
