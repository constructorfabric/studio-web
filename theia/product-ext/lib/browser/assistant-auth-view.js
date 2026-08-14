/*
 * The sign-in surface for Codex and Claude.
 *
 * Two rows, one per assistant, each stating what it currently is — signed in,
 * not signed in, or not installed in this session — and offering the two ways
 * in: a subscription, or a provider key.
 *
 * SUBSCRIPTION FIRST, because that is how most people hold these accounts, and
 * because the alternative asks somebody to go and find a key. Both flows are
 * headless: an interactive login wants to open a browser and be called back on
 * localhost, and localhost inside a hosted session is not a place the user's
 * browser can reach. Codex prints a device code the user approves on any
 * device; Claude issues a long-lived subscription token.
 *
 * The device code is the whole point of the flow, so it is not left buried in a
 * log: the code and the URL are pulled out of the command's output and shown as
 * the primary content, with the raw output underneath for when something goes
 * wrong. The flow can take minutes — somebody has to walk to their phone — so
 * this polls rather than blocking, and it can be cancelled.
 *
 * A key is never echoed back. It goes to the backend, is handed to the CLI on
 * stdin, and the field is cleared: an API key sitting in a text input is one
 * screen-share away from being somebody else's.
 */

const { RemoteConnectionProvider } =
    require('@theia/core/lib/browser/messaging/service-connection-provider');
// The shell's own escape helper, so this surface cannot disagree with the
// rest of the product about what is safe to interpolate.
const { esc: escapeHtml } = require('./comment-ui');

const ASSISTANT_AUTH_PATH = '/services/studio-assistant-auth';
const POLL_MS = 1500;

const ASSISTANTS = [
    { kind: 'codex', label: 'Codex', subscription: 'Sign in with ChatGPT', keyLabel: 'OpenAI API key', keyPlaceholder: 'sk-…' },
    { kind: 'claude', label: 'Claude', subscription: 'Sign in with Claude', keyLabel: 'Anthropic API key', keyPlaceholder: 'sk-ant-…' }
];

/*
 * A device code and the URL to approve it at, pulled out of CLI output.
 *
 * Deliberately loose: the exact wording belongs to a tool that will change it,
 * and a strict parser that stops matching leaves the user staring at a spinner.
 * When nothing matches, the raw output is shown instead — which is always
 * readable, just less pleasant.
 */
function extractDeviceCode(output) {
    const url = (output.match(/https?:\/\/\S+/) || [])[0];
    const code = (output.match(/\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/) || [])[1]
        || (output.match(/code[:\s]+([A-Z0-9]{6,10})\b/i) || [])[1];
    return { url, code };
}

class AssistantAuthView {

    init(container, node) {
        this.node = node;
        this.flows = new Map();
        try {
            this.service = container.get(RemoteConnectionProvider).createProxy(ASSISTANT_AUTH_PATH);
        } catch (error) {
            console.warn('[studio] assistant sign-in service unavailable', error);
            this.service = undefined;
        }
        this.node.addEventListener('click', event => this.onClick(event));
        this.node.addEventListener('keydown', event => {
            if (event.key === 'Enter' && event.target.matches('[data-assistant-key]')) {
                event.preventDefault();
                this.submitKey(event.target.dataset.assistantKey);
            }
        });
        return this;
    }

    async refresh() {
        if (!this.service) {
            this.node.innerHTML = '<p class="studio-settings-note">Assistant sign-in is not available in this session.</p>';
            return;
        }
        let status;
        try {
            status = await this.service.status();
        } catch (error) {
            this.node.innerHTML = '<p class="studio-settings-note">Could not read assistant sign-in state.</p>';
            return;
        }
        this.status = status;
        this.render();
    }

    render() {
        if (!this.status) { return; }
        /*
         * Say when isolation is partial rather than letting somebody assume it
         * is complete. On a platform whose credential store is the system
         * keychain — macOS, i.e. a developer machine rather than a session
         * container — Claude's subscription login lives in that keychain and is
         * therefore shared by everyone using this computer. Moving HOME to
         * separate them is what broke the keychain in the first place.
         */
        const shared = this.status.credentialStore === 'system-keychain'
            ? '<p class="studio-settings-note">This machine stores Claude\u2019s subscription login in the system keychain, ' +
              'so it is shared with anything else signed in here. In a hosted session it is a file in your own credential home.</p>'
            : '';
        this.node.innerHTML = ASSISTANTS.map(assistant => this.rowHtml(assistant)).join('') + shared;
    }

    rowHtml(assistant) {
        const state = this.status[assistant.kind] || {};
        const flow = this.flows.get(assistant.kind);
        const unavailable = state.available === false;
        const tone = unavailable ? 'muted' : (state.signedIn ? 'ok' : 'warn');

        let body = '';
        if (flow) {
            const { url, code } = extractDeviceCode(flow.output || '');
            body =
                '<div class="studio-assistant-flow">' +
                (code
                    ? '<p class="studio-assistant-code-label">Enter this code after opening the link:</p>' +
                      '<p class="studio-assistant-code">' + escapeHtml(code) + '</p>'
                    : '') +
                (url
                    ? '<p><a class="studio-assistant-link" href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer noopener">' +
                      escapeHtml(url) + '</a></p>'
                    : '') +
                (!code && !url
                    ? '<p class="studio-settings-note">Starting sign-in…</p>'
                    : '') +
                '<pre class="studio-assistant-output">' + escapeHtml((flow.output || '').slice(-1200)) + '</pre>' +
                (flow.running
                    ? '<button class="studio-btn" data-act="assistant-cancel" data-kind="' + assistant.kind + '">Cancel</button>'
                    : '<button class="studio-btn" data-act="assistant-refresh" data-kind="' + assistant.kind + '">Done</button>') +
                '</div>';
        } else if (!unavailable) {
            body =
                '<div class="studio-assistant-actions">' +
                (state.signedIn
                    ? '<button class="studio-btn danger" data-act="assistant-signout" data-kind="' + assistant.kind + '">Sign out</button>'
                    : '<button class="studio-btn primary" data-act="assistant-signin" data-kind="' + assistant.kind + '">' +
                      escapeHtml(assistant.subscription) + '</button>') +
                '</div>' +
                '<details class="studio-assistant-key">' +
                '<summary>Use an API key instead</summary>' +
                '<div class="studio-settings-row">' +
                '<input type="password" class="studio-input" data-assistant-key="' + assistant.kind + '" ' +
                'placeholder="' + escapeHtml(assistant.keyPlaceholder) + '" aria-label="' + escapeHtml(assistant.keyLabel) + '" ' +
                'autocomplete="off" spellcheck="false">' +
                '<button class="studio-btn" data-act="assistant-key" data-kind="' + assistant.kind + '">Save key</button>' +
                '</div>' +
                '</details>';
        }

        return '<div class="studio-assistant" data-assistant="' + assistant.kind + '">' +
            '<div class="studio-assistant-head">' +
            '<span class="studio-assistant-name">' + escapeHtml(assistant.label) + '</span>' +
            '<span class="studio-assistant-state tone-' + tone + '">' + escapeHtml(state.detail || 'Unknown') + '</span>' +
            '</div>' +
            body +
            (this.messages && this.messages[assistant.kind]
                ? '<p class="studio-settings-note">' + escapeHtml(this.messages[assistant.kind]) + '</p>'
                : '') +
            '</div>';
    }

    note(kind, message) {
        this.messages = this.messages || {};
        this.messages[kind] = message;
        this.render();
    }

    async onClick(event) {
        const button = event.target.closest('[data-act]');
        if (!button || !this.node.contains(button)) { return; }
        const kind = button.dataset.kind;
        switch (button.dataset.act) {
            case 'assistant-signin': return this.beginSignIn(kind);
            case 'assistant-cancel': return this.cancelSignIn(kind);
            case 'assistant-refresh': return this.finish(kind);
            case 'assistant-signout': return this.signOut(kind);
            case 'assistant-key': return this.submitKey(kind);
            default: return undefined;
        }
    }

    async beginSignIn(kind) {
        if (!this.service) { return; }
        this.note(kind, '');
        const started = await this.service.beginSignIn(kind);
        this.flows.set(kind, { id: started.id, output: started.output || '', running: started.running });
        this.render();
        this.poll(kind);
    }

    poll(kind) {
        const flow = this.flows.get(kind);
        if (!flow || !flow.running) { return; }
        setTimeout(async () => {
            const current = this.flows.get(kind);
            if (!current || current.id !== flow.id) { return; }   // cancelled or replaced
            let update;
            try {
                update = await this.service.pollSignIn(flow.id);
            } catch (error) {
                return;
            }
            current.output = update.output;
            current.running = update.running;
            this.render();
            if (update.running) {
                this.poll(kind);
            } else {
                // The tool has finished; ask it what it thinks the state is now
                // rather than inferring success from an exit code.
                await this.refreshKeepingFlow(kind);
            }
        }, POLL_MS);
    }

    async refreshKeepingFlow(kind) {
        try {
            this.status = await this.service.status();
        } catch (error) { /* keep the last known state */ }
        this.render();
    }

    async cancelSignIn(kind) {
        const flow = this.flows.get(kind);
        if (flow && this.service) {
            try { await this.service.cancelSignIn(flow.id); } catch (error) { /* already gone */ }
        }
        this.flows.delete(kind);
        this.note(kind, 'Sign-in cancelled.');
        await this.refresh();
    }

    async finish(kind) {
        this.flows.delete(kind);
        await this.refresh();
    }

    async signOut(kind) {
        if (!this.service) { return; }
        const result = await this.service.signOut(kind);
        this.note(kind, result.detail || '');
        await this.refresh();
    }

    async submitKey(kind) {
        if (!this.service) { return; }
        const input = this.node.querySelector('[data-assistant-key="' + kind + '"]');
        if (!input) { return; }
        const key = input.value;
        // Cleared before the round trip: a key left in a field outlives the
        // moment it was needed, and this page can sit open for hours.
        input.value = '';
        if (!key.trim()) { return; }
        const result = await this.service.signInWithKey(kind, key);
        this.note(kind, result.detail || (result.ok ? 'Saved.' : 'Could not save the key.'));
        await this.refresh();
    }
}

const ASSISTANT_AUTH_CSS = `
.studio-settings-assistants .studio-assistant { padding: 10px 0; border-top: 1px solid var(--studio-line); }
.studio-settings-assistants .studio-assistant:first-child { border-top: 0; }
.studio-assistant-head { display: flex; align-items: baseline; gap: 10px; }
.studio-assistant-name { font-weight: 600; }
.studio-assistant-state { font-size: 12px; color: var(--studio-muted); }
.studio-assistant-state.tone-ok { color: var(--studio-success, var(--studio-text)); }
.studio-assistant-state.tone-warn { color: var(--studio-amber); }
.studio-assistant-actions { margin-top: 8px; display: flex; gap: 8px; }
.studio-assistant-key { margin-top: 8px; }
.studio-assistant-key > summary { font-size: 12px; color: var(--studio-muted); cursor: pointer; }
.studio-assistant-key > summary:hover { color: var(--studio-text); }
.studio-assistant-flow { margin-top: 8px; }
.studio-assistant-code-label { margin: 0 0 4px; font-size: 12px; color: var(--studio-muted); }
/* The code is the thing the person has to carry to another device, so it is
   the largest text on the page and selectable as one word. */
.studio-assistant-code {
  margin: 0 0 8px; font-family: var(--studio-mono, ui-monospace, monospace);
  font-size: 22px; letter-spacing: 2px; font-weight: 650; user-select: all;
}
.studio-assistant-link { font-size: 13px; }
.studio-assistant-output {
  margin: 8px 0; padding: 8px; max-height: 140px; overflow: auto;
  background: var(--studio-surface-sunken, var(--studio-surface-raised));
  border-radius: 6px; font-size: 11px; white-space: pre-wrap; color: var(--studio-muted);
}
`;

const assistantAuthView = new AssistantAuthView();

module.exports = { assistantAuthView, AssistantAuthView, ASSISTANT_AUTH_CSS, extractDeviceCode };
