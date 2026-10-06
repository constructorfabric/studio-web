#!/usr/bin/env node
/**
 * One-off: move every tenant's repositories from the workspace settings
 * (`repos[]`) into the project config (`sources[]`), the one record the
 * backend and both portals read since the move to `project_sources`.
 *
 *   STUDIO_TOKEN=<platform-admin bearer> node scripts/migrate-project-sources.mjs \
 *       --base https://studio-dev-poc.cfabric.org/cf            # dry run: prints the plan
 *   ... --apply                                                  # writes it
 *
 * For each tenant under the platform root (organizations, workspaces,
 * projects), each git entry of its settings' `repos[]` becomes
 *
 *   { connection_id, full_path, clone_url, branch }
 *
 * in that same tenant's `project.config` `sources[]`. The connection is the
 * one whose `secret_ref` is the entry's `token_ref`, looked up on the tenant
 * and then its ancestors, the way the backend looks. An entry whose
 * repository the config already lists is skipped, so a second run changes
 * nothing. Entries the config already lists are written back verbatim, their
 * `share_mode` included; a moved entry gets none, which reads as `branch`
 * (commit straight to the branch, as before the choice existed).
 * `local` entries, `root_*` and every other settings field stay in
 * the settings: they describe a working copy, not the project's repositories.
 * Nothing is deleted.
 *
 * Plain fetch against the public REST API, so it runs against any stand
 * without a backend release; delete it once every environment has run it.
 */

const SETTINGS_TYPE = 'gts.cf.core.am.tenant_metadata.v1~cf.studio.workspace.settings.v1~';
const CONFIG_TYPE = 'gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~';
const ROOT_TENANT = '00000000-0000-0000-0000-000000000001';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const BASE = option('--base', process.env.STUDIO_BACKEND_URL ?? 'http://127.0.0.1:8090/cf').replace(/\/+$/, '');
const APPLY = flag('--apply');
const TOKEN = process.env.STUDIO_TOKEN;
if (!TOKEN) {
  console.error('STUDIO_TOKEN is not set: a platform-admin bearer token is needed to read every tenant.');
  process.exit(2);
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Every child of `tenant`, through the cursor pages. */
async function children(tenant) {
  const out = [];
  let cursor = null;
  for (let n = 0; n < 100; n++) {
    const q = new URLSearchParams({ limit: '200' });
    if (cursor) q.set('cursor', cursor);
    const page = await call('GET', `/account-management/v1/tenants/${tenant}/children?${q}`);
    out.push(...(page?.items ?? []));
    cursor = page?.page_info?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/** A tenant metadata value, or `null` when it has none. The GET answers the
 *  entry (`{ value }`); the PUT takes the bare value. */
async function metadata(tenant, type) {
  const entry = await call('GET', `/account-management/v1/tenants/${tenant}/metadata/${type}`);
  return entry?.value ?? null;
}

/** The connections a tenant's own catalogue lists (inherited ones included,
 *  as the API answers them). */
async function connections(tenant) {
  const page = await call('GET', `/studio-connector/v1/connections?tenant=${encodeURIComponent(tenant)}`);
  return page?.items ?? [];
}

/** `https://github.com/acme/api.git` → `acme/api`, as the backend's `repo_path_of`. */
function repoPath(url) {
  try {
    const path = new URL(url).pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
    return path || null;
  } catch {
    return null;
  }
}

/** What names a repository: host and path, case and `.git` aside. */
function repoKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}/${repoPath(url)}`.toLowerCase();
  } catch {
    return null;
  }
}

const report = { tenants: 0, withRepos: 0, added: 0, alreadyThere: 0, skipped: [], written: 0 };

async function migrate(tenant, ancestors) {
  report.tenants++;
  const settings = await metadata(tenant.id, SETTINGS_TYPE);
  const repos = Array.isArray(settings?.repos) ? settings.repos : [];
  const git = repos.filter((r) => r && r.source !== 'local' && typeof r.url === 'string' && r.url.trim());
  if (git.length > 0) {
    report.withRepos++;
    const config = (await metadata(tenant.id, CONFIG_TYPE)) ?? {};
    const sources = Array.isArray(config.sources) ? [...config.sources] : [];
    const listed = new Set(sources.map((s) => repoKey(s?.clone_url ?? '')).filter(Boolean));
    // The tenant, then its ancestors: where its connections can be.
    let catalogue = null;
    const added = [];
    for (const repo of git) {
      const url = repo.url.trim();
      const key = repoKey(url);
      if (key && listed.has(key)) {
        report.alreadyThere++;
        continue;
      }
      catalogue ??= (await Promise.all([tenant.id, ...ancestors].map(connections))).flat();
      const connection = repo.token_ref ? catalogue.find((c) => c.secret_ref === repo.token_ref) : undefined;
      const fullPath = repoPath(url);
      if (!fullPath) {
        report.skipped.push(`${tenant.name} (${tenant.id}): ${repo.name} — "${url}" names no repository`);
        continue;
      }
      if (!connection) {
        // Still the project's repository: it clones without credentials.
        report.skipped.push(
          `${tenant.name} (${tenant.id}): ${repo.name} — no connection with secret_ref "${repo.token_ref ?? ''}"; moved without one`,
        );
      }
      const source = { full_path: fullPath, clone_url: url };
      if (connection) source.connection_id = connection.id;
      if (typeof repo.branch === 'string' && repo.branch.trim()) source.branch = repo.branch.trim();
      added.push(source);
      if (key) listed.add(key);
    }
    if (added.length > 0) {
      report.added += added.length;
      console.log(`${APPLY ? 'write' : 'would write'} ${tenant.name} (${tenant.id}):`);
      for (const s of added) console.log(`  + ${s.full_path}  ${s.clone_url}${s.branch ? `  @${s.branch}` : ''}${s.connection_id ? '' : '  (no connection)'}`);
      if (APPLY) {
        await call('PUT', `/account-management/v1/tenants/${tenant.id}/metadata/${CONFIG_TYPE}`, {
          ...config,
          sources: [...sources, ...added],
        });
        report.written++;
      }
    }
  }
  for (const child of await children(tenant.id)) {
    await migrate(child, [tenant.id, ...ancestors]);
  }
}

await migrate({ id: ROOT_TENANT, name: 'platform root' }, []);
console.log(
  `\n${APPLY ? 'Applied' : 'Dry run'}: ${report.tenants} tenants read, ${report.withRepos} with settings repositories; ` +
    `${report.added} to add, ${report.alreadyThere} already in the config` +
    (APPLY ? `, ${report.written} configs written.` : '. Re-run with --apply to write.'),
);
if (report.skipped.length) console.log(`\nNotes (${report.skipped.length}):\n  ${report.skipped.join('\n  ')}`);
