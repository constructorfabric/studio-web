// Constructor Studio desktop: the sign-in kept across restarts (ADR-0027 §2).
//
// Only the refresh token is kept, in the OS keychain (Theia's KeyStoreService,
// keytar underneath): the next start trades it for an access token without a
// browser. One per Studio -- issuer and client -- so switching Studios and
// back finds each its own. A keychain that cannot be used loses nothing but
// the convenience: the member signs in as before.

import type { DesktopTokens } from './desktop-sign-in';

/** The part of Theia's `KeyStoreService` this needs. */
export interface SecretStore {
    getPassword(service: string, account: string): Promise<string | undefined>;
    setPassword(service: string, account: string, password: string): Promise<void>;
    deletePassword(service: string, account: string): Promise<boolean>;
}

export const SIGN_IN_SERVICE = 'constructor-studio-desktop-sign-in';

/** Whose sign-in: one Studio's client at its identity provider. */
export function signInAccount(issuer: string, clientId: string): string {
    return `${clientId}@${issuer.replace(/\/+$/, '')}`;
}

export class RememberedSignIn {
    constructor(
        protected readonly store: SecretStore | undefined,
        protected readonly warn: (message: string) => void = message => console.warn(`[studio-desktop] ${message}`),
    ) { }

    /** The refresh token kept for this Studio, if any. */
    async load(issuer: string, clientId: string): Promise<string | undefined> {
        if (!this.store) {
            return undefined;
        }
        try {
            const token = await this.store.getPassword(SIGN_IN_SERVICE, signInAccount(issuer, clientId));
            return token && token.trim() !== '' ? token : undefined;
        } catch (error) {
            this.warn(`the keychain could not be read; sign in again (${error instanceof Error ? error.message : String(error)})`);
            return undefined;
        }
    }

    /** Keep `tokens`' refresh token; a sign-in without one forgets the old. */
    async save(issuer: string, clientId: string, tokens: DesktopTokens): Promise<void> {
        if (!this.store) {
            return;
        }
        if (!tokens.refreshToken) {
            await this.forget(issuer, clientId);
            return;
        }
        try {
            await this.store.setPassword(SIGN_IN_SERVICE, signInAccount(issuer, clientId), tokens.refreshToken);
        } catch (error) {
            this.warn(`the sign-in could not be kept in the keychain; the next start asks again (${error instanceof Error ? error.message : String(error)})`);
        }
    }

    async forget(issuer: string, clientId: string): Promise<void> {
        if (!this.store) {
            return;
        }
        try {
            await this.store.deletePassword(SIGN_IN_SERVICE, signInAccount(issuer, clientId));
        } catch (error) {
            this.warn(`the kept sign-in could not be removed from the keychain (${error instanceof Error ? error.message : String(error)})`);
        }
    }
}
