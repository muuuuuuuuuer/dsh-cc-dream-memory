import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdentity } from '../src/build-id.js';
import { httpEnv, callHttp } from './v10-helpers.mjs';

test('the build identity names the package that is actually loaded', () => {
  const identity = buildIdentity();
  assert.match(identity.id, /^[0-9a-f]{12}$/u);
  assert.match(identity.packageVersion, /^\d+\.\d+\.\d+/u);
  assert.equal(identity.files, identity.digests.length);
  assert.ok(identity.files >= 5);
  assert.equal(path.resolve(identity.rootDir), path.resolve(fileURLToPath(new URL('..', import.meta.url))));
  for (const entry of identity.digests) assert.match(entry, /^[\w./-]+:[0-9a-f]{16}$/u);
});

test('status names the build and the capabilities this Host mounted', async (t) => {
  const env = await httpEnv(t);
  await env.runtime.forAgent({ id: 's1' });
  const status = (await callHttp(env, { path: '/status?sessionId=s1' })).json();
  assert.equal(status.ok, true);
  assert.match(status.build.id, /^[0-9a-f]{12}$/u);
  assert.equal(status.build.packageVersion, buildIdentity().packageVersion);
  assert.equal(status.uiApi, 4);
  assert.deepEqual(status.capabilities, {
    dreamPipeline: 'v2',
    dreamRuns: true,
    claimMerge: true,
    explicitSaveLedger: true,
  });
});
