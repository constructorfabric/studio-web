import { Emitter } from '@theia/core/lib/common/event';
import { StudioApi } from './studio-api';

/**
 * The key gearbox-studio's `CatalogueStore` asks for a remote catalogue under
 * (`RemoteCatalogueSource` there). A `Symbol.for` key, so this extension binds
 * it without importing gearbox-studio.
 */
export const GEARBOX_REMOTE_CATALOGUE = Symbol.for('gearbox-studio.RemoteCatalogueSource');

export interface RemoteGearCatalogue {
    /** `owner/repo@ref` of the backend's corpus checkout. */
    readonly corpus: string;
    /** Each a Gearbox `GearDescriptor`, passed through untouched. */
    readonly gears: readonly unknown[];
    /** Where a copy of the corpus can be cloned from, at the listed commit. */
    readonly origin?: {
        readonly sourceId: string;
        readonly url: string;
        readonly rev: string;
        readonly needsToken: boolean;
        readonly clonePath?: string;
    };
}

type Fetch = (path: string) => Promise<Response>;

/**
 * Fired when what the backend would answer may have changed. The desktop
 * starts signed out, so the catalogue's first load gets nothing (the local
 * `/studio-api` proxy answers 503); signing in is when to ask again.
 */
export const remoteGearCatalogueChanged = new Emitter<void>();

/**
 * Whether the last ask was refused (401 signed out, 503 no Studio yet) rather
 * than answered. What decides a re-ask on signing in: the Studio view used to
 * fire `remoteGearCatalogueChanged` only for a sign-in it watched happen, and
 * a window that first saw the member already signed in -- the view opened
 * after the browser sign-in finished -- never asked again, leaving the
 * catalogue at "0 gear(s)" until a reload.
 */
let refused = false;

export function remoteGearCatalogueRefused(): boolean {
    return refused;
}

/**
 * The member is signed in now: ask again if the last answer was a refusal.
 * Safe to call on every status seen signed in -- it asks once per refusal, so
 * a catalogue that was listed at start is not loaded twice.
 */
export function remoteGearCatalogueSignedIn(): void {
    if (refused) {
        refused = false;
        remoteGearCatalogueChanged.fire();
    }
}

/**
 * The gear corpus's catalogue, from the one checkout the Studio backend keeps.
 *
 * A workspace that holds no gear corpus -- a desktop project whose only
 * repository is its own -- lists the gears from here instead of cloning the
 * corpus into every project. Undefined when the backend offers no corpus
 * (Gearbox off: a 404, or a corpus with no gears), so the catalogue falls
 * back to the empty engine answer.
 *
 * Rejects when the backend could not be asked at all -- signed out, no Studio
 * behind the proxy yet, or a backend that failed. That is not "no corpus": the
 * catalogue says the backend is unavailable and offers to ask again, instead
 * of claiming the workspace simply has no `gear.gdl`.
 */
export async function loadRemoteGearCatalogue(fetchApi: Fetch = path => StudioApi.fetch(path)): Promise<RemoteGearCatalogue | undefined> {
    let res = await fetchApi('/studio-product/v1/gearbox/catalogue');
    // A backend from before studio-product serves it under the catalogue.
    if (res.status === 404) {
        res = await fetchApi('/studio-components-catalog/v1/gearbox/catalogue');
    }
    // Refused, not absent: signed out (401/403) or no Studio behind the proxy
    // yet (503). A 404 is a backend without Gearbox, which signing in does not change.
    refused = res.status === 401 || res.status === 403 || res.status === 503;
    if (res.status === 401 || res.status === 403) {
        throw new Error(`not signed in to Studio (HTTP ${res.status})`);
    }
    if (res.status >= 500) {
        throw new Error(`the Studio backend is not answering (HTTP ${res.status})`);
    }
    if (!res.ok) {
        return undefined;
    }
    const body = await res.json() as {
        corpus?: string;
        source_id?: string;
        corpus_url?: string;
        corpus_commit?: string | null;
        corpus_needs_token?: boolean;
        corpus_clone_path?: string | null;
        catalogue?: { gears?: Record<string, unknown> };
    };
    const gears = Object.values(body.catalogue?.gears ?? {});
    if (gears.length === 0) {
        return undefined;
    }
    const origin = body.source_id && body.corpus_url && body.corpus_commit
        ? {
            sourceId: body.source_id,
            url: body.corpus_url,
            rev: body.corpus_commit,
            needsToken: body.corpus_needs_token === true,
            ...(body.corpus_clone_path ? { clonePath: body.corpus_clone_path } : {}),
        }
        : undefined;
    return { corpus: body.corpus ?? 'the gear corpus', gears, ...(origin ? { origin } : {}) };
}
