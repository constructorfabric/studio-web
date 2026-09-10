#!/usr/bin/env node
// git credential helper for a session container.
//
// The credentials are already in this container: the studio-session gear
// resolves repository tokens from credstore and passes them in STUDIO_SOURCES
// (and STUDIO_ROOT_TOKEN), and a personal token in STUDIO_GIT_PAT. What was
// missing was any git configuration that uses them, so a `git push` by a
// person in a terminal — or by an agent in one of Orca's worktrees — failed
// with "could not read Username" instead of authenticating.
//
// The rule is deliberately narrow: answer only for hosts this workspace
// actually uses, so a token cannot be handed to some unrelated host that a
// repository's config, a submodule or an agent decides to contact.
//
//   1. a per-source token whose host AND path match the request wins;
//   2. otherwise the personal token answers, but only for a known host;
//   3. anything else gets no answer at all — git then fails without a prompt
//      (GIT_TERMINAL_PROMPT=0), which is the correct outcome.
//
// `store` and `erase` do nothing: nothing is persisted, so every git
// invocation re-reads the environment and a rotated token takes effect at
// once. Nothing here writes to stdout except the credential protocol, and
// errors are swallowed — a broken helper must not stall or spam a git command.

const [action] = process.argv.slice(2);

/** Read git's key=value request from stdin (terminated by a blank line/EOF). */
async function readRequest() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const request = {};
    for (const line of Buffer.concat(chunks).toString('utf8').split(/\r?\n/)) {
        if (!line) continue;
        const separator = line.indexOf('=');
        if (separator > 0) {
            request[line.slice(0, separator)] = line.slice(separator + 1);
        }
    }
    return request;
}

/** A URL's host, or undefined when it is not one git would ask us about. */
function hostOf(url) {
    try {
        return new URL(url).host || undefined;
    } catch {
        return undefined;
    }
}

/** `/org/repo.git` and `org/repo` compare equal; git sends the latter. */
function normalizePath(value) {
    return (value ?? '').replace(/^\/+/, '').replace(/\.git$/, '').toLowerCase();
}

/** Every remote this workspace was built from, with the token it carries. */
function knownRemotes() {
    const remotes = [];
    const add = (url, token) => {
        const host = hostOf(url);
        if (host) {
            remotes.push({ host, path: normalizePath(new URL(url).pathname), token });
        }
    };
    try {
        for (const source of JSON.parse(process.env.STUDIO_SOURCES ?? '[]')) {
            add(source?.url, source?.token);
        }
    } catch {
        // A malformed STUDIO_SOURCES must not take the personal token with it.
    }
    if (process.env.STUDIO_ROOT_URL) {
        add(process.env.STUDIO_ROOT_URL, process.env.STUDIO_ROOT_TOKEN);
    }
    return remotes;
}

function resolve(request) {
    if (request.protocol && request.protocol !== 'https' && request.protocol !== 'http') {
        return undefined; // ssh and friends do not use this path
    }
    const host = request.host;
    if (!host) {
        return undefined;
    }
    const remotes = knownRemotes();
    const path = normalizePath(request.path);

    // A source token is scoped to its own repository, so it is only offered
    // when the request is for that repository. `credential.useHttpPath` is
    // what makes git send the path at all; the entrypoint sets it.
    const exact = remotes.find(
        (remote) => remote.host === host && remote.token && path && remote.path === path,
    );
    if (exact) {
        return exact.token;
    }

    const personal = process.env.STUDIO_GIT_PAT?.trim();
    if (personal && remotes.some((remote) => remote.host === host)) {
        return personal;
    }
    return undefined;
}

async function main() {
    if (action !== 'get') {
        return; // store / erase: nothing is kept, so there is nothing to do
    }
    const token = resolve(await readRequest());
    if (!token) {
        return;
    }
    // "oauth2" satisfies both GitHub and GitLab personal access tokens; the
    // token is the password in either case.
    process.stdout.write(`username=oauth2\npassword=${token}\n`);
}

main().catch(() => {
    // Silence is a valid answer in the credential protocol. Anything printed
    // here would either leak or confuse git.
});
