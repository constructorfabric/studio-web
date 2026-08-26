/*
 * Interactive figures: the parts that are pure data.
 *
 * A figure is a fenced code block whose language is `figure`, holding
 * JavaScript written against the runtime in figure-runtime.js. figure-view.js
 * renders it inside a sandboxed iframe. This module holds everything about
 * figures that needs no DOM: the palette, the API document that is handed to an
 * assistant, the two-stage request prompt, and the starter figures.
 *
 * WHY A CODE BLOCK, AND WHY `figure`.
 *
 * The alternative — a new node type with its own Markdown syntax — was rejected
 * for the reason mermaid-view.js gives for the same decision: a fenced block
 * needs no change to the round trip, so a document full of figures opens
 * identically in Rich, Split and Raw, survives every serialiser in the product,
 * and degrades to a visible code block in any other Markdown renderer on earth.
 * The figure is never the source of truth; the source is, and it is right there.
 *
 * WHY THE FILE HOLDS CODE RATHER THAN A DECLARATIVE SPEC.
 *
 * This was the real design decision, and it went the other way from the obvious
 * one. A JSON component tree assembled from a pre-approved catalogue is safer to
 * describe and much worse to use: every figure anybody actually wants — a
 * simulation with a time step, a chart whose y depends on three sliders, a
 * diagram whose colouring is a rule rather than a constant — is a *function*,
 * and a catalogue can only offer the functions somebody enumerated in advance.
 * The moment a request falls outside the catalogue, a declarative format has no
 * answer at all, while code has a mediocre one that can be edited.
 *
 * So the file holds code, and the risk that comes with that is answered where it
 * belongs: in the sandbox (figure-view.js — opaque origin, no network, no access
 * to the document or the filesystem) and in the runtime's tolerance layers
 * (figure-runtime.js — an unknown method call degrades to a no-op rather than a
 * blank rectangle). Isolation is the iframe, not the format.
 *
 * WHAT THE MODEL IS TOLD, AND WHAT IT IS NOT TOLD.
 *
 * FIGURE_API_DOC below is about twenty-five calls, and it opens with the four
 * rules that are not negotiable — the ones that make a figure wrong in a way
 * nobody can see from the source. It is deliberately the whole contract: the
 * generating side is never asked to reason about the product, the theme, layout,
 * DPI, resize, or animation timing. It is asked for the content and nothing else.
 *
 * The WORKED EXAMPLE does not live in the document, it lives in the request:
 * figureRequestPrompt picks the starter closest to what was asked for and sends
 * it along. That is a correction of a real mistake — this header used to claim
 * the document carried four worked examples when it carried one, and the three
 * complete, tested figures in STARTERS below were sitting unused two hundred
 * lines away. Measured on the first generated figure to go through this prompt:
 * 8,761 of 11,162 output tokens were spent deriving the shape of a figure that
 * one of those starters already demonstrates.
 */

/** The fence language. Anything else is left to the ordinary code block. */
const FIGURE_LANGUAGE = 'figure';

/*
 * Spellings tolerated on the way IN, normalised to FIGURE_LANGUAGE on the way
 * out. A model that has been told `figure` will still occasionally write
 * `js figure` or `interactive`, and a figure that silently renders as grey
 * JavaScript is the worst failure this feature has — it looks like the feature
 * does not exist. Recognising the near-misses costs one list.
 */
const FIGURE_ALIASES = ['figure', 'studio-figure', 'interactive', 'infographic'];

function isFigureLanguage(language) {
    return FIGURE_ALIASES.includes(String(language || '').trim().toLowerCase());
}

/* ==========================================================================
 * The palette.
 *
 * This is the one place the product's "monochrome plus a single navigational
 * accent" rule is relaxed, and it is relaxed for a reason that is not taste: a
 * chart with six series encodes CATEGORY, and category cannot be carried by tone
 * alone past about three steps without becoming unreadable. Every other surface
 * in the product still has one accent; a figure gets a palette because a figure
 * is the only surface where hue is information.
 *
 * --chart-1 is the product accent in both themes, so the commonest figure — one
 * series — is drawn in the product's own colour and the relaxation is invisible
 * until a second series needs distinguishing.
 *
 * Two sets rather than a filter, for the reason the product's own dark theme
 * gives: an inverted light palette is muddy on a near-black ground. These were
 * picked for roughly equal apparent weight against their own background, so no
 * series reads as "the important one" by accident.
 *
 * The tokens are SEMANTIC — `--chart-3`, `--positive`, `--anno-red` — never
 * literal colours, and the generating side is told so in as many words. That
 * single house rule is what makes a figure follow the theme without the
 * generating side knowing the theme exists.
 * ========================================================================== */
const CHART_TOKENS = {
    light: {
        '--chart-1': '#0b2275',
        '--chart-2': '#1e7a6f',
        '--chart-3': '#a8541c',
        '--chart-4': '#6b4c9a',
        '--chart-5': '#7d6a00',
        '--chart-6': '#9c2a55',
        '--positive': '#1a7f4b',
        '--positive-surface': 'rgba(26, 127, 75, .12)',
        '--negative': '#b3261e',
        '--negative-surface': 'rgba(179, 38, 30, .12)',
        '--warning': '#9a6700',
        '--anno-red': '#c2352c',
        '--anno-orange': '#b5651d',
        '--anno-yellow': '#8a7100',
        '--anno-green': '#1a7f4b',
        '--anno-cyan': '#0f6f7a',
        '--anno-blue': '#0b2275',
        '--anno-purple': '#6b4c9a',
        '--anno-pink': '#9c2a55',
        '--grid': 'rgba(31, 35, 40, .10)',
        '--axis': 'rgba(31, 35, 40, .34)'
    },
    dark: {
        '--chart-1': '#7f93f0',
        '--chart-2': '#4fbfae',
        '--chart-3': '#e39a5c',
        '--chart-4': '#b092e6',
        '--chart-5': '#d0be5a',
        '--chart-6': '#ec7fa5',
        '--positive': '#49b87c',
        '--positive-surface': 'rgba(73, 184, 124, .16)',
        '--negative': '#e5534b',
        '--negative-surface': 'rgba(229, 83, 75, .16)',
        '--warning': '#d8a63c',
        '--anno-red': '#e5534b',
        '--anno-orange': '#e39a5c',
        '--anno-yellow': '#d0be5a',
        '--anno-green': '#49b87c',
        '--anno-cyan': '#4fbfae',
        '--anno-blue': '#7f93f0',
        '--anno-purple': '#b092e6',
        '--anno-pink': '#ec7fa5',
        '--grid': 'rgba(231, 233, 238, .10)',
        '--axis': 'rgba(231, 233, 238, .34)'
    }
};

/*
 * The product's own tokens a figure is allowed to see, copied from the shell's
 * computed style rather than restated here — html-viewer.js does the same thing
 * for the same reason, and this is the second surface to need it. A figure that
 * declared its own surface colour would drift from the document the moment
 * anything in product-frontend-module.js was retuned.
 */
const SURFACE_TOKENS = [
    '--studio-bg', '--studio-surface', '--studio-surface-raised', '--studio-surface-sunken',
    '--studio-line', '--studio-edge', '--studio-text', '--studio-muted',
    '--studio-amber', '--studio-danger', '--studio-focus', '--studio-radius'
];

/*
 * Where a figure's own vocabulary maps onto the product's. The runtime resolves
 * `--surface` before it resolves `--studio-surface`, so the generating side
 * never has to know the product's prefix — and a figure written against these
 * names is portable to any host that supplies the same twelve tokens.
 */
const TOKEN_ALIASES = {
    '--surface': '--studio-surface',
    '--surface-raised': '--studio-surface-raised',
    '--surface-sunken': '--studio-surface-sunken',
    '--background': '--studio-bg',
    '--text': '--studio-text',
    '--on-surface': '--studio-text',
    '--on-surface-default': '--studio-text',
    '--muted': '--studio-muted',
    '--on-surface-de-emphasis': '--studio-muted',
    '--line': '--studio-line',
    '--stroke': '--studio-line',
    '--stroke-default': '--studio-line',
    '--stroke-emphasis': '--studio-edge',
    '--outline': '--studio-line',
    '--border': '--studio-line',
    '--primary': '--chart-1',
    '--accent': '--chart-1',
    '--secondary': '--chart-2',
    '--tertiary': '--chart-3',
    '--success': '--positive',
    '--danger': '--negative',
    '--error': '--negative',
    '--bg': '--studio-bg',
    '--card': '--studio-surface-raised',
    '--fg': '--studio-text'
};

/** Every token name the runtime can resolve, in resolution order. */
function tokenNames(theme) {
    return Object.keys(CHART_TOKENS[theme === 'dark' ? 'dark' : 'light']).concat(SURFACE_TOKENS);
}

/* ==========================================================================
 * The API document handed to the generating side.
 *
 * Kept next to the palette and the prompt rather than in a separate asset,
 * because the three drift as one: a token added above and not described here is
 * a token no figure will ever use, and a call described here and not implemented
 * in figure-runtime.js is a hallucination the runtime has to absorb.
 *
 * Four worked examples, not one. Generated figures mirror example structure far
 * more closely than they mirror prose instructions, so the examples are the part
 * of this document that does the work — one per engine family, each complete
 * enough to run unchanged.
 * ========================================================================== */
const FIGURE_API_DOC = [
    '## The figure runtime',
    '',
    'A figure is one ```figure fenced block in the Markdown file, holding a body',
    'script. The script runs inside a sandboxed frame with no network and no',
    'access to the document. Everything it needs is on the global `Studio`.',
    '',
    'You never write HTML, CSS, layout, resize handling, DPI scaling or a theme.',
    'The runtime builds the frame, the control panel and the metric strip. Write',
    'the content and nothing else.',
    '',
    '### 0. The four rules that are not negotiable',
    '',
    'Everything below is detail. These four are the ones that make a figure wrong',
    'in a way you cannot see from the source:',
    '',
    '1. **Semantic colour tokens only.** Never `"red"`, `"#c00"`, `"green"`. The',
    '   figure is rendered in a light and a dark theme and only tokens follow both.',
    '2. **In a world-unit canvas, POSITIONS ARE WORLD UNITS AND SIZES ARE PIXELS.**',
    '   `ctx.arc(x, y, 6, …)` puts a 6-PIXEL dot at world point (x, y);',
    '   `ctx.lineWidth = 2` is 2 pixels at any zoom. Rectangle width and height are',
    '   the exception: they are world quantities, because a bar is a quantity.',
    '3. **`ctx.scaleTo` uses ONE scale for both axes.** A circle is a circle. Pass',
    '   `{ stretch: true }` only when the two axes measure unrelated things (time',
    '   against money); never for anything geometric, radial or angular.',
    '4. **Controls stack vertically and the whole figure must fit about 900px.**',
    '   Past that the frame scrolls, and a reader should not have to scroll a',
    '   figure to reach its own sliders. One panel and at most four or five',
    '   controls unless the request genuinely needs more.',
    '',
    '### 1. The app',
    '',
    '```js',
    'const { state, ui } = Studio.createApp({',
    '    title: "Projectile motion",          // optional',
    '    params: { /* controls — see 2 */ },',
    '    editorial: { hud: [{ label: "Range", value: "0 m" }] },',
    '    caption: "One sentence under the figure.",',
    '    height: 320                          // optional minimum for the main panel',
    '});',
    '```',
    '',
    'Any other top-level key becomes initial state, so',
    '`createApp({ params: …, gravity: 9.81 })` gives you `state.gravity`.',
    '',
    '### 2. Controls are inferred from the shape of the value',
    '',
    'There is no control catalogue and no component names. Write the value and',
    'the runtime picks the control. This is the most important rule here: a',
    '`type` you have to remember is a chance to be wrong, and',
    '`{ value: 20, min: 5, max: 50 }` cannot be wrong.',
    '',
    '| You write | You get |',
    '| --- | --- |',
    '| `{ value: 20, min: 5, max: 50, step: 0.5, label: "Speed (m/s)" }` | slider |',
    '| `{ value: 42, label: "Count" }` | number field |',
    '| `{ value: true, label: "Show grid" }` | switch |',
    '| `{ value: "sum", options: ["sum", "mean", "max"], label: "Statistic" }` | segmented buttons, or a menu if the list is long |',
    '| `{ type: "play", value: false, label: "Animate" }` | play/pause |',
    '| `{ type: "button", label: "Reset", onClick: s => { s.t = 0; } }` | button; the callback gets `state` |',
    '| `{ type: "stepper", value: 3, min: 1, max: 9, label: "Terms" }` | −/+ with the value between |',
    '| `{ type: "steps", options: ["Setup", "Run", "Result"] }` | clickable progress track |',
    '| `{ type: "header", label: "Assumptions" }` | a divider in the control panel |',
    '| `{ type: "color" \\| "text" \\| "date", value: … }` | native field |',
    '',
    'Every param becomes a key on `state` with its value. The readout beside a',
    'slider takes its precision from `step`, so give a step that matches the',
    'resolution the quantity actually has.',
    '',
    '### 3. State',
    '',
    '`state` is a plain object you can read and assign. Assigning fires',
    'subscribers and redraws whatever is on screen. Arrays are live too, so',
    '`state.trail.push(p)` counts as a change.',
    '',
    '```js',
    'state._subscribe("rate", value => recompute());   // one key',
    'state._subscribe((key, value) => {});             // every key',
    'state.projection = rows;                          // derived state is just state',
    'state._snapshot();                                // a plain, detached copy',
    '```',
    '',
    'Put every derived quantity in `state` from a single subscriber, so several',
    'panels cannot disagree about what the current value is.',
    '',
    '### 4. The frame around the drawing',
    '',
    '| Call | Effect |',
    '| --- | --- |',
    '| `ui.setHUD([{ label, value, color? }])` | the metric strip under the figure |',
    '| `ui.setInspector({ title, value, text })` | the detail panel beside it |',
    '| `ui.setLegend([{ label, color }])` | swatch legend. List only series that are actually drawn. |',
    '| `ui.setCaption(text)` | one line under everything |',
    '| `ui.setTitle(text)` | the figure heading |',
    '| `ui.buildStack([{ id: "top", height: 240 }, { id: "bottom", height: 200 }])` | pane ids for a multi-panel figure; the heights are real pixels |',
    '| `ui.splitViz("60%")` | `{ vizTop, vizBottom }`, splitting a 440px budget in that ratio |',
    '',
    'Two panels cost about 440px before controls, so a split figure has room for',
    'roughly four controls. Prefer one panel.',
    '',
    '### 5. Engines',
    '',
    'All take `(target?, setup, options?)`. Omit `target` for the main panel, or',
    'pass a pane id from `buildStack` / `splitViz`. `options` may carry',
    '`{ height, aspect }`; a pane built with a height already has one.',
    '',
    '| Engine | Use it for | `setup` receives | `setup` returns |',
    '| --- | --- | --- | --- |',
    '| `Studio.initPlot` | any real chart | `{ state, width, height, ui }` | a plot config (see 6) |',
    '| `Studio.initCanvas` | free 2D drawing in pixels | `{ ctx, width, height, cx, cy, state, pointer, ui }` | optionally a frame fn `({ dt, t, state, pointer })` |',
    '| `Studio.initCartesianCanvas` | anything with world units and vectors: y is UP, the origin is centred | same | same |',
    '| `Studio.initDiagram` | boxes and arrows, flows, state machines | `{ state, ui }` | `{ nodes, edges, direction }` (see 7) |',
    '| `Studio.initStats` | a row of headline numbers | `{ state }` | `[{ label, value, delta?, note?, color? }]` |',
    '| `Studio.initTable` | rows and columns | `{ state }` | `{ columns, rows }` |',
    '| `Studio.initMermaid` | a diagram you would rather write as Mermaid source | `{ state }` | a Mermaid source string |',
    '',
    'Return a frame function ONLY for something that moves. A static figure draws',
    'in `setup` and is re-run whenever state changes — no timers of your own,',
    'ever.',
    '',
    'Prefer `initCartesianCanvas` over `initCanvas` whenever the maths is in world',
    'coordinates; prefer `initPlot` over drawing axes by hand.',
    '',
    '### 6. Plot configs',
    '',
    '```js',
    'Studio.initPlot(({ state }) => ({',
    '    x: { label: "Year", type: "linear", domain: [2019, 2026] },',
    '    y: { label: "Balance ($)", zero: true },',
    '    color: { domain: ["compound", "simple"], range: ["--chart-1", "--chart-3"], legend: true },',
    '    marks: [',
    '        Studio.plot.areaY(rows, { x: "year", y: "value", fill: "--chart-1", opacity: .14 }),',
    '        Studio.plot.lineY(rows, { x: "year", y: "value", stroke: "series", curve: "smooth" }),',
    '        Studio.plot.dot(last, { x: "year", y: "value", stroke: "series", tip: true }),',
    '        Studio.plot.ruleY([target], { stroke: "--anno-red", dash: true, label: "target" })',
    '    ]',
    '}));',
    '```',
    '',
    'Axis options, on both `x` and `y`: `label`, `domain: [lo, hi]`, `ticks`,',
    '`format: v => …`, `type: "linear" | "band"`, and on `y` also `zero: true`.',
    '**Set `x.domain` whenever the data does not start near zero** — the axis',
    'otherwise spans exactly the data, which is usually right but is worth pinning',
    'when a reader needs a fixed frame (0–180°, 380–750 nm).',
    '',
    'Marks: `lineY`, `areaY`, `barY`, `stackedBarY`, `barX`, `dot`, `ruleY`,',
    '`ruleX`, `text`. `x` and `y` are field names or functions of the row.',
    '`stroke`/`fill` is either a token (`"--chart-2"`) or a FIELD NAME, in which',
    'case the colour comes from `color.domain`/`color.range`. Rows are plain',
    'objects; long form (`{ x, value, series }`) is usually easier than wide.',
    '',
    '### 7. Diagram configs',
    '',
    '```js',
    'Studio.initDiagram(() => ({',
    '    direction: "down",                 // or "right"',
    '    nodes: [',
    '        { id: "ask",   label: "Request", note: "Shown in the inspector on click." },',
    '        { id: "check", label: "Reviewed", group: "accent" }',
    '    ],',
    '    edges: [',
    '        { from: "ask", to: "check" },',
    '        { from: "check", to: "ask", label: "rejected", dashed: true }',
    '    ]',
    '}));',
    '```',
    '',
    'Layout is automatic — never position a node. An edge that runs against the',
    'flow is drawn bowed and dashed for you.',
    '',
    '### 8. Colour',
    '',
    '`Studio.getColor("--chart-2")`, `Studio.transparent("--chart-2", .2)`,',
    '`Studio.scale(["--chart-1", "--chart-2", "--chart-3"])`. Inside a canvas,',
    '`ctx.token("--chart-2")` is the same call.',
    '',
    '```',
    '--chart-1 … --chart-6      series colour, in order',
    '--positive --negative --warning',
    '--anno-red --anno-orange --anno-yellow --anno-green --anno-cyan --anno-blue --anno-purple --anno-pink',
    '--text --muted --line --surface --surface-raised --grid --axis',
    '```',
    '',
    'Encode ordered quantities with opacity or radius rather than hue, so the',
    'meaning survives in both themes.',
    '',
    '### 9. Canvas extras',
    '',
    'The `ctx` you are given is a 2D context with additions. It is cleared for',
    'you before each frame and the DPI transform is already applied.',
    '',
    '```js',
    'ctx.drawArrow(x, y, dx, dy, "--chart-1");        // vector with a head',
    'ctx.drawTag("38.2 m", x, y, "--muted");          // callout; collisions avoided',
    'ctx.drawGrid({ step: 1 });                       // cartesian only',
    'ctx.drawGrid({ step: "auto", labels: false });   // a physical scene wants no axis numbers',
    'ctx.scaleTo([0, 40], [0, 12]);                   // ONE scale for both axes',
    'ctx.scaleTo([0, 40], [0, 12], { stretch: true, pad: 20 });',
    'ctx.toWorld(px, py) -> { x, y };  ctx.toPixels(x, y) -> { x, y }',
    'ctx.getPointer()                                 // in the units you are drawing in',
    'ctx.setAutoClear(false)                          // keep the previous frame',
    'ctx.width, ctx.height, ctx.cx, ctx.cy, ctx.minDim',
    '```',
    '',
    'Call `scaleTo` each frame and the figure auto-fits when a slider moves.',
    '',
    '### 10. Utilities',
    '',
    '`Studio.lerp(a, b, t)`, `clamp(v, lo, hi)`, `map(v, a, b, c, d)`,',
    '`random(lo, hi)`, `noise2D(x, y)`, `format(n, digits)`,',
    '`niceTicks(lo, hi, count)`.',
    '',
    '### 11. House rules',
    '',
    '1. The four rules in section 0.',
    '2. Name real numbers and real units in the labels and in the HUD. A figure',
    '   whose numbers are decorative is worse than a sentence.',
    '3. Make the figure informative while nothing is moving: draw the analytic',
    '   result, then animate a marker along it.',
    '4. No imports, no fetch, no timers of your own.',
    '5. Keep the body under about 150 lines. If it wants to be longer, the figure',
    '   is trying to be two figures.'
].join('\n');

/* ==========================================================================
 * The two-stage request.
 *
 * The upstream design this follows keeps two models apart: one writes a prose
 * spec in the language of the subject, a second transcribes that spec against
 * the runtime API and never sees the reasoning. The split is what stops the
 * pedagogy from being bent to fit whatever the API makes easy.
 *
 * Here there is one assistant, and it is an agent with the file open rather than
 * a two-pass server pipeline, so the split is preserved as ORDER rather than as
 * two processes: write the spec first, in the subject's own terms, then
 * transcribe it. Both halves are kept, and the spec is kept in the file as the
 * block's leading comment — which is what makes the figure re-askable later
 * ("same figure, but per capita") instead of being a wall of code nobody can
 * restate.
 *
 * Saying this out loud because it is a deviation: one model doing both stages in
 * sequence is weaker than two models doing one each. What it buys is that the
 * result lands in the file, under review, through the pipeline this product
 * already has for assistant writes.
 * ========================================================================== */

/** Stage 1's rhetorical structure, which stage 2 then transcribes. */
const SPEC_SHAPE = [
    'Objective:   what the reader should be able to work out by using it',
    'Strategy:    which engine, and the panel layout',
    'Data State:  every named quantity, with its default and its unit',
    'Inputs:      every control, with label, range, step and unit',
    'Behavior:    the maths, the update rule, the animation, the conditional styling'
].join('\n');

/**
 * The prompt behind "describe a figure and have it generated".
 *
 * It asks for a FILE EDIT, like formatChangeRequest in ai-context.js and for the
 * same reason: writing the file is the one thing the assistants can actually do
 * from here, and it is what closes the loop — the editor watches the file and
 * turns the write into a reviewable pending change rather than letting it land
 * in the document unread.
 */
function figureRequestPrompt({ path, description, anchor }) {
    const starter = starterFor(description);
    const lines = [
        'Please edit `' + path + '` and add ONE interactive figure to it.',
        '',
        'The request: ' + String(description || '').trim(),
        ''
    ];
    if (anchor && String(anchor).trim()) {
        lines.push('Insert it directly after this passage, and leave the rest of the document alone:',
            '', '> ' + String(anchor).trim().replace(/\n/g, '\n> '), '');
    } else {
        lines.push('Insert it where it belongs in the document, and change nothing else.', '');
    }
    lines.push(
        '**The file is the only deliverable.** No plan file, no design document, no',
        'summary of your own beyond a sentence or two — whatever workflow you would',
        'normally use for a task this size, the output of it goes in the figure\'s own',
        'spec comment and nowhere else.',
        '',
        '**Two steps, and only the second one is written down.**',
        '',
        'First work out the spec, in the subject\'s own language rather than the API\'s:',
        '',
        '```',
        SPEC_SHAPE,
        '```',
        '',
        'Pin real numbers and real units — defaults, ranges, thresholds, the constants',
        'of the actual problem. This is what carries the correctness of the figure; the',
        'code only transcribes it. Describe colour by MEANING ("the series above',
        'target"), never by name.',
        '',
        'Then write the figure, with that spec compressed into its leading comment so',
        'it can be re-asked later without being re-derived:',
        '',
        '````',
        '```' + FIGURE_LANGUAGE,
        '/* Spec — <the spec, a few lines> */',
        '<the body script>',
        '```',
        '````',
        '',
        'Nothing else changes in the file: no reformatting, no new prose around it',
        'unless the request asked for prose, no second figure.',
        '',
        /*
         * The write-capture, stated. Without this sentence the first model to run
         * this prompt spent five of its ten tool calls discovering the revert —
         * grep the file, pwd, ls, find .studio, read the proposal JSON twice — and
         * then explained the product's own pipeline back to the user. A model that
         * concluded the write had FAILED would have written the figure twice.
         */
        '**Expect the file to revert.** This editor holds an assistant\'s write at the',
        'document\'s previous contents and turns it into a reviewable proposal, so a',
        'moment after you save, `' + path + '` will look unchanged on disk. That is',
        'success, not failure: your figure is waiting in the review panel. Do not read',
        'the file back to check, and do not write it a second time.',
        '',
        '---',
        '',
        'Here is a complete, working figure of a similar kind. Match its shape, its',
        'level of detail and its spec comment; change the subject, the maths and the',
        'engine as the request requires.',
        '',
        '```' + FIGURE_LANGUAGE,
        starterFigure(starter),
        '```',
        '',
        '---',
        '',
        FIGURE_API_DOC
    );
    return lines.join('\n');
}

/* ==========================================================================
 * Starter figures.
 *
 * The offline path, and it is not a demo. Neither assistant can hand text back
 * to this widget (see ai-context.js), so a product whose only way to get a
 * figure is to ask an assistant has a feature that does nothing when the
 * assistants are absent, still downloading, or signed out — which on this target
 * is the whole of the first run.
 *
 * They are also what the test suites assert against, so they are held to the
 * same standard as generated output: real numbers, real units, tokens only.
 * ========================================================================== */

const STARTER_PLOT = [
    '/* Spec — Objective: feel how rate and time trade off under compounding.',
    '   Data State: principal 1000 $, rate 6 %/yr, years 20.',
    '   Inputs: three sliders. Behavior: balance = P(1+r)^t against simple',
    '   interest P(1+rt); the HUD reports the final balance and the gap. */',
    'const { state, ui } = Studio.createApp({',
    '    title: "Compound interest",',
    '    params: {',
    '        principal: { value: 1000, min: 100, max: 20000, step: 100, label: "Principal ($)" },',
    '        rate: { value: 6, min: 0, max: 15, step: 0.25, label: "Annual rate (%)" },',
    '        years: { value: 20, min: 1, max: 40, step: 1, label: "Years" }',
    '    },',
    '    caption: "Compounding is the area between the two curves."',
    '});',
    '',
    'function rows() {',
    '    const r = state.rate / 100;',
    '    const out = [];',
    '    for (let t = 0; t <= state.years; t++) {',
    '        out.push({ year: t, value: state.principal * Math.pow(1 + r, t), series: "compound" });',
    '        out.push({ year: t, value: state.principal * (1 + r * t), series: "simple" });',
    '    }',
    '    return out;',
    '}',
    '',
    'function report() {',
    '    const data = rows();',
    '    const end = data[data.length - 2].value;',
    '    const flat = data[data.length - 1].value;',
    '    ui.setHUD([',
    '        { label: "Compounded", value: "$" + Studio.format(end, 0) },',
    '        { label: "Simple", value: "$" + Studio.format(flat, 0) },',
    '        { label: "Gap", value: "$" + Studio.format(end - flat, 0), color: "--positive" }',
    '    ]);',
    '}',
    'state._subscribe(report);',
    'report();',
    '',
    'Studio.initPlot(() => ({',
    '    x: { label: "Year" },',
    '    y: { label: "Balance ($)", zero: true },',
    '    color: { domain: ["compound", "simple"], range: ["--chart-1", "--chart-3"], legend: true },',
    '    marks: [',
    '        Studio.plot.lineY(rows(), { x: "year", y: "value", stroke: "series", curve: "smooth" }),',
    '        Studio.plot.dot(rows().slice(-2), { x: "year", y: "value", fill: "series", tip: true })',
    '    ]',
    '}));'
].join('\n');

const STARTER_CANVAS = [
    '/* Spec — Objective: see how launch angle and speed set range and apex.',
    '   Data State: v0 20 m/s, angle 40 deg, g 9.81 m/s^2.',
    '   Inputs: two sliders and a play control. Behavior: ideal projectile',
    '   motion; the dashed path is analytic, the marker is integrated. */',
    'const { state, ui } = Studio.createApp({',
    '    title: "Projectile motion",',
    '    params: {',
    '        v0: { value: 20, min: 5, max: 45, step: 0.5, label: "Speed (m/s)" },',
    '        angle: { value: 40, min: 5, max: 85, step: 1, label: "Angle (deg)" },',
    '        play: { type: "play", value: false, label: "Animate" },',
    '        reset: { type: "button", label: "Reset", onClick: s => { s.t = 0; s.play = false; } }',
    '    }',
    '});',
    'state.t = 0;',
    '',
    'const G = 9.81;',
    'const flight = () => 2 * state.v0 * Math.sin(state.angle * Math.PI / 180) / G;',
    'const at = t => {',
    '    const a = state.angle * Math.PI / 180;',
    '    return { x: state.v0 * Math.cos(a) * t, y: state.v0 * Math.sin(a) * t - G * t * t / 2 };',
    '};',
    '',
    'function report() {',
    '    const T = flight();',
    '    ui.setHUD([',
    '        { label: "Range", value: Studio.format(at(T).x, 1) + " m" },',
    '        { label: "Apex", value: Studio.format(at(T / 2).y, 1) + " m" },',
    '        { label: "Flight", value: Studio.format(T, 2) + " s" }',
    '    ]);',
    '}',
    'state._subscribe("v0", () => { state.t = 0; report(); });',
    'state._subscribe("angle", () => { state.t = 0; report(); });',
    'report();',
    'ui.setLegend([{ label: "Ideal path", color: "--chart-1" }, { label: "Velocity", color: "--chart-3" }]);',
    '',
    'Studio.initCartesianCanvas(({ ctx }) => ({ dt, state }) => {',
    '    const T = flight();',
    '    if (state.play) { state.t = (state.t + dt) % T; }',
    '    ctx.scaleTo([0, at(T).x * 1.08], [0, Math.max(at(T / 2).y * 1.5, 2)]);',
    '    ctx.drawGrid({ step: "auto" });',
    '    ctx.beginPath();',
    '    ctx.setLineDash([4, 4]);',
    '    ctx.strokeStyle = ctx.token("--muted");',
    '    for (let i = 0; i <= 64; i++) { const p = at(T * i / 64); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }',
    '    ctx.stroke();',
    '    ctx.setLineDash([]);',
    '    const p = at(state.t);',
    '    const a = state.angle * Math.PI / 180;',
    '    ctx.drawArrow(p.x, p.y, state.v0 * Math.cos(a) * 0.25, (state.v0 * Math.sin(a) - G * state.t) * 0.25, "--chart-3");',
    '    ctx.fillStyle = ctx.token("--chart-1");',
    '    ctx.beginPath();',
    '    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);',
    '    ctx.fill();',
    '    ctx.drawTag(Studio.format(p.x, 1) + " m", p.x, p.y);',
    '});'
].join('\n');

const STARTER_DIAGRAM = [
    '/* Spec — Objective: show what happens to an assistant edit before it can',
    '   reach the document. Strategy: a five-node flow, clickable.',
    '   Behavior: selecting a stage explains it in the inspector. */',
    'const { state, ui } = Studio.createApp({ title: "Review pipeline" });',
    '',
    'Studio.initDiagram(() => ({',
    '    direction: "down",',
    '    nodes: [',
    '        { id: "ask", label: "Request", note: "The instruction, scoped to a passage." },',
    '        { id: "write", label: "Assistant writes the file", note: "An ordinary file write. Nothing is patched." },',
    '        { id: "hold", label: "Held at base", note: "The file is restored to its reviewed state, and the write becomes a proposal." },',
    '        { id: "review", label: "Reviewed per hunk", group: "accent", note: "Accept or reject each change on its own." },',
    '        { id: "doc", label: "Document", note: "Only accepted hunks are ever on disk." }',
    '    ],',
    '    edges: [',
    '        { from: "ask", to: "write" },',
    '        { from: "write", to: "hold" },',
    '        { from: "hold", to: "review" },',
    '        { from: "review", to: "doc", label: "accepted" },',
    '        { from: "review", to: "hold", label: "rejected", dashed: true }',
    '    ]',
    '}));'
].join('\n');

const STARTERS = [
    { key: 'plot', label: 'Chart', hint: 'Sliders driving a chart', code: STARTER_PLOT },
    { key: 'canvas', label: 'Simulation', hint: 'Animated physics on a canvas', code: STARTER_CANVAS },
    { key: 'diagram', label: 'Flow', hint: 'Clickable boxes and arrows', code: STARTER_DIAGRAM }
];

function starterFigure(key) {
    const found = STARTERS.find(s => s.key === key) || STARTERS[0];
    return found.code;
}

/*
 * Which starter to show alongside a request.
 *
 * Crude on purpose. The point is not to guess the engine correctly every time —
 * it is that ANY complete, working figure in the prompt is worth more than a
 * prose table, because generated figures mirror example structure far more
 * closely than they mirror instructions. A wrong-but-complete example still
 * demonstrates createApp, the params shape, the HUD, the spec comment and the
 * house style; the engine line is the one thing the model will override, and it
 * is the thing it is best at choosing.
 *
 * Ordered so the most specific vocabulary wins: a request mentioning both
 * "graph" and "flow" is a flow.
 */
const STARTER_HINTS = [
    // `node`/`edge`/`vertex` rather than a bare "graph": "bar graph" is a chart
    // and "graph with four edges to the centre" is not.
    ['diagram', /\b(flow|pipeline|state machine|architect|process|steps?|stages?|workflow|dependenc|tree|hierarch|network|nodes?|edges?|vertex|vertices)\b/i],
    ['canvas', /\b(simulat|animat|physic|motion|orbit|wave|particle|collision|pendulum|scatter(?:ing)?|angle|geometr|radial|polar|vector|force|field|lattice|molecul)\b/i],
    ['plot', /\b(chart|plot|graph|bars?|histogram|curve|trend|growth|compare|distribution|over time|per year|rate|series)\b/i]
];

function starterFor(description) {
    const text = String(description || '');
    for (const [key, pattern] of STARTER_HINTS) { if (pattern.test(text)) { return key; } }
    // A chart is the safest default: it is the commonest request and the one
    // whose starter shows the most of the API in the fewest lines.
    return 'plot';
}

/**
 * The one-line label the block header shows.
 *
 * Read out of the leading `/* Spec — … *\/` comment, because that sentence is
 * the only part of a generated figure written for a human to read. Falling back
 * to the createApp title, and then to nothing, rather than showing the first
 * line of code — which is never what the figure is about.
 */
function figureLabel(code) {
    const src = String(code || '');
    const spec = src.match(/\/\*\s*Spec\s*[—:-]?\s*([\s\S]*?)\*\//);
    if (spec) {
        /*
         * The comment is UNWRAPPED first, then split into sentences. Splitting on
         * newlines as well as on full stops is the obvious reading and it is
         * wrong: a spec comment is hard-wrapped prose, so the first "sentence"
         * came out as the first LINE — "show what happens to an assistant edit
         * before it can" — which reads as a truncation bug rather than a label.
         */
        const flat = spec[1].replace(/\s+/g, ' ').replace(/^Objective:\s*/i, '').trim();
        const first = flat.split(/\.(?:\s|$)/)[0].replace(/^\s*(?:Strategy|Data State|Inputs|Behavior):\s*/i, '').trim();
        // 80, not 120: this is a one-line label in a block header that also
        // holds three buttons, and in a narrow document column a 120-character
        // objective wrapped to eleven lines and pushed the figure down the page.
        if (first) { return first.length > 80 ? first.slice(0, 79).replace(/\s+\S*$/, '') + '…' : first; }
    }
    const title = src.match(/title:\s*(['"])([^'"]+)\1/);
    if (title) { return title[2]; }
    return '';
}

/** The Markdown a figure is written into the file as. */
function figureBlock(code) {
    return '```' + FIGURE_LANGUAGE + '\n' + String(code).replace(/\s*$/, '') + '\n```';
}

module.exports = {
    FIGURE_LANGUAGE, FIGURE_ALIASES, isFigureLanguage,
    CHART_TOKENS, SURFACE_TOKENS, TOKEN_ALIASES, tokenNames,
    FIGURE_API_DOC, SPEC_SHAPE, figureRequestPrompt,
    STARTERS, starterFigure, starterFor, figureLabel, figureBlock
};
