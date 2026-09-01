/*
 * Where the flow's MCP server actually is on THIS machine.
 *
 * The frontend needs an absolute path and cannot have one: it writes a
 * project's `.mcp.json`, and an MCP registration is a command line. A browser
 * bundle knows nothing about where the application was installed. So the one
 * fact it is missing is served from the backend, which does.
 *
 * WHY THE SERVER IS COPIED OUT OF THE BUNDLE. `src/browser/flow-spec.js` and
 * `flow-log.js` are pure so the MCP server can `require` them rather than
 * mirroring the rules — but in a packaged application they do not exist as
 * files at all: esbuild has folded them into the frontend bundle. So
 * electron-builder copies `product-ext/`'s `flow-mcp/` and those two modules,
 * side by side, into `Contents/Resources/app/flow-mcp/`, and the server tries
 * both layouts. That copy is what this file goes looking for.
 *
 * IT RETURNS A REASON RATHER THAN THROWING. An application whose flow tooling
 * cannot be located must still start a flow: the documents and the contract are
 * most of the value, and a project can be registered by hand. So `describe()`
 * always answers, and the answer carries `why` when `ok` is false — which the
 * rail prints verbatim instead of paraphrasing.
 */
const fs = require('fs');
const path = require('path');
const { ContainerModule } = require('inversify');
const { ConnectionContainerModule } = require('@theia/core/lib/node/messaging/connection-container-module');
const { FLOW_TOOLS_PATH } = require('../common/flow-protocol');

const SERVER_FILE = 'server.mjs';

/*
 * Every layout this file has ever run in, most specific first.
 *
 * The environment variable is first because it is the escape hatch for the case
 * nobody predicted, and because the integration suites use it to point a test
 * run at a checkout. `process.resourcesPath` is defined in the Electron backend
 * (it is forked with ELECTRON_RUN_AS_NODE and Electron still sets it), and is
 * the packaged answer. The rest are the working tree, from whichever directory
 * the backend happened to be started in.
 */
function candidates() {
    const list = [];
    if (process.env.STUDIO_FLOW_MCP) { list.push(path.resolve(process.env.STUDIO_FLOW_MCP)); }
    if (process.resourcesPath) { list.push(path.join(process.resourcesPath, 'app', 'flow-mcp', SERVER_FILE)); }
    list.push(path.resolve(__dirname, '..', 'flow-mcp', SERVER_FILE));
    const cwd = process.cwd();
    /*
     * Both spellings of the package's source directory. This repository calls
     * it `src/` because the files are hand-written; the studio-desktop checkout
     * this package is vendored from still calls it `lib/`. The same file has to
     * resolve in either, so it tries both rather than encoding one of them.
     */
    for (const dir of ['src', 'lib']) {
        list.push(path.resolve(cwd, 'product-ext', dir, 'flow-mcp', SERVER_FILE));
        list.push(path.resolve(cwd, 'app', 'product-ext', dir, 'flow-mcp', SERVER_FILE));
        list.push(path.resolve(cwd, '..', 'app', 'product-ext', dir, 'flow-mcp', SERVER_FILE));
    }
    return list;
}

class FlowToolsService {

    async describe() {
        const tried = candidates();
        const server = tried.find(file => { try { return fs.statSync(file).isFile(); } catch (e) { return false; } });
        /*
         * `process.execPath` rather than the string "node". In a packaged
         * application it is the Electron binary, which runs a script as node
         * when ELECTRON_RUN_AS_NODE is set — so registering the server does not
         * also require the person to have installed node, which is the commonest
         * way an MCP registration that looks correct never starts.
         */
        const runtime = {
            command: process.execPath,
            env: process.versions && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
        };
        if (!server) {
            return {
                ok: false, server: undefined, runtime,
                why: 'the flow MCP server was not found. Looked in:\n  ' + tried.join('\n  '),
                tried
            };
        }
        return { ok: true, server, runtime, tried };
    }
}

/*
 * One instance, outside the connection factory, for quality-backend.js's
 * reason: this answers a question about the machine, not about a session, and
 * a per-connection instance would be a per-tab copy of one immutable fact.
 */
const service = new FlowToolsService();

// A Symbol as the DI token, for quality-backend.js's reason: it only has to be
// unique, and cannot collide with another extension's identifier.
const FlowToolsToken = Symbol('FlowToolsService');

const connectionModule = ConnectionContainerModule.create(({ bind, bindBackendService }) => {
    bind(FlowToolsToken).toConstantValue(service);
    bindBackendService(FLOW_TOOLS_PATH, FlowToolsToken);
});

const mod = new ContainerModule(bind => {
    bind(ConnectionContainerModule).toConstantValue(connectionModule);
});

module.exports = mod;
module.exports.default = mod;
module.exports.FLOW_TOOLS_PATH = FLOW_TOOLS_PATH;
module.exports.FlowToolsService = FlowToolsService;
