// The desktop's Accounts button shows the signed-in member's photo from their
// Studio profile, instead of the generic person glyph.
//
// A style rather than a menu of its own: Theia adds the Accounts menu again
// each time an authentication provider registers, with its own icon class,
// and a stylesheet keyed on that class survives every re-add. Desktop only:
// a session in the portal sits under the portal's own header, photo and all.

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import { desktopStatus, onDesktopChange } from './desktop-studio-client';
import { StudioApi } from './studio-api';

/**
 * Where the photo is. The profile names an uploaded one by its path on the
 * Studio gateway (`<prefix>/studio-user/v1/avatars/<id>/<digest>`, served
 * without a token), and one taken from the identity provider by its address.
 */
export function avatarSource(avatarUrl: string | null | undefined, studioUrl: string | undefined): string | undefined {
    const url = avatarUrl?.trim();
    if (!url) {
        return undefined;
    }
    if (/^https:\/\//.test(url)) {
        return url;
    }
    return url.startsWith('/') && studioUrl ? `${studioUrl.replace(/\/+$/, '')}${url}` : undefined;
}

/** The Accounts button, drawn as the photo in a circle the size of the glyph. */
export function avatarCss(src: string): string {
    const quoted = JSON.stringify(src);
    return `.theia-sidebar-menu-item > i.codicon-account {
    background: center / cover no-repeat url(${quoted});
    border-radius: 50%;
    width: 24px;
    height: 24px;
}
.theia-sidebar-menu-item > i.codicon-account::before { content: ''; }`;
}

@injectable()
export class DesktopAccountAvatar implements FrontendApplicationContribution {
    protected readonly style = document.createElement('style');

    onStart(): void {
        void desktopStatus().then(status => {
            if (!status?.enabled) {
                return;
            }
            document.head.appendChild(this.style);
            // A sign-in, a sign-out or another Studio is another photo, or none.
            onDesktopChange(() => void this.refresh());
            void this.refresh();
        });
    }

    protected async refresh(): Promise<void> {
        const src = await this.photo().catch(() => undefined);
        this.style.textContent = src ? avatarCss(src) : '';
    }

    protected async photo(): Promise<string | undefined> {
        const status = await desktopStatus();
        if (status?.state !== 'signed-in') {
            return undefined;
        }
        const res = await StudioApi.fetch('/studio-user/v1/me');
        if (!res.ok) {
            return undefined;
        }
        const me = await res.json() as { avatar_url?: string | null };
        return avatarSource(me.avatar_url, status.studioUrl);
    }
}
