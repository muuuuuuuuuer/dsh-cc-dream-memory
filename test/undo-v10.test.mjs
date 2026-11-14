/**
 * v10 P1-6: dream batch meta + undo + dream history.
 * Contract §1. os.tmpdir(); mock LLM only (no real dream call).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv, commandEnv, httpEnv, callHttp, exists, scriptDream, claimOf } from './v10-helpers.mjs';

// The Dream adds one cited line to the existing note and creates one page.
const NEW_FILE = 'releases-go-out-on-fridays.md';

async function dreamOnto(env, file) {
  await scriptDream(env, {
    sessions: { s1: ['Use pnpm, not npm.', 'Releases go out on Fridays.'] },
    claims: [claimOf('Use pnpm, not npm.', { target: file, kind: 'preference' }), claimOf('Releases go out on Fridays.')],
  });
  const ready = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(ready.ready, true, JSON.stringify(ready).slice(0, 400));
  const switched = await env.runtime.switchDream({ pctx: env.pctx, agent: env.pctx.agent });
  assert.equal(switched.ok, true, JSON.stringify(switched).slice(0, 400));
  return switched;
}

async function seedUndoEnv(t) {
  const env = await runtimeEnv(t);
  // Original body that the dream will extend.
  const original = await env.pctx.store.saveEntry({
    name: 'undo target',
    type: 'user',
    description: 'original description',
    content: 'ORIGINAL BODY',
  });
  await dreamOnto(env, original.file);
  return { ...env, original };
}

/** Backup batches only: v2 run folders live beside them and hold manifest.json. */
async function batchDirs(env) {
  const names = await readdir(env.pctx.paths.dreamsDir).catch(() => []);
  const batches = [];
  for (const name of names.filter((item) => !item.endsWith('.json')).sort()) {
    if (await exists(path.join(env.pctx.paths.dreamsDir, name, 'meta.json'))) batches.push(name);
  }
  return batches;
}

test('v10 undo: an applied dream writes a meta.json batch record', async (t) => {
  const env = await seedUndoEnv(t);
  const dirs = await batchDirs(env);
  assert.ok(dirs.length >= 1, 'the apply created a backup batch');
  const batchDir = path.join(env.pctx.paths.dreamsDir, dirs.at(-1));
  const metaPath = path.join(batchDir, 'meta.json');
  assert.equal(await exists(metaPath), true, '.dreams/<ts>/meta.json must be written');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  assert.equal(typeof meta.stamp, 'string');
  assert.equal(typeof meta.appliedAt, 'number');
  assert.equal(meta.kind, 'dream-switch', `kind: ${meta.kind}`);
  assert.ok(Array.isArray(meta.files), 'meta lists the touched files');
  assert.equal(meta.files.includes('user_undo_target.md'), true);
});

test('v10 undo: undoLastDream restores files, trashes new files and reconciles the index', async (t) => {
  const env = await seedUndoEnv(t);
  const changed = await env.pctx.store.readEntry(env.original.file);
  assert.match(changed.body, /Use pnpm, not npm./);

  const undo = await env.runtime.undoLastDream(env.pctx, { agent: { id: 'agent-undo' } });
  assert.equal(undo.ok, true, JSON.stringify(undo).slice(0, 500));
  assert.equal(typeof undo.batch, 'string');
  assert.equal(undo.restored.includes(env.original.file), true, 'the overwritten file is restored from the backup');

  const restored = await env.pctx.store.readEntry(env.original.file);
  assert.equal(restored.body.trim(), 'ORIGINAL BODY', 'the pre-dream body is back');
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, NEW_FILE)), false, 'dream-created files are removed from memory/');
  assert.ok(Array.isArray(undo.trashed), 'trashed lists the removed files');
  const trashListing = await env.pctx.store.countTrash?.();
  const undoTrashDir = path.join(env.pctx.paths.trashRoot, `${undo.batch}-undo`);
  const undoTrashExists = await exists(undoTrashDir);
  const trashFiles = undoTrashExists ? await readdir(undoTrashDir) : [];
  assert.equal(
    undo.trashed.includes(NEW_FILE) || trashFiles.some((file) => file.includes('releases-go-out-on-fridays')),
    true,
    'new files are moved to the undo trash',
  );
  const audit = await env.pctx.store.auditIndex();
  assert.equal(audit.missing.length, 0, 'the index is reconciled after undo');
  const indexText = await env.pctx.store.indexText();
  assert.equal(indexText.includes(NEW_FILE), false, 'the dream-created index line is removed');

  const changelog = await readFile(env.pctx.paths.changelogFile, 'utf8');
  assert.match(changelog, /undo of/i);
  assert.match(changelog, /restored:/i);

  // Nothing left to undo.
  const again = await env.runtime.undoLastDream(env.pctx);
  assert.equal(again.ok, false);
  assert.equal(again.error, 'no-undoable-batch');
});

test('v10 undo: no applied batch returns no-undoable-batch', async (t) => {
  const env = await runtimeEnv(t);
  const result = await env.runtime.undoLastDream(env.pctx);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no-undoable-batch');
});

test('v10 undo: GET /dream-history lists only Dream switches', async (t) => {
  const env = await httpEnv(t);
  // A folder without switch metadata (a run artifact) is not a switch.
  const otherDir = path.join(env.pctx.paths.dreamsDir, '2026-01-01T00-00-00');
  await mkdir(otherDir, { recursive: true });
  await writeFile(path.join(otherDir, 'MEMORY.md'), '', 'utf8');

  const res = await callHttp(env, { path: '/dream-history' });
  assert.equal(res.statusCode, 200, res.bodyText());
  const body = res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.items, [], 'only switches are history');

  assert.equal((await callHttp(env, { path: '/dream-history', token: 'bad-token' })).statusCode, 401);
});

test('v10 undo: /memory dream history and /memory dream undo commands', async (t) => {
  const env = await commandEnv(t);
  const original = await env.pctx.store.saveEntry({
    name: 'undo target',
    type: 'user',
    description: 'original description',
    content: 'ORIGINAL BODY',
  });
  await dreamOnto(env, original.file);

  const history = await env.invokeMemory('dream history');
  assert.equal(history.kind, 'success', history.text);
  assert.match(history.text, /apply|2026|batch/i);

  const undo = await env.invokeMemory('dream undo');
  assert.equal(undo.kind, 'success', undo.text);
  assert.match(undo.text, /undo|restor/i);
});
