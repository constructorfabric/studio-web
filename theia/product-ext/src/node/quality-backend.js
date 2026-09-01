/*
 * The quality runner, exposed as a backend service — CONTRACT-runner.md §5.
 *
 * This module does not run detectors. `./quality-runner` does that; this file
 * only wires it onto the RPC path the frontend proxy in
 * `src/browser/quality-runner-client.js` calls. The split matters because the
 * runner is optional in a way most backend services are not: it depends on a
 * Python interpreter and a detector checkout that may not exist on this
 * machine at all (CONTRACT-runner.md §0, Q2), and "the venv is missing" must
 * turn into "analysis is not available here" in the panel, not into a backend
 * that fails to come up. See UnavailableQualityRunner below.
 *
 * THE SINGLETON-PER-ROOT GUARANTEE, AND WHY IT IS BUILT HERE RATHER THAN
 * LEFT TO INVERSIFY. `ConnectionContainerModule` (the same mechanism
 * `viewer-credentials.js` uses) forks a fresh child container per frontend
 * connection, so a class bound `.inSingletonScope()` *inside* the factory
 * below is only a singleton for that one connection — exactly what
 * `viewer-credentials.js` wants, because each browser tab needs its own
 * credential state. The quality runner wants the opposite: CONTRACT-runner.md
 * §5 says "a run is per root and singleton" — a second browser tab asking to
 * run the same root must see the run the first tab already started, not get
 * a bookkeeping instance of its own that has never heard of it. So the runner
 * is constructed exactly ONCE, at module load, outside the connection
 * factory, and every connection's container is bound to that same reference
 * via `toConstantValue`. Two tabs, one runner, one Map of in-flight runs
 * (wherever `./quality-runner` keeps it) — the property CONTRACT-runner.md
 * asks for falls out of that instead of needing its own guard here.
 *
 * NO DECORATORS, matching viewer-credentials.js: this package is plain
 * CommonJS with no build step, so inversify is handed a plain identifier and
 * a constant value rather than a class it would need `@injectable()` on.
 */
const { ContainerModule } = require('inversify');
const { ConnectionContainerModule } = require('@theia/core/lib/node/messaging/connection-container-module');
const { QUALITY_RUNNER_PATH } = require('../common/quality-protocol');

/*
 * The reason this exists at all: `require('./quality-runner')` is another
 * agent's file, written concurrently with this one, and it may not exist yet,
 * may throw while loading its own dependencies (a missing native module, a
 * syntax error mid-edit), or may not export the shape this file expects. Any
 * of those must not take the rest of the backend down with it — a browser
 * session that cannot preview markdown because an unrelated Python feature's
 * module failed to `require` is the wrong failure mode entirely. So this
 * stands in for the real runner and answers every call the same honest way:
 * analysis is not available, and why.
 */
class UnavailableQualityRunner {

    constructor(reason) {
        this.reason = reason instanceof Error ? reason.message : String(reason || 'unknown error');
    }

    async probe() {
        return {
            available: false,
            python: undefined,
            specAnalysis: undefined,
            source: undefined,
            why: 'the quality runner could not be loaded: ' + this.reason
        };
    }

    async run() {
        throw new Error('analysis is not available here: the quality runner could not be loaded');
    }

    async status() {
        throw new Error('analysis is not available here: the quality runner could not be loaded');
    }

    async cancel() {
        throw new Error('analysis is not available here: the quality runner could not be loaded');
    }
}

/*
 * Builds the one runner instance the whole backend process shares. Resolved
 * once, at require-time of this module, which is also why every failure here
 * is caught rather than thrown: an exception during a `ContainerModule`'s own
 * construction reaches Theia's bootstrap and can abort startup, which is
 * exactly the outcome the rest of this file exists to avoid.
 */
function createRunner() {
    try {
        // eslint-disable-next-line global-require -- deliberately lazy: see header.
        const loaded = require('./quality-runner');
        const Runner = (loaded && loaded.QualityRunner) || (loaded && loaded.default) || loaded;
        if (typeof Runner !== 'function') {
            throw new Error('quality-runner.js did not export a constructor');
        }
        return new Runner();
    } catch (error) {
        console.error('[studio] the quality runner failed to load; analysis stays unavailable', error);
        return new UnavailableQualityRunner(error);
    }
}

const runner = createRunner();

// A plain Symbol as the DI token: it only has to be unique, and a Symbol
// cannot collide with some other extension's identifier the way a string or
// an unadorned class constructor name might.
const QualityRunnerService = Symbol('QualityRunnerService');

const connectionModule = ConnectionContainerModule.create(({ bind, bindBackendService }) => {
    // `toConstantValue` binds the SAME `runner` for every connection's child
    // container — see the header comment for why that is the point.
    bind(QualityRunnerService).toConstantValue(runner);
    bindBackendService(QUALITY_RUNNER_PATH, QualityRunnerService);
});

const mod = new ContainerModule(bind => {
    bind(ConnectionContainerModule).toConstantValue(connectionModule);
});

module.exports = mod;
module.exports.default = mod;
module.exports.QUALITY_RUNNER_PATH = QUALITY_RUNNER_PATH;
module.exports.UnavailableQualityRunner = UnavailableQualityRunner;
