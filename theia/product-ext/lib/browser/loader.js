/*
 * The one loading indicator this product owns.
 *
 * WHY A MODULE AND NOT A LINE OF TEXT PER SURFACE. Before this file, every
 * wait in the product answered for itself and answered differently: the
 * document topbar wrote "Loading…", the review rail wrote "Loading review
 * queue…", the Projects listing wrote nothing at all and simply left the
 * PREVIOUS folder on screen while the next one resolved, the HTML preview
 * showed an empty iframe, and the first Mermaid diagram of a session fetched a
 * 3.4 MB script behind a blank rectangle. Four different answers to one
 * question — "is this working or is it broken?" — and two of them were "no
 * answer".
 *
 * WHY flicker-dot. Asked for by name. It is a player for flip-dot spinners:
 * each dot is binary, the whole animation is CSS keyframes over a static SVG,
 * so there is no JS timer, no re-render, and no canvas. That matters here more
 * than it would elsewhere — the biggest wait in this product is application
 * startup, where the main thread is busy parsing a 14 MB bundle and a spinner
 * driven by JS would visibly stall exactly when it is the only thing on screen.
 *
 * WHY computeModel AND NOT <FlickerSpinner>. The package ships a React
 * component and a pure, framework-agnostic `computeModel` that the component
 * itself builds from. Every surface in this extension is imperative DOM — no
 * JSX, no React tree to mount into — so this takes the model and renders the
 * same SVG the component would. It is the package's own documented seam, not a
 * workaround: geometry, timing and keyframe maths still come from one place.
 *
 * WHAT IT SHOWS. C and F, travelling left to right across the dot field like
 * the destination board they are named after. A flip-dot display is a marquee
 * before it is anything else, and a product mark passing through one is a
 * loading state that says whose product is loading — which a rotating arc,
 * the shape every spinner has, cannot.
 *
 * WHY THE PATTERN IS GENERATED AND NOT PASTED. flicker-dot expects `grids` as
 * a paste-ready export from its editor: one flat array of 49 booleans per
 * frame, which at this length is over six hundred literals with no statement
 * of intent in them. Below, the letters are drawn as letters and the motion is
 * one line of modular arithmetic, which is what a reviewer can actually check.
 *
 * WHY THE LETTERS LIVE IN ROWS 1..5. flicker-dot's '5x5' variant is not a
 * separate design; it is the inner rows 1..5 / cols 1..5 of the 7x7 lifted out
 * (the package calls it the safe area). Anything drawn on the outer ring is
 * therefore INVISIBLE at small sizes. Confining the letterforms to the inner
 * five rows means one pattern serves both variants: the 5x5 is the marquee
 * seen through a narrower window, the 7x7 through a wider one with a quiet
 * always-off margin above and below.
 */

const { computeModel, DOT_R } = require('flicker-dot');

/*
 * The letterforms, drawn rather than encoded.
 *
 * FIVE ROWS is not a style choice: the safe area is five rows tall, so that is
 * the tallest a glyph can be and still exist in the 5x5 variant at all.
 *
 * FOUR COLUMNS, and CAPITALS. A lowercase pair was drawn and rejected against
 * the size ladder rather than on taste. Lowercase c and f need three columns to
 * keep their proportion against capitals (four turns them into small capitals),
 * and at 14px — the size beside a line of status text, which is where most of
 * these appear — three columns is nine dots for the whole letter and the c
 * loses its aperture: it reads as a smudge travelling past rather than as a
 * letter. The capitals' four columns still hold there. Three columns for a
 * CAPITAL C was rejected for the related reason: square corners and no aperture
 * make it read as a bracket.
 */
const GLYPHS = [
    ['.###',
     '#...',
     '#...',
     '#...',
     '.###'],
    ['####',
     '#...',
     '###.',
     '#...',
     '#...']
];

/* Blank columns after the first glyph and after the last. The pair has to read
   as "CF" and not as two letters taking turns, so the gap INSIDE the pair is
   one column and the gap that separates one pass from the next is four. */
const GAP_WITHIN = 1;
const GAP_BETWEEN = 4;

const GRID_ROWS = 7;
const GRID_COLS = 7;
const BAND_TOP = 1;   // the first of the five safe-area rows

/**
 * The glyphs laid end to end as a column tape, which is the thing that
 * actually moves. Its length is the loop: the window wraps around it, so the
 * animation has no seam and no reset frame.
 */
function buildTape() {
    const blank = () => new Array(5).fill(false);
    const columns = [];
    GLYPHS.forEach((rows, index) => {
        for (let column = 0; column < rows[0].length; column++) {
            columns.push(rows.map(row => row[column] === '#'));
        }
        const gap = index === GLYPHS.length - 1 ? GAP_BETWEEN : GAP_WITHIN;
        for (let n = 0; n < gap; n++) { columns.push(blank()); }
    });
    return columns;
}

/**
 * One frame per tape column, so the marquee advances exactly one dot per
 * flicker-dot frame (150ms) — the step a flip-dot board takes.
 *
 * The window start runs BACKWARDS along the tape (`-frame`), which is what
 * makes the letters travel left to right: hold the window still and pull the
 * tape the other way, exactly as the physical thing works.
 */
function buildGrids() {
    const tape = buildTape();
    const length = tape.length;
    const grids = [];
    for (let frame = 0; frame < length; frame++) {
        const cells = new Array(GRID_ROWS * GRID_COLS).fill(false);
        const start = ((-frame % length) + length) % length;
        for (let column = 0; column < GRID_COLS; column++) {
            const source = tape[(start + column) % length];
            for (let row = 0; row < 5; row++) {
                if (source[row]) { cells[(BAND_TOP + row) * GRID_COLS + column] = true; }
            }
        }
        grids.push(cells);
    }
    return grids;
}

/* Thirteen columns of tape, so thirteen frames: C, one blank, F, four blanks.
   At flicker-dot's 150ms that is 1.95s for one pass. */
const GRIDS = buildGrids();
const MODEL_FULL = computeModel(GRIDS, false);
const MODEL_SMALL = computeModel(GRIDS, true);

/** Default render sizes. Smaller than flicker-dot's own 28/16: these sit
 *  beside 11.5-12.5px status text, where 28px reads as a graphic rather than
 *  as an indicator. The startup splash passes its own size. */
const SIZE_INLINE = 14;
const SIZE_BLOCK = 28;

function modelFor(variant) {
    return variant === '7x7' ? MODEL_FULL : MODEL_SMALL;
}

function escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function circles(model) {
    /*
     * Two passes, in this order, because that is what makes the dot field
     * read as a physical display rather than as dots appearing from nowhere:
     * every one of the 25 (or 49) positions is drawn once in the OFF colour
     * and stays drawn, and the lit dots are a second layer fading over it.
     * A dot that is never lit is therefore still present, unlit.
     */
    let out = '';
    for (const dot of model.dots) {
        out += '<circle cx="' + dot.cx + '" cy="' + dot.cy + '" r="' + DOT_R + '"/>';
    }
    for (const dot of model.dots) {
        if (dot.kind === 'off') { continue; }
        if (dot.kind === 'on-static') {
            out += '<circle class="on" cx="' + dot.cx + '" cy="' + dot.cy + '" r="' + DOT_R + '"/>';
            continue;
        }
        out += '<circle class="on fk-' + dot.key + '" cx="' + dot.cx + '" cy="' + dot.cy +
            '" r="' + DOT_R + '" opacity="' + (dot.initialOn ? '1' : '0') + '"/>';
    }
    return out;
}

/**
 * The spinner on its own, as markup.
 *
 * @param variant  '5x5' (default) or '7x7'
 * @param size     px; defaults to 14 for 5x5 and 28 for 7x7
 * @param label    accessible name; pass `undefined` with `decorative: true`
 *                 when a visible caption already says it
 * @param decorative  hide from assistive technology (the caption speaks for it)
 */
function loaderMarkup(options = {}) {
    const variant = options.variant === '7x7' ? '7x7' : '5x5';
    const model = modelFor(variant);
    const size = options.size || (variant === '7x7' ? SIZE_BLOCK : SIZE_INLINE);
    const label = options.label || 'Loading';
    const className = 'studio-loader' + (options.className ? ' ' + options.className : '');
    const semantics = options.decorative
        ? 'aria-hidden="true" focusable="false"'
        : 'role="img" aria-label="' + escapeAttr(label) + '"';
    return '<svg class="' + className + '" width="' + size + '" height="' + size +
        '" viewBox="0 0 ' + model.viewBox + ' ' + model.viewBox + '" ' +
        'preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" ' + semantics + '>' +
        (options.decorative ? '' : '<title>' + escapeAttr(label) + '</title>') +
        circles(model) + '</svg>';
}

/**
 * A whole waiting state: the spinner with a line of text under (or beside) it.
 *
 * The caption is not decoration. Every wait in this product is a wait for a
 * NAMED thing — a folder, a review queue, a diagram, a sign-in — and a bare
 * spinner makes the user infer which one. `role="status"` is on the block so
 * the caption is what assistive technology announces, and the spinner inside
 * it is marked decorative so the same fact is not announced twice.
 */
function loadingMarkup(caption, options = {}) {
    const inline = options.inline === true;
    const variant = options.variant || (inline ? '5x5' : '7x7');
    return '<div class="studio-loading' + (inline ? ' inline' : '') +
        (options.className ? ' ' + options.className : '') + '" role="status">' +
        loaderMarkup({ variant, size: options.size, decorative: true }) +
        (caption ? '<span class="studio-loading-caption">' + escapeAttr(caption) + '</span>' : '') +
        '</div>';
}

function nodeFrom(markup) {
    const holder = document.createElement('div');
    holder.innerHTML = markup;
    return holder.firstElementChild;
}

/** loaderMarkup as a detached element, for the imperative surfaces. */
function loaderNode(options = {}) {
    return nodeFrom(loaderMarkup(options));
}

/** loadingMarkup as a detached element. */
function loadingNode(caption, options = {}) {
    return nodeFrom(loadingMarkup(caption, options));
}

/**
 * Put a waiting state into `host` and hand back the way to take it out again.
 *
 * WHY THE DELAY IS THE DEFAULT. Most of these waits are a local filesystem
 * call that returns in single-digit milliseconds. Showing a spinner for 6ms is
 * not feedback, it is a flash — and a surface that flashes on every folder
 * click reads as unstable, which is the opposite of what an indicator is for.
 * So nothing is shown until the wait has lasted long enough to be perceived as
 * one (140ms is the usual figure), and a wait shorter than that is simply
 * never mentioned. Pass `delayMs: 0` for a wait known to be long — the startup
 * splash, a network fetch — where the delay would only leave a blank.
 *
 * Returns a function that is safe to call any number of times, including
 * before the loader ever appeared.
 */
function showLoading(host, caption, options = {}) {
    if (!host) { return () => undefined; }
    const delayMs = options.delayMs === undefined ? 140 : options.delayMs;
    let node;
    let cancelled = false;
    const place = () => {
        if (cancelled || !host.isConnected) { return; }
        node = loadingNode(caption, options);
        if (options.replace) { host.textContent = ''; }
        host.appendChild(node);
    };
    const timer = delayMs > 0 ? setTimeout(place, delayMs) : (place(), undefined);
    return () => {
        cancelled = true;
        if (timer !== undefined) { clearTimeout(timer); }
        if (node && node.parentNode) { node.parentNode.removeChild(node); }
        node = undefined;
    };
}

/*
 * The stylesheet, generated from the same model the markup is.
 *
 * flicker-dot's React component scopes a <style> element INSIDE every spinner
 * instance, keyed to a per-instance id. That is the right call for a component
 * dropped into an unknown page; it is the wrong one here, where there is
 * exactly one pattern and a spinner can appear in a list of file rows. This
 * emits the eight keyframes once, into the product's own single injected
 * stylesheet, and every instance shares them.
 *
 * The colours are tokens, not values, so light/dark is already answered: the
 * product flips --studio-* on the body and the spinner follows with no JS and
 * no re-render (see the theme note in product-frontend-module.js).
 */
const LOADER_CSS = `
.studio-loader { display: inline-block; flex: none; vertical-align: -0.18em; }
.studio-loader circle { fill: var(--studio-loader-off); }
.studio-loader circle.on {
  fill: var(--studio-loader-on);
  animation-duration: ${MODEL_FULL.duration};
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}
${MODEL_FULL.keyframes
        .map(frame => `.studio-loader circle.fk-${frame.key} { animation-name: studio-flicker-${frame.key}; }`)
        .join('\n')}

${MODEL_FULL.keyframes
        .map(frame => `@keyframes studio-flicker-${frame.key} { ${frame.stops.join(' ')} }`)
        .join('\n')}

/* The block form: spinner over caption, centred in whatever it was put into. */
.studio-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 12px;
  color: var(--studio-muted);
}
.studio-loading.inline {
  flex-direction: row;
  gap: 7px;
  padding: 0;
  justify-content: flex-start;
}
.studio-loading-caption { font-size: 12.5px; line-height: 1.5; text-align: center; }
.studio-loading.inline .studio-loading-caption { font-size: 11.5px; }

/*
 * A wait is not an error, and it is not a result either. The whole waiting
 * state fades in over the delay above rather than appearing hard, so a wait
 * that turns out to be borderline resolves into a soft arrival instead of a
 * blink. The animation is one-shot: it must not restart on a reflow.
 */
@keyframes studio-loading-in { from { opacity: 0; } to { opacity: 1; } }
.studio-loading { animation: studio-loading-in 160ms ease-out both; }

/*
 * Reduced motion. flicker-dot disables its own animation under this query and
 * so does this — but a spinner frozen mid-arc is a broken-looking graphic, not
 * a still one, so the lit layer is forced fully on: the result is a complete,
 * static ring, which reads as "waiting" without moving. The fade-in goes too.
 */
@media (prefers-reduced-motion: reduce) {
  .studio-loader circle { animation: none !important; }
  .studio-loader circle.on { opacity: 1 !important; }
  .studio-loading { animation: none; }
}
`;

module.exports = {
    LOADER_CSS,
    loaderMarkup,
    loaderNode,
    loadingMarkup,
    loadingNode,
    showLoading
};
