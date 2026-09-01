/*
 * The frontend's half of the flow-tools service — one question, asked once.
 *
 * "Where is the MCP server on this machine, and what runs it." The frontend
 * needs the answer to write a project's `.mcp.json`, and cannot work it out: a
 * bundle has no idea where the application was installed.
 *
 * CACHED, because the answer is a property of the installation and cannot
 * change while the window is open, and because provisioning asks for it at the
 * moment somebody presses a button.
 *
 * NEVER THROWS. A build with no backend service bound answers `ok: false` with
 * a sentence, and provisioning goes ahead without the registration — the
 * documents and the contract are most of what a flow is, and a project can be
 * registered by hand from REGISTER.md.
 */
const { RemoteConnectionProvider } =
    require('@theia/core/lib/browser/messaging/service-connection-provider');
const { FLOW_TOOLS_PATH } = require('../common/flow-protocol');

const UNAVAILABLE = 'the flow tools backend is not available in this build';

class FlowToolsClient {

    init(container) {
        if (this.service) { return this; }
        try {
            this.service = container.get(RemoteConnectionProvider).createProxy(FLOW_TOOLS_PATH);
        } catch (error) {
            console.warn('[studio] flow tools service unavailable', error);
            this.service = undefined;
        }
        return this;
    }

    /** @returns { ok, server, runtime: { command, env }, why } — never throws. */
    async describe() {
        if (this.cached) { return this.cached; }
        if (!this.service) { return { ok: false, why: UNAVAILABLE }; }
        try {
            this.cached = await this.service.describe();
        } catch (error) {
            this.cached = { ok: false, why: (error && error.message) || UNAVAILABLE };
        }
        return this.cached;
    }
}

const flowTools = new FlowToolsClient();

module.exports = { flowTools, FlowToolsClient };
