/*
 * Interactive figures in the document.
 *
 * A ```figure block is a code block, so this is a node view over the existing
 * codeBlock node — the same decision mermaid-view.js made, for the same reason:
 * the document model does not change, the source stays the source, and a
 * document full of figures opens identically in Rich, Split and Raw.
 *
 * THE SANDBOX IS THE POINT.
 *
 * A figure's body is model-written JavaScript, and it executes. There is exactly
 * one acceptable place for that: a frame with an OPAQUE ORIGIN — `srcdoc` plus
 * `sandbox="allow-scripts"` and deliberately NOT `allow-same-origin`. What that
 * combination denies is the list worth reading:
 *
 *   - no access to this document, so it cannot read the file, the comments, the
 *     Theia services, or the other figures on the page;
 *   - no cookies, no storage, no credentials, nothing to exfiltrate;
 *   - no network at all. The CSP is `default-src 'none'` with inline script and
 *     style allowed and `connect-src 'none'`, so there is no fetch, no
 *     WebSocket, no image beacon, no font request. A figure cannot phone home
 *     even by accident.
 *   - no top-level navigation, no forms, no popups.
 *
 * What it can do is draw, and talk to this module through postMessage. That is
 * the entire capability surface, and it is why the file being allowed to hold
 * code is a defensible decision rather than a reckless one.
 *
 * `allow-same-origin` must never be added here. With `allow-scripts` beside it
 * the sandbox is worth nothing — the frame could reach into this document and
 * remove its own sandbox attribute — and it would be an easy-looking way to
 * "fix" a future feature that wants to read the frame's DOM. Do not.
 */

const { DiagramCodeBlock, mermaidNodeView, renderMermaid } = require('./mermaid-view');
const {
    isFigureLanguage, CHART_TOKENS, SURFACE_TOKENS, TOKEN_ALIASES, STARTERS, figureLabel
} = require('./figure-spec');
const { FIGURE_RUNTIME_SOURCE } = require('./figure-runtime');

const CHANNEL = 'studio-figure';

/*
 * Longer than mermaid's 450ms, and for a different reason than "the parser
 * throws on half-typed input".
 *
 * Rebuilding a figure destroys its frame, which means it loses everything the
 * reader has done with it — every slider they moved, the animation they were
 * watching. That is a much worse interruption than a diagram flickering, so a
 * figure waits until the typing has actually stopped.
 */
const REBUILD_DEBOUNCE_MS = 900;

/*
 * Height bounds. The frame measures itself and asks; this is the answer to
 * "asks for what?".
 *
 * THE CEILING USED TO TRUNCATE, AND THAT WAS THE WORST BUG THIS BLOCK HAD.
 *
 * It was 820px with `scrolling="no"`, on the reasoning that a figure taller than
 * the window has stopped being an illustration. The reasoning is fine; enforcing
 * it by CUTTING is not. Measured on two generated two-panel figures: one asked
 * for 941px and one for 1,036px, and what got clipped was the bottom of the
 * frame — the control panel. Four of six sliders were unreachable, so the
 * interactive figure was not interactive, which is the entire feature. Worse, it
 * looked deliberate: no error, no scrollbar, just a figure that ends.
 *
 * So the ceiling stays, as a ceiling on the SPACE the block takes in the
 * document, and the frame scrolls inside it. Nothing is ever unreachable; a
 * figure that wants too much costs the reader a scroll instead of its controls.
 * Raised to 960 as well, because two panels plus a metric strip plus controls is
 * a legitimate figure and 820 was below that by about one control row.
 */
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 960;

/*
 * What the block occupies before its frame has reported.
 *
 * MIN_HEIGHT is the floor for a figure that failed; it is the wrong placeholder
 * for one that is merely still loading, because the difference between 180 and a
 * real 600 is a 400px jump in the document under the reader's eyes. This is a
 * guess at a typical figure, so the common case barely moves.
 */
const RESERVED_HEIGHT = 420;

let frameSeq = 0;

/**
 * The tokens the frame is allowed to see, resolved from THIS document's theme.
 *
 * READ OFF `document.body`, and that is the whole subtlety.
 * product-frontend-module.js declares the light palette on `:root` and the dark
 * one on `body[data-studio-theme="dark"]` — so `getComputedStyle(documentElement)`
 * returns the LIGHT values in both themes, because the dark block is not in
 * scope there. Every figure was therefore drawn with light surfaces on a dark
 * page: unreadable, and unreadable in a way that looks like the theme push not
 * arriving rather than arriving with the wrong contents.
 */
function resolveTokens() {
    const dark = document.body.getAttribute('data-studio-theme') === 'dark';
    const shell = getComputedStyle(document.body);
    const out = Object.assign({}, CHART_TOKENS[dark ? 'dark' : 'light']);
    for (const token of SURFACE_TOKENS) {
        const value = shell.getPropertyValue(token).trim();
        if (value) { out[token] = value; }
    }
    return { tokens: out, theme: dark ? 'dark' : 'light' };
}

/*
 * The frame's stylesheet: the frozen visual layer.
 *
 * A figure never writes CSS, and this is the other half of that promise. It is
 * what makes twelve figures about twelve unrelated subjects look like one
 * product — which is the single biggest difference between generated
 * illustration that reads as part of a document and generated illustration that
 * reads as clip art.
 *
 * Written against the tokens the host injects, so it follows the document's
 * theme without knowing anything about it.
 */
const FRAME_CSS = `
*, *::before, *::after { box-sizing: border-box; }
/*
 * The same lesson the product's own shell stylesheet records, learned again in
 * here: setting el.hidden is a NO-OP on an element whose display is set, because
 * the hidden attribute is only a display:none in the UA stylesheet and any
 * author rule outranks it. The runtime hides its empty sections that way, and
 * every one of them -- the metric strip, the legend, the control panel -- is a
 * flex container, so a figure with no metrics rendered an empty strip with a
 * divider across the top of it. One rule, first, before anything sets display.
 *
 * NOTE, since this cost a failed build: these comments live inside a template
 * literal. No backticks.
 */
[hidden] { display: none !important; }
html, body { margin: 0; padding: 0; background: transparent; }
/* The frame scrolls itself when it exceeds the height the block is allowed —
   see MAX_HEIGHT. Only vertically: a figure that needs horizontal scrolling has
   been laid out wrongly, and .fig-table-wrap handles the one real exception. */
html { overflow-x: hidden; }
body {
  font: 13px/1.5 Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--studio-text, #1f2328);
  -webkit-font-smoothing: antialiased;
}
.fig { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px 16px; }
.fig-title { font-size: 13px; font-weight: 650; letter-spacing: -.005em; }
.fig-panes { display: flex; flex-direction: column; gap: 10px; }
.fig-pane { position: relative; min-width: 0; }
.fig-pane-label { font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--studio-muted, #6e7781); margin-bottom: 3px; }
.fig-canvas { display: block; width: 100%; }
.fig-canvas.clickable { cursor: pointer; }
.fig-missing { font-size: 12px; color: var(--studio-muted, #6e7781); padding: 20px 0; }

.fig-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.fig-legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--studio-muted, #6e7781); }
.fig-swatch { width: 9px; height: 9px; border-radius: 2px; flex: none; }

/* The metric strip: the figure's headline numbers, in a row that wraps rather
   than scrolls, so nothing is hidden off the right edge in a narrow column. */
.fig-hud { display: flex; flex-wrap: wrap; gap: 2px 26px; padding: 9px 0 0; border-top: 1px solid var(--studio-line, #e1e4e8); }
.fig-hud-cell { min-width: 74px; }
.fig-hud-label { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--studio-muted, #6e7781); }
.fig-hud-value { font-size: 15px; font-weight: 620; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }

.fig-controls { display: flex; flex-direction: column; gap: 9px; padding-top: 3px; }
.fig-control { display: flex; flex-direction: column; gap: 4px; }
.fig-control-header {
  font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--studio-muted, #6e7781);
  padding-top: 5px; border-top: 1px solid var(--studio-line, #e1e4e8);
}
.fig-control-label { display: flex; justify-content: space-between; gap: 10px; font-size: 11.5px; color: var(--studio-muted, #6e7781); }
.fig-control-value { font-variant-numeric: tabular-nums; color: var(--studio-text, #1f2328); font-weight: 600; }

/* One accent, and it is the host's own. A figure's controls are chrome; the
   colour budget belongs to the drawing. */
.fig-range { -webkit-appearance: none; appearance: none; width: 100%; height: 18px; background: transparent; margin: 0; }
.fig-range::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: var(--studio-line, #e1e4e8); }
.fig-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 14px; height: 14px; margin-top: -5.5px;
  border-radius: 50%; background: var(--studio-amber, #0b2275); border: 2px solid var(--studio-surface, #fff);
  box-shadow: 0 1px 3px rgba(0,0,0,.2); cursor: pointer;
}
.fig-range:focus-visible::-webkit-slider-thumb { outline: 2px solid var(--studio-amber, #0b2275); outline-offset: 2px; }

.fig-switch {
  position: relative; width: 34px; height: 19px; flex: none; padding: 0; cursor: pointer;
  border: 1px solid var(--studio-line, #e1e4e8); border-radius: 999px; background: var(--studio-surface-raised, #f6f7f9);
  transition: background 140ms ease, border-color 140ms ease;
}
.fig-switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%;
  background: var(--studio-muted, #6e7781); transition: transform 140ms cubic-bezier(.23,1,.32,1), background 140ms ease;
}
.fig-switch.on { background: var(--studio-amber, #0b2275); border-color: var(--studio-amber, #0b2275); }
.fig-switch.on::after { transform: translateX(15px); background: #fff; }

.fig-segmented, .fig-steps, .fig-stepper { display: inline-flex; align-self: flex-start; border: 1px solid var(--studio-line, #e1e4e8); border-radius: 7px; overflow: hidden; }
.fig-seg, .fig-step, .fig-step-btn {
  font: inherit; font-size: 11.5px; padding: 4px 11px; cursor: pointer; border: 0; background: transparent;
  color: var(--studio-muted, #6e7781); border-left: 1px solid var(--studio-line, #e1e4e8);
}
.fig-seg:first-child, .fig-step:first-child, .fig-step-btn:first-child { border-left: 0; }
.fig-seg:hover, .fig-step:hover, .fig-step-btn:hover { background: var(--studio-surface-raised, #f6f7f9); color: var(--studio-text, #1f2328); }
.fig-seg.on, .fig-step.on { background: var(--studio-amber, #0b2275); color: #fff; font-weight: 600; }
.fig-step.done { color: var(--studio-text, #1f2328); }
.fig-step-value { display: inline-flex; align-items: center; padding: 0 12px; font-size: 11.5px; font-variant-numeric: tabular-nums; border-left: 1px solid var(--studio-line, #e1e4e8); }

.fig-button, .fig-play {
  align-self: flex-start; font: inherit; font-size: 11.5px; font-weight: 600; padding: 5px 13px; cursor: pointer;
  border: 1px solid var(--studio-line, #e1e4e8); border-radius: 7px;
  background: var(--studio-surface-raised, #f6f7f9); color: var(--studio-text, #1f2328);
}
.fig-button:hover, .fig-play:hover { border-color: var(--studio-amber, #0b2275); color: var(--studio-amber, #0b2275); }
.fig-play.on { background: var(--studio-amber, #0b2275); border-color: var(--studio-amber, #0b2275); color: #fff; }

.fig-input, .fig-select {
  font: inherit; font-size: 12px; padding: 4px 8px; align-self: flex-start; min-width: 140px;
  border: 1px solid var(--studio-line, #e1e4e8); border-radius: 7px;
  background: var(--studio-bg, #fff); color: var(--studio-text, #1f2328);
}

.fig-inspector { border-left: 2px solid var(--studio-amber, #0b2275); padding: 2px 0 2px 10px; }
.fig-inspector-title { font-size: 11.5px; font-weight: 650; }
.fig-inspector-value { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
.fig-inspector-text { font-size: 12px; color: var(--studio-muted, #6e7781); line-height: 1.55; }

.fig-stats { display: flex; flex-wrap: wrap; gap: 10px; }
.fig-stat {
  flex: 1 1 120px; min-width: 120px; padding: 10px 12px;
  border: 1px solid var(--studio-line, #e1e4e8); border-radius: 9px; background: var(--studio-surface-raised, #f6f7f9);
}
.fig-stat-label { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--studio-muted, #6e7781); }
.fig-stat-value { font-size: 22px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; margin-top: 2px; }
.fig-stat-delta { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.fig-stat-note { font-size: 11px; color: var(--studio-muted, #6e7781); margin-top: 3px; line-height: 1.45; }

.fig-table-wrap { overflow-x: auto; }
.fig-table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.fig-table th {
  text-align: left; font-size: 10px; letter-spacing: .05em; text-transform: uppercase; font-weight: 650;
  color: var(--studio-muted, #6e7781); padding: 5px 10px 5px 0; border-bottom: 1px solid var(--studio-line, #e1e4e8);
}
.fig-table td { padding: 5px 10px 5px 0; border-bottom: 1px solid var(--studio-line, #e1e4e8); }
.fig-table tr:last-child td { border-bottom: 0; }

.fig-mermaid { display: flex; justify-content: center; }
.fig-mermaid svg { max-width: 100%; height: auto; }
.fig-mermaid.failed { font-size: 12px; color: var(--studio-muted, #6e7781); }

.fig-caption { font-size: 11.5px; line-height: 1.55; color: var(--studio-muted, #6e7781); }
`;

/**
 * The frame's whole document.
 *
 * Assembled here, deterministically, from four fixed parts and one variable one
 * — which is the shape that makes the variable part safe to be model-written.
 */
function frameDocument(script, boot) {
    return [
        '<!doctype html><html><head><meta charset="utf-8">',
        // Inline script and style, and NOTHING else. See the header.
        '<meta http-equiv="Content-Security-Policy" content="' +
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'" + '">',
        '<style>' + FRAME_CSS + '</style></head><body>',
        '<script>window.__studioFigure = ' + JSON.stringify(boot) + ';<\/script>',
        '<script>' + FIGURE_RUNTIME_SOURCE + '<\/script>',
        /*
         * The generated body, and the one piece of escaping in this file.
         *
         * `</script` inside the figure's source — in a string, in a comment,
         * anywhere — ends this element early and drops the rest of the figure
         * into the document as text. The HTML parser does not care that it is
         * inside a JavaScript string literal. Splitting the sequence is the
         * standard fix and it changes nothing about what the script means.
         */
        '<script>\ntry {\n' + String(script).replace(/<\/script/gi, '<\\/script') +
        '\n} catch (error) { window.dispatchEvent(new ErrorEvent("error", { error: error, message: String(error && error.message || error) })); }\n<\/script>',
        '</body></html>'
    ].join('');
}

function button(label, title) {
    const el = document.createElement('button');
    // The mermaid block's own button class, deliberately: two rendered-content
    // blocks in the same document with two different button treatments would be
    // two designs, and there is no reason for a second one.
    el.className = 'studio-diagram-btn';
    el.type = 'button';
    el.textContent = label;
    el.title = title || label;
    return el;
}

/* ==========================================================================
 * The node view.
 * ========================================================================== */

function figureNodeView({ node, editor, getPos }) {
    const dom = document.createElement('div');
    dom.className = 'studio-codeblock is-figure';

    const head = document.createElement('div');
    head.className = 'studio-diagram-head';
    const name = document.createElement('span');
    name.className = 'studio-diagram-name';
    const notes = document.createElement('span');
    notes.className = 'studio-figure-notes';
    notes.hidden = true;
    const tools = document.createElement('div');
    tools.className = 'studio-diagram-tools';
    const figureBtn = button('Figure', 'Show the rendered figure');
    const sourceBtn = button('Source', 'Edit the figure source');
    const resetBtn = button('Reset', 'Rebuild the figure from its source');
    tools.append(figureBtn, sourceBtn, resetBtn);
    head.append(name, notes, tools);

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    pre.appendChild(code);

    const stage = document.createElement('div');
    stage.className = 'studio-figure-stage';
    const frame = document.createElement('iframe');
    /*
     * Exactly these three tokens. `allow-scripts` because a figure is code;
     * `allow-pointer-lock` and `allow-downloads` are NOT here and should not be.
     * `allow-same-origin` must never be — see the module header.
     */
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', 'Interactive figure');
    /*
     * Scrollable, deliberately. See MAX_HEIGHT: the alternative to a scrollbar on
     * an over-tall figure is a figure with its controls cut off.
     */
    frame.setAttribute('scrolling', 'auto');
    stage.appendChild(frame);
    const error = document.createElement('div');
    error.className = 'studio-figure-error';
    error.hidden = true;
    stage.appendChild(error);

    dom.append(head, pre, stage);

    const id = CHANNEL + ':' + (++frameSeq);
    let showing = 'figure';
    let built;
    let timer;
    let destroyed = false;
    let ready = false;
    let pending = [];
    const seen = [];

    const isFigure = current => isFigureLanguage((current.attrs && current.attrs.language) || '');
    const sourceOf = current => current.textContent;

    /*
     * The envelope last, over the message — the same rule the frame's own `post`
     * follows, and for the same reason: a message field named `channel` would
     * otherwise replace the routing marker and the frame would ignore its own
     * mail. The frame side of this shipped as a real bug once (see post() in
     * figure-runtime.js); this side is written the safe way from the start.
     */
    function send(message) {
        if (!ready) { pending.push(message); return; }
        try { frame.contentWindow.postMessage(Object.assign({}, message, { channel: CHANNEL }), '*'); }
        catch (e) { console.warn('[studio] a figure would not accept a message', e); }
    }

    function build(source) {
        built = source;
        ready = false;
        reported = false;
        pending = [];
        seen.length = 0;
        renderNotes();
        error.hidden = true;
        error.textContent = '';
        frame.style.height = RESERVED_HEIGHT + 'px';
        const boot = resolveTokens();
        frame.srcdoc = frameDocument(source, { tokens: boot.tokens, aliases: TOKEN_ALIASES, theme: boot.theme });
    }

    function renderNotes() {
        // Telemetry, surfaced rather than only posted. These are the calls a
        // figure made that this runtime does not have, and the person editing the
        // document is the one who can act on them — by asking for the figure
        // again, or by fixing the line.
        const tolerated = seen.filter(entry => entry.kind === 'hallucination').length;
        notes.hidden = !tolerated;
        notes.textContent = tolerated ? tolerated + (tolerated === 1 ? ' tolerated call' : ' tolerated calls') : '';
        notes.title = seen.map(entry => entry.message).join('\n');
    }

    function showError(message) {
        error.hidden = false;
        error.textContent = '';
        const box = document.createElement('div');
        box.className = 'studio-diagram-error';
        box.innerHTML = '<b>This figure could not run.</b> The source is unchanged and still saved.';
        const detail = document.createElement('pre');
        detail.textContent = String(message || '').split('\n').slice(0, 4).join('\n');
        box.appendChild(detail);
        error.appendChild(box);
    }

    /*
     * Ask again when the block scrolls into view.
     *
     * Chromium does not lay out an offscreen cross-origin frame, so a figure
     * below the fold measures 0 and never reports a height. Measured in a
     * six-figure document: the two figures above the fold sized correctly and the
     * other four sat at the placeholder until they were scrolled to. THIS side of
     * the boundary is not throttled, so the observer fires reliably and pokes the
     * frame the moment it becomes visible.
     *
     * `reported` is the guard that keeps this to one extra message per figure —
     * a figure that has already told us its height does not need asking again,
     * and IntersectionObserver fires on every entry and exit.
     */
    let reported = false;
    let visibility;
    if (typeof IntersectionObserver === 'function') {
        visibility = new IntersectionObserver(entries => {
            if (destroyed || reported) { return; }
            if (entries.some(entry => entry.isIntersecting)) { send({ type: 'measure' }); }
        }, { rootMargin: '200px' });
    }

    const onMessage = event => {
        if (destroyed || !frame.contentWindow || event.source !== frame.contentWindow) { return; }
        const data = event.data;
        if (!data || data.source !== CHANNEL) { return; }
        if (data.type === 'ready') {
            ready = true;
            const queued = pending;
            pending = [];
            for (const message of queued) { send(message); }
            return;
        }
        if (data.type === 'height') {
            const height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(Number(data.value) || 0)));
            frame.style.height = height + 'px';
            reported = true;
            return;
        }
        if (data.type === 'telemetry') {
            seen.push(data);
            renderNotes();
            return;
        }
        if (data.type === 'error') {
            showError(data.message);
            return;
        }
        if (data.type === 'mermaid') {
            /*
             * The frame cannot load Mermaid — it has no network, by design — so
             * it is rendered out here, with the same loader the document's own
             * fenced diagrams use, and posted back as SVG. A figure and a
             * diagram in the same document therefore share one copy of a 3 MB
             * library instead of inlining it twice.
             */
            renderMermaid('studio-figure-mermaid-' + data.id + '-' + Date.now().toString(36), String(data.code))
                .then(svg => send({ type: 'mermaid-svg', id: data.id, svg }))
                .catch(e => send({ type: 'mermaid-error', id: data.id, message: String((e && e.message) || e) }));
        }
    };
    window.addEventListener('message', onMessage);

    /*
     * A theme switch is a MESSAGE, not a rebuild.
     *
     * Rebuilding would be one line and would throw away every slider the reader
     * has moved and whatever the animation was in the middle of. The frame knows
     * how to re-resolve its tokens and repaint, so switching theme with a figure
     * open leaves the figure exactly where it was, in the other palette.
     */
    const onThemeChange = () => {
        if (!built) { return; }
        const boot = resolveTokens();
        send({ type: 'tokens', tokens: boot.tokens, theme: boot.theme });
    };
    document.addEventListener('studio-theme-changed', onThemeChange);

    function applyMode(current) {
        const figure = isFigure(current);
        dom.classList.toggle('is-figure', figure);
        head.hidden = !figure;
        if (!figure) {
            pre.hidden = false;
            stage.hidden = true;
            return;
        }
        const label = figureLabel(sourceOf(current));
        name.textContent = label ? 'Figure — ' + label : 'Interactive figure';
        const asFigure = showing === 'figure';
        pre.hidden = asFigure;
        stage.hidden = !asFigure;
        figureBtn.classList.toggle('on', asFigure);
        sourceBtn.classList.toggle('on', !asFigure);
        resetBtn.hidden = !asFigure;
        if (!asFigure) { return; }
        const source = sourceOf(current);
        if (!source.trim()) {
            error.hidden = false;
            error.textContent = '';
            const empty = document.createElement('div');
            empty.className = 'studio-diagram-empty';
            empty.innerHTML = 'Empty figure — switch to <b>Source</b> and describe one.';
            error.appendChild(empty);
            return;
        }
        if (source !== built) { build(source); }
    }

    function current() {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        const at = pos === undefined ? undefined : editor.state.doc.nodeAt(pos);
        return at || node;
    }

    figureBtn.addEventListener('click', event => {
        event.preventDefault();
        showing = 'figure';
        applyMode(current());
    });
    sourceBtn.addEventListener('click', event => {
        event.preventDefault();
        showing = 'source';
        applyMode(current());
        if (typeof getPos === 'function') { editor.chain().focus().setTextSelection(getPos() + 1).run(); }
    });
    resetBtn.addEventListener('click', event => {
        event.preventDefault();
        build(sourceOf(current()));
    });

    applyMode(node);
    if (visibility) { visibility.observe(stage); }

    return {
        dom,
        contentDOM: code,
        update(updated) {
            if (updated.type.name !== node.type.name) { return false; }
            // A language change across the figure boundary is a different node
            // view entirely; returning false makes ProseMirror rebuild it rather
            // than leaving a figure's frame around a shell script.
            if (isFigure(updated) !== isFigure(node)) { return false; }
            node = updated;
            if (!isFigure(updated)) { return true; }
            const label = figureLabel(sourceOf(updated));
            name.textContent = label ? 'Figure — ' + label : 'Interactive figure';
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (destroyed || showing !== 'figure') { return; }
                applyMode(current());
            }, REBUILD_DEBOUNCE_MS);
            return true;
        },
        // The frame, the head and the error box all live outside contentDOM.
        // Without this every one of them would be read back as a document edit.
        ignoreMutation(mutation) {
            return !code.contains(mutation.target) || mutation.type === 'selection';
        },
        destroy() {
            destroyed = true;
            clearTimeout(timer);
            if (visibility) { visibility.disconnect(); }
            window.removeEventListener('message', onMessage);
            document.removeEventListener('studio-theme-changed', onThemeChange);
            // Explicitly, rather than leaving it to the collector: a detached
            // frame that is still running an animation loop keeps burning a
            // rAF callback for as long as it survives.
            frame.srcdoc = '';
        }
    };
}

/* ==========================================================================
 * One node view for the code block, dispatching on the language.
 *
 * ProseMirror allows exactly one node view per node type, and both figures and
 * Mermaid diagrams are code blocks. So this is where the two meet: the language
 * decides which view is built, and a change that crosses the boundary returns
 * false from update() so the view is rebuilt rather than confused.
 *
 * It lives here rather than in mermaid-view.js so the dependency points one way
 * — figures know about diagrams, diagrams know nothing about figures.
 * ========================================================================== */

function codeBlockNodeView(props) {
    const wasFigure = isFigureLanguage((props.node.attrs && props.node.attrs.language) || '');
    const view = wasFigure ? figureNodeView(props) : mermaidNodeView(props);
    const update = view.update;
    /*
     * Retyping ```mermaid as ```figure has to change which view is mounted, and
     * neither view can do that to itself. Returning false is ProseMirror's
     * documented "I cannot represent this node" — it destroys the view and builds
     * a new one, which re-enters this function and picks the other branch.
     *
     * The figure view already refuses the crossing from its own side; this catches
     * it from the diagram side, which otherwise would quietly hide its chrome and
     * leave a figure rendered as grey JavaScript.
     */
    view.update = function (updated) {
        if (isFigureLanguage((updated.attrs && updated.attrs.language) || '') !== wasFigure) { return false; }
        return update ? update.apply(view, arguments) : true;
    };
    return view;
}

const DocumentCodeBlock = DiagramCodeBlock.extend({
    addNodeView() { return codeBlockNodeView; }
});

/* ==========================================================================
 * "Describe a figure."
 *
 * The entry point. Deliberately the same popover shape as the inline AI edit in
 * ai-context.js — one instruction, one destination — plus a row of starters,
 * which is the offline path: neither assistant can hand text back to this widget,
 * so a feature whose only route is "ask an assistant" does nothing at all on a
 * first run, while the plugins are still downloading.
 * ========================================================================== */

function starterButtonsHtml() {
    return '<div class="studio-figure-starters">' +
        '<span>or start from</span>' +
        STARTERS.map(starter =>
            '<button type="button" data-ai="starter:' + starter.key + '" title="' + starter.hint + '">' +
            starter.label + '</button>').join('') +
        '</div>';
}

const FIGURE_CSS = `
.studio-codeblock.is-figure { border: 1px solid var(--studio-line); border-radius: 10px; overflow: hidden; background: var(--studio-surface); }
.studio-codeblock.is-figure pre { margin: 0; border-radius: 0; background: var(--studio-surface-raised); }
/* The block is content, not chrome: it takes the document's full column and is
   separated from the prose by its border alone, the same way the diagram block
   is. No inset, no shadow, no card on a sunken ground. */
.studio-figure-stage { position: relative; }
.studio-figure-stage iframe {
  display: block; width: 100%; border: 0; background: var(--studio-surface);
  /* No transition on height: the frame reports its own height once it has laid
     out, and animating that makes every figure appear to grow on open. */
}
.studio-figure-error { padding: 12px 14px; }
/* The tolerated-call count. Muted and unmissable-if-looked-for, which is the
   right weight: it is information for whoever is editing the figure, not a
   warning about the document. */
/* Two lines at most. The label is an objective sentence and the column it sits
   in can be 380px wide beside an open rail; unclamped, it wrapped to eleven
   lines and the figure started below the fold of its own block. */
.studio-codeblock.is-figure .studio-diagram-name {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; line-height: 1.35;
}
.studio-figure-notes {
  flex: none; font-size: 10.5px; color: var(--studio-muted); cursor: help;
  padding: 1px 7px; border-radius: 999px; border: 1px solid var(--studio-line);
}
.studio-figure-starters { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 2px 2px 0; }
.studio-figure-starters span { font-size: 11px; color: var(--studio-muted); margin-right: 2px; }
.studio-figure-starters button {
  font: inherit; font-size: 11px; padding: 3px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--studio-line); background: var(--studio-surface); color: var(--studio-text);
  width: auto !important; text-align: center !important;
}
.studio-figure-starters button:hover { border-color: var(--studio-amber); color: var(--studio-amber); background: var(--studio-surface); }
`;

module.exports = {
    DocumentCodeBlock, figureNodeView, codeBlockNodeView,
    frameDocument, FRAME_CSS, FIGURE_CSS, resolveTokens, starterButtonsHtml,
    MIN_HEIGHT, MAX_HEIGHT, REBUILD_DEBOUNCE_MS
};
