/**
 * v10 P1-6: dream batch meta + undo + dream history.
 * Contract §1. os.tmpdir(); mock LLM only (no real dream call).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv, commandEnv, httpEnv, callHttp, exists, writePlanOf, streamOf } from './v10-helpers.mjs';

const APPLY_PLAN = writePlanOf(
  [
    {
      op: 'write',
      scope: 'project',
      type: 'user',
      name: 'undo target',
      description: 'note touched by a dream',
      body: 'dream-changed body',
      file: 'user_undo_target.md',
    },
    {
      op: 'write',
      scope: 'project',
      type: 'user',
      name: 'new from dream',
      description: 'new file created by a dream',
      body: 'new dream file body',
      file: 'user_new_from_dream.md',
    },
  ],
  { summary: 'undo test plan' },
);

async function seedUndoEnv(t) {
  const env = await runtimeEnv(t, {}, { plan: APPLY_PLAN });
  // Original body that the dream will overwrite.
  const original = await env.pctx.store.saveEntry({
    name: 'undo target',
    type: 'user',
    description: 'original description',
    content: 'ORIGINAL BODY',
  });
  const applied = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(applied.applied, true, JSON.stringify(applied).slice(0, 400));
  return { ...env, original };
}

async function batchDirs(env) {
  const names = await readdir(env.pctx.paths.dreamsDir).catch(() => []);
  return names.filter((name) => !name.endsWith('.json')).sort();
}

test('v10 undo: an applied dream writes a meta.json batch record', async (t) => {
  const env = await seedUndoEnv(t);
  const dirs = await batchDirs(env);
  assert.ok(dirs.length >= 1, 'the apply created a backup batch');
  const batchDir = path.join(env.pctx.paths.dreamsDir, dirs.at(-1));
  const metaPath = path.join(batchDir, 'meta.json');
  assert.equal(await exists(metaPath), true, '.dreams/<ts>/meta.json must be written');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  assert.equal(typeof meta.ts, 'string');
  assert.equal(typeof meta.appliedAt, 'number');
  assert.equal(meta.kind === 'apply' || meta.kind === 'apply-ops', true, `kind: ${meta.kind}`);
  assert.equal(typeof meta.ops, 'number');
  assert.ok(Array.isArray(meta.files), 'meta lists the touched files');
  assert.equal(meta.files.includes('user_undo_target.md'), true);
});

test('v10 undo: undoLastDream restores files, trashes new files and reconciles the index', async (t) => {
  const env = await seedUndoEnv(t);
  const changed = await env.pctx.store.readEntry(env.original.file);
  assert.match(changed.body, /dream-changed body/);

  const undo = await env.runtime.undoLastDream(env.pctx, { agent: { id: 'agent-undo' } });
  assert.equal(undo.ok, true, JSON.stringify(undo).slice(0, 500));
  assert.equal(typeof undo.batch, 'string');
  assert.equal(undo.restored.includes(env.original.file), true, 'the overwritten file is restored from the backup');

  const restored = await env.pctx.store.readEntry(env.original.file);
  assert.equal(restored.body.trim(), 'ORIGINAL BODY', 'the pre-dream body is back');
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, 'user_new_from_dream.md')), false, 'dream-created files are removed from memory/');
  assert.ok(Array.isArray(undo.trashed), 'trashed lists the removed files');
  const trashListing = await env.pctx.store.countTrash?.();
  const undoTrashDir = path.join(env.pctx.paths.trashRoot, `${undo.batch}-undo`);
  const undoTrashExists = await exists(undoTrashDir);
  const trashFiles = undoTrashExists ? await readdir(undoTrashDir) : [];
  assert.equal(
    undo.trashed.includes('user_new_from_dream.md') || trashFiles.some((file) => file.includes('user_new_from_dream')),
    true,
    'new files are moved to the undo trash',
  );
  const audit = await env.pctx.store.auditIndex();
  assert.equal(audit.missing.length, 0, 'the index is reconciled after undo');
  const indexText = await env.pctx.store.indexText();
  assert.equal(indexText.includes('user_new_from_dream'), false, 'the dream-created index line is removed');

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

test('v10 undo: GET /dream-history lists batches with undoable/hasMeta flags', async (t) => {
  const env = await httpEnv(t);
  // Legacy batch without meta.json: listed but not undoable.
  const legacyDir = path.join(env.pctx.paths.dreamsDir, '2026-01-01T00-00-00');
  await mkdir(legacyDir, { recursive: true });
  await writeFile(path.join(legacyDir, 'MEMORY.md'), '', 'utf8');

  const res = await callHttp(env, { path: '/dream-history' });
  assert.equal(res.statusCode, 200, res.bodyText());
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.items));
  const legacy = body.items.find((item) => item.ts === '2026-01-01T00-00-00');
  assert.ok(legacy, 'legacy batches are listed');
  assert.equal(legacy.hasMeta, false);
  assert.equal(legacy.undoable, false);

  assert.equal((await callHttp(env, { path: '/dream-history', token: 'bad-token' })).statusCode, 401);
});

test('v10 undo: /memory dream history and /memory dream undo commands', async (t) => {
  const env = await commandEnv(t, {}, { plan: APPLY_PLAN });
  await env.pctx.store.saveEntry({
    name: 'undo target',
    type: 'user',
    description: 'original description',
    content: 'ORIGINAL BODY',
  });
  const applied = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(applied.applied, true, JSON.stringify(applied).slice(0, 300));

  const history = await env.invokeMemory('dream history');
  assert.equal(history.kind, 'success', history.text);
  assert.match(history.text, /apply|2026|batch/i);

  const undo = await env.invokeMemory('dream undo');
  assert.equal(undo.kind, 'success', undo.text);
  assert.match(undo.text, /undo|restor/i);
});
