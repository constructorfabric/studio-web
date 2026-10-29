// The link the portal opens a project in the desktop Studio with (ADR-0027 §6).
//
//   cfstudio://open?studio=<Studio address>&issuer=<OIDC issuer>&project=<id>&name=<name>
//                  [&product=<path of a product.gdl>&branch=<branch it was saved on>[&build=1]]
//
// `product` is the portal's Components tab handing a composed product on:
// once the project is cloned and open, the desktop opens that description in
// the Gearbox perspective -- the same command a portal session runs for
// `studio.openProduct` -- and `branch` is where the portal saved it when that
// is not the branch a checkout opens. `build=1` is the Builds tab's "On my
// machine": once the product is open, generate it and press its Build.
//
// It names a Studio and a project and carries no token: whatever it asks for
// is done with the member's own sign-in, the same way a click in the desktop's
// Studio view does it. The Studio is named twice because one Studio can be
// reached at more than one address -- the portal a person clicked on is not
// always the address the desktop signs in to -- while the realm they both sign
// in with is one, so the issuer is what the desktop matches first.

import { DesktopEnvironment } from './desktop-environments';

/** The scheme the desktop registers with the operating system. */
export const DESKTOP_LINK_SCHEME = 'cfstudio';
/** The one thing a link asks for today. */
export const DESKTOP_LINK_OPEN = 'open';

export interface DesktopLink {
    /** The project to clone and open. */
    readonly project: string;
    /** What to call its folder and its window; the project id when absent. */
    readonly name?: string;
    readonly studioUrl?: string;
    readonly issuer?: string;
    /** A product description to open once the project is: a path inside the
     *  project's repository (`product.gdl`). */
    readonly product?: string;
    /** The branch `product` was saved on. */
    readonly branch?: string;
    /** Generate `product` and build it once it is open; meaningless without one. */
    readonly build?: boolean;
}

/** A repository-relative path: no root, no `..`, nothing outside a
 *  conservative alphabet -- the link comes from outside the app. */
function repoPath(value: string | null): string | undefined {
    const path = value?.trim().replace(/\\/g, '/');
    if (!path || path.length > 256 || path.startsWith('/') || !/^[\w./-]+$/.test(path)) {
        return undefined;
    }
    return path.split('/').some(segment => segment === '..' || segment === '') ? undefined : path;
}

/** A git branch name, by the same caution. */
function branchName(value: string | null): string | undefined {
    const branch = value?.trim();
    if (!branch || branch.length > 200 || !/^[\w./-]+$/.test(branch) || branch.includes('..') || branch.startsWith('-')) {
        return undefined;
    }
    return branch;
}

const trimSlash = (value: string | null | undefined): string | undefined => {
    const trimmed = value?.trim().replace(/\/+$/, '');
    return trimmed ? trimmed : undefined;
};

/**
 * Read a `cfstudio://open?...` link, or `undefined` for anything else.
 *
 * Strict on what it acts on: the scheme, the `open` action and a project id
 * that looks like one. A Studio address that is not http(s) is dropped rather
 * than handed to the sign-in, since the link comes from outside the app.
 */
export function parseDesktopLink(raw: string): DesktopLink | undefined {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return undefined;
    }
    if (url.protocol !== `${DESKTOP_LINK_SCHEME}:`) {
        return undefined;
    }
    // `cfstudio://open?..` parses with `open` as the host; `cfstudio:open?..`
    // with it as the path. Both are the same link.
    const action = url.host || url.pathname.replace(/^\/+/, '').split('/')[0];
    if (action !== DESKTOP_LINK_OPEN) {
        return undefined;
    }
    const project = url.searchParams.get('project')?.trim();
    if (!project || !/^[0-9a-zA-Z-]{8,64}$/.test(project)) {
        return undefined;
    }
    const web = (value: string | undefined) => (value && /^https?:\/\/[^/\s]+/.test(value) ? value : undefined);
    const product = repoPath(url.searchParams.get('product'));
    return {
        project,
        name: url.searchParams.get('name')?.trim() || undefined,
        studioUrl: web(trimSlash(url.searchParams.get('studio'))),
        issuer: web(trimSlash(url.searchParams.get('issuer'))),
        product,
        branch: branchName(url.searchParams.get('branch')),
        ...(product && url.searchParams.get('build') === '1' ? { build: true } : {}),
    };
}

/** The link the portal writes for a project. */
export function desktopLink(link: DesktopLink): string {
    const params = new URLSearchParams();
    if (link.studioUrl) {
        params.set('studio', link.studioUrl);
    }
    if (link.issuer) {
        params.set('issuer', link.issuer);
    }
    params.set('project', link.project);
    if (link.name) {
        params.set('name', link.name);
    }
    if (link.product) {
        params.set('product', link.product);
    }
    if (link.branch) {
        params.set('branch', link.branch);
    }
    if (link.product && link.build) {
        params.set('build', '1');
    }
    return `${DESKTOP_LINK_SCHEME}://${DESKTOP_LINK_OPEN}?${params.toString()}`;
}

/**
 * Which of the build's Studios the link means: the one with its issuer, else
 * the one at its address. `undefined` when it names neither -- a Studio this
 * build does not offer, which the member is asked about before it is used.
 */
export function environmentFor(link: DesktopLink, environments: readonly DesktopEnvironment[]): DesktopEnvironment | undefined {
    const norm = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase();
    const same = (a: string | undefined, b: string) => !!a && norm(a) === norm(b);
    return environments.find(e => same(link.issuer, e.issuer))
        ?? environments.find(e => same(link.studioUrl, e.studioUrl))
        // The same machine, reached another way: a local stand serves the
        // portal, the gateway and Keycloak on different ports, and names the
        // loopback as localhost in one place and 127.0.0.1 in another.
        ?? environments.find(e => sameHost(link, e));
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostOf(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    try {
        const host = new URL(value).hostname.toLowerCase();
        return LOOPBACK.has(host) ? 'loopback' : host;
    } catch {
        return undefined;
    }
}

/** Whether the link's Studio or realm is on the host of the environment's. */
function sameHost(link: DesktopLink, environment: DesktopEnvironment): boolean {
    const theirs = new Set([hostOf(environment.studioUrl), hostOf(environment.issuer)]);
    return [hostOf(link.studioUrl), hostOf(link.issuer)].some(h => h !== undefined && theirs.has(h));
}

/** Whether the link is about the Studio the desktop is connected to now. */
export function isCurrent(link: DesktopLink, current: DesktopEnvironment | undefined): boolean {
    if (!current) {
        return false;
    }
    if (!link.issuer && !link.studioUrl) {
        // A link that names no Studio means the one in use.
        return true;
    }
    return environmentFor(link, [current]) !== undefined;
}
