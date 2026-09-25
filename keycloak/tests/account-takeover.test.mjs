// Can somebody sign in to Studio as another person?
//
// Runs against a live Keycloak (the Compose stack's, by default) and asks it
// directly. Nothing in Studio decides who a caller is from an e-mail: a person
// is found by the token's `sub` alone (studio-backend/src/user_profile), so a
// caller becomes somebody else only if Keycloak issues them somebody else's
// `sub`. These tests make Keycloak do exactly the logins that could, and fail
// if it does.
//
// The identity providers of keycloak/realm-studio.json (google, github,
// microsoft) all set trustEmail=true and use the stock "first broker login"
// flow. The tests stand up an OIDC provider with the same settings — a second
// realm of the same Keycloak playing the external IdP — plus a victim with a
// password, and drive the browser flow over plain HTTP with a cookie jar.
// Everything is created under a unique suffix and removed afterwards.
//
//   NODE_EXTRA_CA_CERTS=docker/keycloak/certs/dev-ca.pem node --test keycloak/tests/
//
// KC_PUBLIC   the browser-facing base URL          (https://localhost:8443)
// KC_ADMIN    an admin API base URL                 (http://127.0.0.1:8088)
// KC_BACKCHANNEL  how Keycloak reaches itself       (http://localhost:8080)
// KC_ADMIN_USER / KC_ADMIN_PASSWORD                  (admin / admin)
// Skips, not fails, when no Keycloak answers.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const PUBLIC = process.env.KC_PUBLIC ?? 'https://localhost:8443';
const ADMIN = process.env.KC_ADMIN ?? 'http://127.0.0.1:8088';
const BACK = process.env.KC_BACKCHANNEL ?? 'http://localhost:8080';
const REALM = 'studio';
const CLIENT = 'studio-portal';
const REDIRECT = 'http://127.0.0.1:8081/takeover-test-callback';
const run = randomBytes(3).toString('hex');
const IDP_REALM = `takeover-idp-${run}`;
const IDP_ALIAS = `takeover-${run}`;
const VICTIM = { username: `vasil-${run}`, email: `vasil-${run}@example.com`, password: `victim-${run}-Pw1!` };
const ATTACKER_PASSWORD = `mallory-${run}-Pw1!`;

let adminToken;
let reachable = false;
let victimId;

// --- admin API -----------------------------------------------------------------

async function admin(method, path, body) {
    const res = await fetch(`${ADMIN}/admin/realms${path}`, {
        method,
        headers: { Authorization: `Bearer ${adminToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 404) {
        throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    }
    return res;
}

async function createUser(realm, { username, email, password, emailVerified }) {
    const res = await admin('POST', `/${realm}/users`, {
        username, email, emailVerified, enabled: true, firstName: username, lastName: 'Test',
        credentials: [{ type: 'password', value: password, temporary: false }],
    });
    return res.headers.get('location').split('/').pop();
}

// --- a browser, over HTTP ------------------------------------------------------

class Browser {
    // Keyed by name AND path, like a browser: both realms live on one host and
    // name their cookies alike (AUTH_SESSION_ID, KC_RESTART), apart only by
    // Path. A jar that ignores the path lets the IdP realm's cookies overwrite
    // the broker's, and Keycloak answers "cookie_not_found".
    constructor() { this.jar = new Map(); }
    cookie(url) {
        const path = new URL(url).pathname;
        return [...this.jar.values()]
            .filter(c => path.startsWith(c.path))
            .sort((a, b) => b.path.length - a.path.length)
            .map(c => `${c.name}=${c.value}`).join('; ');
    }
    remember(res, url) {
        for (const header of res.headers.getSetCookie?.() ?? []) {
            const [kv, ...attrs] = header.split(';').map(s => s.trim());
            const i = kv.indexOf('=');
            const name = kv.slice(0, i);
            const value = kv.slice(i + 1);
            const pathAttr = attrs.find(a => /^path=/i.test(a))?.slice(5);
            const path = pathAttr || new URL(url).pathname.replace(/\/[^/]*$/, '') || '/';
            const expired = attrs.some(a => /^max-age=0$/i.test(a)) || /^expires=Thu, 01 Jan 1970/i.test(attrs.find(a => /^expires=/i.test(a)) ?? '');
            const key = `${name}@${path}`;
            if (expired || value === '') this.jar.delete(key); else this.jar.set(key, { name, value, path });
        }
    }
    /** Follow redirects until a page, or until the client's redirect URI is reached. */
    async go(url, init = {}) {
        for (let hop = 0; hop < 15; hop++) {
            if (url.startsWith(REDIRECT)) {
                return { url, landed: true, text: '' };
            }
            const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), Cookie: this.cookie(url) } });
            this.remember(res, url);
            const location = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && location) {
                url = new URL(location, url).toString();
                init = {};
                continue;
            }
            return { url, landed: false, text: await res.text(), status: res.status };
        }
        throw new Error('too many redirects');
    }
    async submit(page, fields) {
        const action = page.text.match(/<form[^>]*action="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
        assert.ok(action, `no form on ${page.url}`);
        return this.go(new URL(action, page.url).toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
        });
    }
}

function pkce() {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Start a sign-in to Studio; answers the browser's first page or landing. */
async function startSignIn(browser, extra = {}) {
    const { verifier, challenge } = pkce();
    const query = new URLSearchParams({
        response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, scope: 'openid',
        state: randomBytes(8).toString('hex'), code_challenge: challenge, code_challenge_method: 'S256', ...extra,
    });
    const page = await browser.go(`${PUBLIC}/realms/${REALM}/protocol/openid-connect/auth?${query}`);
    return { page, verifier };
}

/** Trade the code on a landing for the `sub` it was issued to. */
async function subjectOf(landing, verifier) {
    const code = new URL(landing.url).searchParams.get('code');
    assert.ok(code, `landed without a code: ${landing.url}`);
    const res = await fetch(`${ADMIN}/realms/${REALM}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT, code, redirect_uri: REDIRECT, code_verifier: verifier }),
    });
    const body = await res.json();
    assert.ok(body.access_token, `token exchange failed: ${JSON.stringify(body)}`);
    const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url').toString());
    return { sub: claims.sub, username: claims.preferred_username };
}

/** What a page is, by the Keycloak template it came from. */
function whatIs(page) {
    if (page.landed) return 'landed';
    if (/id="kc-form-login"/.test(page.text)) return 'login-form';
    if (/kc-page-title[^>]*>\s*[^<]*(already exists|Account already exists|Link)/i.test(page.text) || /name="submitAction"/.test(page.text)) return 'confirm-link';
    if (/id="kc-idp-review-profile-form"|kc-update-profile-form/.test(page.text)) return 'review-profile';
    // Keycloak's pages carry their message in one of a few places; the title
    // alone ("Sign in to studio") says nothing.
    const message = page.text.match(/id="kc-error-message"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)?.[1]
        ?? page.text.match(/class="(?:instruction|kc-feedback-text|pf-v5-c-alert__title)[^"]*"[^>]*>([\s\S]*?)<\//)?.[1]
        ?? page.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]
        ?? '';
    return `other(${page.status}): ${message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

/**
 * Sign in to Studio through the test IdP as `attacker`, answering the IdP's own
 * login form and any profile review, but NEVER the victim's password. Answers
 * what Keycloak did: `takeover` (a code for the victim's sub), `new-user`
 * (somebody else's sub), or `asks` (it wanted a confirmation first).
 */
async function brokeredSignIn(attackerUsername) {
    const browser = new Browser();
    const { page: first, verifier } = await startSignIn(browser, { kc_idp_hint: IDP_ALIAS });
    assert.equal(whatIs(first), 'login-form', `expected the IdP's login form, got ${whatIs(first)} at ${first.url}`);
    assert.ok(first.url.includes(`/realms/${IDP_REALM}/`), `the first form should be the IdP's, got ${first.url}`);
    let page = await browser.submit(first, { username: attackerUsername, password: ATTACKER_PASSWORD });
    const steps = [];
    for (let step = 0; step < 4; step++) {
        const kind = whatIs(page);
        steps.push(kind);
        if (kind === 'review-profile') {
            page = await browser.submit(page, {});
        } else if (kind === 'confirm-link') {
            // "Account already exists" — take the attacker's side and ask to link.
            page = await browser.submit(page, { submitAction: 'linkAccount' });
        } else {
            break;
        }
    }
    const kind = whatIs(page);
    if (kind !== 'landed') {
        // A login form now is Keycloak asking for the EXISTING account's
        // password — the attacker does not have it, so the link stops here.
        return { outcome: kind === 'login-form' ? 'asks-victim-password' : 'asks', steps };
    }
    const who = await subjectOf(page, verifier);
    return { outcome: who.sub === victimId ? 'takeover' : 'new-user', ...who };
}

// --- fixtures --------------------------------------------------------------------

before(async () => {
    try {
        const res = await fetch(`${ADMIN}/realms/master/protocol/openid-connect/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'password', client_id: 'admin-cli',
                username: process.env.KC_ADMIN_USER ?? 'admin', password: process.env.KC_ADMIN_PASSWORD ?? 'admin',
            }),
        });
        adminToken = (await res.json()).access_token;
        reachable = !!adminToken;
    } catch {
        reachable = false;
    }
    if (!reachable) return;

    // The victim: an ordinary Studio user with a password and a verified address.
    victimId = await createUser(REALM, { ...VICTIM, emailVerified: true });

    // The external IdP: its own realm, with a confidential client for the broker.
    await admin('POST', '', { realm: IDP_REALM, enabled: true, sslRequired: 'none' });
    const secret = randomBytes(16).toString('hex');
    await admin('POST', `/${IDP_REALM}/clients`, {
        clientId: 'studio-broker', enabled: true, publicClient: false, secret, standardFlowEnabled: true,
        redirectUris: [`${PUBLIC}/realms/${REALM}/broker/${IDP_ALIAS}/endpoint`],
    });

    // The broker, configured as keycloak/realm-studio.json configures google,
    // github and microsoft: trustEmail on, the stock first-broker-login flow.
    await admin('POST', `/${REALM}/identity-provider/instances`, {
        alias: IDP_ALIAS, providerId: 'oidc', enabled: true, trustEmail: true,
        firstBrokerLoginFlowAlias: 'first broker login',
        config: {
            authorizationUrl: `${PUBLIC}/realms/${IDP_REALM}/protocol/openid-connect/auth`,
            tokenUrl: `${BACK}/realms/${IDP_REALM}/protocol/openid-connect/token`,
            userInfoUrl: `${BACK}/realms/${IDP_REALM}/protocol/openid-connect/userinfo`,
            jwksUrl: `${BACK}/realms/${IDP_REALM}/protocol/openid-connect/certs`,
            issuer: `${PUBLIC}/realms/${IDP_REALM}`,
            validateSignature: 'true', useJwksUrl: 'true',
            clientId: 'studio-broker', clientSecret: secret, clientAuthMethod: 'client_secret_post',
            defaultScope: 'openid email profile', syncMode: 'IMPORT',
        },
    });
});

after(async () => {
    if (!reachable) return;
    await admin('DELETE', `/${REALM}/identity-provider/instances/${IDP_ALIAS}`);
    // Users the broker created for the attackers, and the victim.
    for (const name of [VICTIM.username, `mallory-v-${run}`, `mallory-u-${run}`]) {
        const found = await (await admin('GET', `/${REALM}/users?username=${encodeURIComponent(name)}&exact=true`)).json();
        for (const u of found) await admin('DELETE', `/${REALM}/users/${u.id}`);
    }
    const byEmail = await (await admin('GET', `/${REALM}/users?email=${encodeURIComponent(VICTIM.email)}&exact=true`)).json();
    for (const u of byEmail) await admin('DELETE', `/${REALM}/users/${u.id}`);
    await admin('DELETE', `/${IDP_REALM}`);
});

// --- the tests -------------------------------------------------------------------

test('an IdP account with the victim\'s verified e-mail does not sign in as the victim', async (t) => {
    if (!reachable) return t.skip('no Keycloak admin API reachable');
    await createUser(IDP_REALM, { username: `mallory-v-${run}`, email: VICTIM.email, password: ATTACKER_PASSWORD, emailVerified: true });
    const result = await brokeredSignIn(`mallory-v-${run}`);
    t.diagnostic(JSON.stringify(result));
    assert.notEqual(result.outcome, 'takeover',
        `Keycloak linked an outside account to ${VICTIM.username} by e-mail and signed it in without the victim's password`);
});

test('an IdP account claiming the victim\'s e-mail UNVERIFIED does not sign in as the victim (nOAuth)', async (t) => {
    if (!reachable) return t.skip('no Keycloak admin API reachable');
    // The IdP realm allows one account per address; the previous attacker goes.
    for (const u of await (await admin('GET', `/${IDP_REALM}/users?email=${encodeURIComponent(VICTIM.email)}&exact=true`)).json()) {
        await admin('DELETE', `/${IDP_REALM}/users/${u.id}`);
    }
    await createUser(IDP_REALM, { username: `mallory-u-${run}`, email: VICTIM.email, password: ATTACKER_PASSWORD, emailVerified: false });
    const result = await brokeredSignIn(`mallory-u-${run}`);
    t.diagnostic(JSON.stringify(result));
    assert.notEqual(result.outcome, 'takeover',
        `trustEmail made an unverified address count as proof of owning ${VICTIM.username}`);
});

test('a browser left signed in as the victim does not sign the next person in as the victim, when the app asks who', async (t) => {
    if (!reachable) return t.skip('no Keycloak admin API reachable');
    const browser = new Browser();
    // The victim signs in once, in this browser.
    const { page: form, verifier } = await startSignIn(browser);
    const landing = await browser.submit(form, { username: VICTIM.username, password: VICTIM.password });
    assert.equal((await subjectOf(landing, verifier)).sub, victimId);

    // Without prompt=login the browser's session answers for whoever clicks
    // next — the behaviour the desktop sign-in was fixed for. Recorded, not
    // asserted: it is how browser SSO works, and each client has to opt out.
    const silent = await startSignIn(browser);
    t.diagnostic(`without prompt=login: ${whatIs(silent.page)}`);

    // With it, Keycloak asks again.
    const asked = await startSignIn(browser, { prompt: 'login' });
    assert.equal(whatIs(asked.page), 'login-form', 'prompt=login must show the login form even with a live session');
});
