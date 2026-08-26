/*
 * The figure runtime: everything a generated figure is written against.
 *
 * This module exports ONE function and its source text. The function runs inside
 * the sandboxed frame figure-view.js creates; the text is what gets inlined into
 * that frame's document.
 *
 * WHY THE SOURCE IS `Function.prototype.toString()` AND NOT A BUILD ARTEFACT.
 *
 * The runtime has to be a string in the parent, because the frame is built from
 * `srcdoc` and has no origin it could fetch anything from. Three ways to get
 * one, and the trade that decided it:
 *
 *  - a template literal holding the runtime as text: 1500 lines with no syntax
 *    highlighting, no linting, no parse error until a figure is opened, and
 *    every backtick and `${` escaped by hand. Rejected on sight.
 *  - its own esbuild entry point, fetched as text at first use, the way
 *    mermaid-view.js fetches mermaid: real source file, but it adds a build
 *    entry, a network fetch, a cache, and a failure mode (script present but
 *    unfetchable) for something that is 40 KB and always needed together with
 *    the code that inlines it.
 *  - this: a real source file, checked by the same tooling as everything else,
 *    turned into text by the language itself.
 *
 * THE ONE INVARIANT THIS BUYS ITS SIMPLICITY WITH. `figureRuntime` may not
 * reference ANYTHING outside itself — no module-scope constant, no require, no
 * closure over a helper. `toString()` returns only the function's own text, so a
 * reference to a helper defined beside it compiles fine, passes review, and
 * throws `ReferenceError` inside the frame where nobody is looking. Everything
 * the runtime needs is therefore nested inside it or passed in as `global`.
 *
 * That invariant is not left to discipline: figure-test.mjs evaluates
 * FIGURE_RUNTIME_SOURCE in a fresh jsdom window with nothing else in scope and
 * exercises it, so a stray outer reference fails the gate rather than a figure.
 *
 * Minification is safe here, and this was checked rather than assumed: esbuild
 * renames locals inside the function and leaves its boundary alone, because
 * hoisting anything out of a function body would change its semantics. The
 * function is self-contained before minification and stays self-contained after.
 */

/**
 * Install the figure runtime on `global` (the sandboxed frame's window).
 *
 * Returns its own internals. In the frame that return value is discarded — the
 * generated script talks to `global.Studio`. The return exists so the test suite
 * can reach the pure parts (control inference, colour resolution, the state
 * proxy) without a canvas.
 */
function figureRuntime(global) {
    'use strict';

    const doc = global.document;
    const boot = global.__studioFigure || {};
    let tokens = Object.assign({}, boot.tokens);
    const aliases = Object.assign({}, boot.aliases);
    let theme = boot.theme === 'dark' ? 'dark' : 'light';

    /* ======================================================================
     * Talking to the host.
     *
     * One channel, one message shape, and `targetOrigin: '*'` because the frame
     * has an OPAQUE origin — a sandboxed frame without allow-same-origin has no
     * origin string to name, so anything narrower silently drops every message.
     * That is safe in this direction: the frame is telling its own parent about
     * itself, and the parent checks `event.source` rather than trusting a name.
     * ====================================================================== */

    const CHANNEL = 'studio-figure';
    const telemetry = [];

    /*
     * The envelope is written LAST, over the payload, and that is not style.
     *
     * Written first — `Object.assign({source: CHANNEL, type}, payload)` — any
     * payload key called `source` or `type` silently replaces the routing
     * information, and the host drops the message because it no longer looks
     * like ours. That is not hypothetical: the Mermaid bridge sent the diagram
     * text as `source`, which overwrote the channel marker, and the effect was a
     * figure that posted its request into a void and rendered an empty panel with
     * no error anywhere. Ten minutes to find, one line to make impossible.
     */
    function post(type, payload) {
        try {
            if (global.parent && global.parent !== global) {
                global.parent.postMessage(Object.assign({}, payload || {}, { source: CHANNEL, type: type }), '*');
            }
        } catch (e) { /* the host went away; a figure has nothing to do about it */ }
    }

    /*
     * Telemetry is not error logging.
     *
     * `hallucination` and `color-missing` events are the record of what figures
     * are being written against that this runtime does not implement — which is
     * the list of what to implement next. The alternative to collecting them is
     * discovering the same gap once per broken figure, from a screenshot.
     */
    function report(kind, message, detail) {
        const entry = { kind: kind, message: message, detail: detail };
        telemetry.push(entry);
        post('telemetry', entry);
        if (global.console && global.console.warn) { global.console.warn('[figure] ' + message); }
    }

    let fatal = false;
    function fail(where, error) {
        const message = String((error && error.message) || error);
        post('error', { where: where, message: message, stack: String((error && error.stack) || '').split('\n').slice(0, 4).join('\n') });
        if (fatal) { return; }
        fatal = true;
        if (global.console && global.console.error) { global.console.error('[figure] ' + where, error); }
    }

    /*
     * Every model-written callback goes through here.
     *
     * Layer 6 of the tolerance design: setup and each frame are wrapped
     * individually, so a figure whose frame function throws on the 400th frame
     * keeps the 399 frames it already drew on screen and reports once, instead
     * of tearing the frame down.
     */
    function guard(where, fn) {
        return function () {
            try { return fn.apply(this, arguments); }
            catch (error) { fail(where, error); return undefined; }
        };
    }

    /*
     * Layer 4: adaptive callback arity.
     *
     * Both of these are things a model writes, and both are reasonable:
     *
     *     ({ ctx, width }) => { … }
     *     (ctx, width, height) => { … }
     *
     * A runtime that supports one of them is a runtime that fails half the time
     * for a reason the author cannot see. `fn.length` tells them apart before
     * the call, so both are correct.
     */
    function invoke(fn, contextObject, positional) {
        if (typeof fn !== 'function') { return undefined; }
        return fn.length <= 1 ? fn(contextObject) : fn.apply(null, positional || [contextObject]);
    }

    /* ======================================================================
     * Colour.
     *
     * The whole point of this section is that a figure asking for a colour it
     * invented still gets a readable one. A model writing against an unfamiliar
     * palette reaches for the palette it EXPECTED, and absorbing that at the
     * boundary is cheaper than any amount of prompt insistence.
     *
     * Five stages, each reported so the gaps are visible:
     *   1. exact token
     *   2. alias (--accent, --card, --success … about thirty)
     *   3. structural rewrite (--charts-2, --series-2, --chart-9, deemphasis)
     *   4. fuzzy match, edit distance <= 4, against the real token list
     *   5. plain English ("blue", "red")
     * then --studio-text, which is always legible on the figure's own surface.
     * ====================================================================== */

    const PLAIN_COLORS = {
        red: '--anno-red', orange: '--anno-orange', yellow: '--anno-yellow',
        green: '--anno-green', cyan: '--anno-cyan', teal: '--anno-cyan',
        blue: '--anno-blue', purple: '--anno-purple', violet: '--anno-purple',
        pink: '--anno-pink', magenta: '--anno-pink',
        grey: '--studio-muted', gray: '--studio-muted',
        black: '--studio-text', white: '--studio-bg',
        primary: '--chart-1', accent: '--chart-1', secondary: '--chart-2',
        good: '--positive', bad: '--negative'
    };

    function distance(a, b) {
        // Levenshtein, iterative single row. Token names are short; this is
        // called once per unknown name and then cached by the caller.
        const m = a.length, n = b.length;
        if (!m) { return n; }
        if (!n) { return m; }
        let prev = new Array(n + 1);
        for (let j = 0; j <= n; j++) { prev[j] = j; }
        for (let i = 1; i <= m; i++) {
            const row = [i];
            for (let j = 1; j <= n; j++) {
                row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            prev = row;
        }
        return prev[n];
    }

    const colorCache = Object.create(null);

    function rewrite(name) {
        return name
            .replace(/^--charts?-/, '--chart-')
            .replace(/^--series-/, '--chart-')
            .replace(/^--color-/, '--chart-')
            .replace(/deemphasis/, 'de-emphasis')
            .replace(/^--chart-([7-9]|[1-9]\d+)$/, '--chart-6')
            .replace(/^--studio-/, '--studio-');
    }

    function resolveToken(name) {
        if (Object.prototype.hasOwnProperty.call(colorCache, name)) { return colorCache[name]; }
        const known = Object.keys(tokens);
        let resolved;
        let how;
        if (tokens[name]) { resolved = tokens[name]; how = 'exact'; }
        if (!resolved && aliases[name] && tokens[aliases[name]]) { resolved = tokens[aliases[name]]; how = 'alias'; }
        if (!resolved) {
            const structural = rewrite(name);
            if (tokens[structural]) { resolved = tokens[structural]; how = 'rewrite'; }
            else if (aliases[structural] && tokens[aliases[structural]]) { resolved = tokens[aliases[structural]]; how = 'rewrite'; }
        }
        /*
         * PLAIN ENGLISH BEFORE FUZZY, and the order is not a preference.
         *
         * Measured while writing the test for this: with fuzzy first, `blue`
         * resolved to `--line` and `green` to `--grid` — both edit distance 3
         * from the name asked for, both structural tokens, both nonsense as a
         * series colour. A word that is a colour in English is a much stronger
         * signal than a spelling that is nearly a token, so it goes first.
         */
        if (!resolved) {
            const plain = PLAIN_COLORS[name.replace(/^--/, '').toLowerCase()];
            if (plain && tokens[plain]) { resolved = tokens[plain]; how = 'plain'; }
        }
        if (!resolved) {
            /*
             * The allowance scales with the length of the name, for the same
             * reason. A fixed threshold of 4 over names as short as `--grid` will
             * match almost anything to almost anything; one third of the length
             * keeps a long misspelling recoverable (`--chrat-2` -> `--chart-2`,
             * distance 2 of an allowance of 3) while refusing to guess at a short
             * name it has no real evidence about.
             */
            const allowance = Math.max(2, Math.floor(name.length / 3));
            let best, bestScore = allowance + 1;
            for (const candidate of known.concat(Object.keys(aliases))) {
                const score = distance(name, candidate);
                if (score < bestScore) { bestScore = score; best = candidate; }
            }
            if (best) {
                resolved = tokens[best] || tokens[aliases[best]];
                how = 'fuzzy';
                if (resolved) { report('color-fuzzy', 'Unknown token ' + name + ' read as ' + best, { asked: name, used: best }); }
            }
        }
        if (!resolved) {
            resolved = tokens['--studio-text'] || '#1f2328';
            report('color-missing', 'No colour for ' + name + '; used the text colour', { asked: name });
        } else if (how !== 'exact' && how !== 'fuzzy') {
            report('color-' + how, 'Token ' + name + ' resolved by ' + how, { asked: name });
        }
        colorCache[name] = resolved;
        return resolved;
    }

    function getColor(value) {
        if (value === undefined || value === null) { return resolveToken('--chart-1'); }
        const name = String(value).trim();
        if (!name) { return resolveToken('--chart-1'); }
        if (name.charAt(0) === '-') { return resolveToken(name); }
        // A literal colour is honoured rather than refused — a figure that draws
        // in the wrong theme is still a figure — but it is reported, because it
        // is the one rule whose violation is invisible until somebody switches
        // theme. `currentColor` and `transparent` are not literals in that sense.
        if (/^(#|rgb|hsl|oklch|lab\()/i.test(name)) {
            report('color-literal', 'Literal colour ' + name + ' will not follow the theme', { asked: name });
            return name;
        }
        if (name === 'transparent' || name === 'none' || name === 'currentColor') { return name; }
        return resolveToken('--' + name);
    }

    function transparent(value, alpha) {
        const color = getColor(value);
        const a = Math.max(0, Math.min(1, alpha === undefined ? 0.2 : alpha));
        // color-mix rather than parsing: every colour here comes from the host's
        // own tokens, which may be hex, rgb() or a colour function, and a parser
        // that handles three of those four is a parser that silently fails on a
        // retuned palette.
        return 'color-mix(in srgb, ' + color + ' ' + Math.round(a * 100) + '%, transparent)';
    }

    function scale(list) {
        const source = (list && list.length ? list : ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6']);
        return function (index) { return getColor(source[((index | 0) % source.length + source.length) % source.length]); };
    }

    /* ======================================================================
     * Numbers.
     * ====================================================================== */

    const lerp = (a, b, t) => a + (b - a) * t;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, Math.min(lo, hi)), Math.max(lo, hi));
    const map = (v, a, b, c, d) => (b === a ? c : c + (d - c) * ((v - a) / (b - a)));
    const random = (lo, hi) => (hi === undefined ? Math.random() * (lo === undefined ? 1 : lo) : lo + Math.random() * (hi - lo));

    function format(value, digits) {
        const n = Number(value);
        if (!isFinite(n)) { return '—'; }
        const d = digits === undefined
            ? (Number.isInteger(n) ? 0 : Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 1 : 2)
            : digits;
        const fixed = n.toFixed(Math.max(0, Math.min(6, d)));
        const parts = fixed.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return parts.join('.');
    }

    /*
     * One number format per axis, decided by the STEP and not by each value.
     *
     * Formatting tick by tick is the obvious thing and it looks wrong: a set of
     * ticks at 0, 2, 4 … 20 came out as "0.00, 2.0, 4.0 … 20.0", because the
     * general-purpose formatter reads the magnitude of each value on its own. An
     * axis is one scale, so it gets one precision, and the step is what says what
     * that precision has to be.
     */
    function axisFormat(ticks) {
        const numeric = ticks.filter(t => typeof t === 'number' && isFinite(t));
        if (!numeric.length) { return value => String(value); }
        const step = numeric.length > 1
            ? Math.abs(numeric[1] - numeric[0])
            : (Math.abs(numeric[0]) || 1);
        const digits = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
        return value => (typeof value === 'number' && isFinite(value) ? format(value, digits) : String(value));
    }

    /** Round numbers a reader can hold in their head, spanning [lo, hi]. */
    function niceTicks(lo, hi, count) {
        const target = Math.max(2, count || 5);
        if (!(isFinite(lo) && isFinite(hi)) || lo === hi) { return [lo || 0]; }
        const span = hi - lo;
        const raw = span / target;
        const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
        const normalised = raw / magnitude;
        const step = (normalised >= 7.5 ? 10 : normalised >= 3.5 ? 5 : normalised >= 1.5 ? 2 : 1) * magnitude;
        const out = [];
        for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
            out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toFixed(10)));
        }
        return out.length ? out : [lo, hi];
    }

    /*
     * Value noise, not Perlin. Deterministic from its inputs, so a figure that
     * uses it looks the same every time it is opened — which matters for a
     * figure living in a document somebody reviews.
     */
    function hash2(x, y) {
        const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        return s - Math.floor(s);
    }
    function noise2D(x, y) {
        const xi = Math.floor(x), yi = Math.floor(y);
        const xf = x - xi, yf = y - yi;
        const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
        return lerp(lerp(hash2(xi, yi), hash2(xi + 1, yi), u), lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u), v) * 2 - 1;
    }
    const noise3D = (x, y, z) => noise2D(x + (z || 0) * 37.13, y - (z || 0) * 11.7);

    /* ======================================================================
     * State.
     *
     * A Proxy, so `state.rate = 7` is the whole API for "change something and
     * redraw". Three things it has to get right:
     *
     *  - ARRAYS. `state.trail.push(p)` has to count as a change, or every figure
     *    that accumulates a path needs a redraw call the author will forget.
     *    Arrays are therefore wrapped on read.
     *  - RE-ENTRANCY. A subscriber that assigns to the key it is subscribed to
     *    is a normal thing to write (clamping, normalising) and an infinite loop
     *    if unguarded. The in-flight set makes it a no-op instead.
     *  - PLAIN VALUES OUT. Anything handed to a draw engine is unwrapped, so a
     *    figure can never see a Proxy where it expected an array.
     * ====================================================================== */

    function createState(seed, onChange) {
        const values = Object.assign({}, seed || {});
        const keySubs = Object.create(null);
        const anySubs = [];
        const inflight = new Set();
        let proxy;

        function notify(key) {
            if (inflight.has(key)) { return; }
            inflight.add(key);
            try {
                const list = keySubs[key] || [];
                for (const fn of list.slice()) { guard('subscriber(' + key + ')', fn)(values[key], key); }
                for (const fn of anySubs.slice()) { guard('subscriber(*)', fn)(key, values[key]); }
                if (onChange) { onChange(key, values[key]); }
            } finally { inflight.delete(key); }
        }

        const MUTATORS = ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'];
        const arrayProxies = new WeakMap();
        function wrapArray(array, key) {
            const existing = arrayProxies.get(array);
            if (existing) { return existing; }
            const wrapped = new Proxy(array, {
                get(target, prop) {
                    const value = target[prop];
                    if (typeof prop === 'string' && MUTATORS.indexOf(prop) !== -1) {
                        return function () {
                            const result = value.apply(target, arguments);
                            notify(key);
                            return result;
                        };
                    }
                    return typeof value === 'function' ? value.bind(target) : value;
                },
                set(target, prop, value) { target[prop] = value; notify(key); return true; }
            });
            arrayProxies.set(array, wrapped);
            return wrapped;
        }

        const api = {
            /*
             * `_subscribe(key, fn)` or `_subscribe(fn)`. Returns an unsubscribe,
             * which nothing in a figure needs and which costs one line — a
             * subscriber that cannot be removed is a leak waiting for the first
             * figure that rebuilds a panel.
             */
            _subscribe(a, b) {
                if (typeof a === 'function') {
                    anySubs.push(a);
                    return () => { const i = anySubs.indexOf(a); if (i !== -1) { anySubs.splice(i, 1); } };
                }
                const key = String(a);
                (keySubs[key] = keySubs[key] || []).push(b);
                return () => {
                    const list = keySubs[key] || [];
                    const i = list.indexOf(b);
                    if (i !== -1) { list.splice(i, 1); }
                };
            },
            /** A plain snapshot: no Proxy, safe to keep or to hand to anything. */
            _snapshot() { return JSON.parse(JSON.stringify(values, (k, v) => (typeof v === 'function' ? undefined : v))); },
            _values: values
        };

        proxy = new Proxy(values, {
            get(target, prop) {
                if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(api, prop)) { return api[prop]; }
                const value = target[prop];
                if (Array.isArray(value)) { return wrapArray(value, String(prop)); }
                return value;
            },
            set(target, prop, value) {
                const key = String(prop);
                if (target[key] === value && typeof value !== 'object') { return true; }
                target[key] = value;
                notify(key);
                return true;
            },
            has(target, prop) { return prop in target || Object.prototype.hasOwnProperty.call(api, prop); },
            deleteProperty(target, prop) { delete target[prop]; notify(String(prop)); return true; },
            ownKeys(target) { return Reflect.ownKeys(target); },
            getOwnPropertyDescriptor(target, prop) { return Reflect.getOwnPropertyDescriptor(target, prop); }
        });

        return proxy;
    }

    /* ======================================================================
     * Control inference.
     *
     * The single most important idea in this runtime, and the reason there is no
     * component catalogue: the control is read off the SHAPE of the value.
     *
     * Every explicit `type` field is a chance for the generating side to be
     * wrong about a name it was told once. `{ value: 20, min: 5, max: 50 }`
     * cannot be wrong — it is a description of the quantity, not of a widget.
     * `type` is still honoured, for the handful of controls no value shape
     * implies (a play button, a section header, a date field), and those are
     * exactly the ones a figure rarely needs.
     * ====================================================================== */

    const EXPLICIT_TYPES = ['play', 'button', 'header', 'stepper', 'steps', 'segmented', 'color', 'text', 'date', 'number', 'slider', 'toggle', 'select'];

    function inferControl(param) {
        const spec = (param && typeof param === 'object' && !Array.isArray(param)) ? param : { value: param };
        const declared = typeof spec.type === 'string' ? spec.type.toLowerCase() : '';
        if (declared) {
            if (EXPLICIT_TYPES.indexOf(declared) !== -1) {
                if (declared === 'segmented' || declared === 'select') { return declared; }
                if (declared === 'slider') { return 'slider'; }
                return declared;
            }
            report('hallucination', 'Unknown control type "' + spec.type + '"; inferred from the value instead', { type: spec.type });
        }
        if (Array.isArray(spec.options) && spec.options.length) {
            const long = spec.options.length > 4 || spec.options.some(o => String(o).length > 14);
            return long ? 'select' : 'segmented';
        }
        if (typeof spec.value === 'boolean') { return 'toggle'; }
        if (typeof spec.value === 'number') {
            return (typeof spec.min === 'number' && typeof spec.max === 'number') ? 'slider' : 'number';
        }
        if (typeof spec.onClick === 'function') { return 'button'; }
        if (typeof spec.value === 'string') { return 'text'; }
        return 'text';
    }

    /*
     * The icon on a button, chosen by what the label SAYS.
     *
     * Asking the generating side for an icon name would be asking it to know an
     * icon set; reading the verb it already wrote costs nothing and is right
     * nearly always. Unicode rather than an icon font: the frame loads no
     * assets, by design.
     */
    function buttonGlyph(label) {
        const text = String(label || '').toLowerCase();
        if (/reset|restart|again|clear/.test(text)) { return '↺'; }
        if (/launch|fire|shoot|throw|drop/.test(text)) { return '↗'; }
        if (/run|start|solve|sort|step|compute|simulate/.test(text)) { return '▶'; }
        if (/add|new|\+/.test(text)) { return '+'; }
        if (/remove|delete|-$/.test(text)) { return '−'; }
        if (/shuffle|random/.test(text)) { return '⤨'; }
        return '';
    }

    /* ======================================================================
     * Layout.
     *
     * The runtime owns the DOM, completely. A figure never writes an element, a
     * class or a style, and the stylesheet lives in the host module rather than
     * here — "freeze the visual layer" is the rule that makes twelve figures
     * about twelve unrelated subjects look like one product instead of twelve.
     *
     * One column, always. The generating side is told controls stack vertically,
     * and this is the half of that promise that cannot be talked out of it: a
     * figure sits in a document column that is 640px on a laptop and narrower
     * beside an open rail, and a side-by-side layout is unreadable at both.
     * ====================================================================== */

    function element(tag, className, parent) {
        const el = doc.createElement(tag);
        if (className) { el.className = className; }
        if (parent) { parent.appendChild(el); }
        return el;
    }

    const root = element('div', 'fig', doc.body);
    const titleEl = element('div', 'fig-title', root);
    const panesEl = element('div', 'fig-panes', root);
    const legendEl = element('div', 'fig-legend', root);
    const hudEl = element('div', 'fig-hud', root);
    const controlsEl = element('div', 'fig-controls', root);
    const inspectorEl = element('div', 'fig-inspector', root);
    const captionEl = element('div', 'fig-caption', root);
    titleEl.hidden = true;
    legendEl.hidden = true;
    hudEl.hidden = true;
    controlsEl.hidden = true;
    inspectorEl.hidden = true;
    captionEl.hidden = true;

    const defaultPane = element('div', 'fig-pane', panesEl);
    defaultPane.id = 'viz';
    const panes = { viz: defaultPane };

    /*
     * A pane name that does not exist resolves to the main one rather than
     * throwing. A figure that called `buildStack` and then mistyped one id would
     * otherwise lose that whole panel to a blank rectangle; drawing two things
     * on top of each other is wrong, but it is visibly wrong.
     */
    /*
     * A pane's intended height, recorded on the element rather than read back
     * off layout. An engine that measured `host.clientHeight` would be reading a
     * box whose height it is itself about to set — one resize and the canvas
     * grows without bound.
     */
    function setPaneHeight(el, px) {
        const height = Math.max(60, Math.round(Number(px) || 0));
        if (!height) { return; }
        el.__figHeight = height;
        el.style.minHeight = height + 'px';
    }

    function pane(target) {
        /*
         * `panes.viz`, not `defaultPane`.
         *
         * buildStack empties the pane container, so once a figure has called it —
         * or called splitViz, which is buildStack underneath — `defaultPane` is a
         * DETACHED element. An engine called with no target after that rendered
         * into a node that is not in the document, which looks exactly like the
         * engine having silently done nothing. Caught with a figure that split
         * the panel and then asked for stat tiles: the tiles were built, in
         * memory, forever.
         */
        if (!target) { return panes.viz || defaultPane; }
        if (target && target.nodeType === 1) { return target; }
        const id = String(target);
        if (panes[id]) { return panes[id]; }
        report('hallucination', 'No pane named "' + id + '"; drew into the main panel', { pane: id });
        return defaultPane;
    }

    /* ======================================================================
     * Redraw.
     *
     * Every engine registers a repaint. A state change schedules one pass over
     * all of them on the next frame, coalesced — so a subscriber that touches
     * six derived keys repaints once, and a figure with three linked panels
     * cannot show two of them a frame apart.
     * ====================================================================== */

    const repaints = [];
    let scheduled = false;

    function scheduleRepaint() {
        if (scheduled) { return; }
        scheduled = true;
        (global.requestAnimationFrame || function (fn) { return global.setTimeout(fn, 16); })(function () {
            scheduled = false;
            for (const fn of repaints.slice()) { fn(); }
            measure();
        });
    }

    /*
     * Height, reported rather than declared.
     *
     * The host cannot measure a sandboxed frame's content — no same-origin
     * access, by design — so the frame tells it. Upstream's equivalent has the
     * generating side declare a height and observes exactly two values in
     * practice, which is the tell that it is guessing; measuring is both simpler
     * for the author and right when a control panel grows a row.
     */
    let lastHeight = 0;
    function measure(force) {
        /*
         * The raw rect FIRST, and bail on zero before the slack is added.
         *
         * This read `Math.ceil(rect.height) + 2`, and the `+ 2` is what made the
         * zero-height guard below useless: a throttled offscreen frame measures
         * 0, reports 2, and the host clamps 2 up to its floor. So the four
         * figures below the fold in a six-figure document did not merely fail to
         * size themselves — they actively told the host they were 2px tall, which
         * is a worse answer than saying nothing, because saying nothing would
         * have left the host's own placeholder in place.
         */
        const raw = root.getBoundingClientRect().height;
        if (!raw) { return; }
        const height = Math.ceil(raw) + 2;
        /*
         * `force` exists because of render throttling, which is invisible until
         * a document has several figures in it.
         *
         * Chromium does not lay out or animate a cross-origin frame that is
         * outside the viewport, so a figure below the fold measures 0 and never
         * posts — and the host leaves it at its placeholder height until the
         * reader scrolls to it, which then makes the document jump. Measured in a
         * six-figure document: the first two sized correctly and the other four
         * sat at the floor. The host now asks again when a figure scrolls into
         * view, and this is the door it knocks on.
         */
        if (!force && Math.abs(height - lastHeight) < 2) { return; }
        lastHeight = height;
        post('height', { value: height });
    }

    /* ======================================================================
     * `ui` — everything around the drawing.
     * ====================================================================== */

    function setTitle(text) {
        titleEl.textContent = String(text || '');
        titleEl.hidden = !titleEl.textContent;
        measure();
    }

    function setCaption(text) {
        captionEl.textContent = String(text || '');
        captionEl.hidden = !captionEl.textContent;
        measure();
    }

    function setHUD(input) {
        // Both `setHUD([…])` and `setEditorial({hud: […]})` reach here, and so
        // does `setHUD({hud: […]})`, which is what a figure writes when it has
        // seen the other spelling once. All three are the same request.
        const list = Array.isArray(input) ? input : (input && Array.isArray(input.hud) ? input.hud : []);
        hudEl.textContent = '';
        for (const item of list) {
            const cell = element('div', 'fig-hud-cell', hudEl);
            element('div', 'fig-hud-label', cell).textContent = String((item && item.label) || '');
            const value = element('div', 'fig-hud-value', cell);
            value.textContent = String(item && item.value !== undefined ? item.value : '—');
            if (item && item.color) { value.style.color = getColor(item.color); }
        }
        hudEl.hidden = !list.length;
        measure();
    }

    function setLegend(list) {
        const items = Array.isArray(list) ? list : [];
        legendEl.textContent = '';
        for (const item of items) {
            const row = element('span', 'fig-legend-item', legendEl);
            const swatch = element('span', 'fig-swatch', row);
            swatch.style.background = getColor(item && item.color);
            element('span', 'fig-legend-label', row).textContent = String((item && item.label) || '');
        }
        legendEl.hidden = !items.length;
        measure();
    }

    function setInspector(input) {
        const spec = input || {};
        inspectorEl.textContent = '';
        if (spec.title) { element('div', 'fig-inspector-title', inspectorEl).textContent = String(spec.title); }
        if (spec.value !== undefined && spec.value !== null && spec.value !== '') {
            element('div', 'fig-inspector-value', inspectorEl).textContent = String(spec.value);
        }
        if (spec.text) { element('div', 'fig-inspector-text', inspectorEl).textContent = String(spec.text); }
        inspectorEl.hidden = !inspectorEl.childNodes.length;
        measure();
    }

    /** Several stacked panels, each its own engine. The multi-panel primitive. */
    function buildStack(list) {
        const specs = Array.isArray(list) ? list : [];
        panesEl.textContent = '';
        const ids = [];
        for (let i = 0; i < specs.length; i++) {
            const spec = specs[i] || {};
            const id = String(spec.id || ('pane' + (i + 1)));
            const el = element('div', 'fig-pane', panesEl);
            el.id = id;
            if (spec.height) { setPaneHeight(el, spec.height); }
            if (spec.label) { element('div', 'fig-pane-label', el).textContent = String(spec.label); }
            panes[id] = el;
            ids.push(id);
        }
        if (!ids.length) { panesEl.appendChild(defaultPane); return ['viz']; }
        // The main pane is now whichever the figure listed first, so an engine
        // called without a target lands in a real panel instead of one that is
        // no longer in the document.
        panes.viz = panes[ids[0]];
        measure();
        return ids;
    }

    /*
     * Two panes, and the ratio is REAL.
     *
     * It used to set flex-grow on panes inside a column flexbox with no height of
     * its own, which distributes free space of exactly zero — so the ratio was
     * accepted, ignored, and each pane sized to whatever its engine drew. Both
     * generated figures that reached for this passed a considered ratio ("55%",
     * "62%") and got neither. Splitting a fixed budget in real pixels is what the
     * argument reads as, so that is what it now does.
     *
     * SPLIT_BUDGET is smaller than two default panels on purpose: 2 x 280 plus a
     * metric strip and six controls overflows the height a figure is allowed, and
     * a two-panel figure does not need each panel to be as tall as a single-panel
     * figure's one.
     */
    const SPLIT_BUDGET = 440;

    function splitViz(ratio) {
        const share = String(ratio || '50%');
        const percent = Math.min(85, Math.max(15, parseFloat(share) || 50));
        const top = Math.round(SPLIT_BUDGET * percent / 100);
        const ids = buildStack([
            { id: 'vizTop', height: top },
            { id: 'vizBottom', height: SPLIT_BUDGET - top }
        ]);
        // Both an object and a pair, because both spellings get written:
        //   const { vizTop, vizBottom } = ui.splitViz('60%')
        //   const [top, bottom] = ui.splitViz('60%')
        const result = { vizTop: 'vizTop', vizBottom: 'vizBottom' };
        result[Symbol.iterator] = function* () { yield 'vizTop'; yield 'vizBottom'; };
        return result;
    }

    /*
     * Layer 2: a named fallback for a call that does not exist.
     *
     * `splitHorizontal` is implemented for one reason — figures kept asking for
     * it — and it reports itself, so the record says how often the API a model
     * expected differs from the API it was given. It returns the vertical split
     * under the names the caller used, because a stacked pair of panels is a
     * worse answer than a side-by-side pair and a much better answer than none,
     * and side-by-side is refused on the layout grounds above.
     */
    function splitHorizontal(ratio) {
        report('hallucination', 'splitHorizontal is not available; used a vertical split', { property: 'splitHorizontal' });
        const split = splitViz(ratio);
        const result = { vizLeft: split.vizTop, vizRight: split.vizBottom, vizTop: split.vizTop, vizBottom: split.vizBottom };
        result[Symbol.iterator] = function* () { yield result.vizLeft; yield result.vizRight; };
        return result;
    }

    function createContainer(style) {
        const el = element('div', 'fig-container', pane());
        if (style && typeof style === 'object') {
            for (const key of Object.keys(style)) {
                try { el.style[key] = style[key]; } catch (e) { /* an invented style property is not worth failing over */ }
            }
        }
        return el;
    }

    /* ======================================================================
     * Controls.
     * ====================================================================== */

    function buildControls(params, state) {
        controlsEl.textContent = '';
        const keys = Object.keys(params || {});
        let rendered = 0;
        for (const key of keys) {
            const spec = (params[key] && typeof params[key] === 'object' && !Array.isArray(params[key]))
                ? params[key] : { value: params[key] };
            const kind = inferControl(spec);
            const label = spec.label !== undefined ? String(spec.label) : key;
            if (kind === 'header') {
                const head = element('div', 'fig-control-header', controlsEl);
                head.textContent = label;
                rendered++;
                continue;
            }
            const row = element('div', 'fig-control kind-' + kind, controlsEl);
            if (kind !== 'button' && kind !== 'play' && kind !== 'steps') {
                const labelEl = element('label', 'fig-control-label', row);
                labelEl.textContent = label;
                if (kind === 'slider' || kind === 'stepper' || kind === 'number') {
                    /*
                     * The readout's precision comes from the STEP, for the same
                     * reason an axis takes its precision from its tick spacing: a
                     * slider stepping by 0.5 showed "20.00", which claims two
                     * digits of resolution the control does not have.
                     */
                    const step = Number(spec.step);
                    const digits = !isFinite(step) || step <= 0 || step >= 1
                        ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
                    const readout = element('span', 'fig-control-value', labelEl);
                    const paint = v => { readout.textContent = format(v, digits); };
                    paint(state[key]);
                    state._subscribe(key, paint);
                }
            }
            buildControl(kind, key, spec, label, row, state);
            rendered++;
        }
        controlsEl.hidden = !rendered;
        measure();
    }

    function buildControl(kind, key, spec, label, row, state) {
        if (kind === 'slider') {
            const input = element('input', 'fig-range', row);
            input.type = 'range';
            input.min = spec.min;
            input.max = spec.max;
            input.step = spec.step !== undefined ? spec.step : 'any';
            input.value = state[key];
            input.addEventListener('input', () => { state[key] = Number(input.value); });
            state._subscribe(key, v => { if (Number(input.value) !== v) { input.value = v; } });
            return;
        }
        if (kind === 'toggle') {
            const button = element('button', 'fig-switch', row);
            button.type = 'button';
            const paint = v => { button.classList.toggle('on', !!v); button.setAttribute('aria-pressed', v ? 'true' : 'false'); };
            paint(state[key]);
            button.addEventListener('click', () => { state[key] = !state[key]; });
            state._subscribe(key, paint);
            return;
        }
        if (kind === 'segmented' || kind === 'select') {
            const options = (spec.options || []).map(String);
            if (kind === 'segmented') {
                const group = element('div', 'fig-segmented', row);
                const buttons = options.map(option => {
                    const button = element('button', 'fig-seg', group);
                    button.type = 'button';
                    button.textContent = option;
                    button.addEventListener('click', () => { state[key] = option; });
                    return button;
                });
                const paint = v => buttons.forEach((b, i) => b.classList.toggle('on', options[i] === String(v)));
                paint(state[key]);
                state._subscribe(key, paint);
            } else {
                const select = element('select', 'fig-select', row);
                for (const option of options) {
                    const el = element('option', '', select);
                    el.value = option;
                    el.textContent = option;
                }
                select.value = String(state[key]);
                select.addEventListener('change', () => { state[key] = select.value; });
                state._subscribe(key, v => { select.value = String(v); });
            }
            return;
        }
        if (kind === 'play') {
            const button = element('button', 'fig-play', row);
            button.type = 'button';
            const paint = v => { button.textContent = (v ? '⏸  Pause' : '▶  ' + (label || 'Play')); button.classList.toggle('on', !!v); };
            paint(state[key]);
            button.addEventListener('click', () => { state[key] = !state[key]; });
            state._subscribe(key, paint);
            return;
        }
        if (kind === 'button') {
            const button = element('button', 'fig-button', row);
            button.type = 'button';
            const glyph = buttonGlyph(label);
            button.textContent = (glyph ? glyph + '  ' : '') + label;
            button.addEventListener('click', guard('onClick(' + key + ')', () => {
                if (typeof spec.onClick === 'function') { spec.onClick(state); }
                scheduleRepaint();
            }));
            return;
        }
        if (kind === 'stepper') {
            const group = element('div', 'fig-stepper', row);
            const step = spec.step || 1;
            const down = element('button', 'fig-step-btn', group);
            down.type = 'button';
            down.textContent = '−';
            const readout = element('span', 'fig-step-value', group);
            const up = element('button', 'fig-step-btn', group);
            up.type = 'button';
            up.textContent = '+';
            const paint = v => { readout.textContent = String(v); };
            const move = delta => {
                let next = Number(state[key]) + delta * step;
                if (typeof spec.min === 'number') { next = Math.max(spec.min, next); }
                if (typeof spec.max === 'number') { next = Math.min(spec.max, next); }
                state[key] = Number(next.toFixed(6));
            };
            down.addEventListener('click', () => move(-1));
            up.addEventListener('click', () => move(1));
            paint(state[key]);
            state._subscribe(key, paint);
            return;
        }
        if (kind === 'steps') {
            const options = (spec.options || []).map(String);
            const track = element('div', 'fig-steps', row);
            const cells = options.map((option, index) => {
                const cell = element('button', 'fig-step', track);
                cell.type = 'button';
                cell.textContent = option;
                cell.addEventListener('click', () => { state[key] = index; });
                return cell;
            });
            const paint = v => {
                const at = typeof v === 'number' ? v : options.indexOf(String(v));
                cells.forEach((c, i) => { c.classList.toggle('on', i === at); c.classList.toggle('done', i < at); });
            };
            paint(state[key]);
            state._subscribe(key, paint);
            return;
        }
        // number / text / color / date, and anything else that reached here.
        const input = element('input', 'fig-input', row);
        input.type = kind === 'number' ? 'number' : kind;
        if (kind === 'number') {
            if (spec.min !== undefined) { input.min = spec.min; }
            if (spec.max !== undefined) { input.max = spec.max; }
            if (spec.step !== undefined) { input.step = spec.step; }
        }
        input.value = state[key] === undefined ? '' : state[key];
        input.addEventListener('input', () => {
            state[key] = kind === 'number' ? Number(input.value) : input.value;
        });
        state._subscribe(key, v => { if (String(input.value) !== String(v)) { input.value = v; } });
    }

    /* ======================================================================
     * The canvas host.
     *
     * Everything every drawing engine needs and no figure should ever write:
     * device-pixel scaling, resize, the clear before each frame, the frame
     * timer, the pointer, and re-running the drawing when state changes.
     *
     * `setup` may return a frame function. If it does, the figure is animated
     * and the loop owns redrawing. If it does not, `setup` IS the drawing, and
     * it is re-run on a state change or a resize. Both shapes get written and
     * both are correct; which one a figure used is not something it has to
     * declare.
     * ====================================================================== */

    const DEFAULT_HEIGHT = 280;

    function mountCanvas(target, setup, options, mode) {
        const opts = options || {};
        const host = pane(target);
        const canvas = element('canvas', 'fig-canvas', host);
        const raw = canvas.getContext ? canvas.getContext('2d') : undefined;
        if (!raw) {
            report('viz-error', 'No 2D canvas in this environment', { engine: mode });
            element('div', 'fig-missing', host).textContent = 'This figure needs a canvas and could not get one.';
            return undefined;
        }

        const frame = {
            mode: mode === 'world' ? 'world' : 'screen',
            sx: 1, sy: 1, ox: 0, oy: 0,
            width: 0, height: 0, dpr: 1,
            tags: [], autoClear: true
        };
        const pointer = { x: 0, y: 0, wx: 0, wy: 0, down: false, inside: false };
        const ctx = wrapContext(raw, frame, pointer);

        function resize() {
            const width = Math.max(120, Math.round(host.clientWidth || opts.width || 600));
            const aspect = opts.aspect ? parseAspect(opts.aspect) : 0;
            // The pane's own height wins over the default: a figure that laid out
            // panes with buildStack or splitViz has already said how tall each
            // one is, and an engine that ignored that made the ratio a lie.
            const height = Math.max(80, Math.round(
                opts.height || (aspect ? width / aspect : (host.__figHeight || DEFAULT_HEIGHT))));
            const dpr = Math.min(3, Math.max(1, global.devicePixelRatio || 1));
            frame.width = width;
            frame.height = height;
            frame.dpr = dpr;
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            canvas.style.width = width + 'px';
            canvas.style.height = height + 'px';
            if (frame.mode === 'world') { defaultWorld(frame); }
        }

        function before() {
            raw.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0);
            raw.lineWidth = 1;
            raw.lineJoin = 'round';
            raw.lineCap = 'round';
            raw.textBaseline = 'alphabetic';
            raw.font = '12px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
            raw.globalAlpha = 1;
            raw.setLineDash([]);
            frame.tags = [];
            if (frame.autoClear) { raw.clearRect(0, 0, frame.width, frame.height); }
        }

        /*
         * A setup that knows how tall it needs to be, saying so.
         *
         * Every other engine draws into a height it was given. A diagram cannot:
         * how tall it has to be is a RESULT of laying it out, and the layout
         * needs the text measured, which needs the canvas. So the diagram
         * measures, calls this, and gets told whether the canvas moved — if it
         * did, it returns immediately and the redraw this triggers does the real
         * drawing at the right size. Without the return value the outer call
         * would carry on painting with stale dimensions over the top of the new
         * frame.
         */
        function setHeight(px) {
            const next = Math.max(80, Math.min(760, Math.round(px)));
            if (next === opts.height) { return false; }
            opts.height = next;
            resize();
            draw();
            measure();
            return true;
        }

        function context() {
            return {
                el: host, canvas: canvas, ctx: ctx, width: frame.width, height: frame.height,
                setHeight: setHeight,
                cx: frame.mode === 'world' ? 0 : frame.width / 2,
                cy: frame.mode === 'world' ? 0 : frame.height / 2,
                minDim: Math.min(frame.width, frame.height),
                dpr: frame.dpr, pointer: pointer, state: publicState, ui: publicUi, Studio: publicStudio
            };
        }

        /*
         * `loop` is declared before `draw`, and `draw` is a function declaration
         * rather than a const, because setHeight can reach draw DURING the setup
         * call below — a diagram measures itself the first thing it does. Written
         * the natural way round, both were still in their temporal dead zone at
         * that moment, and every diagram failed with a ReferenceError on the one
         * path that has to work first.
         */
        let loop;
        function draw() {
            before();
            if (loop) { return; }
            invoke(guard('draw', setup), context(), [ctx, frame.width, frame.height]);
        }

        resize();
        loop = invoke(guard('setup', setup), context(), [ctx, frame.width, frame.height]);
        if (typeof loop !== 'function') { loop = undefined; }
        if (!loop) { draw(); }

        repaints.push(() => { resize(); draw(); });
        if (global.ResizeObserver) {
            const observer = new global.ResizeObserver(() => { resize(); if (!loop) { draw(); } });
            observer.observe(host);
        }

        if (loop) {
            let last = 0;
            const tick = timestamp => {
                const now = timestamp || 0;
                const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
                last = now;
                before();
                invoke(guard('frame', loop), { dt: dt, t: now / 1000, state: publicState, ctx: ctx, pointer: pointer, ui: publicUi },
                    [dt, publicState, pointer]);
                (global.requestAnimationFrame || function (fn) { return global.setTimeout(fn, 16); })(tick);
            };
            (global.requestAnimationFrame || function (fn) { return global.setTimeout(fn, 16); })(tick);
        }

        const track = event => {
            const rect = canvas.getBoundingClientRect();
            pointer.x = event.clientX - rect.left;
            pointer.y = event.clientY - rect.top;
            const world = toWorld(frame, pointer.x, pointer.y);
            pointer.wx = world.x;
            pointer.wy = world.y;
            pointer.inside = true;
            if (!loop) { draw(); }
        };
        canvas.addEventListener('pointermove', track);
        canvas.addEventListener('pointerdown', event => { pointer.down = true; track(event); });
        canvas.addEventListener('pointerup', () => { pointer.down = false; });
        canvas.addEventListener('pointerleave', () => { pointer.inside = false; pointer.down = false; if (!loop) { draw(); } });

        measure();
        return { canvas: canvas, ctx: ctx, frame: frame, redraw: draw, pointer: pointer };
    }

    function parseAspect(value) {
        const text = String(value);
        const parts = text.split('/');
        if (parts.length === 2) { return Number(parts[0]) / Number(parts[1]); }
        const number = Number(text);
        return isFinite(number) && number > 0 ? number : 0;
    }

    /*
     * World coordinates without a flipped canvas transform.
     *
     * The obvious way to get y-up is `setTransform(s, 0, 0, -s, ox, oy)`, and it
     * takes two things with it: every line is scaled to a fractional width, and
     * every piece of text is upside down and has to be un-flipped by hand. So
     * this converts POSITIONS on the way through the wrapper instead, and leaves
     * the transform alone.
     *
     * The rule that falls out of it — POSITIONS ARE WORLD UNITS, SIZES ARE
     * PIXELS — is the one thing about this runtime a figure author has to hold in
     * their head, and it is the useful way round: a marker is 6px whatever the
     * zoom, an axis line is 1px, and a bar's width is a world quantity. Rect
     * width and height are therefore converted as well, since a rectangle in
     * world space is nearly always a quantity rather than a decoration.
     */
    function defaultWorld(frame) {
        const unit = Math.min(frame.width, frame.height) / 10;
        frame.sx = unit;
        frame.sy = unit;
        frame.ox = frame.width / 2;
        frame.oy = frame.height / 2;
    }

    function toPixels(frame, x, y) {
        if (frame.mode !== 'world') { return { x: x, y: y }; }
        return { x: frame.ox + x * frame.sx, y: frame.oy - y * frame.sy };
    }

    function toWorld(frame, px, py) {
        if (frame.mode !== 'world') { return { x: px, y: py }; }
        return { x: (px - frame.ox) / frame.sx, y: (frame.oy - py) / frame.sy };
    }

    const POSITION_PAIRS = {
        moveTo: [[0, 1]], lineTo: [[0, 1]], arc: [[0, 1]], ellipse: [[0, 1]],
        arcTo: [[0, 1], [2, 3]], quadraticCurveTo: [[0, 1], [2, 3]],
        bezierCurveTo: [[0, 1], [2, 3], [4, 5]],
        rect: [[0, 1]], fillRect: [[0, 1]], strokeRect: [[0, 1]], clearRect: [[0, 1]],
        fillText: [[1, 2]], strokeText: [[1, 2]],
        createLinearGradient: [[0, 1], [2, 3]]
    };
    const SIZE_PAIRS = { rect: [2, 3], fillRect: [2, 3], strokeRect: [2, 3], clearRect: [2, 3] };

    /*
     * `ctx.width` is a NUMBER and `ctx.drawArrow` is a FUNCTION, and both live in
     * the same extras table — so the table cannot be read uniformly. The five
     * measurements are listed rather than marked, because a marker object around
     * each one would be more machinery than a list of five names.
     */
    const CONTEXT_GETTERS = ['width', 'height', 'cx', 'cy', 'minDim'];

    function wrapContext(raw, frame, pointer) {
        const extras = buildContextExtras(raw, frame, pointer);
        const bound = Object.create(null);

        return new Proxy(raw, {
            get(target, prop) {
                if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(extras, prop)) {
                    return CONTEXT_GETTERS.indexOf(prop) === -1 ? extras[prop] : extras[prop]();
                }
                const value = target[prop];
                if (typeof value !== 'function') { return value; }
                if (bound[prop]) { return bound[prop]; }
                const pairs = POSITION_PAIRS[prop];
                const sizes = SIZE_PAIRS[prop];
                bound[prop] = function () {
                    if (frame.mode !== 'world' || (!pairs && !sizes)) { return value.apply(target, arguments); }
                    const args = Array.prototype.slice.call(arguments);
                    if (pairs) {
                        for (const pair of pairs) {
                            const point = toPixels(frame, Number(args[pair[0]]), Number(args[pair[1]]));
                            args[pair[0]] = point.x;
                            args[pair[1]] = point.y;
                        }
                    }
                    if (sizes && pairs) {
                        args[sizes[0]] = Number(args[sizes[0]]) * frame.sx;
                        // A world rectangle grows upward from its own y, so the
                        // pixel rectangle has to be moved up by its own height
                        // as well as scaled — otherwise every bar is drawn
                        // hanging below its baseline.
                        const h = Number(args[sizes[1]]) * frame.sy;
                        args[sizes[1]] = h;
                        args[pairs[0][1]] = args[pairs[0][1]] - h;
                    }
                    return value.apply(target, args);
                };
                return bound[prop];
            },
            set(target, prop, value) { target[prop] = value; return true; },
            has(target, prop) { return prop in target || Object.prototype.hasOwnProperty.call(extras, prop); }
        });
    }

    function buildContextExtras(raw, frame, pointer) {
        function tagRect(text, x, y) {
            raw.font = '11px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
            const width = raw.measureText(text).width + 10;
            return { x: x, y: y, w: width, h: 18 };
        }
        function overlaps(a, b) {
            return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
        }

        return {
            width: () => frame.width,
            height: () => frame.height,
            cx: () => (frame.mode === 'world' ? 0 : frame.width / 2),
            cy: () => (frame.mode === 'world' ? 0 : frame.height / 2),
            minDim: () => Math.min(frame.width, frame.height),
            token: name => getColor(name),
            setAutoClear: value => { frame.autoClear = value !== false; },
            toPixels: (x, y) => toPixels(frame, x, y),
            toWorld: (x, y) => toWorld(frame, x, y),
            /*
             * The pointer in the coordinate system the figure is drawing in.
             * `pointer.x/y` are always pixels; this is what a world-unit figure
             * wants, and asking it to convert is asking it to know the transform
             * it was given a runtime to avoid.
             */
            getPointer: () => (frame.mode === 'world'
                ? { x: pointer.wx, y: pointer.wy, down: pointer.down, inside: pointer.inside }
                : { x: pointer.x, y: pointer.y, down: pointer.down, inside: pointer.inside }),

            /**
             * Fit the view to the data. Called every frame, this is what makes a
             * figure auto-scale when a slider moves — which is the difference
             * between a simulation you can explore and one that walks off the
             * edge of its own canvas at the second notch of the first slider.
             */
            scaleTo: (xExtent, yExtent, options) => {
                const opts = options || {};
                const padding = opts.pad === undefined ? 28 : opts.pad;
                const x0 = Number(xExtent[0]), x1 = Number(xExtent[1]);
                const y0 = Number(yExtent[0]), y1 = Number(yExtent[1]);
                const usableW = Math.max(20, frame.width - padding * 2);
                const usableH = Math.max(20, frame.height - padding * 2);
                frame.mode = 'world';
                const perX = usableW / Math.max(1e-9, x1 - x0);
                const perY = usableH / Math.max(1e-9, y1 - y0);
                /*
                 * ONE SCALE FOR BOTH AXES, BY DEFAULT. This is the correction to
                 * the most damaging bug this runtime has had.
                 *
                 * It used to fit each axis independently, which is what "fit the
                 * view to the data" sounds like and is wrong for every figure
                 * whose coordinates mean the same thing in both directions —
                 * which is nearly every figure that reaches for world units at
                 * all. Two measured examples, both from generated figures that
                 * were otherwise correct: a star graph's leaves on a radius-1.0
                 * circle rendered on a 2.6:1 ellipse, and a Rayleigh scattering
                 * lobe whose true forward-to-sideways ratio is 2:1 rendered at
                 * about 5:1. The second one does not look like a layout bug, it
                 * looks like physics — the figure confidently taught the wrong
                 * answer, and nothing in the source said so.
                 *
                 * A shape can only be trusted if one world unit is one length on
                 * screen. `stretch: true` is there for the genuine exception (a
                 * time axis against a value axis, where the units are unrelated),
                 * and it has to be asked for.
                 */
                if (opts.stretch) {
                    frame.sx = perX;
                    frame.sy = perY;
                } else {
                    frame.sx = frame.sy = Math.min(perX, perY);
                }
                frame.ox = padding - x0 * frame.sx + Math.max(0, usableW - (x1 - x0) * frame.sx) / 2;
                frame.oy = frame.height - padding + y0 * frame.sy - Math.max(0, usableH - (y1 - y0) * frame.sy) / 2;
                /*
                 * The extent recorded is what is VISIBLE, not what was asked
                 * for. Uniform scaling means one axis usually shows more than
                 * the request, and drawGrid reads this to decide where its
                 * lines and labels go — recording the request would leave a
                 * band of unlabelled grid at the edges.
                 */
                const seenX = frame.width / frame.sx;
                const seenY = frame.height / frame.sy;
                const midX = (x0 + x1) / 2, midY = (y0 + y1) / 2;
                frame.extent = {
                    x: [midX - seenX / 2, midX + seenX / 2],
                    y: [midY - seenY / 2, midY + seenY / 2]
                };
            },

            /** Vectors, with a head that stays the same size at any scale. */
            drawArrow: (x, y, dx, dy, color) => {
                const from = toPixels(frame, x, y);
                const to = toPixels(frame, x + dx, y + dy);
                const angle = Math.atan2(to.y - from.y, to.x - from.x);
                const length = Math.hypot(to.x - from.x, to.y - from.y);
                if (length < 1) { return; }
                const head = Math.min(9, length * 0.4);
                raw.save();
                raw.strokeStyle = getColor(color || '--chart-1');
                raw.fillStyle = raw.strokeStyle;
                raw.lineWidth = 1.6;
                raw.beginPath();
                raw.moveTo(from.x, from.y);
                raw.lineTo(to.x - Math.cos(angle) * head * 0.7, to.y - Math.sin(angle) * head * 0.7);
                raw.stroke();
                raw.beginPath();
                raw.moveTo(to.x, to.y);
                raw.lineTo(to.x - Math.cos(angle - 0.4) * head, to.y - Math.sin(angle - 0.4) * head);
                raw.lineTo(to.x - Math.cos(angle + 0.4) * head, to.y - Math.sin(angle + 0.4) * head);
                raw.closePath();
                raw.fill();
                raw.restore();
            },

            /*
             * A callout that does not land on top of the last one.
             *
             * Eight candidate offsets, tried in order, skipping any that overlaps
             * a tag already placed this frame or leaves the canvas. Placements
             * are remembered per frame, which is what makes a figure with six
             * labelled points readable instead of a pile of text — and it is the
             * kind of thing no figure author would write by hand, which is
             * exactly why it belongs here.
             */
            drawTag: (text, x, y, color) => {
                const label = String(text);
                const anchor = toPixels(frame, x, y);
                const offsets = [[10, -10], [-10, -10], [10, 16], [-10, 16], [18, 2], [-18, 2], [0, -22], [0, 26]];
                let placed;
                for (const offset of offsets) {
                    const candidate = tagRect(label, anchor.x + offset[0] + (offset[0] < 0 ? -0 : 0), anchor.y + offset[1]);
                    if (offset[0] < 0) { candidate.x -= candidate.w; }
                    if (candidate.x < 2 || candidate.y < 2 ||
                        candidate.x + candidate.w > frame.width - 2 || candidate.y + candidate.h > frame.height - 2) { continue; }
                    if (frame.tags.some(existing => overlaps(existing, candidate))) { continue; }
                    placed = candidate;
                    break;
                }
                if (!placed) {
                    placed = tagRect(label, anchor.x + 10, anchor.y - 10);
                }
                frame.tags.push(placed);
                raw.save();
                raw.font = '11px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
                raw.strokeStyle = transparent('--studio-line', 0.9);
                raw.lineWidth = 1;
                raw.beginPath();
                raw.moveTo(anchor.x, anchor.y);
                raw.lineTo(placed.x + placed.w / 2, placed.y + placed.h / 2);
                raw.stroke();
                raw.fillStyle = getColor('--studio-surface');
                raw.globalAlpha = 0.92;
                roundRect(raw, placed.x, placed.y, placed.w, placed.h, 5);
                raw.fill();
                raw.globalAlpha = 1;
                raw.strokeStyle = transparent('--studio-line', 1);
                roundRect(raw, placed.x, placed.y, placed.w, placed.h, 5);
                raw.stroke();
                raw.fillStyle = getColor(color || '--studio-text');
                raw.textAlign = 'center';
                raw.textBaseline = 'middle';
                raw.fillText(label, placed.x + placed.w / 2, placed.y + placed.h / 2);
                raw.restore();
            },

            /** Reference grid in world units, with the axes drawn through zero. */
            drawGrid: options => {
                const opts = options || {};
                const extent = frame.extent || {
                    x: [toWorld(frame, 0, 0).x, toWorld(frame, frame.width, 0).x],
                    y: [toWorld(frame, 0, frame.height).y, toWorld(frame, 0, 0).y]
                };
                const xs = opts.step && opts.step !== 'auto'
                    ? stepsBetween(extent.x[0], extent.x[1], opts.step) : niceTicks(extent.x[0], extent.x[1], 8);
                const ys = opts.step && opts.step !== 'auto'
                    ? stepsBetween(extent.y[0], extent.y[1], opts.step) : niceTicks(extent.y[0], extent.y[1], 5);
                raw.save();
                raw.lineWidth = 1;
                raw.strokeStyle = getColor('--grid');
                raw.beginPath();
                for (const x of xs) {
                    const at = toPixels(frame, x, 0).x;
                    raw.moveTo(at, 0);
                    raw.lineTo(at, frame.height);
                }
                for (const y of ys) {
                    const at = toPixels(frame, 0, y).y;
                    raw.moveTo(0, at);
                    raw.lineTo(frame.width, at);
                }
                raw.stroke();
                if (opts.labels !== false) {
                    raw.fillStyle = getColor('--studio-muted');
                    raw.font = '10px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
                    raw.textAlign = 'center';
                    raw.textBaseline = 'top';
                    const baseline = clamp(toPixels(frame, 0, 0).y, 12, frame.height - 14);
                    for (const x of xs) {
                        if (Math.abs(x) < 1e-9) { continue; }
                        raw.fillText(format(x), toPixels(frame, x, 0).x, baseline + 3);
                    }
                    raw.textAlign = 'left';
                    raw.textBaseline = 'middle';
                    const gutter = clamp(toPixels(frame, 0, 0).x, 4, frame.width - 40);
                    for (const y of ys) {
                        if (Math.abs(y) < 1e-9) { continue; }
                        raw.fillText(format(y), gutter + 4, toPixels(frame, 0, y).y);
                    }
                }
                raw.strokeStyle = getColor('--axis');
                raw.beginPath();
                const zeroY = toPixels(frame, 0, 0).y;
                const zeroX = toPixels(frame, 0, 0).x;
                raw.moveTo(0, zeroY);
                raw.lineTo(frame.width, zeroY);
                raw.moveTo(zeroX, 0);
                raw.lineTo(zeroX, frame.height);
                raw.stroke();
                raw.restore();
            }
        };
    }

    function stepsBetween(lo, hi, step) {
        const out = [];
        const size = Math.abs(Number(step)) || 1;
        for (let v = Math.ceil(lo / size) * size; v <= hi + size * 1e-9; v += size) { out.push(Number(v.toFixed(10))); }
        return out;
    }

    function roundRect(raw, x, y, w, h, r) {
        const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
        raw.beginPath();
        raw.moveTo(x + radius, y);
        raw.lineTo(x + w - radius, y);
        raw.quadraticCurveTo(x + w, y, x + w, y + radius);
        raw.lineTo(x + w, y + h - radius);
        raw.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
        raw.lineTo(x + radius, y + h);
        raw.quadraticCurveTo(x, y + h, x, y + h - radius);
        raw.lineTo(x, y + radius);
        raw.quadraticCurveTo(x, y, x + radius, y);
        raw.closePath();
    }

    /* ======================================================================
     * The chart engine.
     *
     * Written here rather than wrapped around a charting library, and that was a
     * real decision rather than a preference. The frame has no network — that is
     * what the sandbox buys — so a library would have to be inlined into every
     * figure's document, and the smallest credible one is larger than this whole
     * runtime. What a figure actually needs is line, area, bar, dot and rule
     * over one linear or one categorical axis, with ticks a reader can read.
     * That is this section.
     *
     * The config shape deliberately mirrors Observable Plot, because that is the
     * shape a model reaches for when asked for a chart config, and matching what
     * it already writes is worth more than a cleaner design of my own.
     * ====================================================================== */

    function accessor(spec, fallback) {
        if (typeof spec === 'function') { return spec; }
        if (typeof spec === 'string') { return row => (row ? row[spec] : undefined); }
        if (spec === undefined && fallback !== undefined) { return accessor(fallback); }
        return row => row;
    }

    function markRows(mark) {
        const data = mark && mark.data;
        if (!data) { return []; }
        return Array.prototype.slice.call(data);
    }

    /*
     * Is this a token, a data field, or a literal?
     *
     * `stroke: "--chart-2"` is a colour. `stroke: "series"` is a field to colour
     * BY. Telling them apart by the leading dashes rather than by a separate
     * `colorBy` option is what lets a figure write the natural thing in both
     * cases, and it cannot be ambiguous: no token is a field name and no field
     * name starts with two dashes.
     */
    function colorChannel(value, rows) {
        if (typeof value === 'function') { return { kind: 'field', get: value }; }
        if (typeof value !== 'string' || !value) { return undefined; }
        if (value.charAt(0) === '-') { return { kind: 'token', token: value }; }
        const sample = rows.find(row => row && typeof row === 'object');
        if (sample && Object.prototype.hasOwnProperty.call(sample, value)) {
            return { kind: 'field', get: row => row[value] };
        }
        return { kind: 'token', token: value };
    }

    const plot = {
        lineY: (data, options) => Object.assign({ kind: 'line', data: data }, options),
        areaY: (data, options) => Object.assign({ kind: 'area', data: data }, options),
        barY: (data, options) => Object.assign({ kind: 'bar', data: data }, options),
        stackedBarY: (data, options) => Object.assign({ kind: 'bar', stacked: true, data: data }, options),
        barX: (data, options) => Object.assign({ kind: 'barX', data: data }, options),
        dot: (data, options) => Object.assign({ kind: 'dot', data: data }, options),
        ruleY: (values, options) => Object.assign({ kind: 'ruleY', data: values }, options),
        ruleX: (values, options) => Object.assign({ kind: 'ruleX', data: values }, options),
        text: (data, options) => Object.assign({ kind: 'text', data: data }, options)
    };

    function initPlot(target, setup, options) {
        const mount = mountCanvas(target, function (context) {
            const config = invoke(setup, { state: publicState, ui: publicUi, width: context.width, height: context.height, ctx: context.ctx },
                [context.ctx, context.width, context.height]) || {};
            drawPlot(context, config);
        }, options, 'screen');
        return mount;
    }

    /*
     * The scales, separated from the drawing.
     *
     * Pulled out so it can be checked without a canvas — and it had to be,
     * because the bug that lived in here (an x domain silently forced to include
     * zero) is invisible in every figure whose x axis starts at zero, which is
     * every figure in STARTERS. A pure function over a config is something a test
     * can interrogate directly.
     */
    function plotGeometry(config, width, height) {
        const marks = Array.isArray(config.marks) ? config.marks.filter(Boolean)
            : (config.marks ? [config.marks] : []);
        const xSpec = config.x || {};
        const ySpec = config.y || {};

        const xValues = [];
        const yValues = [];
        for (const mark of marks) {
            const getX = accessor(mark.x, 'x');
            const getY = accessor(mark.y, 'y');
            if (mark.kind === 'ruleY') { for (const v of markRows(mark)) { yValues.push(Number(v)); } continue; }
            if (mark.kind === 'ruleX') { for (const v of markRows(mark)) { xValues.push(v); } continue; }
            for (const row of markRows(mark)) {
                xValues.push(getX(row));
                yValues.push(Number(getY(row)));
                if (mark.y0 !== undefined) { yValues.push(Number(accessor(mark.y0)(row))); }
            }
        }

        const banded = xSpec.type === 'band' || (xSpec.type !== 'linear' && xValues.some(v => typeof v === 'string')) ||
            marks.some(m => m.kind === 'bar');
        const horizontal = marks.some(m => m.kind === 'barX');

        const numericY = yValues.filter(v => isFinite(v));
        let yLo = ySpec.domain ? Number(ySpec.domain[0]) : Math.min.apply(null, numericY.length ? numericY : [0]);
        let yHi = ySpec.domain ? Number(ySpec.domain[1]) : Math.max.apply(null, numericY.length ? numericY : [1]);
        if (!ySpec.domain) {
            if (ySpec.zero !== false && yLo > 0) { yLo = 0; }
            if (ySpec.zero !== false && yHi < 0) { yHi = 0; }
            const pad = (yHi - yLo) * 0.08 || 1;
            if (!(ySpec.zero !== false && yLo === 0)) { yLo -= pad; }
            yHi += pad;
        }
        if (yLo === yHi) { yHi = yLo + 1; }

        const categories = [];
        if (banded) {
            for (const value of (xSpec.domain || xValues)) {
                const key = String(value);
                if (categories.indexOf(key) === -1) { categories.push(key); }
            }
        }

        /*
         * THE X DOMAIN IS THE DATA'S, NOT THE DATA'S PLUS ZERO.
         *
         * This read `.concat([0])` and `.concat([1])`, which were meant as guards
         * against calling Math.min on an empty array and are in fact a clamp:
         * every linear x axis was forced to include 0 and 1. A generated figure
         * plotting 380-750 nm therefore drew its curve in the right-hand 45% of
         * the panel with half the chart empty, and the same would have happened to
         * years, temperatures, pH, or anything else not starting near the origin.
         *
         * Zero belongs on the Y axis by default — a bar whose base is not zero
         * lies about a magnitude. On X it is just a number nobody asked about.
         */
        const numericX = xValues.map(Number).filter(isFinite);
        let xLo = xSpec.domain && !banded ? Number(xSpec.domain[0])
            : (numericX.length ? Math.min.apply(null, numericX) : 0);
        let xHi = xSpec.domain && !banded ? Number(xSpec.domain[1])
            : (numericX.length ? Math.max.apply(null, numericX) : 1);
        if (!xSpec.domain && xLo === xHi) { xLo -= 0.5; xHi += 0.5; }

        return {
            marks, xSpec, ySpec, colorSpec: config.color || {},
            banded, horizontal, categories,
            xLo, xHi, yLo, yHi,
            yTicks: niceTicks(yLo, yHi, ySpec.ticks || 5),
            width, height
        };
    }

    function drawPlot(context, config) {
        const ctx = context.ctx;
        const marks = Array.isArray(config.marks) ? config.marks.filter(Boolean)
            : (config.marks ? [config.marks] : []);
        if (!marks.length) {
            /*
             * Layer 7: the wrong-engine fallback. A figure that wrote canvas
             * drawing inside an initPlot callback returns undefined here, and
             * saying so beats an empty rectangle that reads as a rendering bug.
             */
            report('viz-error', 'initPlot received no marks; nothing to draw', {});
            ctx.fillStyle = getColor('--studio-muted');
            ctx.font = '12px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
            ctx.textAlign = 'center';
            ctx.fillText('This chart returned no marks.', context.width / 2, context.height / 2);
            return;
        }

        const geom = plotGeometry(config, context.width, context.height);
        const xSpec = geom.xSpec;
        const ySpec = geom.ySpec;
        const colorSpec = geom.colorSpec;
        const banded = geom.banded;
        const categories = geom.categories;
        const yLo = geom.yLo, yHi = geom.yHi;
        const xLo = geom.xLo, xHi = geom.xHi;

        const yTicks = geom.yTicks;
        const formatY = typeof ySpec.format === 'function' ? ySpec.format : axisFormat(yTicks);

        // Margins are measured, not assumed: a y axis reading "$1,240,000" needs
        // a wider gutter than one reading "0.4", and a chart whose labels are cut
        // off is the commonest way a generated chart looks broken.
        ctx.font = '10px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
        const yLabelWidth = Math.max.apply(null, yTicks.map(t => ctx.measureText(formatY(t)).width).concat([12]));
        const margin = {
            left: Math.ceil(yLabelWidth) + 12 + (ySpec.label ? 14 : 0),
            right: 14,
            top: 10,
            bottom: 24 + (xSpec.label ? 14 : 0)
        };
        const plotW = Math.max(20, context.width - margin.left - margin.right);
        const plotH = Math.max(20, context.height - margin.top - margin.bottom);

        const bandWidth = banded ? plotW / Math.max(1, categories.length) : 0;
        const xAt = value => banded
            ? margin.left + categories.indexOf(String(value)) * bandWidth + bandWidth / 2
            : margin.left + (xHi === xLo ? plotW / 2 : ((Number(value) - xLo) / (xHi - xLo)) * plotW);
        const yAt = value => margin.top + plotH - ((Number(value) - yLo) / (yHi - yLo)) * plotH;

        // --- grid and axes ---
        ctx.save();
        ctx.strokeStyle = getColor('--grid');
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const tick of yTicks) {
            const y = Math.round(yAt(tick)) + 0.5;
            ctx.moveTo(margin.left, y);
            ctx.lineTo(margin.left + plotW, y);
        }
        ctx.stroke();
        ctx.fillStyle = getColor('--studio-muted');
        ctx.font = '10px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const tick of yTicks) { ctx.fillText(formatY(tick), margin.left - 6, yAt(tick)); }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const xTicks = banded ? categories : niceTicks(xLo, xHi, xSpec.ticks || 6);
        const formatX = typeof xSpec.format === 'function' ? xSpec.format : axisFormat(xTicks);
        const stride = banded && categories.length > 12 ? Math.ceil(categories.length / 12) : 1;
        xTicks.forEach((tick, index) => {
            if (index % stride) { return; }
            ctx.fillText(formatX(tick), xAt(tick), margin.top + plotH + 7);
        });
        if (xSpec.label) {
            ctx.fillText(String(xSpec.label), margin.left + plotW / 2, margin.top + plotH + 22);
        }
        if (ySpec.label) {
            ctx.save();
            ctx.translate(10, margin.top + plotH / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(String(ySpec.label), 0, 0);
            ctx.restore();
        }
        ctx.strokeStyle = getColor('--axis');
        ctx.beginPath();
        ctx.moveTo(margin.left, margin.top);
        ctx.lineTo(margin.left, margin.top + plotH);
        ctx.lineTo(margin.left + plotW, margin.top + plotH);
        ctx.stroke();
        ctx.restore();

        // --- colour ---
        const domain = colorSpec.domain ? colorSpec.domain.map(String) : [];
        const range = colorSpec.range && colorSpec.range.length
            ? colorSpec.range : ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6'];
        const seenSeries = [];
        function seriesColor(value) {
            const key = String(value);
            let index = domain.indexOf(key);
            if (index === -1) {
                index = seenSeries.indexOf(key);
                if (index === -1) { seenSeries.push(key); index = seenSeries.length - 1; }
                index += domain.length;
            }
            return getColor(range[index % range.length]);
        }
        if (colorSpec.legend && domain.length) {
            setLegend(domain.map((label, index) => ({ label: label, color: range[index % range.length] })));
        }

        const hits = [];

        for (const mark of marks) {
            const rows = markRows(mark);
            const getX = accessor(mark.x, 'x');
            const getY = accessor(mark.y, 'y');
            const strokeChannel = colorChannel(mark.stroke, rows);
            const fillChannel = colorChannel(mark.fill, rows);
            const colorOf = row => {
                const channel = strokeChannel || fillChannel;
                if (!channel) { return getColor('--chart-1'); }
                return channel.kind === 'token' ? getColor(channel.token) : seriesColor(channel.get(row));
            };

            ctx.save();
            ctx.globalAlpha = mark.opacity === undefined ? 1 : mark.opacity;
            if (mark.dash) { ctx.setLineDash(Array.isArray(mark.dash) ? mark.dash : [4, 4]); }

            if (mark.kind === 'ruleY' || mark.kind === 'ruleX') {
                ctx.strokeStyle = getColor(mark.stroke || mark.fill || '--anno-red');
                ctx.lineWidth = mark.strokeWidth || 1.25;
                ctx.beginPath();
                for (const value of rows) {
                    if (mark.kind === 'ruleY') {
                        const y = Math.round(yAt(Number(value))) + 0.5;
                        ctx.moveTo(margin.left, y);
                        ctx.lineTo(margin.left + plotW, y);
                    } else {
                        const x = Math.round(xAt(value)) + 0.5;
                        ctx.moveTo(x, margin.top);
                        ctx.lineTo(x, margin.top + plotH);
                    }
                }
                ctx.stroke();
                if (mark.label) {
                    ctx.fillStyle = ctx.strokeStyle;
                    ctx.font = '10px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
                    ctx.textAlign = 'right';
                    ctx.textBaseline = 'bottom';
                    const first = rows[0];
                    if (mark.kind === 'ruleY') { ctx.fillText(String(mark.label), margin.left + plotW - 4, yAt(Number(first)) - 3); }
                    else { ctx.fillText(String(mark.label), xAt(first) - 4, margin.top + 12); }
                }
                ctx.restore();
                continue;
            }

            const groups = groupRows(rows, strokeChannel || fillChannel);

            if (mark.kind === 'line' || mark.kind === 'area') {
                for (const group of groups) {
                    const points = group.rows.map(row => ({ x: xAt(getX(row)), y: yAt(getY(row)), row: row }))
                        .filter(p => isFinite(p.x) && isFinite(p.y));
                    if (points.length < 2) { continue; }
                    const color = colorOf(group.rows[0]);
                    ctx.beginPath();
                    pathThrough(ctx, points, mark.curve);
                    if (mark.kind === 'area') {
                        const base = yAt(mark.y0 !== undefined ? Number(mark.y0) : Math.max(yLo, Math.min(0, yHi)));
                        ctx.lineTo(points[points.length - 1].x, base);
                        ctx.lineTo(points[0].x, base);
                        ctx.closePath();
                        ctx.fillStyle = mark.opacity === undefined ? transparent(fillChannel && fillChannel.kind === 'token' ? fillChannel.token : '--chart-1', 0.16) : color;
                        ctx.fill();
                    } else {
                        ctx.strokeStyle = color;
                        ctx.lineWidth = mark.strokeWidth || 2;
                        ctx.stroke();
                    }
                    for (const point of points) { hits.push({ x: point.x, y: point.y, row: point.row, color: color, mark: mark }); }
                }
            } else if (mark.kind === 'bar') {
                const series = groups.length;
                const inner = bandWidth * 0.72;
                const slot = mark.stacked ? inner : inner / Math.max(1, series);
                const stackTops = Object.create(null);
                groups.forEach((group, groupIndex) => {
                    for (const row of group.rows) {
                        const value = Number(getY(row));
                        if (!isFinite(value)) { continue; }
                        const key = String(getX(row));
                        const centre = xAt(key);
                        const left = mark.stacked
                            ? centre - inner / 2
                            : centre - inner / 2 + groupIndex * slot;
                        const from = mark.stacked ? (stackTops[key] || 0) : 0;
                        const to = mark.stacked ? from + value : value;
                        if (mark.stacked) { stackTops[key] = to; }
                        const yTop = yAt(Math.max(from, to));
                        const yBottom = yAt(Math.min(from, to));
                        ctx.fillStyle = colorOf(row);
                        ctx.beginPath();
                        roundRect(ctx, left, yTop, Math.max(1, slot - 2), Math.max(1, yBottom - yTop), 3);
                        ctx.fill();
                        hits.push({ x: left + slot / 2, y: yTop, row: row, color: ctx.fillStyle, mark: mark });
                    }
                });
            } else if (mark.kind === 'barX') {
                const rowHeight = plotH / Math.max(1, rows.length);
                rows.forEach((row, index) => {
                    const value = Number(getY(row) !== undefined ? getY(row) : getX(row));
                    const width = ((value - Math.min(0, yLo)) / (yHi - yLo)) * plotW;
                    const top = margin.top + index * rowHeight + rowHeight * 0.18;
                    ctx.fillStyle = colorOf(row);
                    ctx.beginPath();
                    roundRect(ctx, margin.left, top, Math.max(1, width), rowHeight * 0.64, 3);
                    ctx.fill();
                    hits.push({ x: margin.left + width, y: top + rowHeight * 0.32, row: row, color: ctx.fillStyle, mark: mark });
                });
            } else if (mark.kind === 'dot') {
                for (const row of rows) {
                    const x = xAt(getX(row));
                    const y = yAt(getY(row));
                    if (!isFinite(x) || !isFinite(y)) { continue; }
                    const r = mark.r === undefined ? 3.5 : (typeof mark.r === 'function' ? mark.r(row) : Number(mark.r));
                    ctx.fillStyle = colorOf(row);
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fill();
                    if (mark.stroke && strokeChannel && strokeChannel.kind === 'token') {
                        ctx.strokeStyle = getColor(strokeChannel.token);
                        ctx.lineWidth = 1.5;
                        ctx.stroke();
                    }
                    hits.push({ x: x, y: y, row: row, color: ctx.fillStyle, mark: mark });
                }
            } else if (mark.kind === 'text') {
                ctx.font = '11px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
                ctx.textAlign = mark.textAlign || 'center';
                ctx.textBaseline = 'bottom';
                const getText = accessor(mark.text, 'label');
                for (const row of rows) {
                    ctx.fillStyle = colorOf(row);
                    ctx.fillText(String(getText(row)), xAt(getX(row)), yAt(getY(row)) - 6);
                }
            } else {
                report('viz-error', 'Unknown mark "' + mark.kind + '"', { mark: mark.kind });
            }
            ctx.restore();
        }

        // --- the tip ---
        const wanted = marks.some(mark => mark.tip);
        if (wanted && context.pointer && context.pointer.inside) {
            let best, bestDistance = 26;
            for (const hit of hits) {
                if (!hit.mark.tip) { continue; }
                const distanceTo = Math.hypot(hit.x - context.pointer.x, hit.y - context.pointer.y);
                if (distanceTo < bestDistance) { bestDistance = distanceTo; best = hit; }
            }
            if (best) { drawTip(ctx, context, best, formatX, formatY, accessor(best.mark.x, 'x'), accessor(best.mark.y, 'y')); }
        }
    }

    function groupRows(rows, channel) {
        if (!channel || channel.kind === 'token') { return [{ key: '', rows: rows }]; }
        const order = [];
        const buckets = Object.create(null);
        for (const row of rows) {
            const key = String(channel.get(row));
            if (!buckets[key]) { buckets[key] = []; order.push(key); }
            buckets[key].push(row);
        }
        return order.map(key => ({ key: key, rows: buckets[key] }));
    }

    /*
     * A path through points, straight or smoothed.
     *
     * `curve: "smooth"` is a Catmull-Rom spline converted to cubic beziers with
     * the tangents clamped so it cannot overshoot into negative values — which
     * is the one thing a smoothed chart must never do, because an interpolation
     * artefact that dips below zero is read as data.
     */
    function pathThrough(ctx, points, curve) {
        if (curve === 'step') {
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                ctx.lineTo(points[i].x, points[i - 1].y);
                ctx.lineTo(points[i].x, points[i].y);
            }
            return;
        }
        if (curve !== 'smooth' && curve !== 'monotone' && curve !== 'monotone-x' && curve !== 'catmull-rom') {
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) { ctx.lineTo(points[i].x, points[i].y); }
            return;
        }
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[i - 1] || points[i];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = points[i + 2] || p2;
            const monotone = (p2.y - p1.y) === 0 ? 0 : 1;
            const t = 0.2 * monotone + 0.16;
            ctx.bezierCurveTo(
                p1.x + (p2.x - p0.x) * t, p1.y + (p2.y - p0.y) * t,
                p2.x - (p3.x - p1.x) * t, p2.y - (p3.y - p1.y) * t,
                p2.x, p2.y);
        }
    }

    function drawTip(ctx, context, hit, formatX, formatY, getX, getY) {
        const lines = [formatX(getX(hit.row)), formatY(getY(hit.row))];
        ctx.save();
        ctx.font = '11px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
        const width = Math.max.apply(null, lines.map(line => ctx.measureText(line).width)) + 16;
        const height = lines.length * 14 + 10;
        let x = hit.x + 12;
        let y = hit.y - height - 8;
        if (x + width > context.width - 4) { x = hit.x - width - 12; }
        if (y < 2) { y = hit.y + 12; }
        ctx.fillStyle = getColor('--studio-surface');
        ctx.strokeStyle = getColor('--studio-line');
        ctx.lineWidth = 1;
        roundRect(ctx, x, y, width, height, 6);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(hit.x, hit.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = hit.color;
        ctx.fill();
        ctx.fillStyle = getColor('--studio-text');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        lines.forEach((line, index) => { ctx.fillText(line, x + 8, y + 5 + index * 14); });
        ctx.restore();
    }

    /* ======================================================================
     * Diagrams: boxes and arrows, laid out rather than positioned.
     *
     * A figure describes nodes and edges and never a coordinate. That is the
     * whole point: a generated diagram with hand-placed boxes is a diagram that
     * overlaps itself the first time a label is longer than the author imagined,
     * and it is unfixable without re-reading every number.
     *
     * Layering is longest-path from the roots, which is the right algorithm for
     * the shape figures actually ask for (a pipeline, a state machine, a
     * hierarchy) and is four lines. Nodes are clickable and feed the inspector,
     * so a diagram can carry more than fits in its boxes.
     * ====================================================================== */

    /*
     * Layers, over the DAG that remains once the back edges are removed.
     *
     * THE FIRST VERSION OF THIS WAS WRONG in a way worth recording, because it
     * looked right and the mistake is easy to repeat. It relaxed longest-path
     * distances edge by edge, bounded by the node count "so a cycle settles
     * instead of spinning". A cycle does not settle: every pass pushes both of
     * its ends one layer further apart, so the bound does not make it converge,
     * it just stops it somewhere arbitrary. The five-node pipeline in the
     * diagram starter — which has one retry edge, the most ordinary thing a
     * figure draws — came out with layers 0, 1, 9, 10, 10, and rendered as two
     * boxes on top of each other with a line running off the canvas.
     *
     * The fix is to decide FIRST which edges are back edges (a depth-first
     * search: an edge into a node still on the stack), then layer over what is
     * left, which is a DAG by construction. Back edges still draw — they are the
     * interesting ones — they just do not get a vote on the layout.
     */
    function layerNodes(nodes, edges) {
        const outgoing = Object.create(null);
        for (const node of nodes) { outgoing[node.id] = []; }
        const real = edges.filter(edge => outgoing[edge.from] && outgoing[edge.to]);
        for (const edge of real) { outgoing[edge.from].push(edge.to); }

        const WHITE = 0, GREY = 1, BLACK = 2;
        const colour = Object.create(null);
        const back = new Set();
        for (const node of nodes) { colour[node.id] = WHITE; }

        // Iterative DFS: a figure with a hundred nodes must not blow the stack,
        // and the explicit stack is what lets an edge be classified on the way
        // in rather than reconstructed afterwards.
        for (const root of nodes) {
            if (colour[root.id] !== WHITE) { continue; }
            const stack = [{ id: root.id, next: 0 }];
            colour[root.id] = GREY;
            while (stack.length) {
                const frame = stack[stack.length - 1];
                const children = outgoing[frame.id];
                if (frame.next >= children.length) {
                    colour[frame.id] = BLACK;
                    stack.pop();
                    continue;
                }
                const child = children[frame.next++];
                if (colour[child] === GREY) { back.add(frame.id + '\u0000' + child); continue; }
                if (colour[child] === BLACK) { continue; }
                colour[child] = GREY;
                stack.push({ id: child, next: 0 });
            }
        }

        const forward = real.filter(edge => !back.has(edge.from + '\u0000' + edge.to));
        const layer = Object.create(null);
        for (const node of nodes) { layer[node.id] = 0; }
        // Longest path over a DAG, relaxed to a fixed point. Bounded by the node
        // count because that is the longest a simple path can be — and here the
        // bound is a proof rather than a hope.
        for (let pass = 0; pass < nodes.length; pass++) {
            let moved = false;
            for (const edge of forward) {
                if (layer[edge.to] <= layer[edge.from]) { layer[edge.to] = layer[edge.from] + 1; moved = true; }
            }
            if (!moved) { break; }
        }
        return layer;
    }

    function initDiagram(target, setup, options) {
        const boxes = [];
        let selected;

        /*
         * LAYOUT CONSTANTS, and why they are constants rather than fractions of
         * the canvas.
         *
         * The first version divided the available height by the number of layers,
         * which is the intuitive thing and produces a diagram that gets less
         * legible the more it has to say: five layers in 300px gives each box
         * 20px of room. A diagram's boxes are text, text has a size, so the
         * PITCH is fixed and the CANVAS is what gives way — see setHeight in
         * mountCanvas.
         */
        const BOX_HEIGHT = 40;
        const LANE_GAP = 36;
        const CROSS_GAP = 16;
        const EDGE_PAD = 14;

        const mount = mountCanvas(target, function (context) {
            const ctx = context.ctx;
            const config = invoke(setup, { state: publicState, ui: publicUi, width: context.width, height: context.height }, [context.width, context.height]) || {};
            const nodes = (config.nodes || []).filter(node => node && node.id !== undefined);
            const edges = (config.edges || []).filter(Boolean);
            if (!nodes.length) {
                report('viz-error', 'initDiagram received no nodes', {});
                return;
            }
            const across = String(config.direction || 'down') === 'right';
            const layer = layerNodes(nodes, edges);
            const rows = [];
            for (const node of nodes) {
                const at = layer[node.id] || 0;
                (rows[at] = rows[at] || []).push(node);
            }
            for (let i = 0; i < rows.length; i++) { rows[i] = rows[i] || []; }

            ctx.font = '12px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
            const widthOf = node => Math.min(210, Math.max(80, ctx.measureText(String(node.label || node.id)).width + 26));
            const widest = Math.max.apply(null, rows.map(row => row.reduce((sum, n) => sum + widthOf(n), 0) + CROSS_GAP * Math.max(0, row.length - 1)));
            const deepest = Math.max.apply(null, rows.map(row => row.length));

            // Ask for the height the layout needs, and stop if the canvas moved:
            // the redraw that call triggers is the one that should paint.
            const needed = across
                ? deepest * BOX_HEIGHT + (deepest - 1) * CROSS_GAP + EDGE_PAD * 2
                : rows.length * BOX_HEIGHT + (rows.length - 1) * LANE_GAP + EDGE_PAD * 2;
            if (context.setHeight(needed)) { return; }

            boxes.length = 0;
            const lanePitch = across
                ? Math.max(110, (context.width - EDGE_PAD * 2) / Math.max(1, rows.length))
                : BOX_HEIGHT + LANE_GAP;

            rows.forEach((row, laneIndex) => {
                const widths = row.map(widthOf);
                if (across) {
                    const total = row.length * BOX_HEIGHT + CROSS_GAP * (row.length - 1);
                    let cursor = (context.height - total) / 2;
                    const laneAt = EDGE_PAD + laneIndex * lanePitch;
                    row.forEach((node, i) => {
                        boxes.push({ x: laneAt, y: cursor, w: Math.min(widths[i], lanePitch - CROSS_GAP), h: BOX_HEIGHT, node: node });
                        cursor += BOX_HEIGHT + CROSS_GAP;
                    });
                } else {
                    const total = widths.reduce((sum, w) => sum + w, 0) + CROSS_GAP * (row.length - 1);
                    let cursor = Math.max(EDGE_PAD, (context.width - total) / 2);
                    const laneAt = EDGE_PAD + laneIndex * lanePitch;
                    row.forEach((node, i) => {
                        boxes.push({ x: cursor, y: laneAt, w: widths[i], h: BOX_HEIGHT, node: node });
                        cursor += widths[i] + CROSS_GAP;
                    });
                }
            });

            const centre = box => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
            const find = id => boxes.find(box => box.node.id === id);

            // Edges first, so a box always sits on top of the line reaching it.
            ctx.save();
            for (const edge of edges) {
                const from = find(edge.from);
                const to = find(edge.to);
                if (!from || !to) {
                    report('viz-error', 'Edge names a node that does not exist', { edge: edge.from + '->' + edge.to });
                    continue;
                }
                const a = centre(from);
                const b = centre(to);
                // A back edge — a retry, a loop, a fallback — goes the wrong way
                // against the flow, so it is drawn bowed out to the side and
                // dashed. Straight, it would run back down the middle through
                // every box it passes.
                const back = (layer[edge.to] || 0) <= (layer[edge.from] || 0);
                ctx.strokeStyle = getColor(edge.color || (back ? '--studio-muted' : '--axis'));
                ctx.lineWidth = 1.3;
                ctx.setLineDash(edge.dashed || back ? [4, 4] : []);
                const start = edgePoint(from, a, b);
                const end = edgePoint(to, b, a);
                let control;
                ctx.beginPath();
                ctx.moveTo(start.x, start.y);
                if (back) {
                    /*
                     * Always the same side — right in a downward diagram, below in
                     * a rightward one. Choosing it from which half of the canvas
                     * the edge is in reads as adaptive and is not: the two ends of
                     * a back edge are usually in the SAME column, so the
                     * comparison decides on a rounding error, and the retry edge
                     * ended up drawn over the forward edge it is meant to be
                     * distinguished from.
                     */
                    const span = across ? Math.abs(end.y - start.y) : Math.abs(end.x - start.x);
                    const bow = Math.max(64, span * 0.6);
                    control = across
                        ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 + bow }
                        : { x: (start.x + end.x) / 2 + bow, y: (start.y + end.y) / 2 };
                    ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
                } else {
                    ctx.lineTo(end.x, end.y);
                }
                ctx.stroke();
                ctx.setLineDash([]);
                // The head points along the last segment, which for a bowed edge
                // is the tangent at the end and not the chord — otherwise the
                // arrow on a retry edge points into the box's corner.
                const tail = control || start;
                const angle = Math.atan2(end.y - tail.y, end.x - tail.x);
                ctx.fillStyle = ctx.strokeStyle;
                ctx.beginPath();
                ctx.moveTo(end.x, end.y);
                ctx.lineTo(end.x - Math.cos(angle - 0.4) * 8, end.y - Math.sin(angle - 0.4) * 8);
                ctx.lineTo(end.x - Math.cos(angle + 0.4) * 8, end.y - Math.sin(angle + 0.4) * 8);
                ctx.closePath();
                ctx.fill();
                if (edge.label) {
                    const at = control
                        ? { x: (start.x + end.x) / 4 + control.x / 2, y: (start.y + end.y) / 4 + control.y / 2 }
                        : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
                    ctx.font = '10px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
                    const width = ctx.measureText(String(edge.label)).width + 8;
                    ctx.fillStyle = getColor('--studio-bg');
                    roundRect(ctx, at.x - width / 2, at.y - 8, width, 16, 4);
                    ctx.fill();
                    ctx.fillStyle = getColor('--studio-muted');
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(String(edge.label), at.x, at.y);
                }
            }
            ctx.restore();

            for (const box of boxes) {
                const node = box.node;
                const accent = node.group === 'accent' || node.accent;
                const on = selected === node.id;
                ctx.fillStyle = accent ? transparent('--chart-1', 0.1) : getColor('--studio-surface-raised');
                ctx.strokeStyle = on ? getColor('--chart-1') : getColor(accent ? '--chart-1' : '--studio-line');
                ctx.lineWidth = on ? 2 : 1;
                roundRect(ctx, box.x, box.y, box.w, box.h, 8);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = getColor(accent ? '--chart-1' : '--studio-text');
                ctx.font = '12px ' + (tokens['--fig-font'] || 'Inter, system-ui, sans-serif');
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(clipText(ctx, String(node.label || node.id), box.w - 16), box.x + box.w / 2, box.y + box.h / 2);
            }
            /*
             * Said once, in the figure itself, when there is something to say.
             * A diagram whose nodes carry notes is a click-to-explain diagram and
             * there is nothing on screen that says so.
             */
            if (!selected && nodes.some(node => node.note)) {
                setInspector({ text: 'Select a step to read what it does.' });
            }
        }, Object.assign({ height: 260 }, options), 'screen');

        if (mount) {
            mount.canvas.classList.add('clickable');
            mount.canvas.addEventListener('click', event => {
                const rect = mount.canvas.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const y = event.clientY - rect.top;
                const found = boxes.find(box => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h);
                selected = found ? found.node.id : undefined;
                publicState.diagramClick = selected;
                if (found) {
                    setInspector({ title: String(found.node.label || found.node.id), text: found.node.note || '' });
                } else {
                    setInspector({});
                }
                mount.redraw();
            });
        }
        return mount;
    }

    function edgePoint(box, from, to) {
        // Where a straight line from `from` to `to` leaves `box`. Slab method,
        // so the arrow lands on the border rather than under the label.
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        if (!dx && !dy) { return from; }
        const scaleX = dx ? (box.w / 2 + 3) / Math.abs(dx) : Infinity;
        const scaleY = dy ? (box.h / 2 + 3) / Math.abs(dy) : Infinity;
        const t = Math.min(scaleX, scaleY);
        return { x: from.x + dx * t, y: from.y + dy * t };
    }

    function clipText(ctx, text, width) {
        if (ctx.measureText(text).width <= width) { return text; }
        let out = text;
        while (out.length > 1 && ctx.measureText(out + '…').width > width) { out = out.slice(0, -1); }
        return out + '…';
    }

    /* ======================================================================
     * The three DOM engines.
     *
     * Numbers, tables and Mermaid are text. Drawing text on a canvas would cost
     * selection, copying and the browser's own line breaking to gain nothing —
     * so these render real elements, styled by the frame's frozen stylesheet.
     * ====================================================================== */

    function initStats(target, setup) {
        const host = pane(target);
        const grid = element('div', 'fig-stats', host);
        const render = () => {
            const list = invoke(guard('initStats', setup), { state: publicState, ui: publicUi }, [publicState]) || [];
            grid.textContent = '';
            for (const item of (Array.isArray(list) ? list : [list])) {
                if (!item) { continue; }
                const tile = element('div', 'fig-stat', grid);
                element('div', 'fig-stat-label', tile).textContent = String(item.label || '');
                const value = element('div', 'fig-stat-value', tile);
                value.textContent = String(item.value === undefined ? '—' : item.value);
                if (item.color) { value.style.color = getColor(item.color); }
                if (item.delta !== undefined && item.delta !== null && item.delta !== '') {
                    const delta = element('div', 'fig-stat-delta', tile);
                    const numeric = Number(item.delta);
                    const up = isFinite(numeric) ? numeric >= 0 : !/^-/.test(String(item.delta));
                    delta.textContent = (isFinite(numeric) ? (up ? '▲ ' : '▼ ') : '') + String(item.delta);
                    delta.style.color = getColor(up ? '--positive' : '--negative');
                }
                if (item.note) { element('div', 'fig-stat-note', tile).textContent = String(item.note); }
            }
            measure();
        };
        render();
        repaints.push(render);
        return thenable({ el: grid, redraw: render });
    }

    function initTable(target, setup) {
        const host = pane(target);
        const wrap = element('div', 'fig-table-wrap', host);
        const render = () => {
            const config = invoke(guard('initTable', setup), { state: publicState, ui: publicUi }, [publicState]) || {};
            const rows = config.rows || (Array.isArray(config) ? config : []);
            let columns = config.columns;
            if (!columns || !columns.length) {
                const sample = rows.find(row => row && typeof row === 'object' && !Array.isArray(row));
                columns = sample ? Object.keys(sample) : [];
            }
            const specs = columns.map(column => (typeof column === 'string'
                ? { key: column, label: column }
                : { key: column.key || column.label, label: column.label || column.key, align: column.align, format: column.format }));
            wrap.textContent = '';
            const table = element('table', 'fig-table', wrap);
            const head = element('tr', '', element('thead', '', table));
            for (const spec of specs) {
                const cell = element('th', '', head);
                cell.textContent = String(spec.label);
                if (spec.align) { cell.style.textAlign = spec.align; }
            }
            const body = element('tbody', '', table);
            for (const row of rows) {
                const tr = element('tr', '', body);
                specs.forEach((spec, index) => {
                    const cell = element('td', '', tr);
                    const value = Array.isArray(row) ? row[index] : row[spec.key];
                    cell.textContent = typeof spec.format === 'function'
                        ? String(spec.format(value, row))
                        : (typeof value === 'number' ? format(value) : String(value === undefined ? '' : value));
                    if (spec.align) { cell.style.textAlign = spec.align; }
                    else if (typeof value === 'number') { cell.style.textAlign = 'right'; }
                });
            }
            measure();
        };
        render();
        repaints.push(render);
        return thenable({ el: wrap, redraw: render });
    }

    /*
     * Mermaid, rendered by the HOST and posted back.
     *
     * The frame has no network and carries no library, so it cannot render
     * Mermaid itself — and it does not need to: the product already loads Mermaid
     * for fenced diagrams in the same document (mermaid-view.js), so a figure
     * asking for one reuses a script that is very likely already parsed. The
     * source goes out, the SVG comes back, and the frame stays 40 KB.
     */
    const mermaidPending = Object.create(null);
    let mermaidSeq = 0;

    function initMermaid(target, source) {
        const host = pane(target);
        const holder = element('div', 'fig-mermaid', host);
        const render = () => {
            const text = typeof source === 'function'
                ? invoke(guard('initMermaid', source), { state: publicState, ui: publicUi }, [publicState])
                : source;
            if (!text) { return; }
            const id = 'm' + (++mermaidSeq);
            mermaidPending[id] = holder;
            post('mermaid', { id: id, code: String(text) });
        };
        render();
        repaints.push(render);
        return thenable({ el: holder, redraw: render });
    }

    /* ======================================================================
     * Tolerance layers 1, 2 and 5.
     * ====================================================================== */

    /*
     * Layer 5: everything an engine returns is thenable.
     *
     * `await Studio.initCanvas(…)` is a reasonable-looking thing to write and
     * there is no reason it should hang. `then` resolves immediately with the
     * object itself, so both `await` and `.then(m => …)` do what they look like.
     */
    function thenable(value) {
        const object = value || {};
        /*
         * `plain` is not tidiness, it is the whole trick.
         *
         * A thenable whose `then` resolves with ITSELF hangs: the language
         * assimilates a thenable resolution value by calling its `then` again,
         * forever. So `await` on a naive self-resolving object never returns —
         * which is precisely the failure this layer exists to prevent, arrived at
         * from the other direction. Resolving with a copy taken BEFORE `then` was
         * attached breaks the cycle and still hands the caller everything the
         * engine returned. Found by the test that awaits an engine; it hung.
         */
        const plain = Object.assign({}, object);
        object.then = function (onResolved) {
            try { return Promise.resolve(typeof onResolved === 'function' ? onResolved(plain) : plain); }
            catch (error) { fail('then', error); return Promise.resolve(plain); }
        };
        object.catch = function () { return Promise.resolve(plain); };
        object.finally = function (fn) { if (typeof fn === 'function') { fn(); } return Promise.resolve(plain); };
        return object;
    }

    /*
     * Layer 1: an unknown property is a no-op, not a crash.
     *
     * A figure calling `ui.renderTooltip()` should lose its tooltip, not its
     * frame. The exclusions matter as much as the rule: `then`, `catch` and the
     * well-known symbols must stay UNDEFINED, because a `then` that returns a
     * no-op function makes the object a broken thenable — `await` on it would
     * call it and wait forever for a resolve that never comes. That is a hang
     * rather than a degradation, which is the one outcome this layer exists to
     * prevent.
     */
    const PASS_THROUGH = ['then', 'catch', 'finally', 'toJSON', 'constructor', 'prototype'];

    function tolerant(name, target, fallbacks) {
        return new Proxy(target, {
            get(object, prop) {
                if (prop in object) { return object[prop]; }
                if (typeof prop !== 'string') { return undefined; }
                if (PASS_THROUGH.indexOf(prop) !== -1) { return undefined; }
                if (fallbacks && Object.prototype.hasOwnProperty.call(fallbacks, prop)) {
                    report('hallucination', name + '.' + prop + ' is not real; used a fallback', { property: prop, object: name });
                    return fallbacks[prop];
                }
                report('hallucination', 'Called ' + name + '.' + prop + ', which does not exist', { property: prop, object: name });
                return function () { return null; };
            },
            set(object, prop, value) { object[prop] = value; return true; },
            has() { return true; }
        });
    }

    /*
     * A 2D context that draws nothing, for the geometry seam above. Everything
     * `scaleTo` and the extras touch either mutates `frame` or goes through one
     * of these, so a stub is enough to exercise the arithmetic.
     */
    const STUB_CONTEXT = {
        save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
        quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, stroke() {}, fill() {},
        fillText() {}, setLineDash() {}, translate() {}, rotate() {}, setTransform() {},
        clearRect() {}, measureText() { return { width: 20 }; }
    };

    /* ======================================================================
     * `Studio` — the surface a figure is written against.
     * ====================================================================== */

    /*
     * Every engine is `(target?, setup, options?)`.
     *
     * The optional FIRST argument is unusual and it is the right way round here:
     * a single-panel figure — which is most of them — writes
     * `Studio.initPlot(cb)` and never learns that panels have names, while a
     * multi-panel one writes `Studio.initPlot('bands', cb)`. Reading the shape
     * of the arguments rather than requiring a placeholder is the same idea as
     * inferring a control from its value.
     */
    function engineArgs(args) {
        const list = Array.prototype.slice.call(args);
        if (typeof list[0] === 'function' || (list.length === 1 && typeof list[0] === 'string')) {
            return { target: undefined, setup: list[0], options: list[1] };
        }
        return { target: list[0], setup: list[1], options: list[2] };
    }

    let publicState = createState({}, () => scheduleRepaint());

    const uiApi = {
        setTitle: setTitle,
        setCaption: setCaption,
        setHUD: setHUD,
        setEditorial: setHUD,
        setMetrics: setHUD,
        setLegend: setLegend,
        setInspector: setInspector,
        setDetails: setInspector,
        buildStack: buildStack,
        splitViz: splitViz,
        splitHorizontal: splitHorizontal,
        createContainer: createContainer,
        pane: pane
    };
    const publicUi = tolerant('ui', uiApi, {});
    // `ui.ui` returning `ui` is not an accident: a figure that has written
    // `const { ui } = Studio.createApp(...)` and then `ui.ui.setHUD(...)` is
    // making a mistake with an obvious intended meaning, and honouring it costs
    // one line.
    uiApi.ui = publicUi;

    const studioApi = {
        createApp: createApp,
        state: undefined,
        ui: publicUi,
        plot: plot,
        getColor: getColor,
        token: getColor,
        transparent: transparent,
        scale: scale,
        createScale: scale,
        lerp: lerp,
        clamp: clamp,
        map: map,
        random: random,
        noise2D: noise2D,
        noise3D: noise3D,
        format: format,
        niceTicks: niceTicks,
        theme: () => theme,
        initCanvas: function () { const a = engineArgs(arguments); return thenable(mountCanvas(a.target, a.setup, a.options, 'screen') || {}); },
        initCartesianCanvas: function () { const a = engineArgs(arguments); return thenable(mountCanvas(a.target, a.setup, a.options, 'world') || {}); },
        initPlot: function () { const a = engineArgs(arguments); return thenable(initPlot(a.target, a.setup, a.options) || {}); },
        initDiagram: function () { const a = engineArgs(arguments); return thenable(initDiagram(a.target, a.setup, a.options) || {}); },
        initStats: function () { const a = engineArgs(arguments); return initStats(a.target, a.setup); },
        initTable: function () { const a = engineArgs(arguments); return initTable(a.target, a.setup); },
        initMermaid: function () { const a = engineArgs(arguments); return initMermaid(a.target, a.setup); }
    };

    /*
     * Layer 2, the general case: names figures reach for, mapped to the engine
     * that answers the same question. Each one reports itself, so this list is
     * evidence rather than guesswork — an entry earns its place by being written
     * by a figure that then rendered nothing.
     */
    const STUDIO_FALLBACKS = {
        initChart: studioApi.initPlot,
        initLineChart: studioApi.initPlot,
        initBarChart: studioApi.initPlot,
        initGraph: studioApi.initDiagram,
        initFlow: studioApi.initDiagram,
        initFlowchart: studioApi.initDiagram,
        initNetwork: studioApi.initDiagram,
        initD3: studioApi.initCanvas,
        initSvg: studioApi.initCanvas,
        initPhysics: studioApi.initCanvas,
        initThree: studioApi.initCanvas,
        initSimulation: studioApi.initCanvas,
        initKPI: studioApi.initStats,
        initMetrics: studioApi.initStats,
        initGrid: studioApi.initTable,
        getToken: getColor,
        colour: getColor,
        getColour: getColor,
        addBadge: function () { return null; }
    };

    const publicStudio = tolerant('Studio', studioApi, STUDIO_FALLBACKS);

    /**
     * The one call every figure starts with.
     *
     * Any top-level key that is not one this understands is folded into the
     * initial state rather than ignored — a figure writing
     * `createApp({ params: …, gravity: 9.81 })` meant `state.gravity`, and there
     * is no other reading of it.
     */
    function createApp(options) {
        const opts = options || {};
        const params = opts.params || opts.inputs || opts.controls || {};
        const seed = {};
        for (const key of Object.keys(params)) {
            const spec = params[key];
            const isSpec = spec && typeof spec === 'object' && !Array.isArray(spec);
            if (isSpec && inferControl(spec) === 'button') { continue; }
            if (isSpec && inferControl(spec) === 'header') { continue; }
            seed[key] = isSpec
                ? (spec.value !== undefined ? spec.value : (Array.isArray(spec.options) ? spec.options[0] : undefined))
                : spec;
        }
        const KNOWN = ['title', 'params', 'inputs', 'controls', 'editorial', 'caption', 'height', 'state', 'hud', 'legend'];
        for (const key of Object.keys(opts)) {
            if (KNOWN.indexOf(key) === -1) { seed[key] = opts[key]; }
        }
        if (opts.state && typeof opts.state === 'object') { Object.assign(seed, opts.state); }

        publicState = createState(seed, () => scheduleRepaint());
        studioApi.state = publicState;

        if (opts.title) { setTitle(opts.title); }
        if (opts.height) { pane().style.minHeight = Math.round(Number(opts.height)) + 'px'; }
        buildControls(params, publicState);
        if (opts.editorial || opts.hud) { setHUD(opts.editorial || opts.hud); }
        if (opts.legend) { setLegend(opts.legend); }
        if (opts.caption) { setCaption(opts.caption); }

        return { state: publicState, ui: publicUi, Studio: publicStudio };
    }

    /* ======================================================================
     * The host channel, inbound.
     * ====================================================================== */

    function applyTokens(next, nextTheme) {
        tokens = Object.assign({}, next);
        theme = nextTheme === 'dark' ? 'dark' : 'light';
        for (const key of Object.keys(colorCache)) { delete colorCache[key]; }
        for (const name of Object.keys(tokens)) {
            try { doc.documentElement.style.setProperty(name, tokens[name]); } catch (e) { /* ignore */ }
        }
        doc.documentElement.setAttribute('data-theme', theme);
        // Re-run every engine: a chart's colours are baked into pixels, so a
        // theme switch is a redraw rather than a restyle. The DOM engines are in
        // `repaints` too, which is why the legend and the stat tiles change with
        // them instead of a frame later.
        scheduleRepaint();
    }

    applyTokens(tokens, theme);

    global.addEventListener('message', event => {
        const data = event && event.data;
        if (!data || data.channel !== CHANNEL) { return; }
        if (data.type === 'tokens') { applyTokens(data.tokens || {}, data.theme); return; }
        if (data.type === 'mermaid-svg') {
            const holder = mermaidPending[data.id];
            if (holder) { holder.innerHTML = data.svg; delete mermaidPending[data.id]; measure(); }
            return;
        }
        if (data.type === 'mermaid-error') {
            const holder = mermaidPending[data.id];
            if (holder) {
                holder.textContent = 'This diagram could not be rendered.';
                holder.className = 'fig-mermaid failed';
                delete mermaidPending[data.id];
                measure();
            }
            return;
        }
        if (data.type === 'redraw') { scheduleRepaint(); return; }
        // The host asking "how tall are you really?" — see measure(force).
        if (data.type === 'measure') { scheduleRepaint(); measure(true); }
    });

    /*
     * A syntax error in the generated script never reaches `guard` — the script
     * fails to parse, so no callback of ours is ever called. `onerror` is the
     * only place that failure is observable, and reporting it is the difference
     * between "this figure could not be built, here is the line" and an empty
     * rectangle.
     */
    global.addEventListener('error', event => {
        fail('script', (event && event.error) || new Error((event && event.message) || 'Script error'));
    });
    global.addEventListener('unhandledrejection', event => {
        fail('promise', (event && event.reason) || new Error('Unhandled rejection'));
    });

    if (global.ResizeObserver) {
        new global.ResizeObserver(() => measure()).observe(doc.body);
    }

    global.Studio = publicStudio;
    // One alias, for the same reason the fallback table exists: a figure that
    // has seen a shorter name written somewhere still runs.
    global.SF = publicStudio;
    // `Plot.lineY(…)` gets written without `Studio.` in front of it often enough
    // to be worth two characters here.
    global.Plot = plot;

    post('ready', {});
    measure();

    return {
        Studio: publicStudio,
        state: () => publicState,
        ui: publicUi,
        internals: {
            inferControl: inferControl,
            /*
             * Two test seams, and both earned their place: the bugs that lived
             * behind them (an x domain forced to include zero, axes scaled
             * independently) are invisible in every figure whose x starts at zero
             * and whose panel happens to be square — which is every figure in
             * STARTERS. Reaching them needs a call, not a canvas.
             */
            plotGeometry: plotGeometry,
            contextExtras: frame => buildContextExtras(STUB_CONTEXT, frame, { x: 0, y: 0, wx: 0, wy: 0, down: false, inside: false }),
            getColor: getColor,
            resolveToken: resolveToken,
            createState: createState,
            niceTicks: niceTicks,
            format: format,
            buttonGlyph: buttonGlyph,
            layerNodes: layerNodes,
            telemetry: telemetry,
            applyTokens: applyTokens,
            root: root,
            distance: distance
        }
    };
}

/*
 * The runtime as text, for inlining into the frame.
 *
 * The IIFE wrapper and the `window` argument are the whole contract: the frame's
 * document contains this string inside a <script>, and nothing else of ours.
 */
const FIGURE_RUNTIME_SOURCE = '(' + figureRuntime.toString() + ')(window);';

/*
 * The invariant, checked at load rather than trusted.
 *
 * `figureRuntime` must take exactly one argument and reference nothing outside
 * itself. Arity is the cheap half and it is checked here, because a second
 * parameter added in a refactor would make the inlined call pass `undefined` for
 * it and fail somewhere unrelated. The expensive half — no free identifiers — is
 * checked by figure-test.mjs, which evaluates this source in an empty jsdom
 * window and drives it.
 */
if (figureRuntime.length !== 1) {
    throw new Error('figureRuntime must take exactly one argument (the frame window)');
}

module.exports = { figureRuntime, FIGURE_RUNTIME_SOURCE };
