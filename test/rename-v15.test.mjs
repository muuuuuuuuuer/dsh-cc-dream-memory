import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeEnv } from './v10-helpers.mjs';

test('v15 memory_update rename: renameEntry moves file, index and keeps old version recoverable', async (t) => {
  const env = await runtimeEnv(t);
  const pctx = await env.runtime.storeFor(env.workspaceDir);
  const saved = await pctx.store.saveEntry({
    name: 'old deployment name',
    type: 'project',
    description: 'old description',
    content: 'the deployment moved to GCP',
  });
  const renamed = await pctx.store.renameEntry(saved.file, 'deployment gcp', { source: { via: 'tool:memory_update' } });
  assert.equal(renamed.renamed, true);
  assert.notEqual(renamed.file, saved.file);
  const entries = await pctx.store.listEntries();
  assert.equal(entries.some((entry) => entry.file === saved.file), false, 'old file is trashed');
  const current = entries.find((entry) => entry.file === renamed.file);
  assert.ok(current, 'new file exists');
  assert.equal(current.name, 'deployment gcp');
  const index = await pctx.store.indexText();
  assert.match(index, /deployment gcp/i);
  assert.doesNotMatch(index, /old deployment name/i);
});

test('v15 memory_update rename: renaming onto an existing name is refused', async (t) => {
  const env = await runtimeEnv(t);
  const pctx = await env.runtime.storeFor(env.workspaceDir);
  const first = await pctx.store.saveEntry({ name: 'alpha', type: 'user', description: 'a', content: 'alpha body' });
  await pctx.store.saveEntry({ name: 'beta', type: 'user', description: 'b', content: 'beta body' });
  await assert.rejects(
    () => pctx.store.renameEntry(first.file, 'beta'),
    (error) => error?.code === 'CONFLICT',
  );
});
