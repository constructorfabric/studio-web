// The signed-in member's photo and their organizations' logos, as the
// Constructor Studio view shows them on the desktop: the photo beside the
// member's name, each logo beside its organization in the project tree.
//
// The view's tab on the left rail keeps its own icon -- the way into the
// Studio Web integration -- rather than the photo: a face there read as an
// account menu, and was cut by the rail.

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

/** Who the photo is of: a change of Studio, of person or of state is another photo, or none. */
export function photoKey(status: { state?: string; studioUrl?: string; user?: { sub?: string } } | undefined): string {
    return status?.state === 'signed-in' ? `${status.studioUrl ?? ''}|${status.user?.sub ?? ''}` : '';
}

/** The member's photo on `studioUrl`, from their Studio profile; `undefined` for none. */
export async function memberPhoto(studioUrl: string | undefined): Promise<string | undefined> {
    const res = await StudioApi.fetch('/studio-user/v1/me');
    if (!res.ok) {
        return undefined;
    }
    const me = await res.json() as { avatar_url?: string | null };
    return avatarSource(me.avatar_url, studioUrl);
}

/** The image types a logo may be (the portal accepts no other). */
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** A logo as the portal answers it, as an address an `<img>` can show; `undefined` for anything else. */
export function logoSource(logo: { content_type?: string; data?: string } | undefined): string | undefined {
    const type = logo?.content_type?.trim().toLowerCase();
    const data = logo?.data?.trim();
    if (!type || !LOGO_TYPES.has(type) || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) {
        return undefined;
    }
    return `data:${type};base64,${data}`;
}

/** An organization's logo from the portal; `undefined` when it has none (404) or it cannot be read. */
export async function organizationLogo(organizationId: string): Promise<string | undefined> {
    const res = await StudioApi.fetch(`/studio-organizations/v1/logo?organization_id=${encodeURIComponent(organizationId)}`);
    if (!res.ok) {
        return undefined;
    }
    return logoSource(await res.json() as { content_type?: string; data?: string });
}
