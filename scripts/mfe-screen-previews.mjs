#!/usr/bin/env node
/**
 * Pictures of every micro-frontend screen of a built FrontX shell.
 *
 * Serves the shell's `dist/` on a free local port, signs the browser in with a
 * made-up session, answers every backend call with an empty, well-formed
 * response, visits each screen the micro-frontends' `mfe.json` place, and
 * takes a picture of each. With `--upload` the pictures are handed to the
 * components catalogue (`POST /studio-components-catalog/v1/screen-previews`),
 * where the product map shows them on the micro-frontend's card.
 *
 * Nothing here talks to a real backend or IdP except the upload. What the
 * pictures show is therefore each screen as a signed-in user with one
 * organization, one workspace and one empty project sees it: the layout, the
 * navigation and the screen's empty state, never real data.
 *
 *   node scripts/mfe-screen-previews.mjs \
 *     --dist studio-frontend/dist \
 *     --mfes studio-frontend/src-app/mfe_packages \
 *     --out  previews \
 *     [--commit <sha>] \
 *     [--upload <api base, e.g. https://host/cf> --org <organization id>]
 *
 * The upload's bearer is read from STUDIO_TOKEN. Playwright is resolved from
 * PLAYWRIGHT_MODULE (a path to its package directory) or as `playwright`;
 * PLAYWRIGHT_CHANNEL picks an installed browser (`chrome`) over the bundled one.
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── arguments ───────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

// ── what to visit ───────────────────────────────────────────────────────────

const SCREEN_DOMAIN = /frontx\.screensets\.layout\.screen\.v1/;

/**
 * The screens one package's `mfe.json` places, in the shell's order. A
 * package whose directory starts with `_` is a template or a fixture, not a
 * micro-frontend of the product.
 */
export function screensOf(dir, mfeJson, packageJson) {
  if (dir.startsWith('_')) return null;
  const name = packageJson?.name ?? dir;
  const version = packageJson?.version ?? null;
  const screens = (mfeJson.extensions ?? [])
    .filter((e) => SCREEN_DOMAIN.test(e.domain ?? ''))
    .map((e) => ({
      route: e.presentation?.route ?? null,
      label: e.presentation?.label ?? null,
      level: e.presentation?.level ?? 'organization',
      section: e.presentation?.section ?? null,
      order: e.presentation?.order ?? 1000,
      hidden: e.presentation?.placement === 'hidden',
    }))
    // A hidden screen is opened from another one, on something it names (the
    // editor, on an artifact): an empty project has nothing to open it on.
    .filter((s) => typeof s.route === 'string' && s.route.startsWith('/') && !s.hidden)
    .sort((a, b) => a.order - b.order || a.route.localeCompare(b.route));
  return { dir, name, version, screens };
}

export function readMfes(root) {
  const out = [];
  for (const dir of readdirSync(root).sort()) {
    const mfePath = join(root, dir, 'mfe.json');
    if (!existsSync(mfePath)) continue;
    const pkgPath = join(root, dir, 'package.json');
    const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null;
    const m = screensOf(dir, JSON.parse(readFileSync(mfePath, 'utf8')), pkg);
    if (m && m.screens.length) out.push(m);
  }
  return out;
}

// ── the made-up world the shell is shown ────────────────────────────────────

export const WORLD = {
  platform: '00000000-0000-0000-0000-000000000001',
  org: '5c0e0000-0000-4000-8000-0000000000a1',
  workspace: '5c0e0000-0000-4000-8000-0000000000b1',
  project: '5c0e0000-0000-4000-8000-0000000000c1',
  user: '5c0e0000-0000-4000-8000-0000000000f1',
};

const TENANT_TYPES = {
  platform: 'gts.cf.core.am.tenant_type.v1~cf.core.am.platform.v1~',
  organization: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~',
  workspace: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~',
  project: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~',
};

const STAMP = '2026-01-01T00:00:00Z';

function tenant(id) {
  const t = {
    [WORLD.platform]: ['Platform', TENANT_TYPES.platform, null, 0],
    [WORLD.org]: ['Example organization', TENANT_TYPES.organization, WORLD.platform, 1],
    [WORLD.workspace]: ['Example workspace', TENANT_TYPES.workspace, WORLD.org, 2],
    [WORLD.project]: ['Example project', TENANT_TYPES.project, WORLD.workspace, 3],
  }[id];
  if (!t) return null;
  const [name, type, parent, depth] = t;
  return {
    id,
    name,
    status: 'active',
    tenant_type: type,
    parent_id: parent,
    self_managed: false,
    depth,
    child_count: depth < 3 ? 1 : 0,
    created_at: STAMP,
    updated_at: STAMP,
  };
}

const CHILD = { [WORLD.platform]: WORLD.org, [WORLD.org]: WORLD.workspace, [WORLD.workspace]: WORLD.project };

const page = (items) => ({ items, total: items.length, page_info: { next_cursor: null, prev_cursor: null, limit: 200 } });

/** An unsigned token with the claims the shell reads a name from. */
export function fakeToken() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: WORLD.user,
    name: 'Preview User',
    preferred_username: 'preview',
    email: 'preview@example.com',
    iat: now,
    exp: now + 3600,
  })}.`;
}

/**
 * What the stand-in backend answers: `[status, body]`. Accounts and the
 * caller's membership are answered from {@link WORLD}; every other read is an
 * empty page, which every list in the shell reads as "nothing yet".
 */
export function answer(method, url) {
  const u = new URL(url, 'http://x');
  const p = u.pathname;
  if (method !== 'GET') return [200, {}];
  if (p === '/cf/account-management/v1/me')
    return [200, { subject_id: WORLD.user, subject_type: 'user', subject_tenant_id: WORLD.org }];
  let m = p.match(/^\/cf\/account-management\/v1\/tenants\/([^/]+)$/);
  if (m) return tenant(m[1]) ? [200, tenant(m[1])] : [404, { title: 'Not found', status: 404 }];
  m = p.match(/^\/cf\/account-management\/v1\/tenants\/([^/]+)\/children$/);
  if (m) return [200, page(CHILD[m[1]] ? [tenant(CHILD[m[1]])] : [])];
  m = p.match(/^\/cf\/account-management\/v1\/tenants\/([^/]+)\/users$/);
  if (m)
    return [200, page([{ id: WORLD.user, username: 'preview', email: 'preview@example.com', display_name: 'Preview User' }])];
  if (/\/metadata\//.test(p)) return [404, { title: 'Not found', status: 404 }];
  if (p === '/cf/studio-user/v1/me/memberships')
    return [200, page([{ user_id: WORLD.user, org_id: WORLD.org, role: 'owner', status: 'active', source: 'assignment', org_name: 'Example organization' }])];
  if (p === '/cf/studio-documents/v1/spec-rows')
    return [200, { items: [], total: 0, sources: { files_known: true, reviews_known: true, repos_known: true, counts: [] } }];
  return [200, page([])];
}

// ── the stand-in server ─────────────────────────────────────────────────────

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

/** Serve `dist` with the shell's fallback to `index.html`, a token endpoint,
 *  and {@link answer} for `/cf/`. Resolves to its origin. */
export function serve(dist, log = () => {}) {
  const root = resolve(dist);
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const path = decodeURIComponent(url.split('?')[0]);
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (path === '/env.js') {
      const origin = `http://${req.headers.host}`;
      return send(200, TYPES['.js'], `window.__STUDIO_ENV__ = ${JSON.stringify({ OIDC_ISSUER: `${origin}/__idp`, OIDC_CLIENT_ID: 'preview' })};`);
    }
    if (path === '/__idp/protocol/openid-connect/token') {
      return send(200, TYPES['.json'], JSON.stringify({ access_token: fakeToken(), expires_in: 3600, refresh_token: 'preview', token_type: 'Bearer' }));
    }
    if (path.startsWith('/cf/')) {
      if (path.endsWith('/stream')) {
        // An event stream that says nothing and stays open.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(': preview\n\n');
        return undefined;
      }
      const [status, body] = answer(req.method ?? 'GET', url);
      log(`${req.method} ${url} -> ${status}`);
      return send(status, TYPES['.json'], JSON.stringify(body));
    }
    let file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    return send(200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

// ── the browser ─────────────────────────────────────────────────────────────

async function loadPlaywright() {
  const from = process.env.PLAYWRIGHT_MODULE;
  if (from) {
    const entry = join(from, 'index.mjs');
    return import(pathToFileURL(existsSync(entry) ? entry : join(from, 'index.js')).href);
  }
  return import('playwright');
}

/**
 * The shell's address of a screen (ADR-0028): `?screen=` with the token (the
 * route's first segment), the level parameters as far down as the screen's
 * level goes, and its section.
 */
export function screenUrl(origin, screen) {
  const token = screen.route.split('/').filter(Boolean)[0];
  const entry = [token, `org=${WORLD.org}`];
  if (screen.level === 'workspace' || screen.level === 'project') entry.push(`workspace=${WORLD.workspace}`);
  if (screen.level === 'project') entry.push(`project=${WORLD.project}`);
  if (screen.section) entry.push(`section=${screen.section}`);
  return `${origin}/?screen=${entry.join(';')}`;
}

/** A PNG screenshot made a smaller WebP in the page itself: no image library. */
async function toWebp(page, png, width) {
  return page.evaluate(
    async ({ b64, width: w }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const h = Math.round((img.height * w) / img.width);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return { url: c.toDataURL('image/webp', 0.8), width: w, height: h };
    },
    { b64: png.toString('base64'), width },
  );
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'local';
  }
}

async function upload(base, org, token, body) {
  const url = `${base.replace(/\/$/, '')}/studio-components-catalog/v1/screen-previews${org ? `?organization_id=${encodeURIComponent(org)}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`upload ${body.component} ${body.route}: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dist = args.dist ?? 'studio-frontend/dist';
  const mfesRoot = args.mfes ?? 'studio-frontend/src-app/mfe_packages';
  const outDir = args.out ?? 'mfe-screen-previews';
  const commit = typeof args.commit === 'string' ? args.commit : gitCommit();
  const width = Number(args.width ?? 960);
  const only = typeof args.only === 'string' ? args.only.split(',') : null;
  const verbose = Boolean(args.verbose);
  if (args.upload && !process.env.STUDIO_TOKEN) throw new Error('--upload needs STUDIO_TOKEN');

  const mfes = readMfes(mfesRoot).filter((m) => !only || only.includes(m.dir));
  const { server, origin } = await serve(dist, verbose ? (l) => console.log('  api', l) : undefined);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  // A session the shell restores on load: the refresh token it looks for.
  await context.addInitScript(() => sessionStorage.setItem('studio.oidc.refresh', 'preview'));
  // The framework's developer-panel button floats over every screen; it is
  // not part of any of them.
  await context.addInitScript(() =>
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '.fixed.z-\\[10000\\] { display: none !important; }';
      document.head.append(style);
    }),
  );
  const tab = await context.newPage();
  if (verbose) tab.on('pageerror', (e) => console.log('  pageerror', String(e).slice(0, 200)));
  mkdirSync(outDir, { recursive: true });
  const index = [];
  try {
    for (const mfe of mfes) {
      for (const [order, screen] of mfe.screens.entries()) {
        const url = screenUrl(origin, screen);
        await tab.goto(url, { waitUntil: 'networkidle' });
        // Module Federation loads the remote after the shell settles.
        await tab.waitForTimeout(Number(args.settle ?? 2500));
        const png = await tab.screenshot();
        const shot = await toWebp(tab, png, width);
        const file = `${mfe.dir}${screen.route.replace(/[^a-z0-9]+/gi, '-')}.webp`;
        writeFileSync(join(outDir, file), Buffer.from(shot.url.split(',')[1], 'base64'));
        const entry = {
          component: mfe.name,
          version: mfe.version,
          commit,
          route: screen.route,
          label: screen.label,
          order,
          width: shot.width,
          height: shot.height,
          file,
          landed: tab.url().replace(origin, ''),
        };
        index.push(entry);
        console.log(`${mfe.name} ${screen.route} -> ${file} (${Math.round(shot.url.length / 1365)} KiB) at ${entry.landed}`);
        if (args.upload) {
          const { file: _f, landed: _l, ...body } = entry;
          await upload(args.upload, args.org, process.env.STUDIO_TOKEN, { ...body, image: shot.url });
        }
      }
    }
  } finally {
    writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    await browser.close();
    server.close();
  }
  console.log(`${index.length} screen(s) of ${mfes.length} micro-frontend(s)${args.upload ? ', uploaded' : ''}; commit ${commit}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
