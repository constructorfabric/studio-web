import { inject, injectable } from '@theia/core/shared/inversify';
import { ILogger, MessageService } from '@theia/core';
import URI from '@theia/core/lib/common/uri';
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import type { StudioNotifyEditorRequest } from '../common/studio-protocol';

/**
 * Shows a Studio-originated message in this IDE (ADR-0010 `notifyEditor`).
 *
 * The portal and the backend gears know things the IDE cannot see — an import
 * finished, a publish was rejected, a schedule fired — and until now the only
 * way to tell whoever is working was a chat message they may not be reading.
 * This puts it where they already are.
 *
 * Display-only, on purpose: it opens no file, changes no workspace state, and
 * the one action it offers is opening a link the sender supplied.
 */
@injectable()
export class NotifyEditorFrontendController {
    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenerService)
    protected readonly openers!: OpenerService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    async onNotifyEditor(request: StudioNotifyEditorRequest): Promise<void> {
        const message = (request.message ?? '').trim();
        if (!message) {
            return;
        }

        // The sender's own label, so "Studio: …" is not hard-coded here: a job
        // that names itself reads better than a generic prefix.
        const source = (request.source ?? '').trim() || 'Studio';
        const detail = (request.detail ?? '').trim();
        const text = detail ? `${source}: ${message} — ${detail}` : `${source}: ${message}`;

        const link = this.openableLink(request.link);
        const actions = link ? ['Open'] : [];

        try {
            const chosen = await this.show(request.level, text, actions);
            if (chosen === 'Open' && link) {
                // Theia's opener service, like every other link this extension
                // follows: it is what routes an http(s) URI to the browser.
                await open(this.openers, new URI(link));
            }
        } catch (error) {
            // A notification that cannot be shown must not take anything else
            // down with it — the caller already has its answer.
            this.logger.warn(`[studio] notifyEditor failed: ${error}`);
        }
    }

    protected show(
        level: StudioNotifyEditorRequest['level'],
        text: string,
        actions: string[]
    ): Promise<string | undefined> {
        switch (level) {
            case 'error':
                return this.messageService.error(text, ...actions);
            case 'warn':
                return this.messageService.warn(text, ...actions);
            // An unknown level is information rather than a reason to drop the
            // message: this crosses a version boundary, and a newer backend
            // sending `debug` should still be heard.
            default:
                return this.messageService.info(text, ...actions);
        }
    }

    /**
     * The link, if it is one we are willing to open.
     *
     * Only `http`/`https`: the message comes from a server, and handing an
     * arbitrary scheme to the browser (`javascript:`, `file:`) is not something
     * a notification should be able to do.
     */
    protected openableLink(raw?: string): string | undefined {
        const candidate = (raw ?? '').trim();
        if (!candidate) {
            return undefined;
        }
        try {
            const url = new URL(candidate);
            return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
        } catch {
            return undefined;
        }
    }
}
