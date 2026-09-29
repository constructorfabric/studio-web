// The assistant extensions a desktop fetches on first need (#480): the window
// asks the backend to fetch what is missing, shows the download as a progress
// notification, says what failed with a way to try again, and answers the
// rail's "why can Codex not open" with the state it is in.
//
// Only on a desktop whose backend serves `/studio-desktop/assistants`. A web
// session answers 404 there (docs/desktop-contributing.md, rule 1), so this
// stops after one request, and the rail's command answers nothing.

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { CommandContribution, CommandRegistry, MessageService, Progress } from '@theia/core/lib/common';
import {
    AssistantStatus, AssistantsStatus, DESKTOP_ASSISTANT_MESSAGE_COMMAND, assistantUnavailableMessage, progressLine
} from '../common/desktop-assistants';
import { desktopStatus, desktopUrl } from './desktop-studio-widget';

const POLL_MS = 1000;

@injectable()
export class DesktopAssistantsContribution implements FrontendApplicationContribution, CommandContribution {
    @inject(FrontendApplicationStateService)
    protected readonly appState: FrontendApplicationStateService;

    @inject(MessageService)
    protected readonly messages: MessageService;

    protected last: AssistantsStatus | undefined;
    protected progress: Progress | undefined;
    protected timer: ReturnType<typeof setTimeout> | undefined;
    /** Failures already told, so a poll does not repeat them. */
    protected readonly told = new Set<string>();

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand({ id: DESKTOP_ASSISTANT_MESSAGE_COMMAND }, {
            execute: async (extensionId: unknown, label: unknown) => {
                if (typeof extensionId !== 'string') {
                    return undefined;
                }
                const status = (await this.read())?.assistants.find(a => a.id === extensionId.toLowerCase());
                if (status?.state === 'failed') {
                    this.offerRetry(status);
                }
                return assistantUnavailableMessage(typeof label === 'string' ? label : status?.label ?? extensionId, status);
            },
        });
    }

    onStart(): void {
        void this.appState.reachedState('ready').then(async () => {
            if (!(await desktopStatus())?.enabled) {
                return;
            }
            if (await this.post('ensure')) {
                this.poll();
            }
        });
    }

    onStop(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.progress?.cancel();
    }

    protected async read(): Promise<AssistantsStatus | undefined> {
        try {
            const answer = await fetch(desktopUrl('assistants'));
            this.last = answer.ok ? await answer.json() as AssistantsStatus : undefined;
        } catch {
            this.last = undefined;
        }
        return this.last;
    }

    protected async post(action: 'ensure' | 'retry', body?: object): Promise<boolean> {
        try {
            const answer = await fetch(desktopUrl(`assistants/${action}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            });
            return answer.ok;
        } catch {
            return false;
        }
    }

    protected poll(): void {
        this.timer = setTimeout(() => void this.tick(), POLL_MS);
    }

    protected async tick(): Promise<void> {
        const status = await this.read();
        if (!status) {
            this.progress?.cancel();
            this.progress = undefined;
            return;
        }
        const line = progressLine(status.assistants);
        if (line) {
            if (!this.progress) {
                this.progress = await this.messages.showProgress({ text: '', options: { cancelable: false } });
            }
            this.progress.report({
                message: line.percent === undefined ? line.text : `${line.text} ${line.percent} %`,
                work: line.percent === undefined ? undefined : { done: line.percent, total: 100 },
            });
        } else if (this.progress) {
            this.progress.cancel();
            this.progress = undefined;
            const ready = status.assistants.filter(a => a.state === 'ready').map(a => a.label);
            if (ready.length) {
                this.messages.info(`${ready.join(' and ')} ${ready.length > 1 ? 'are' : 'is'} ready.`);
            }
        }
        for (const failed of status.assistants.filter(a => a.state === 'failed')) {
            this.offerRetry(failed);
        }
        if (line) {
            this.poll();
        }
    }

    /** One message per failure, with the way out. */
    protected offerRetry(status: AssistantStatus): void {
        const key = `${status.id}@${status.version}:${status.error}`;
        if (this.told.has(key)) {
            return;
        }
        this.told.add(key);
        void this.messages.error(assistantUnavailableMessage(status.label, status)!, 'Try again').then(async choice => {
            if (choice !== 'Try again') {
                return;
            }
            this.told.delete(key);
            if (await this.post('retry', { id: status.id })) {
                if (this.timer) {
                    clearTimeout(this.timer);
                }
                this.poll();
            }
        });
    }
}
