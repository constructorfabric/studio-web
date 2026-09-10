// The workspace-source clone phase of the session entrypoint.
//
// This phase is what the boot splash exists to cover, so it is also where
// startup time is won or lost — and it had no coverage at all. The two things
// asserted here are the ones that broke silently: field parsing (a source
// carrying a token but no branch used to clone with `--branch <token>`, which
// fails and prints the token into the container log) and concurrency (sources
// are independent directories, so the phase must cost the slowest repository
// rather than the sum).
//
// Like gate.test.mjs, the code under test is extracted from entrypoint.sh
// rather than copied, so this cannot drift away from what ships.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const hasBash = (() => {
  const probe = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
})();

if (!hasBash) {
  // A Windows checkout outside Git Bash has no bash on PATH. CI runs on
  // Linux, so the assertions below are still enforced before merge.
  console.log('workspace source clones: skipped (no bash on PATH)');
} else {
  const entrypoint = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
  const match = entrypoint.match(/^clone_source\(\) \{[\s\S]*?^fi$/m);
  assert.ok(match, 'entrypoint must contain the clone_source worker and the sources block');
  const block = match[0];
  assert.match(block, /STUDIO_SOURCES/, 'extracted block must include the sources loop');
  assert.match(block, /STUDIO_CLONE_JOBS/, 'extracted block must include the concurrency cap');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-clone-test-'));
  const script = path.join(directory, 'clone-block.sh');
  await writeFile(script, `#!/bin/bash\nset -euo pipefail\nWORKSPACE="$1"\nshift\n${block}\n`, 'utf8');

  const git = (args, cwd) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const runBlock = (workspace, env = {}) =>
    spawnSync('bash', [script, workspace], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  try {
    // ── Upstream repositories to clone from ──
    const upstream = path.join(directory, 'upstream');
    for (const name of ['a', 'b', 'c', 'd']) {
      const repo = path.join(upstream, name);
      await mkdir(repo, { recursive: true });
      git(['init', '-q', '.'], repo);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
    }
    const withBranch = path.join(upstream, 'd');
    git(['checkout', '-q', '-b', 'feature'], withBranch);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'feature'], withBranch);

    const workspace = path.join(directory, 'ws');
    await mkdir(path.join(workspace, 'already'), { recursive: true });
    await writeFile(path.join(workspace, 'already', 'file.txt'), 'keep', 'utf8');

    const token = 'clone-test-token';
    const sources = [
      { name: 'a', url: path.join(upstream, 'a') },
      // The regression: a token with no branch. `branch` is empty, and a tab
      // separator would collapse it and shift the token into its place.
      { name: 'b', url: path.join(upstream, 'b'), token },
      { name: 'c', url: path.join(upstream, 'c') },
      { name: 'd', url: withBranch, branch: 'feature', token },
      { name: 'already', url: path.join(upstream, 'a') },
      { name: 'broken', url: path.join(upstream, 'does-not-exist') },
    ];

    const run = runBlock(workspace, { STUDIO_SOURCES: JSON.stringify(sources) });
    const output = `${run.stdout}${run.stderr}`;

    // A failing source must not abort the session: the entrypoint runs under
    // `set -e`, and the IDE has to start with whatever did materialize.
    assert.equal(run.status, 0, `clone block exited ${run.status}: ${output}`);

    for (const name of ['a', 'b', 'c', 'd']) {
      const head = spawnSync('git', ['-C', path.join(workspace, name), 'branch', '--show-current'], {
        encoding: 'utf8',
      });
      assert.equal(head.status, 0, `source '${name}' was not cloned: ${output}`);
      if (name === 'd') {
        assert.equal(head.stdout.trim(), 'feature', "source 'd' must be on its requested branch");
      }
    }

    assert.match(output, /source 'already' already materialized/);
    assert.match(output, /WARNING: clone of 'broken' failed/);
    assert.ok(!output.includes(token), 'a token must never reach the session log');
    const config = await readFile(path.join(workspace, 'b', '.git', 'config'), 'utf8');
    assert.ok(!config.includes(token), 'a token must never land in .git/config');

    // ── Concurrency ──
    // Four stubbed clones of two seconds each: sequentially that is eight
    // seconds, so anything under five proves they overlap. The stub replaces
    // git on PATH rather than slowing a real clone, which keeps the assertion
    // about the loop instead of about network speed.
    const stubBin = path.join(directory, 'stub-bin');
    await mkdir(stubBin, { recursive: true });
    await writeFile(
      path.join(stubBin, 'git'),
      '#!/bin/bash\ndest="${@: -1}"\nsleep 2\nmkdir -p "$dest/.git"\n',
      { encoding: 'utf8', mode: 0o755 },
    );
    const parallelWorkspace = path.join(directory, 'ws-parallel');
    await mkdir(parallelWorkspace, { recursive: true });
    const started = Date.now();
    const parallel = runBlock(parallelWorkspace, {
      PATH: `${stubBin}${path.delimiter}${process.env.PATH}`,
      STUDIO_SOURCES: JSON.stringify(
        ['p', 'q', 'r', 's'].map((name) => ({ name, url: path.join(upstream, 'a') })),
      ),
      STUDIO_CLONE_JOBS: '4',
    });
    const elapsed = Date.now() - started;
    assert.equal(parallel.status, 0, `parallel run exited ${parallel.status}`);
    assert.ok(
      elapsed < 5000,
      `four 2s clones took ${elapsed}ms — they are running sequentially`,
    );

    console.log('workspace source clones parse every field and run concurrently');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
