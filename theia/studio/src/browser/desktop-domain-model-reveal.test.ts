import { findQuote, revealQuote, revealQuoteWhenRendered } from './desktop-domain-model-reveal';

function rendered(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
}

describe('a quote in a rendered document', () => {
    afterEach(() => { document.body.innerHTML = ''; });

    it('is found across inline marks, as the reader sees it', () => {
        const root = rendered('<h1>Orders</h1><p>An <strong>order</strong>s list has   one\n customer.</p>');
        expect(findQuote(root, 'An orders list has one customer.')?.toString()).toBe('An orders list has   one\n customer.');
    });

    it('does not run one paragraph\'s last word into the next one\'s first', () => {
        const root = rendered('<p>The end</p><p>Next start</p>');
        expect(findQuote(root, 'endNext')).toBeUndefined();
        expect(findQuote(root, 'end Next')?.toString()).toBe('endNext');
    });

    it('is not found when the text does not hold it, nor for an empty quote', () => {
        const root = rendered('<p>An order has one customer.</p>');
        expect(findQuote(root, 'An order has many customers.')).toBeUndefined();
        expect(findQuote(root, '   ')).toBeUndefined();
    });

    it('is scrolled to and selected', () => {
        const root = rendered('<p>Intro.</p><p>An order is paid once.</p>');
        const scrolled = jest.fn();
        (root.querySelectorAll('p')[1] as HTMLElement).scrollIntoView = scrolled;
        expect(revealQuote(root, 'paid once')).toBe(true);
        expect(scrolled).toHaveBeenCalledWith({ block: 'center' });
        expect(document.getSelection()?.toString()).toBe('paid once');
    });

    it('is waited for while the editor draws its text, and given up on', async () => {
        const root = rendered('');
        setTimeout(() => { root.innerHTML = '<p>Drawn late.</p>'; }, 30);
        await expect(revealQuoteWhenRendered(root, 'Drawn late.', 10, 10)).resolves.toBe(true);
        await expect(revealQuoteWhenRendered(root, 'Never drawn.', 3, 1)).resolves.toBe(false);
    });
});
