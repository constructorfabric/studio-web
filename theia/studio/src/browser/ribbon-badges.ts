// A number on a ribbon button (studio-mode-bar.tsx): how many things wait
// behind it — the documents Share would send. The contribution that knows
// the number sets it under the button's command; the ribbon only draws it.

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';

/** How a count reads on a badge: nothing for none, and short past 99. */
export function badgeText(count: number | undefined): string | undefined {
    if (!count || count < 0 || !Number.isFinite(count)) {
        return undefined;
    }
    return count > 99 ? '99+' : String(Math.floor(count));
}

@injectable()
export class RibbonBadges {
    protected readonly counts = new Map<string, number>();
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    get(command: string): number | undefined {
        return this.counts.get(command);
    }

    /** Set the number on the button that runs `command`; 0 takes the badge off. */
    set(command: string, count: number): void {
        const next = count > 0 ? count : undefined;
        if (this.counts.get(command) === next) {
            return;
        }
        if (next === undefined) {
            this.counts.delete(command);
        } else {
            this.counts.set(command, next);
        }
        this.onDidChangeEmitter.fire();
    }
}
