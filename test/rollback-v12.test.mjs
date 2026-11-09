/**
 * v12 Bug 3: selective dream rollback must not discard concurrent writes.
 * Contract `docs/superpowers/specs/2026-11-08-v12-review-fixes.md` Bug 3.
 * Mock LLM; os.tmpdir().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv, writePlanOf, exists } from './v10-helpers.mjs';

const A = 'user_rollback_a.md';
const B = 'user_rollback_b.md';
const PLAN = writePlanOf(
  [
    {
      op: 'write',
      scope: 'project',
      type: 'user',
      name: 'rollback a',
      description: 'first op',
      body: 'DREAM BODY A',
      file: A,
    },
    {
      op: 'write',
      scope: 'project',
      type: 'user',
      name: 'rollback b',
      description: 'second op fails',
      body: 'DREAM BODY B',
      file: B,
    },
  ],
  { summary: 'rollback safety plan' },
);

/** Store wrapper whose second write simulates concurrent user writes and fails. */
function failingStore(store, { onSecondWrite }) {
  let writes = 0;
  const proxy = Object.create(store);
  proxy.writeRawEntry = async function writeRawEntry(file, input) {
    writes += 1;
    if (writes === 2) {
      await onSecondWrite();
      throw new Error('forced dream write failure');
    }
    return store.writeRawEntry(file, input);
  };
  proxy.__writes = () => writes;
  return proxy;
}

test('v12 rollback: concurrent writes survive; a concurrently-edited touched file is skipped with a conflict', async (t) => {
  const env = await runtimeEnv(t, {}, { plan: PLAN });
  const concurrentName = 'concurrent note';
  const store = failingStore(env.pctx.store, {
    onSecondWrite: async () => {
      // A file the dream never touches: must survive the rollback.
      await env.pctx.store.saveEntry({
        name: concurrentName,
        type: 'user',
        description: 'written during the dream',
        content: 'CONCURRENT UNTOUCHED BODY',
      });
      // A file the dream already rewrote: the user edits it mid-apply.
      await env.pctx.store.updateEntry(A, { content: 'CONCURRENT EDIT OF A' });
    },
  });
  const pctx = { ...env.pctx, store };

  const result = await env.runtime.dream({ pctx, force: true, trigger: 'manual' });
  assert.notEqual(result.applied, true, JSON.stringify(result).slice(0, 400));
  assert.equal(result.rolledBack, true, JSON.stringify(result).slice(0, 400));

  const entries = await env.pctx.store.listEntries();
  const concurrent = entries.find((entry) => entry.name === concurrentName);
  assert.ok(concurrent, 'a file written concurrently during the dream is preserved');
  assert.match((await env.pctx.store.readEntry(concurrent.file)).body, /CONCURRENT UNTOUCHED BODY/);

  const touched = await env.pctx.store.readEntry(A);
  assert.match(touched.body, /CONCURRENT EDIT OF A/, 'the concurrent edit of a touched file wins (rollback skips it)');
  const conflict = (result.conflicts ?? []).find((item) => item.file === A);
  assert.ok(conflict, `the rollback reports the skipped touched file: ${JSON.stringify(result.conflicts)}`);
  assert.equal(typeof conflict.reason, 'string');
  // The failed second op never landed.
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, B)), false);

  // The pre-rollback snapshot exists for forensics.
  const batchNames = await readdir(env.pctx.paths.dreamsDir).catch(() => []);
  assert.equal(
    batchNames.some((name) => name.endsWith('-rollback')),
    true,
    `expected a .dreams/<ts>-rollback/ snapshot: ${batchNames.join(', ')}`,
  );
  const rollbackDir = path.join(env.pctx.paths.dreamsDir, batchNames.find((name) => name.endsWith('-rollback')));
  const snapshotFiles = await readdir(rollbackDir);
  assert.equal(snapshotFiles.includes(A), true, 'the snapshot captured the memory state before rollback');
  const changelog = await readFile(env.pctx.paths.changelogFile, 'utf8');
  assert.match(changelog, /rollback/i);
});
