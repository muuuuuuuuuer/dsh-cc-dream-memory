/**
 * v11 step 1: dream undo safety (hashes, conflicts, legacy batches).
 * Contract `docs/superpowers/specs/2026-11-07-v11-user-six-steps.md` §1.
 * os.tmpdir(); mock LLM only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv, httpEnv, callHttp, exists, scriptDream, claimOf } from './v10-helpers.mjs';

const TOUCHED = 'user_touch_target.md';
// The Dream adds one cited line to TOUCHED and creates one page from a claim.
const CREATED = 'releases-go-out-on-fridays.md';

async function dream(env) {
  await scriptDream(env, {
    sessions: { s1: ['Use pnpm, not npm.', 'Releases go out on Fridays.'] },
    claims: [claimOf('Use pnpm, not npm.', { target: TOUCHED, kind: 'preference' }), claimOf('Releases go out on Fridays.')],
  });
  const ready = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(ready.ready, true, JSON.stringify(ready).slice(0, 400));
  const switched = await env.runtime.switchDream({ pctx: env.pctx, agent: env.pctx.agent });
  assert.equal(switched.ok, true, JSON.stringify(switched).slice(0, 400));
  return switched;
}

async function seedEnv(t) {
  const env = await runtimeEnv(t);
  await env.pctx.store.saveEntry({
    name: 'touch target',
    type: 'user',
    description: 'original description',
    content: 'ORIGINAL BODY',
  });
  await env.pctx.store.saveEntry({
    name: 'untouched note',
    type: 'user',
    description: 'never touched by the dream',
    content: 'untouched original body',
  });
  await dream(env);
  return env;
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function snapshotMemory(env) {
  const names = await readdir(env.pctx.paths.memoryDir).catch(() => []);
  const snapshot = {};
  for (const name of names.sort()) {
    snapshot[name] = await readIfExists(path.join(env.pctx.paths.memoryDir, name));
  }
  return snapshot;
}

async function batchWithMeta(env) {
  const names = (await readdir(env.pctx.paths.dreamsDir).catch(() => [])).filter((name) => !name.endsWith('.json')).sort();
  for (const name of names.slice().reverse()) {
    const metaPath = path.join(env.pctx.paths.dreamsDir, name, 'meta.json');
    const raw = await readIfExists(metaPath);
    if (!raw) continue;
    const meta = JSON.parse(raw);
    if (meta && meta.hashes) return { dir: name, meta };
  }
  return null;
}

test('v11 undo: dream meta records hashes/created/rewritten for touched files', async (t) => {
  const env = await seedEnv(t);
  const batch = await batchWithMeta(env);
  assert.ok(batch, 'the apply batch meta.json must contain hashes');
  const { meta } = batch;
  assert.ok(meta.hashes && typeof meta.hashes === 'object');
  for (const file of [TOUCHED, CREATED]) {
    assert.match(String(meta.hashes[file]), /^sha256:[0-9a-f]{64}$/, `hash for ${file}`);
  }
  assert.ok(Array.isArray(meta.rewritten) && meta.rewritten.includes(TOUCHED));
  assert.ok(Array.isArray(meta.created) && meta.created.includes(CREATED));
});

test('v11 undo: undo restores touched files and preserves later edits to untouched files', async (t) => {
  const env = await seedEnv(t);
  // Edit a file the dream never touched.
  const untouchedBefore = await env.pctx.store.readEntry('user_untouched_note.md');
  await env.pctx.store.updateEntry('user_untouched_note.md', { content: 'USER EDIT AFTER DREAM' });
  assert.match((await env.pctx.store.readEntry('user_untouched_note.md')).body, /USER EDIT AFTER DREAM/);

  const result = await env.runtime.undoLastDream(env.pctx, { agent: { id: 'agent-undo' } });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 500));
  assert.equal(result.batch, (await batchWithMeta(env))?.dir);

  const touched = await env.pctx.store.readEntry(TOUCHED);
  assert.equal(touched.body.trim(), 'ORIGINAL BODY', 'the touched file is restored from the pre-dream backup');
  const untouched = await env.pctx.store.readEntry('user_untouched_note.md');
  assert.match(untouched.body, /USER EDIT AFTER DREAM/, 'later edits to untouched files survive the undo');
  assert.equal(untouchedBefore.body.trim(), 'untouched original body');
});

test('v11 undo: undo refuses when a touched file changed (conflict), leaving the disk untouched', async (t) => {
  const env = await seedEnv(t);
  await env.pctx.store.updateEntry(TOUCHED, { content: 'USER EDIT AFTER DREAM' });
  const before = await snapshotMemory(env);
  const indexBefore = await env.pctx.store.indexText();

  const result = await env.runtime.undoLastDream(env.pctx, { agent: { id: 'agent-undo' } });
  assert.equal(result.ok, false, JSON.stringify(result).slice(0, 500));
  assert.equal(result.error, 'conflict');
  assert.ok(Array.isArray(result.conflicts) && result.conflicts.length >= 1, JSON.stringify(result));
  const conflict = result.conflicts.find((item) => item.file === TOUCHED);
  assert.ok(conflict, `conflicts should list ${TOUCHED}: ${JSON.stringify(result.conflicts)}`);
  assert.match(String(conflict.expected), /^sha256:/);
  assert.match(String(conflict.actual), /^sha256:/);
  assert.notEqual(conflict.expected, conflict.actual);

  const after = await snapshotMemory(env);
  assert.deepEqual(after, before, 'a refused undo must not change any memory file');
  assert.equal(await env.pctx.store.indexText(), indexBefore, 'a refused undo must not change the index');
});

test('v11 undo: files created after the dream are not trashed by undo', async (t) => {
  const env = await seedEnv(t);
  await env.pctx.store.saveEntry({
    name: 'new after dream',
    type: 'user',
    description: 'created after the dream',
    content: 'brand new body',
  });
  const newFile = (await env.pctx.store.listEntries()).find((entry) => entry.name === 'new after dream').file;

  const result = await env.runtime.undoLastDream(env.pctx, { agent: { id: 'agent-undo' } });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
  assert.equal(result.trashed.includes(newFile), false, 'post-dream files are not moved to trash');
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, newFile)), true, 'post-dream files stay in memory/');
});

test('v11 undo: a folder without switch metadata is neither history nor undoable', async (t) => {
  const env = await httpEnv(t);
  const otherDir = path.join(env.pctx.paths.dreamsDir, '2026-01-01T00-00-00');
  await mkdir(otherDir, { recursive: true });
  await writeFile(path.join(otherDir, 'meta.json'), JSON.stringify({ kind: 'apply', appliedAt: 1, files: [] }), 'utf8');

  const res = await callHttp(env, { path: '/dream-history' });
  assert.equal(res.statusCode, 200, res.bodyText());
  assert.deepEqual(res.json().items, []);

  const undo = await env.runtime.undoLastDream(env.pctx);
  assert.equal(undo.ok, false);
  assert.equal(undo.error, 'no-undoable-batch');
});

test('v11 undo: GET /dream-history marks an undone batch as undone and no longer undoable', async (t) => {
  const env = await httpEnv(t);
  await env.pctx.store.saveEntry({ name: 'touch target', type: 'user', description: 'original', content: 'ORIGINAL BODY' });
  await dream(env);

  const before = (await callHttp(env, { path: '/dream-history' })).json().items.find((item) => item.undoable === true);
  assert.ok(before, 'the applied batch is listed');
  assert.equal(before.undoable, true);
  assert.equal(before.undone, false);

  const undo = await env.runtime.undoLastDream(env.pctx);
  assert.equal(undo.ok, true, JSON.stringify(undo).slice(0, 300));
  const after = (await callHttp(env, { path: '/dream-history' })).json().items.find((item) => item.ts === before.ts);
  assert.equal(after.undone, true, 'the history shows the batch was undone');
  assert.equal(after.undoable, false, 'an undone batch cannot be offered for undo again');
});

test('v11 undo: a second undo can restore the previous batch (consecutive undo)', async (t) => {
  const env = await seedEnv(t);
  const first = await env.runtime.undoLastDream(env.pctx);
  assert.equal(first.ok, true, JSON.stringify(first).slice(0, 300));

  // Dream the same sessions again, then undo twice in a row.
  await dream(env);
  const undo2 = await env.runtime.undoLastDream(env.pctx);
  assert.equal(undo2.ok, true, JSON.stringify(undo2).slice(0, 300));
  assert.notEqual(undo2.batch, first.batch);
});
