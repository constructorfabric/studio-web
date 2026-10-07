import { badgeText, RibbonBadges } from './ribbon-badges';

describe('ribbon badges', () => {
    it('reads nothing for none, the number up to 99, then 99+', () => {
        expect(badgeText(undefined)).toBeUndefined();
        expect(badgeText(0)).toBeUndefined();
        expect(badgeText(-1)).toBeUndefined();
        expect(badgeText(3)).toBe('3');
        expect(badgeText(99)).toBe('99');
        expect(badgeText(100)).toBe('99+');
    });

    it('keeps a count per command and says when one changed, not when it did not', () => {
        const badges = new RibbonBadges();
        let changes = 0;
        badges.onDidChange(() => changes++);
        badges.set('studio.share.open', 2);
        badges.set('studio.share.open', 2);
        expect(badges.get('studio.share.open')).toBe(2);
        expect(changes).toBe(1);
        badges.set('studio.share.open', 0);
        expect(badges.get('studio.share.open')).toBeUndefined();
        expect(changes).toBe(2);
        badges.set('other', 0);
        expect(changes).toBe(2);
    });
});
