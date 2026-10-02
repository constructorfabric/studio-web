import assert from 'node:assert/strict';
import './materialize-workspace.test.mjs';
import './clone-sources.test.mjs';
import './git-credentials.test.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const entrypoint = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
const match = entrypoint.match(/cat > \/tmp\/gate\.js <<'GATE'\r?\n([\s\S]*?)\r?\nGATE/);
assert.ok(match, 'entrypoint must contain the generated session gate');

const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-gate-test-'));
const gatePath = path.join(directory, 'gate.cjs');
await writeFile(gatePath, match[1], 'utf8');

const token = 'integration-test-token';
const child = spawn(process.execPath, [gatePath], {
  env: { ...process.env, STUDIO_SESSION_TOKEN: token, STUDIO_GATEWAY_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let gateStderr = '';
child.stderr.on('data', (chunk) => {
  gateStderr += chunk;
});
const gateExited = new Promise((resolve) => child.once('exit', resolve)).then((code) => {
  throw new Error(`the gate exited (${code}):\n${gateStderr}`);
});
gateExited.catch(() => {});

const request = (requestPath, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: 3003,
        path: requestPath,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ response, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
  });

try {
  let response;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      ({ response } = await request(`/?token=${encodeURIComponent(token)}`));
      break;
    } catch (error) {
      if (attempt === 39) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, './');
  assert.match(String(response.headers['set-cookie']), /studio_session_token=/);

  const cookie = String(response.headers['set-cookie']).split(';', 1)[0];
  const readiness = await request('/__studio_session_ready__');
  assert.equal(readiness.response.statusCode, 204);

  // There is deliberately no Theia process on port 3004 in this integration
  // test. The authenticated request therefore exercises the normal boot gap:
  // it must receive our non-cacheable splash as HTTP 200 so a CDN cannot
  // replace it with a generic Bad Gateway page.
  const starting = await request('/', { Cookie: cookie });
  assert.equal(starting.response.statusCode, 200);
  assert.match(String(starting.response.headers['cache-control']), /no-store/);
  assert.match(starting.body, /Constructor Studio is starting the IDE/);
  console.log('session gate keeps redirect and IDE boot splash CDN-safe');

  // A closed tab ends the IDE websocket while Theia is still writing to it.
  // On a stand that killed the gate with an unhandled EPIPE, and the session
  // stayed unreachable until it was recreated.
  const upstream = net.createServer((socket) => {
    socket.on('error', () => {});
    const timer = setInterval(() => socket.write('x'.repeat(64 * 1024)), 1);
    socket.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => upstream.listen(3004, '127.0.0.1', resolve));
  try {
    for (let round = 0; round < 5; round += 1) {
      const dropped = new Promise((resolve, reject) => {
        const client = net.connect(3003, '127.0.0.1', () => {
          client.write(
            'GET /services HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n' +
              `Upgrade: websocket\r\nCookie: ${cookie}\r\n\r\n`,
          );
        });
        client.on('error', () => {});
        client.once('data', () => {
          client.resetAndDestroy();
          setTimeout(resolve, 100);
        });
        setTimeout(() => reject(new Error('no upgrade traffic')), 5000).unref();
      });
      await Promise.race([dropped, gateExited]);
    }
    const after = await Promise.race([request('/__studio_session_ready__'), gateExited]);
    assert.equal(after.response.statusCode, 204, 'the gate survives a dropped websocket');
    assert.equal(child.exitCode, null, 'the gate process is still running');
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
  console.log('session gate survives a websocket the browser drops mid-stream');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await rm(directory, { recursive: true, force: true });
}
