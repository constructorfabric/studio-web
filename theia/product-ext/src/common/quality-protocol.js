/*
 * The one string both halves of the quality runner service have to agree on.
 *
 * `src/node/quality-backend.js` binds a backend service at this path;
 * `src/browser/quality-runner-client.js` opens a proxy to that same path. If
 * each side kept its own string literal, a rename on one side and not the
 * other would fail silently at runtime — the proxy would just never connect,
 * and probe() would report "unavailable" for a reason that has nothing to do
 * with whether the runner is actually installed. One shared module makes that
 * class of drift a `require` error instead, at load time, in both directions.
 *
 * CONTRACT-runner.md §5 is explicit that this file exports the path and
 * nothing else — no types, no defaults, no logic. There is nothing here that
 * could disagree with itself.
 */
const QUALITY_RUNNER_PATH = '/services/studio-quality-runner';

module.exports = { QUALITY_RUNNER_PATH };
