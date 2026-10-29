import { avatarCss, avatarSource } from './desktop-account-avatar';

describe('the desktop account photo', () => {
    it('finds an uploaded photo on the Studio it was uploaded to, and takes an identity provider\'s as it is', () => {
        expect(avatarSource('/cf/studio-user/v1/avatars/u-1/abc', 'https://studio-dev.cfabric.org/'))
            .toBe('https://studio-dev.cfabric.org/cf/studio-user/v1/avatars/u-1/abc');
        expect(avatarSource('https://avatars.githubusercontent.com/u/1', undefined)).toBe('https://avatars.githubusercontent.com/u/1');
    });

    it('has none without a photo, without a Studio to find it on, or at an address it will not load', () => {
        expect(avatarSource(undefined, 'https://s')).toBeUndefined();
        expect(avatarSource('  ', 'https://s')).toBeUndefined();
        expect(avatarSource('/cf/x', undefined)).toBeUndefined();
        expect(avatarSource('http://plain.example/p.png', 'https://s')).toBeUndefined();
        expect(avatarSource('javascript:alert(1)', 'https://s')).toBeUndefined();
    });

    it('quotes the address, so it cannot close the rule', () => {
        expect(avatarCss('https://s/a") ; } body { x: y')).toContain('url("https://s/a\\") ; } body { x: y")');
    });
});
