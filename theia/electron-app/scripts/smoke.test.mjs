// node --test theia/electron-app/scripts/smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fatalLines, verdict } from './smoke.mjs';

test('the app is up once the shell, the Studio view and its sign-in show', () => {
    assert.equal(verdict({ shell: true, studioView: true, signIn: true }).ready, true);
});

test('each missing part says what is missing', () => {
    assert.deepEqual(verdict(undefined), { ready: false, why: 'no window yet' });
    assert.match(verdict({ shell: false, studioView: true, signIn: true }).why, /shell/);
    assert.match(verdict({ shell: true, studioView: false, signIn: true }).why, /Studio view is not there/);
    assert.match(verdict({ shell: true, studioView: true, signIn: false }).why, /sign in/);
});

test('a log is broken only by the lines that stop the app', () => {
    const log = [
        'root INFO Backend http://127.0.0.1:52011',
        'root WARN [studio-kits] kits unavailable Error: Studio answered 503',
        "Error: Cannot find module 'drivelist'",
        'Error: listen EADDRINUSE: address already in use',
    ].join('\r\n');
    assert.deepEqual(fatalLines(log), ["Error: Cannot find module 'drivelist'", 'Error: listen EADDRINUSE: address already in use']);
    assert.deepEqual(fatalLines('root INFO all fine\n'), []);
});
