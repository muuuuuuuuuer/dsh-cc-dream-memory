/**
 * Read-only data the redesigned Memory page needs: per-entry trust facts on
 * `/status` (hot set, host ledger, STATUS marker), pending-write details and
 * the Dream v2 coverage carried by the plan preview.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callHttp, httpEnv, memoryFile, writePlan } from './v10-helpers.mjs';
import { recordVerification } from '../src/verification-ledger.js';
import { shapeManifest, writeRunManifest } from '../src/dream-run.js';

async function seed(env, file, meta, body) {
  await writeFile(path.join(env.pctx.paths.memoryDir, file), memoryFile(meta, body), 'utf8');
}

test('status: entries carry ledger and STATUS trust facts', async (t) => {
  const env = await httpEnv(t);
  const store = env.pctx.store;
  await seed(env, 'project_verified.md', { name: 'Verified', type: 'project', description: 'verified' }, 'STATUS: current\nfact');
  await seed(env, 'project_edited.md', { name: 'Edited', type: 'project', description: 'changed' }, 'STATUS: current\nold fact');
  await seed(env, 'project_stale.md', { name: 'Stale', type: 'project', description: 'old' }, 'STATUS: stale\nold');
  await seed(env, 'user_plain.md', { name: 'Plain', type: 'user', description: 'no markers' }, 'plain note');
  for (const file of ['project_verified.md', 'project_edited.md']) {
    const read = await store.readEntry(file, 'project');
    await recordVerification({
      store, scope: 'project', file, name: read.frontmatter.name, description: read.frontmatter.description,
      body: read.body, date: '2026-11-10', source: 'dream',
    });
  }
  await seed(env, 'project_edited.md', { name: 'Edited', type: 'project', description: 'changed' }, 'STATUS: current\nnew fact');

  const status = (await callHttp(env, { path: '/status?sessionId=s1' })).json();
  assert.equal(status.ok, true);
  const byFile = Object.fromEntries(status.entries.map((entry) => [entry.file, entry]));
  assert.deepEqual(byFile['project_verified.md'].verified, { date: '2026-11-10', source: 'dream' });
  assert.equal(byFile['project_verified.md'].status, 'current');
  assert.equal(byFile['project_edited.md'].verified, null, 'an edit voids the ledger record');
  assert.equal(byFile['project_edited.md'].verifiedOutdated, true);
  assert.equal(byFile['project_stale.md'].current, false);
  assert.equal(byFile['project_stale.md'].status, 'stale');
  assert.equal(byFile['user_plain.md'].status, '');
  assert.equal(byFile['user_plain.md'].current, true);
  assert.equal(byFile['user_plain.md'].verifiedOutdated, false);
});

test('status: carries the UI data contract version', async (t) => {
  const env = await httpEnv(t);
  const status = (await callHttp(env, { path: '/status?sessionId=s1' })).json();
  const { UI_API } = await import('../src/status.js');
  assert.equal(status.uiApi, UI_API);
});

test('status: dream runs carry each run status and counts', async (t) => {
  const env = await httpEnv(t);
  const runId = '2026-11-12T09-00-00-abcdef';
  await writeRunManifest(
    path.join(env.pctx.paths.dreamsDir, runId),
    shapeManifest({ runId, status: 'failed', stage: 'analyze', counts: { done: 1, failed: 2, pending: 0 } }),
  );
  const res = await callHttp(env, { token: env.token, path: '/status?sessionId=s1' });
  assert.equal(res.statusCode, 200, res.bodyText());
  const [run] = res.json().dreamRuns;
  assert.equal(run.runId, runId);
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.counts, { done: 1, failed: 2, pending: 0 });
});
