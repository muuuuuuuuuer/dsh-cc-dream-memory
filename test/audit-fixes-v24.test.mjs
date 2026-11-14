import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers.mjs';
import { runtimeEnv } from './v10-helpers.mjs';
import { listProposals, writeProposal } from '../src/inbox.js';

test('a later extraction merges into the same session proposal', async (t) => {
  const paths = { projectDir: await makeTempDir(t, 'inbox-merge-') };
  const first = await writeProposal(paths, {
    sessionId: 's1',
    items: [{ name: 'deploy', content: 'make release' }],
  });
  const second = await writeProposal(paths, {
    sessionId: 's1',
    items: [
      { name: 'deploy', content: 'make release' },
      { name: 'package manager', content: 'pnpm' },
    ],
  });
  const records = await listProposals(paths);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, first.id);
  assert.equal(records[0].id, second.id);
  assert.equal(records[0].items.length, 2);
  assert.ok(records[0].updatedAt >= records[0].createdAt);
});

test('a full inbox refuses a new session instead of evicting pending work', async (t) => {
  const paths = { projectDir: await makeTempDir(t, 'inbox-full-') };
  for (let index = 0; index < 5; index += 1) {
    const record = await writeProposal(paths, {
      sessionId: `s${index}`,
      items: [{ name: `note ${index}`, content: `content ${index}` }],
    });
    assert.ok(record);
  }
  const before = await listProposals(paths);
  const refused = await writeProposal(paths, {
    sessionId: 's6',
    items: [{ name: 'late', content: 'must not evict' }],
  });
  const after = await listProposals(paths);
  assert.equal(refused, null);
  assert.equal(after.length, 5);
  assert.deepEqual(after.map((record) => record.id).sort(), before.map((record) => record.id).sort());
});

test('reconcileIndex enforces the byte budget as well as the line cap', async (t) => {
  const env = await runtimeEnv(t, { indexMaxBytes: 640, indexMaxLines: 200 });
  for (let index = 0; index < 12; index += 1) {
    await env.pctx.store.saveEntry({
      scope: 'project',
      name: `long note ${index}`,
      type: 'project',
      description: `a deliberately long description that makes the index grow ${'x'.repeat(80)}`,
      content: `body ${index}`,
      source: { via: 'test' },
    });
  }
  await env.pctx.store.reconcileIndex('project');
  const raw = await env.pctx.store.indexText('project');
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 640, `index is ${Buffer.byteLength(raw, 'utf8')} bytes`);
  const head = await env.pctx.store.injectedIndex('project');
  assert.ok(head.text.length > 0);
});
