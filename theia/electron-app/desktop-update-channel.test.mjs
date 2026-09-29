// node --test theia/electron-app/desktop-update-channel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { channelFrom, channelChoice } = require('./desktop-update-channel.js');

test('the channel follows the Settings choice', () => {
    assert.equal(channelFrom('beta', '0.3.0'), 'beta');
    assert.equal(channelFrom('stable', '0.3.0-beta.2'), 'latest');
});

test('without a choice, an installed pre-release follows betas and a release follows releases', () => {
    for (const chosen of ['auto', undefined]) {
        assert.equal(channelFrom(chosen, '0.3.0-beta.2'), 'beta');
        assert.equal(channelFrom(chosen, '0.3.0'), 'latest');
    }
});

test('the updater holds what the frontend last reported', async () => {
    const choice = channelChoice();
    assert.equal(choice.get(), undefined);
    let settled = false;
    void choice.reported.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);

    choice.set('beta');
    await choice.reported;
    assert.equal(choice.get(), 'beta');
    assert.equal(channelFrom(choice.get(), '0.3.0'), 'beta');

    choice.set('stable');
    assert.equal(channelFrom(choice.get(), '0.3.0-beta.2'), 'latest');

    // Back to `auto` (or anything unknown): the installed version decides again.
    choice.set('auto');
    assert.equal(choice.get(), undefined);
    choice.set('nightly');
    assert.equal(choice.get(), undefined);
});
