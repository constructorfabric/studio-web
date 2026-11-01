// Start the built desktop app and check it comes up as a member would see it:
// the window's shell, the Studio view offering to sign in, and a log without
// a backend that failed to start. Run after `theia build`, from electron-app:
//
//   node scripts/smoke.mjs [--timeout 240]
//
// Talks to the window over the Chrome DevTools protocol, so it needs no
// browser driver; the Studio it is pointed at is never reached (nobody signs
// in), so it needs no network either.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Log lines that mean the app did not start as it should. */
const FATAL = [
    /Cannot find module/,
    /Failed to start the backend/i,
    /uncaughtException/,
    /Error: listen EADDRINUSE/,
    /Could not load native module/i,
    /The application could not be started/i,
];

/** The lines of `log` that say the app is broken. */
export function fatalLines(log) {
    return log.split(/\r?\n/).filter(line => FATAL.some(re => re.test(line)));
}

/**
 * What the window shows, from `snapshot()` below, as one verdict: ready once
 * the shell is laid out and the Studio view offers to sign in.
 */
export function verdict(seen) {
    if (!seen) return { ready: false, why: 'no window yet' };
    if (!seen.shell) return { ready: false, why: 'the shell is not laid out yet' };
    if (!seen.studioView) return { ready: false, why: 'the Studio view is not there yet' };
    if (!seen.signIn) return { ready: false, why: 'the Studio view does not offer to sign in' };
    return { ready: true, why: 'the shell, the Studio view and its sign-in are up' };
}

/** Evaluated in the window: what the member would see. */
const SNAPSHOT = `(() => ({
    shell: !!document.querySelector('#theia-app-shell, .theia-app-shell, .lm-Widget.theia-app-main'),
    studioView: !!document.querySelector('.studio-desktop, [id*="studio-desktop"]'),
    signIn: [...document.querySelectorAll('button')].some(b => /sign in/i.test(b.textContent || '')),
}))()`;

async function snapshot(port) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
    if (!page) return undefined;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    try {
        const answer = await new Promise((resolve, reject) => {
            ws.onmessage = m => resolve(JSON.parse(String(m.data)));
            ws.onerror = reject;
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: SNAPSHOT, returnByValue: true } }));
        });
        return answer.result?.result?.value;
    } finally {
        ws.close();
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const timeoutIndex = process.argv.indexOf('--timeout');
    const timeoutMs = (timeoutIndex > 0 ? Number(process.argv[timeoutIndex + 1]) : 240) * 1000;
    const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    // The data folder must be outside the workspace: the backend refuses otherwise.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-smoke-'));
    const workspace = path.join(scratch, 'workspace');
    fs.mkdirSync(workspace);
    const port = 9300 + Math.floor(Math.random() * 500);
    const env = {
        ...process.env,
        STUDIO_DESKTOP_ENVIRONMENTS: JSON.stringify([{ id: 'smoke', label: 'Smoke', studioUrl: 'http://127.0.0.1:9', issuer: 'http://127.0.0.1:9/realms/studio' }]),
        STUDIO_DESKTOP_DEFAULT: 'smoke',
        STUDIO_DESKTOP_SETTINGS: path.join(scratch, 'settings.json'),
        // What desktop-main.js gives the packaged app: `theia start` skips it.
        STUDIO_ACTOR_ID: 'desktop',
        STUDIO_WORKSPACE_ID: 'desktop',
        STUDIO_WORKSPACE_ROOT: workspace,
        STUDIO_REPOSITORY_ROOT: workspace,
        STUDIO_DATA_DIR: path.join(scratch, 'data'),
    };
    const app = spawn('npx', ['theia', 'start', workspace, '--plugins=local-dir:../plugins', `--remote-debugging-port=${port}`], {
        cwd: here, env, shell: process.platform === 'win32', detached: process.platform !== 'win32',
    });
    let log = '';
    app.stdout.on('data', d => { log += d; });
    app.stderr.on('data', d => { log += d; });
    const stop = () => {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(app.pid), '/t', '/f']);
        else try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ }
    };
    const deadline = Date.now() + timeoutMs;
    let last = verdict(undefined);
    try {
        while (Date.now() < deadline) {
            const fatal = fatalLines(log);
            if (fatal.length > 0) throw new Error(`the app logged a failure:\n${fatal.join('\n')}`);
            if (app.exitCode !== null) throw new Error(`the app exited with ${app.exitCode}`);
            last = verdict(await snapshot(port).catch(() => undefined));
            if (last.ready) {
                console.log(`smoke: ${last.why}`);
                return;
            }
            await sleep(2000);
        }
        throw new Error(`the app was not up in ${timeoutMs / 1000} s: ${last.why}`);
    } catch (error) {
        const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
        console.error(`smoke: windows ${JSON.stringify(pages.map(t => [t.type, t.url]))}`);
        console.error(`smoke: ${error.message}\n--- the app's log, last 80 lines ---\n${log.split(/\r?\n/).slice(-80).join('\n')}`);
        process.exitCode = 1;
    } finally {
        if (process.env.SMOKE_LOG) fs.writeFileSync(process.env.SMOKE_LOG, log);
        stop();
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    await main();
}
