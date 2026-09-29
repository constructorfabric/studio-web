// The frontend half of #497: tell the backend which project this window has
// open, ask the member once whether Studio may add projects to their Orca,
// and remember the answer as a preference.
//
// It runs on every host and does nothing in a portal session: the backend
// answers `enabled: false` there (see OrcaServiceImpl.trackProject), so no
// question is asked and nothing is added or removed. The decisions are plain
// functions in ../common/desktop-orca-projects.ts.

import { injectable, inject, optional } from '@theia/core/shared/inversify';
import { Emitter, type Event } from '@theia/core/lib/common/event';
import { MessageService } from '@theia/core/lib/common/message-service';
import { generateUuid } from '@theia/core/lib/common/uuid';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { PreferenceScope } from '@theia/core/lib/common/preferences/preference-scope';
import type { PreferenceSchema } from '@theia/core/lib/common/preferences/preference-schema';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { OrcaService } from '../common/orca-protocol';
import {
    ORCA_ADD_ANSWERS,
    ORCA_ADD_PROJECTS_PREFERENCE,
    addProjectQuestion,
    applyAnswer,
    decideOnOpen,
    readAddProjectsPreference,
    type OrcaAddAnswer,
    type OrcaAddProjectsPreference,
    type OrcaKeptRepository
} from '../common/desktop-orca-projects';

export const ORCA_PROJECTS_PREFERENCE_SCHEMA: PreferenceSchema = {
    properties: {
        [ORCA_ADD_PROJECTS_PREFERENCE]: {
            type: 'string',
            enum: ['ask', 'always', 'never'],
            enumDescriptions: [
                'Ask the first time a project with repositories Orca does not know is opened.',
                'Add them to Orca without asking. Studio removes what it added when the project closes.',
                'Never add them; the Agents panel still has a button for it.'
            ],
            default: 'ask',
            // An application-wide choice about the member's own Orca, not a
            // project's: no workspace or folder value.
            scope: PreferenceScope.User,
            description:
                'Desktop Studio: whether a project opened in Studio is added to your own Orca, so agents can ' +
                'work on it. Studio removes only what it added, when the project closes. Has no effect in a ' +
                'portal session, where Orca starts with the session.'
        }
    }
};

@injectable()
export class DesktopOrcaProjectSync implements FrontendApplicationContribution {

    @inject(OrcaService)
    protected readonly orca!: OrcaService;

    @inject(WorkspaceService)
    protected readonly workspaces!: WorkspaceService;

    @inject(MessageService)
    protected readonly messages!: MessageService;

    @inject(PreferenceService) @optional()
    protected readonly preferences: PreferenceService | undefined;

    /** This window, as the backend tells windows apart. */
    protected readonly windowId = generateUuid();
    /** Project folders the member said "not now" for, until the window reloads. */
    protected readonly dismissed = new Set<string>();
    /** Repositories of closed projects Studio left in Orca, and why. */
    protected keptRepositories: readonly OrcaKeptRepository[] = [];
    protected enabledHere = false;
    protected readonly onDidChangeEmitter = new Emitter<void>();
    /** Fires after a check changed what Orca knows, or what was kept. */
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
    protected running: Promise<void> = Promise.resolve();

    onStart(): void {
        void this.check();
        this.workspaces.onWorkspaceChanged(() => void this.check());
    }

    /**
     * The window is going away: its project is closed as far as Orca is
     * concerned. Best effort — a message that does not arrive leaves the
     * repositories registered until the app starts again, the safe side.
     */
    onStop(): void {
        if (this.enabledHere) {
            void this.orca.trackProject(this.windowId, undefined).catch(() => undefined);
        }
    }

    /** Whether this runs here at all: false in a session, or until the first answer. */
    get enabled(): boolean {
        return this.enabledHere;
    }

    get kept(): readonly OrcaKeptRepository[] {
        return this.keptRepositories;
    }

    preference(): OrcaAddProjectsPreference {
        return readAddProjectsPreference(this.preferences?.get(ORCA_ADD_PROJECTS_PREFERENCE));
    }

    /** Report the open project again: after Orca started, or from the panel's retry. */
    check(): Promise<void> {
        this.running = this.running.then(() => this.sync(), () => this.sync());
        return this.running;
    }

    protected async sync(): Promise<void> {
        await this.preferences?.ready;
        const roots = await this.workspaces.roots;
        const root = roots.length ? roots[0].resource.path.fsPath() : undefined;
        const sync = await this.orca.trackProject(this.windowId, root).catch(() => undefined);
        if (!sync?.enabled) {
            return;
        }
        this.enabledHere = true;
        this.keptRepositories = sync.kept;
        let changed = sync.removed.length > 0 || sync.kept.length > 0;
        if (sync.removed.length) {
            this.messages.info(
                `Removed from Orca: ${sync.removed.map(baseName).join(', ')}. Studio had added them for a ` +
                    'project that is closed now; their files stay where they are.'
            );
        }
        if (root) {
            const decision = decideOnOpen(this.preference(), sync.unknown, this.dismissed.has(root));
            let add = decision === 'add';
            if (decision === 'ask') {
                const answer = await this.ask(sync.unknown);
                const effect = applyAnswer(answer);
                if (effect.preference) {
                    await this.preferences?.set(ORCA_ADD_PROJECTS_PREFERENCE, effect.preference, PreferenceScope.User);
                }
                if (effect.dismiss) {
                    this.dismissed.add(root);
                }
                add = effect.add;
            }
            if (add) {
                try {
                    await this.orca.registerWorkspace(root);
                    changed = true;
                } catch (error) {
                    this.messages.error(
                        `Could not add the project to Orca: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        }
        if (changed) {
            this.onDidChangeEmitter.fire();
        }
    }

    protected async ask(unknown: readonly string[]): Promise<OrcaAddAnswer | undefined> {
        const labels = Object.entries(ORCA_ADD_ANSWERS) as [OrcaAddAnswer, string][];
        const picked = await this.messages.info(addProjectQuestion(unknown), ...labels.map(([, label]) => label));
        return labels.find(([, label]) => label === picked)?.[0];
    }
}

function baseName(value: string): string {
    const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] ?? value;
}
