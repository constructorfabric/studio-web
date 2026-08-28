/*
 * The maths renderer, fetched on first use.
 *
 * Structurally identical to loadMermaid() in mermaid-view.js, for the reason
 * that file records: esbuild inlines a dynamic import unless the output is ESM
 * with splitting on, and this application builds as an IIFE because its Monaco
 * and plugin-host workers are not modules. So `import('katex')` would read as
 * lazy and would not be. KaTeX is built as its own script (see katexOptions in
 * browser-app/esbuild.mjs) and loaded here by tag; a document with no equation
 * in it never fetches it.
 *
 * TWO tags, not one, and the stylesheet is not optional. KaTeX's HTML output is
 * a stack of absolutely positioned spans whose vertical metrics live entirely
 * in katex.css — without it an equation renders as its glyphs run together on
 * one line, which looks like a rendering bug rather than a missing asset. Both
 * are awaited together so a caller cannot paint markup the CSS has not arrived
 * for.
 *
 * The failure mode is deliberately the same as mermaid's: the promise is
 * cleared on error, so an equation typed after a transient network failure
 * retries rather than being stuck with a rejected promise for the life of the
 * page.
 */

const KATEX_SCRIPT = 'katex.js';
const KATEX_STYLES = 'katex.css';
const KATEX_GLOBAL = 'studioKatex';

let katexPromise;

function appUrl(file) {
    // Relative to the application root, the same way bundle.js is loaded, so
    // this follows the app wherever it is mounted.
    return new URL(file, document.baseURI).toString();
}

/*
 * How long an equation waits for its stylesheet before rendering unstyled.
 *
 * A <link> that neither loads nor errors is not hypothetical — a stylesheet
 * refused by a Content-Security-Policy is the documented case, and a headless
 * DOM fires neither event at all — and without a bound the await below would
 * never settle, so every equation in the document would stay blank forever on
 * a fault whose worst honest outcome is bad kerning. Long enough that a real
 * fetch on a slow link wins the race; short enough that nobody watches it.
 */
const STYLES_TIMEOUT_MS = 4000;

function settleOnce(resolve) {
    let done = false;
    return () => { if (!done) { done = true; resolve(); } };
}

function loadStyles() {
    const existing = document.querySelector('link[data-studio-katex]');
    if (existing && existing.getAttribute('data-studio-katex') === 'ready') {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        const settle = settleOnce(resolve);
        /*
         * A stylesheet that 404s settles rather than rejects. The renderer is
         * still useful without it — badly set, but readable — and failing the
         * whole equation because its CSS is missing would turn a cosmetic
         * problem into a document that will not display.
         */
        const ready = link => { link.setAttribute('data-studio-katex', 'ready'); settle(); };

        if (existing) {
            // Another node view is already waiting on the same tag. Join it
            // rather than adding a second <link> for one stylesheet.
            existing.addEventListener('load', () => ready(existing), { once: true });
            existing.addEventListener('error', () => ready(existing), { once: true });
        } else {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = appUrl(KATEX_STYLES);
            link.setAttribute('data-studio-katex', 'pending');
            link.onload = () => ready(link);
            link.onerror = () => ready(link);
            document.head.appendChild(link);
        }

        setTimeout(settle, STYLES_TIMEOUT_MS);
    });
}

function loadScript() {
    return new Promise((resolve, reject) => {
        const existing = globalThis[KATEX_GLOBAL];
        if (existing) { return resolve(existing.default || existing); }
        const script = document.createElement('script');
        script.src = appUrl(KATEX_SCRIPT);
        script.async = true;
        script.onload = () => {
            const loaded = globalThis[KATEX_GLOBAL];
            if (!loaded) {
                reject(new Error('katex.js loaded but exposed no global'));
                return;
            }
            resolve(loaded.default || loaded);
        };
        script.onerror = () => reject(new Error('could not load katex.js'));
        document.head.appendChild(script);
    });
}

function loadKatex() {
    if (!katexPromise) {
        katexPromise = Promise.all([loadScript(), loadStyles()])
            .then(([katex]) => katex)
            .catch(error => { katexPromise = undefined; throw error; });
    }
    return katexPromise;
}

/*
 * The document's macro table.
 *
 * Shared across every equation in the session on purpose: a `\gdef` in one
 * block is expected to be visible to the next one, which is how every LaTeX
 * document written by a human behaves. KaTeX mutates this object itself for
 * global definitions, so it is passed by reference and never copied.
 *
 * Seeded with nothing. A configurable table is item X-03 in the brief and
 * belongs in file-type settings, not here; this is the object it will populate.
 */
const macros = {};

/*
 * WHY `throwOnError: true` AND A CATCH, rather than `throwOnError: false`.
 *
 * The brief asks that invalid LaTeX render as editable source rather than an
 * unrecoverable error node. `throwOnError: false` does something else: it
 * renders the offending span in red inside otherwise-normal output and tells
 * the caller nothing, so the editor cannot show the author WHAT is wrong or
 * offer them the source to fix. Throwing and catching yields KaTeX's own
 * message — "Expected '}', got 'EOF'" — which is the useful half of the error.
 *
 * Either way nothing throws out of this function. That is the invariant the
 * brief actually needs: a document containing a typo in an equation opens.
 *
 * `strict: false` because real documents contain unicode in \text and
 * non-standard spacing, and a warning-as-error there fails an equation a reader
 * would have had no trouble with. `trust` is left at its default of false: it
 * gates \href, \url and \includegraphics, which would let a document's own
 * source inject a link or a remote fetch into the rendered page.
 */
async function renderMath(latex, options) {
    const displayMode = !!(options && options.display);
    let katex;
    try {
        katex = await loadKatex();
    } catch (error) {
        return { error: error.message, unavailable: true };
    }
    try {
        return {
            html: katex.renderToString(String(latex == null ? '' : latex), {
                displayMode,
                throwOnError: true,
                strict: false,
                trust: false,
                macros
            })
        };
    } catch (error) {
        /*
         * A ParseError carries the position; anything else is a bug in KaTeX or
         * a browser API it needed. Both are reported the same way, because to
         * the author the outcome is identical: this equation did not render and
         * here is why.
         */
        return { error: error && error.message ? error.message : 'could not render this equation' };
    }
}

module.exports = { loadKatex, renderMath, macros };
