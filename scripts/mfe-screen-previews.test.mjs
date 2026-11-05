// node --test scripts/mfe-screen-previews.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WORLD, answer, parseArgs, screenUrl, screensOf } from './mfe-screen-previews.mjs';

const SCREEN = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1';
const OVERLAY = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.overlay.v1';

test('the screens a manifest places, in the shell order, without overlays or hidden ones', () => {
  const m = screensOf(
    'projects-mfe',
    {
      extensions: [
        { domain: SCREEN, presentation: { label: 'Specs', route: '/projects/specs', order: 30, level: 'project', section: 'specs' } },
        { domain: SCREEN, presentation: { label: 'Overview', route: '/projects/overview', order: 10, level: 'project', section: 'overview' } },
        { domain: OVERLAY, presentation: { label: 'New project', route: '/projects/new' } },
        { domain: SCREEN, presentation: { label: 'Editor', route: '/space', placement: 'hidden' } },
      ],
    },
    { name: '@constructor-studio/projects-mfe', version: '0.1.0' },
  );
  assert.equal(m.name, '@constructor-studio/projects-mfe');
  assert.equal(m.version, '0.1.0');
  assert.deepEqual(
    m.screens.map((s) => s.route),
    ['/projects/overview', '/projects/specs'],
  );
});

test('a template or a fixture is not a micro-frontend of the product', () => {
  assert.equal(screensOf('_blank-mfe', { extensions: [] }, null), null);
});

test('a screen is addressed by its token, its level and its section', () => {
  const url = screenUrl('http://h', { route: '/projects/specs', level: 'project', section: 'specs' });
  assert.equal(
    url,
    `http://h/?screen=projects;org=${WORLD.org};workspace=${WORLD.workspace};project=${WORLD.project};section=specs`,
  );
  assert.equal(screenUrl('http://h', { route: '/people', level: 'organization', section: null }), `http://h/?screen=people;org=${WORLD.org}`);
});

test('the stand-in backend knows the one organization and answers the rest empty', () => {
  assert.equal(answer('GET', '/cf/account-management/v1/me')[1].subject_tenant_id, WORLD.org);
  const [, kids] = answer('GET', `/cf/account-management/v1/tenants/${WORLD.org}/children?limit=200`);
  assert.deepEqual(kids.items.map((t) => t.id), [WORLD.workspace]);
  assert.deepEqual(answer('GET', '/cf/studio-tasks/v1/runs?limit=1')[1].items, []);
  assert.equal(answer('GET', `/cf/account-management/v1/tenants/${WORLD.org}/metadata/x`)[0], 404);
  assert.equal(answer('POST', '/cf/anything')[0], 200);
});

test('flags take a value unless the next one is a flag', () => {
  assert.deepEqual(parseArgs(['--out', 'x', '--verbose', '--only', 'a,b']), { out: 'x', verbose: true, only: 'a,b' });
});
