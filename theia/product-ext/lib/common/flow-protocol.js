/*
 * The one string both halves of the flow-tools service have to agree on, and
 * the shape of what that service answers.
 *
 * Same reasoning as quality-protocol.js: `lib/node/flow-backend.js` binds a
 * backend service at this path and `lib/browser/flow-tools-client.js` proxies
 * to it, and a rename on one side only would fail at runtime as "the tools are
 * not available here" — a sentence that is true for a completely different
 * reason than the one the reader would assume.
 */
const FLOW_TOOLS_PATH = '/services/studio-flow-tools';

module.exports = { FLOW_TOOLS_PATH };
