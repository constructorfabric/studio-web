/*
 * Three symmetric-delimiter inline marks with no existing remark plugin:
 * `~x~` subscript, `^x^` superscript, `++x++` insert (see CONTRACT.md's
 * dialect table). `==x==` highlight, the fourth one CONTRACT.md lists, is
 * NOT here — it reuses mdast-util-highlight-mark / micromark-extension-
 * highlight-mark (re-exported below), an existing, tested implementation of
 * that exact syntax; writing a second one would only be to avoid depending
 * on it, which is not a reason.
 *
 * These three, by contrast, have no package on the registry (searched:
 * micromark-extension-subscript, mdast-util-gfm-superscript — neither
 * exists), so this is a hand-written micromark extension, not a pre-parse
 * text rewrite. The reason is CORRECTNESS, not preference: a delimiter run
 * has to be told apart from a code span (`` `~x~` `` must not be touched), an
 * autolink, an escaped character, and — critically for `~` — GFM
 * strikethrough's own delimiter, all of which only the tokenizer pipeline
 * itself is guaranteed to already know about. A regex pre-pass over raw text
 * cannot see any of that.
 *
 * Structurally this is `micromark-extension-highlight-mark`'s own
 * `tokenizeHighlight`/`resolveAllHighlight` (read directly from
 * node_modules to build this), generalised over the delimiter character and
 * run length instead of hard-coding `=` and 2. Three instantiations below
 * cover `~x~` (tilde, length 1 — length 2 is already GFM strikethrough, see
 * md-parse.js's `singleTilde: false` option, which frees length 1 for this),
 * `^x^` (caret, length 1) and `++x++` (plus, length 2).
 */
import { ok as assert } from 'uvu/assert';
import { splice } from 'micromark-util-chunked';
import { classifyCharacter } from 'micromark-util-classify-character';
import { resolveAll } from 'micromark-util-resolve-all';
import { codes, constants, types } from 'micromark-util-symbol';
import { highlightMark, highlightMarkHtml } from 'micromark-extension-highlight-mark';
import { highlightMarkFromMarkdown, highlightMarkToMarkdown } from 'mdast-util-highlight-mark';

/**
 * Builds a micromark + mdast-util (from- and to-markdown) extension trio for
 * an mdast container type wrapped by a run of `size` copies of one
 * character, symmetric open and close (`~x~`, `^x^`, `++x++`).
 */
function makeDelimiterMark({ code, char, size, mdastType }) {
    const SEQ = mdastType + 'Sequence';
    const SEQ_TMP = SEQ + 'Temporary';
    const TEXT = mdastType + 'Text';

    function tokenize(effects, ok, nok) {
        const previous = this.previous;
        const events = this.events;
        let count = 0;
        return start;
        function start(c) {
            assert(c === code, 'expected the delimiter character');
            if (previous === code && events[events.length - 1][1].type !== types.characterEscape) {
                return nok(c);
            }
            effects.enter(SEQ_TMP);
            return more(c);
        }
        function more(c) {
            const before = classifyCharacter(previous);
            if (c === code) {
                if (count >= size) { return nok(c); }
                effects.consume(c);
                count++;
                return more;
            }
            if (count < size) { return nok(c); }
            const token = effects.exit(SEQ_TMP);
            const after = classifyCharacter(c);
            token._open = !after || (after === constants.attentionSideAfter && Boolean(before));
            token._close = !before || (before === constants.attentionSideAfter && Boolean(after));
            return ok(c);
        }
    }

    function resolveAllDelimiter(events, context) {
        let index = -1;
        while (++index < events.length) {
            if (events[index][0] !== 'enter' || events[index][1].type !== SEQ_TMP || !events[index][1]._close) { continue; }
            let open = index;
            while (open--) {
                if (events[open][0] !== 'exit' || events[open][1].type !== SEQ_TMP || !events[open][1]._open) { continue; }
                if (events[index][1].end.offset - events[index][1].start.offset !==
                    events[open][1].end.offset - events[open][1].start.offset) { continue; }
                events[index][1].type = SEQ;
                events[open][1].type = SEQ;
                const wrapper = { type: mdastType, start: Object.assign({}, events[open][1].start), end: Object.assign({}, events[index][1].end) };
                const text = { type: TEXT, start: Object.assign({}, events[open][1].end), end: Object.assign({}, events[index][1].start) };
                const nextEvents = [['enter', wrapper, context], ['enter', events[open][1], context], ['exit', events[open][1], context], ['enter', text, context]];
                const insideSpan = context.parser.constructs.insideSpan.null;
                if (insideSpan) { splice(nextEvents, nextEvents.length, 0, resolveAll(insideSpan, events.slice(open + 1, index), context)); }
                splice(nextEvents, nextEvents.length, 0, [['exit', text, context], ['enter', events[index][1], context], ['exit', events[index][1], context], ['exit', wrapper, context]]);
                splice(events, open - 1, index - open + 3, nextEvents);
                index = open + nextEvents.length - 2;
                break;
            }
        }
        index = -1;
        while (++index < events.length) {
            if (events[index][1].type === SEQ_TMP) { events[index][1].type = types.data; }
        }
        return events;
    }

    const tokenizer = { name: mdastType, tokenize, resolveAll: resolveAllDelimiter };
    const micromark = () => ({
        text: { [code]: tokenizer },
        insideSpan: { null: [tokenizer] },
        attentionMarkers: { null: [code] }
    });

    const marker = char.repeat(size);
    const fromMarkdown = {
        canContainEols: [mdastType],
        enter: { [mdastType]: function (token) { this.enter({ type: mdastType, children: [] }, token); } },
        exit: { [mdastType]: function (token) { this.exit(token); } }
    };
    function handle(node, _parent, state, info) {
        const tracker = state.createTracker(info);
        const exit = state.enter(mdastType);
        let value = tracker.move(marker);
        value += tracker.move(state.containerPhrasing(node, { before: value, after: marker, ...tracker.current() }));
        value += tracker.move(marker);
        exit();
        return value;
    }
    handle.peek = () => char;
    const toMarkdown = {
        unsafe: [{ character: char, inConstruct: 'phrasing' }],
        handlers: { [mdastType]: handle }
    };

    return { micromark, fromMarkdown, toMarkdown };
}

const subscript = makeDelimiterMark({ code: codes.tilde, char: '~', size: 1, mdastType: 'subscript' });
const superscript = makeDelimiterMark({ code: codes.caret, char: '^', size: 1, mdastType: 'superscript' });
const insert = makeDelimiterMark({ code: codes.plusSign, char: '+', size: 2, mdastType: 'insert' });

// Same {micromark, fromMarkdown, toMarkdown} shape as the three above, so
// md-parse.js and md-serialize.js can wire all four through one loop instead
// of special-casing highlight's package-supplied names.
const highlight = { micromark: highlightMark, fromMarkdown: highlightMarkFromMarkdown, toMarkdown: highlightMarkToMarkdown };

export { subscript, superscript, insert, highlight };
