/*
 * Same-user, same-file, two tabs — requirement 17.
 *
 * This is the one collaboration hazard that needs no server to be real: one
 * person with the same document open twice, each tab holding a different
 * unsaved draft, the second save silently destroying the first. Detecting it
 * is purely client-side, so the prototype can be honest about it rather than
 * deferring it to a hosted backend that does not exist yet.
 *
 * BroadcastChannel carries the protocol; it is same-origin and same-profile,
 * which is exactly the scope of "the same user's other tab". Where it is
 * unavailable the lock degrades to "no duplicate detected" rather than
 * blocking the editor — a missing warning, never a false one.
 *
 * Deliberately NOT claimed: this does not detect a second *browser*, a second
 * machine, or another user. Those need server-side session state and an
 * identity model, neither of which this prototype has.
 */

const CHANNEL = 'studio-document-sessions';

// How long to wait for other tabs to answer a claim. Long enough for a
// same-process BroadcastChannel round trip by a wide margin, short enough
// that a document with no duplicate does not feel gated on opening.
const CLAIM_TIMEOUT_MS = 250;

function newTabId() {
    return 't-' + (globalThis.crypto && globalThis.crypto.randomUUID
        ? globalThis.crypto.randomUUID().slice(0, 8)
        : Math.floor(Math.random() * 1e9).toString(36));
}

class SessionLock {

    /**
     * @param uri       the document being claimed
     * @param handlers.onYieldRequested  another tab took over; drop this draft
     * @param handlers.onFocusRequested  another tab asked this one to surface
     * @param handlers.onOtherClosed     the other session released the file
     */
    constructor(uri, handlers) {
        this.key = uri.toString();
        this.tabId = newTabId();
        this.handlers = handlers || {};
        this.dirty = false;
        this.openedAt = new Date().toISOString();
        this.channel = undefined;
        try {
            if (typeof BroadcastChannel === 'function') {
                this.channel = new BroadcastChannel(CHANNEL);
                this.channel.onmessage = e => this.onMessage(e.data);
            }
        } catch (e) {
            console.warn('[studio] duplicate-session detection unavailable', e);
        }
    }

    post(message) {
        if (!this.channel) { return; }
        try { this.channel.postMessage({ ...message, key: this.key, from: this.tabId }); }
        catch (e) { console.warn('[studio] session message failed', e); }
    }

    onMessage(message) {
        if (!message || message.key !== this.key || message.from === this.tabId) { return; }
        switch (message.type) {
            case 'claim':
                // Answer so the newcomer can tell the user what it is up
                // against — including whether this tab has unsaved work,
                // which is the difference between a warning and a hazard.
                this.post({ type: 'held', dirty: this.dirty, openedAt: this.openedAt, to: message.from });
                break;
            case 'held':
                if (message.to === this.tabId && this.pendingClaim) { this.pendingClaim(message); }
                break;
            case 'yield':
                if (message.to === this.tabId && this.handlers.onYieldRequested) {
                    this.handlers.onYieldRequested(message);
                }
                break;
            case 'focus':
                if (message.to === this.tabId) {
                    try { window.focus(); } catch (e) { /* pop-up blockers */ }
                    if (this.handlers.onFocusRequested) { this.handlers.onFocusRequested(message); }
                }
                break;
            case 'release':
                if (this.handlers.onOtherClosed) { this.handlers.onOtherClosed(message); }
                break;
            default:
                break;
        }
    }

    /**
     * Announce this tab and wait briefly for an existing holder.
     * @returns {Promise<{tabId, dirty, openedAt}|undefined>} the other session, if any
     */
    claim() {
        if (!this.channel) { return Promise.resolve(undefined); }
        return new Promise(resolve => {
            let settled = false;
            this.pendingClaim = message => {
                if (settled) { return; }
                settled = true;
                this.pendingClaim = undefined;
                this.other = { tabId: message.from, dirty: !!message.dirty, openedAt: message.openedAt };
                resolve(this.other);
            };
            this.post({ type: 'claim' });
            setTimeout(() => {
                if (settled) { return; }
                settled = true;
                this.pendingClaim = undefined;
                resolve(undefined);
            }, CLAIM_TIMEOUT_MS);
        });
    }

    /** Keeps other tabs' warnings accurate as this one gains or loses a draft. */
    setDirty(dirty) { this.dirty = !!dirty; }

    /** Ask the other session to surface itself, so the user can go finish there. */
    focusOther() { if (this.other) { this.post({ type: 'focus', to: this.other.tabId }); } }

    /** Tell the other session to drop its draft; this tab is taking the file. */
    takeOver() { if (this.other) { this.post({ type: 'yield', to: this.other.tabId }); this.other = undefined; } }

    release() {
        this.post({ type: 'release' });
        if (this.channel) { try { this.channel.close(); } catch (e) { /* already closed */ } }
        this.channel = undefined;
    }
}

module.exports = { SessionLock };
