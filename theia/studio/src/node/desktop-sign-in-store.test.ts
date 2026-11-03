/**
 * @jest-environment node
 */
import { RememberedSignIn, SIGN_IN_SERVICE, SecretStore, signInAccount } from './desktop-sign-in-store';

const ISSUER = 'https://sso.example.com/realms/studio/';

function memoryStore(): SecretStore & { readonly items: Map<string, string> } {
    const items = new Map<string, string>();
    return {
        items,
        getPassword: async (service, account) => items.get(`${service}|${account}`),
        setPassword: async (service, account, password) => { items.set(`${service}|${account}`, password); },
        deletePassword: async (service, account) => items.delete(`${service}|${account}`),
    };
}

function brokenStore(): SecretStore {
    const fail = async (): Promise<never> => { throw new Error('no keychain'); };
    return { getPassword: fail, setPassword: fail, deletePassword: fail };
}

describe('the sign-in kept across restarts', () => {
    it('is one per Studio: client at issuer, whatever the trailing slash', () => {
        expect(signInAccount(ISSUER, 'studio-desktop')).toBe('studio-desktop@https://sso.example.com/realms/studio');
        expect(signInAccount('https://sso.example.com/realms/studio', 'studio-desktop')).toBe(signInAccount(ISSUER, 'studio-desktop'));
    });

    it('keeps the refresh token, gives it back, and forgets it', async () => {
        const store = memoryStore();
        const kept = new RememberedSignIn(store);
        await kept.save(ISSUER, 'studio-desktop', { accessToken: 'a', refreshToken: 'r1', expiresAt: 0 });
        expect([...store.items.keys()]).toEqual([`${SIGN_IN_SERVICE}|studio-desktop@https://sso.example.com/realms/studio`]);
        expect([...store.items.values()]).toEqual(['r1']);
        await expect(kept.load(ISSUER, 'studio-desktop')).resolves.toBe('r1');
        await expect(kept.load('https://other.example.com/realms/studio', 'studio-desktop')).resolves.toBeUndefined();
        await kept.forget(ISSUER, 'studio-desktop');
        await expect(kept.load(ISSUER, 'studio-desktop')).resolves.toBeUndefined();
    });

    it('never keeps the access token, and forgets the old refresh token when a sign-in has none', async () => {
        const store = memoryStore();
        const kept = new RememberedSignIn(store);
        await kept.save(ISSUER, 'studio-desktop', { accessToken: 'a', refreshToken: 'r1', expiresAt: 0 });
        await kept.save(ISSUER, 'studio-desktop', { accessToken: 'a2', expiresAt: 0 });
        expect(store.items.size).toBe(0);
    });

    it('takes an empty kept value as nothing kept', async () => {
        const store = memoryStore();
        await store.setPassword(SIGN_IN_SERVICE, signInAccount(ISSUER, 'studio-desktop'), '  ');
        await expect(new RememberedSignIn(store).load(ISSUER, 'studio-desktop')).resolves.toBeUndefined();
    });

    it('costs only the convenience when the keychain cannot be used, saying so', async () => {
        const warnings: string[] = [];
        const kept = new RememberedSignIn(brokenStore(), m => warnings.push(m));
        await expect(kept.load(ISSUER, 'studio-desktop')).resolves.toBeUndefined();
        await expect(kept.save(ISSUER, 'studio-desktop', { accessToken: 'a', refreshToken: 'r', expiresAt: 0 })).resolves.toBeUndefined();
        await expect(kept.forget(ISSUER, 'studio-desktop')).resolves.toBeUndefined();
        expect(warnings).toHaveLength(3);
        expect(warnings[0]).toMatch(/no keychain/);
    });

    it('does nothing without a keychain at all (the web session)', async () => {
        const kept = new RememberedSignIn(undefined);
        await kept.save(ISSUER, 'studio-desktop', { accessToken: 'a', refreshToken: 'r', expiresAt: 0 });
        await expect(kept.load(ISSUER, 'studio-desktop')).resolves.toBeUndefined();
    });
});
