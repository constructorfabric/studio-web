// The session credential helper. What matters here is not that it answers,
// but that it refuses: it holds a personal token that can push to a person's
// repositories, and a git process in a session is steered by repository
// config, submodules and — through Orca — by an agent acting on repository
// content. So every case below that expects an empty answer is the point of
// the test, and the "no token in the output" assertions guard the rest.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./git-credentials.mjs', import.meta.url));

const SOURCE_TOKEN = 'source-token-for-one-repo';
const PERSONAL_TOKEN = 'personal-token-for-the-user';
const SOURCES = JSON.stringify([
  { name: 'web', url: 'https://github.com/acme/studio-web', token: SOURCE_TOKEN },
  // A source with no token of its own: the personal token has to cover it.
  { name: 'docs', url: 'https://github.com/acme/docs' },
]);

const ask = (request, env = {}, action = 'get') => {
  const result = spawnSync(process.execPath, [helper, action], {
    input: `${Object.entries(request).map(([k, v]) => `${k}=${v}`).join('\n')}\n\n`,
    encoding: 'utf8',
    env: { STUDIO_SOURCES: SOURCES, STUDIO_GIT_PAT: PERSONAL_TOKEN, ...env },
  });
  assert.equal(result.status, 0, `helper exited ${result.status}: ${result.stderr}`);
  const answer = {};
  for (const line of result.stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) answer[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return { answer, stdout: result.stdout };
};

// ── A source's own token is used for that source's own repository ──
{
  const { answer } = ask({ protocol: 'https', host: 'github.com', path: 'acme/studio-web.git' });
  assert.equal(answer.username, 'oauth2');
  assert.equal(answer.password, SOURCE_TOKEN, 'a repository must get its own token');
}

// ── The personal token covers the rest of a known host ──
{
  const { answer } = ask({ protocol: 'https', host: 'github.com', path: 'acme/docs' });
  assert.equal(answer.password, PERSONAL_TOKEN, 'a tokenless source falls back to the personal token');
}
{
  // A repository on the same host that is not a configured source at all —
  // an agent cloning a dependency, say. Same host, so the personal token is
  // the right answer; the alternative is a session where nothing works.
  const { answer } = ask({ protocol: 'https', host: 'github.com', path: 'acme/unrelated' });
  assert.equal(answer.password, PERSONAL_TOKEN);
}

// ── Refusals ──
for (const [what, request, env] of [
  ['an unknown host', { protocol: 'https', host: 'evil.example.com', path: 'acme/studio-web' }, {}],
  ['a lookalike host', { protocol: 'https', host: 'github.com.evil.example.com', path: 'acme/docs' }, {}],
  ['a non-http protocol', { protocol: 'ssh', host: 'github.com', path: 'acme/docs' }, {}],
  ['no host at all', { protocol: 'https' }, {}],
  ['no tokens in the environment', { protocol: 'https', host: 'github.com', path: 'acme/docs' },
    { STUDIO_GIT_PAT: '', STUDIO_SOURCES: JSON.stringify([{ name: 'web', url: 'https://github.com/acme/studio-web' }]) }],
]) {
  const { stdout } = ask(request, env);
  assert.equal(stdout.trim(), '', `${what} must get no credentials`);
}

// ── A malformed STUDIO_SOURCES must not take the personal token down with it ──
{
  const { answer } = ask(
    { protocol: 'https', host: 'github.com', path: 'acme/docs' },
    { STUDIO_SOURCES: '{not json', STUDIO_ROOT_URL: 'https://github.com/acme/root' },
  );
  assert.equal(answer.password, PERSONAL_TOKEN, 'the root URL still establishes the host');
}

// ── Nothing is persisted, so store and erase have nothing to say ──
for (const action of ['store', 'erase']) {
  const { stdout } = ask(
    { protocol: 'https', host: 'github.com', path: 'acme/studio-web', username: 'oauth2', password: SOURCE_TOKEN },
    {},
    action,
  );
  assert.equal(stdout.trim(), '', `${action} must write nothing`);
}

// ── The shipping configuration, exercised through git itself ──
// A helper that returns the right answer is only half of it: git has to be
// configured to call it, and `credential.useHttpPath` has to be on or the
// per-source match above can never fire. Both lines are read out of
// entrypoint.sh, and the path they name is checked against the Dockerfile, so
// none of the three can drift apart silently.
{
  const entrypoint = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
  const useHttpPath = entrypoint.match(/^git config --global credential\.useHttpPath (\S+)$/m);
  const helperLine = entrypoint.match(/^git config --global credential\.helper '(.+)'$/m);
  assert.ok(useHttpPath, 'entrypoint must enable credential.useHttpPath');
  assert.equal(useHttpPath[1], 'true');
  assert.ok(helperLine, 'entrypoint must configure a credential helper');

  const installedPath = helperLine[1].match(/(\/\S+\.mjs)/)?.[1];
  assert.ok(installedPath, 'the helper line must name the installed script');
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.ok(
    dockerfile.includes(`docker/git-credentials.mjs ${installedPath}`),
    `the image must install docker/git-credentials.mjs at ${installedPath}`,
  );

  // Run git with the entrypoint's own configuration, pointed at this
  // checkout's copy of the helper, and isolated from the developer's git
  // config — a machine-wide helper would otherwise answer first, or hang on
  // a GUI prompt, and this would be a test of that instead.
  const quotedHelper = `"${helper.split(path.sep).join('/')}"`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-credential-test-'));
  try {
    const emptyConfig = path.join(directory, 'empty.gitconfig');
    await writeFile(emptyConfig, '');
    const filled = spawnSync(
      'git',
      [
        '-c', `credential.useHttpPath=${useHttpPath[1]}`,
        // git runs a `!`-prefixed helper through a shell, which eats Windows
        // backslashes; the container path is POSIX already, so this only
        // matters for running the test on a Windows checkout.
        '-c', `credential.helper=${helperLine[1].replace(installedPath, quotedHelper)}`,
        'credential', 'fill',
      ],
      {
        input: ['protocol=https', 'host=github.com', 'path=acme/studio-web.git', '', '']
          .join('\n'),
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: emptyConfig,
          GIT_CONFIG_SYSTEM: emptyConfig,
          GIT_TERMINAL_PROMPT: '0',
          STUDIO_SOURCES: SOURCES,
          STUDIO_GIT_PAT: PERSONAL_TOKEN,
        },
      },
    );
    assert.equal(filled.status, 0, `git credential fill failed: ${filled.stderr}`);
    assert.match(filled.stdout, /username=oauth2/);
    assert.match(
      filled.stdout,
      new RegExp(`password=${SOURCE_TOKEN}`),
      'git must resolve the source token through the configured helper',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

console.log('session credential helper answers for known remotes only, and git uses it');
