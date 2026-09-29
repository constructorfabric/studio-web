// node test/assistant-unavailable.test.js
//
// The rail's "why can this assistant not open" sentence. A desktop Studio
// fetches Claude Code and Codex on first need (#480) and answers
// `studio.desktop.assistantMessage` with the state they are in; a web session
// answers nothing, and a build without the studio extension has no command.
const assert = require('assert');
const { unavailableMessage, DESKTOP_ASSISTANT_MESSAGE_COMMAND } = require('../src/browser/ai-context.js');

const FALLBACK = 'Codex is not available here — install or sign in, then try again.';

function registry(answer) {
    const calls = [];
    return {
        calls,
        getCommand: id => (id === DESKTOP_ASSISTANT_MESSAGE_COMMAND ? { id } : undefined),
        isEnabled: () => true,
        executeCommand: async (id, ...args) => { calls.push([id, ...args]); return answer(...args); },
    };
}

(async () => {
    // No studio extension: the old sentence.
    assert.strictEqual(await unavailableMessage({ getCommand: () => undefined }, 'codex', 'Codex'), FALLBACK);

    // A web session: the command answers nothing.
    assert.strictEqual(await unavailableMessage(registry(() => undefined), 'codex', 'Codex'), FALLBACK);

    // The command fails: the old sentence, not an exception.
    assert.strictEqual(await unavailableMessage(registry(() => { throw new Error('boom'); }), 'codex', 'Codex'), FALLBACK);

    // A desktop mid-download: its sentence, asked with the extension id.
    const desktop = registry((id, label) => `${label} is downloading (37 %). It opens here once it is installed.`);
    assert.strictEqual(await unavailableMessage(desktop, 'codex', 'Codex'), 'Codex is downloading (37 %). It opens here once it is installed.');
    assert.deepStrictEqual(desktop.calls, [[DESKTOP_ASSISTANT_MESSAGE_COMMAND, 'openai.chatgpt', 'Codex']]);

    const claude = registry(id => id);
    assert.strictEqual(await unavailableMessage(claude, 'claude', 'Claude Code'), 'anthropic.claude-code');

    console.log('assistant-unavailable: ok');
})().catch(error => { console.error(error); process.exit(1); });
