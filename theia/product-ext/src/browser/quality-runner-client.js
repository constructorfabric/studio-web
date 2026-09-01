/*
 * The frontend half of the quality runner service — CONTRACT-runner.md §5.
 *
 * Same shape as `viewer-credentials-client.js`: a proxy is opened lazily, its
 * absence is expected rather than exceptional, and nothing in here ever
 * throws out of a constructor. A browser-only deployment (or one where
 * `src/node/quality-backend.js` fell back to `UnavailableQualityRunner`
 * because no Python interpreter could be found — CONTRACT-runner.md §0, Q2)
 * has no runner to talk to, and that has to read as "analysis is not
 * available here", not as a broken page.
 *
 * DEGRADE, DO NOT THROW — but only at the boundary this file owns:
 *   - `probe()` returns `{ available: false, why }` on any failure, because
 *     probing IS the question "can I use this", and a caller checking that
 *     answer should never need a try/catch of its own.
 *   - `run`, `status` and `cancel` reject with a plain `Error` (a message a
 *     panel can show verbatim), rather than leaking an RPC stack or an
 *     `undefined` a caller would have to guess about.
 *
 * URI -> FILESYSTEM PATH. The backend (`quality-backend.js`, and the runner
 * underneath it) works entirely in filesystem paths — CONTRACT-runner.md §5's
 * envelope talks about `<root>/.studio/quality/...` on disk, and `runner.json`
 * resolution walks a real filesystem. The frontend, like every other browser
 * module in this extension (`quality-store.js`, `search-view.js`,
 * `changes-store.js`, ...), otherwise only ever holds a Theia `URI`. The
 * conversion is `uri.path.fsPath()` — Theia's own method for exactly this,
 * used inside `@theia/core`'s own `URI` class — not a new convention invented
 * for this file. `toFsPath` below accepts either a `URI` instance or a plain
 * string (a raw `file://` uri, or already a path) so callers do not each have
 * to know which one they are holding.
 */

const { RemoteConnectionProvider } =
    require('@theia/core/lib/browser/messaging/service-connection-provider');
const { URI } = require('@theia/core/lib/common/uri');
const { QUALITY_RUNNER_PATH } = require('../common/quality-protocol');

/** How often `watch()` polls `status()` while a run is open — CONTRACT §5. */
const WATCH_INTERVAL_MS = 500;

function toFsPath(rootUriOrString) {
    const uri = rootUriOrString instanceof URI ? rootUriOrString : new URI(String(rootUriOrString));
    return uri.path.fsPath();
}

/** The message every rejection below carries when there is nothing more specific to say. */
const UNAVAILABLE = 'the quality runner backend is not available in this build';

class QualityRunnerClient {

    /**
     * @param container the frontend inversify container
     *
     * Mirrors `ViewerCredentialsClient.init`: the proxy is created here,
     * lazily, rather than at module load, and a container that has no
     * `RemoteConnectionProvider` bound (or a backend that never registered
     * this path) leaves `this.service` undefined instead of throwing. Every
     * method below already checks for that.
     */
    init(container) {
        /*
         * IDEMPOTENT, and it has to be: this client is a singleton shared by the
         * document rail and the project tab, and each of them calls `init` when
         * it is constructed. Creating a second proxy on every call replaced a
         * working one with a fresh one mid-session — the project tab's probe
         * then never settled and its "Check project" control never appeared,
         * while the rail's, which had already resolved, went on looking fine.
         * One proxy per client, made on the first call that can make one.
         */
        if (this.service) { return this; }
        try {
            const provider = container.get(RemoteConnectionProvider);
            this.service = provider.createProxy(QUALITY_RUNNER_PATH);
        } catch (error) {
            console.warn('[studio] quality runner service unavailable; analysis stays unavailable', error);
            this.service = undefined;
        }
        return this;
    }

    /** @returns { available, python, specAnalysis, source, why } — never throws. */
    async probe(rootUri) {
        if (!this.service) {
            return { available: false, why: UNAVAILABLE };
        }
        try {
            return await this.service.probe(toFsPath(rootUri));
        } catch (error) {
            return { available: false, why: (error && error.message) || UNAVAILABLE };
        }
    }

    /** @returns { runId } — CONTRACT §5: returns as soon as the run is registered. */
    async run(rootUri, options) {
        if (!this.service) {
            throw new Error(UNAVAILABLE);
        }
        try {
            return await this.service.run(toFsPath(rootUri), options || {});
        } catch (error) {
            throw new Error((error && error.message) || 'could not start the analysis run');
        }
    }

    /** @returns { state, done, total, current, startedAt, error } */
    async status(runId) {
        if (!this.service) {
            throw new Error(UNAVAILABLE);
        }
        try {
            return await this.service.status(runId);
        } catch (error) {
            throw new Error((error && error.message) || 'could not read the run status');
        }
    }

    /** @returns boolean */
    async cancel(runId) {
        if (!this.service) {
            throw new Error(UNAVAILABLE);
        }
        try {
            return await this.service.cancel(runId);
        } catch (error) {
            throw new Error((error && error.message) || 'could not cancel the run');
        }
    }

    /*
     * Poll status() every 500ms while the run is open, and resolve with the
     * final status the instant it leaves 'running' (CONTRACT §5: "status is
     * polled by the one surface that shows a progress line, at 500 ms, and
     * only while a run is open" — this is that polling, in one place, so it
     * is written once rather than once per caller).
     *
     * `onProgress`, if given, is called with every status seen, including the
     * last — a caller paints a progress line from that and does not need a
     * timer of its own. A throwing `onProgress` cannot break the poll: it is
     * a rendering callback, not a reason to abandon a run somebody is waiting
     * on.
     *
     * NOT DECLARED `async`, ON PURPOSE. `watch()` has to be cancellable by the
     * caller ("the run panel closed; stop asking"), and an `async function`
     * can only ever hand back a bare `Promise` — there is nowhere to hang a
     * `cancel()` off of. Returning a `Promise` built by hand lets one be
     * attached to it directly, so the call site still reads as async
     * (`await client.watch(...)`) while also supporting:
     *
     *   const w = client.watch(runId, onProgress);
     *   ... later, if the caller stopped caring ...
     *   w.cancel();
     *
     * Cancelling here only stops the polling loop and resolves with
     * `{ state: 'cancelled' }` for the CALLER's purposes — it does not call
     * the backend's `cancel()`, which stops the run itself. Those are
     * different actions (watching vs. cancelling), and conflating them would
     * mean a panel that merely closes ends up killing someone else's run.
     */
    watch(runId, onProgress) {
        let stopped = false;
        let timer;
        const promise = new Promise((resolve, reject) => {
            const poll = () => {
                if (stopped) { return; }
                this.status(runId).then(current => {
                    if (stopped) { return; }
                    if (typeof onProgress === 'function') {
                        try {
                            onProgress(current);
                        } catch (error) {
                            console.warn('[studio] quality runner watch progress handler failed', error);
                        }
                    }
                    const state = current && current.state;
                    if (state === 'done' || state === 'failed' || state === 'cancelled') {
                        resolve(current);
                        return;
                    }
                    timer = setTimeout(poll, WATCH_INTERVAL_MS);
                }, error => {
                    if (stopped) { return; }
                    reject(error);
                });
            };
            poll();
        });
        promise.cancel = () => {
            stopped = true;
            if (timer) { clearTimeout(timer); }
        };
        return promise;
    }
}

module.exports = { QualityRunnerClient, QUALITY_RUNNER_PATH };
