/*
 * Where the backend serves workspace files for preview, as an ABSOLUTE URL.
 *
 * WHY THIS IS NOT A ROOT-RELATIVE PATH, which is what it used to be.
 * '/studio-preview/...' resolves against the page that uses it. Served over
 * HTTP the page is http://host:port/, so the path lands on the backend and
 * everything works. In an Electron shell the frontend is loaded from
 *
 *     file:///.../lib/frontend/index.html?port=NNNN
 *
 * and the identical string resolves to file:///studio-preview/..., which cannot
 * exist. The failure is silent in the way that costs the most time: an HTML
 * preview renders as an empty frame and a Markdown image as a broken one, with
 * nothing in the log naming a URL, because a file:// request that misses is not
 * an application error.
 *
 * Theia's Endpoint exists for exactly this. It reads window.location and, when
 * the protocol is file:, falls back to localhost plus the `port` search
 * parameter — the parameter the Electron frontend is always loaded with. So one
 * call is correct on both targets rather than one target and a workaround.
 *
 * It also fixes a case the browser build has always had latent: served under a
 * path prefix rather than at a host root, the root-relative form drops the
 * prefix and misses. Endpoint keeps it.
 */

const { Endpoint } = require('@theia/core/lib/browser/endpoint');

/* Must match PREFIX in src/node/preview-endpoint.js, which serves it. */
const PREFIX = '/studio-preview';

/**
 * The absolute base for preview URLs, with no trailing slash. Callers append a
 * workspace-absolute path.
 *
 * Deliberately does NOT take the path and return a finished URL: the two
 * callers encode differently — an iframe src is assigned raw, a Markdown image
 * src goes through encodeURI — and folding the path in here would double-encode
 * one of them. Keeping the join at the call site keeps each caller's existing
 * encoding exactly as it was, so this change is about the base and nothing else.
 */
function previewBase() {
    return new Endpoint({ path: PREFIX }).getRestUrl().toString();
}

module.exports = { PREFIX, previewBase };
