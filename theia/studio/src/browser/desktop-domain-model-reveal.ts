// A passage brought into view in a RENDERED document.
//
// In Doc editing a Markdown file opens in the product's editor
// (product-ext), a ProseMirror document whose open handler takes the file
// only: the `selection` an opener passes is dropped, and the document has no
// line to reveal anyway (product-ext's search-view.js names the same gap).
// What it does have is the text as rendered, which is closer to a model's
// quote than the source is -- the extractor quotes prose, not Markdown. So the
// quote is looked for in the widget's own text, with runs of whitespace
// folded, scrolled to and selected. The DOM only: nothing of product-ext's is
// called, and a widget without the text is left as it opened.

/** A text node and an offset in it. */
interface Point {
    readonly node: Text;
    readonly offset: number;
}

/**
 * The range of `quote` in the text under `root`, whitespace folded on both
 * sides; `undefined` when the text does not hold it.
 */
export function findQuote(root: HTMLElement, quote: string): Range | undefined {
    const wanted = quote.replace(/\s+/g, ' ').trim();
    if (!wanted) {
        return undefined;
    }
    let folded = '';
    const points: Point[] = [];
    let inSpace = true;
    let block: Element | null | undefined;
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        // A new block (paragraph, item, cell) is a new word: the next
        // paragraph's first word must not run into this one's last. Inline
        // marks are not: `**order**s` is still one word.
        const own = blockOf(node, root);
        if (block !== undefined && own !== block && !inSpace) {
            folded += ' ';
            points.push({ node, offset: 0 });
            inSpace = true;
        }
        block = own;
        const text = node.data;
        for (let i = 0; i < text.length; i++) {
            if (/\s/.test(text[i])) {
                if (!inSpace) {
                    folded += ' ';
                    points.push({ node, offset: i });
                    inSpace = true;
                }
            } else {
                folded += text[i];
                points.push({ node, offset: i });
                inSpace = false;
            }
        }
    }
    const at = folded.indexOf(wanted);
    if (at < 0) {
        return undefined;
    }
    const start = points[at];
    const last = points[at + wanted.length - 1];
    const range = root.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(last.node, Math.min(last.offset + 1, last.node.data.length));
    return range;
}

const BLOCKS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'PRE', 'BLOCKQUOTE', 'DIV', 'DT', 'DD']);

/** The nearest block element holding `node`, below `root`. */
function blockOf(node: Node, root: HTMLElement): Element | null {
    for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        if (BLOCKS.has(el.tagName)) {
            return el;
        }
    }
    return null;
}

/** Scroll the quote into view and select it; whether it was there. */
export function revealQuote(root: HTMLElement, quote: string): boolean {
    const range = findQuote(root, quote);
    if (!range) {
        return false;
    }
    const element = range.startContainer.parentElement;
    if (element && typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center' });
    }
    const selection = root.ownerDocument.getSelection();
    if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
    }
    return true;
}

/**
 * `revealQuote`, retried while the document renders: an editor that has just
 * opened draws its text a moment later. Gives up after `tries`.
 */
export async function revealQuoteWhenRendered(root: HTMLElement, quote: string, tries = 20, waitMs = 100): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
        if (revealQuote(root, quote)) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    return false;
}
