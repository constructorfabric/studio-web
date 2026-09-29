// node --test electron-app/scripts/assistants-manifest.test.mjs — no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { manifestEntry, metadataUrl, parseDigest, parseFetchVsixPins, shortLabel, studioCliUrl, studioCliVersion } from './assistants-manifest.mjs';

const theia = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('reads the fetch_vsix pins of theia/Dockerfile, the one pin', () => {
    const pins = parseFetchVsixPins(readFileSync(join(theia, 'Dockerfile'), 'utf8'));
    assert.deepEqual(pins.map(p => p.dir), ['anthropic.claude-code', 'openai.chatgpt']);
    for (const pin of pins) {
        assert.match(pin.version, /^\d+\.\d+\.\d+$/);
        assert.equal(`${pin.namespace}.${pin.name}`.toLowerCase(), pin.dir);
    }
});

test('reads them from a CRLF checkout, skipping the function that defines fetch_vsix', () => {
    const text = [
        'RUN fetch_vsix() { \\',
        '      namespace="$1"; name="$2"; \\',
        '    }; \\',
        '    fetch_vsix Anthropic claude-code 2.1.227 anthropic.claude-code; \\',
        '    fetch_vsix openai chatgpt 26.5803.61601 openai.chatgpt',
    ].join('\r\n');
    assert.deepEqual(parseFetchVsixPins(text), [
        { namespace: 'Anthropic', name: 'claude-code', version: '2.1.227', dir: 'anthropic.claude-code' },
        { namespace: 'openai', name: 'chatgpt', version: '26.5803.61601', dir: 'openai.chatgpt' },
    ]);
});

test('asks open-vsx for one version, or for the newest', () => {
    assert.equal(metadataUrl('openai', 'chatgpt', 'win32-x64', '26.1.2'), 'https://open-vsx.org/api/openai/chatgpt/win32-x64/26.1.2');
    assert.equal(metadataUrl('openai', 'chatgpt', 'win32-x64'), 'https://open-vsx.org/api/openai/chatgpt/win32-x64');
});

test('labels an assistant by its name, not its tagline', () => {
    assert.equal(shortLabel('Codex – OpenAI’s coding agent', 'x'), 'Codex');
    assert.equal(shortLabel('Claude Code for VS Code', 'x'), 'Claude Code');
    assert.equal(shortLabel(undefined, 'openai.chatgpt'), 'openai.chatgpt');
});

test('writes an entry the app accepts', () => {
    const sha = 'b'.repeat(64);
    const meta = {
        namespace: 'openai', name: 'chatgpt', version: '26.5730.61309', displayName: 'Codex – OpenAI’s coding agent',
        files: { download: 'https://open-vsx.org/api/openai/chatgpt/win32-x64/26.5730.61309/file/openai.chatgpt-26.5730.61309@win32-x64.vsix' },
    };
    assert.deepEqual(manifestEntry(meta, 'win32-x64', sha), {
        id: 'openai.chatgpt', label: 'Codex', version: '26.5730.61309', target: 'win32-x64', url: meta.files.download, sha256: sha,
    });
    assert.throws(() => manifestEntry({ ...meta, files: {} }, 'win32-x64', sha), /no download/);
    assert.throws(() => manifestEntry(meta, 'win32-x64', 'nope'), /no usable SHA-256/);
});

test('reads a .sha256 file in either shape', () => {
    assert.equal(parseDigest('ABCDEF\n'), 'abcdef');
    assert.equal(parseDigest('abcdef  openai.chatgpt.vsix\n'), 'abcdef');
});

test('versions the Constructor Studio CLI by its pins, as build_vsix.py does', () => {
    const pin = JSON.parse(readFileSync(join(theia, 'cfs.json'), 'utf8'));
    const version = studioCliVersion(pin);
    assert.equal(version, `${pin.engine.replace(/^v/, '')}-${pin.ref.slice(0, 7)}.${pin.extension.build}`);
    // A version the desktop's manifest check accepts, and a folder name.
    assert.match(version, /^[0-9A-Za-z][0-9A-Za-z.+-]*$/);
    assert.equal(
        studioCliUrl('https://github.com/o/r/releases/download/', '1.6.2-ca55c66.1', 'win32-x64'),
        'https://github.com/o/r/releases/download/studio-cli-v1.6.2-ca55c66.1/constructorfabric.studio-cli-1.6.2-ca55c66.1-win32-x64.vsix'
    );
});
