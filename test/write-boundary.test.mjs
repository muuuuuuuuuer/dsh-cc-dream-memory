import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsEnv } from './v10-helpers.mjs';

const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
const seed = (store, extra = {}) => store.saveEntry({ name: 'language', type: 'user', description: 'reply language', content: '用户喜欢中文回复。', ...extra });

test('force cannot turn a low-confidence save into active memory', async (t) => {
  const e = await toolsEnv(t);
  const r = await e.definitions.get('memory_save').execute({ name: 'guess', content: 'An unconfirmed inference.', confidence: 'low', force: true }, exec);
  assert.equal(r.action, 'queued-review');
  assert.equal(r.written, false);
  assert.equal((await e.pctx.store.listEntries()).length, 0);
});

test('low-confidence updates use the same queue even with force', async (t) => {
  const e = await toolsEnv(t);
  const saved = await seed(e.pctx.store);
  const r = await e.definitions.get('memory_update').execute({ file: saved.file, content: 'Unconfirmed replacement.', confidence: 'low', force: true }, exec);
  assert.equal(r.action, 'queued-review');
  assert.equal((await e.pctx.store.readEntry(saved.file)).body, '用户喜欢中文回复。');
  const approved = await e.mods.pending.approvePendingWrite(e.paths, r.pendingId, { store: e.pctx.store });
  assert.equal(approved.action, 'update');
  assert.equal((await e.pctx.store.readEntry(saved.file)).body, 'Unconfirmed replacement.');
});

test('a detected conflicting save cannot create a second active preference, including with force', async (t) => {
  const e = await toolsEnv(t);
  const saved = await seed(e.pctx.store);
  for (const force of [false, true]) {
    const r = await e.definitions.get('memory_save').execute({ name: 'reply preference', type: 'user', description: 'Chinese replies', content: '用户讨厌中文回复。', force }, exec);
    assert.equal(r.action, 'queued-review', JSON.stringify(r));
    assert.ok((await e.mods.pending.listPendingWrites(e.paths)).some((item) => item.id === r.pendingId));
    assert.equal(r.written, false);
    assert.equal(r.existingFile, saved.file);
  }
  assert.equal((await e.pctx.store.listEntries()).length, 1);
  const corrected = await e.definitions.get('memory_update').execute({ file: saved.file, content: '用户讨厌中文回复。' }, exec);
  assert.equal(corrected.ok, true);
  assert.equal((await e.pctx.store.readEntry(saved.file)).body, '用户讨厌中文回复。');
});

test('a cross-file conflict on update leaves both existing files unchanged', async (t) => {
  const e = await toolsEnv(t);
  await seed(e.pctx.store);
  const other = await seed(e.pctx.store, { name: 'other', description: 'another topic', content: 'A separate durable fact.' });
  const r = await e.definitions.get('memory_update').execute({ file: other.file, content: '用户讨厌中文回复。', description: 'Chinese replies', force: true }, exec);
  assert.equal(r.action, 'queued-review', JSON.stringify(r));
  assert.ok((await e.mods.pending.listPendingWrites(e.paths)).some((item) => item.id === r.pendingId));
  assert.equal((await e.pctx.store.readEntry(other.file)).body, 'A separate durable fact.');
});

test('approval refuses an update or deletion after the author edited its target', async (t) => {
  for (const deletion of [false, true]) {
    const e = await toolsEnv(t, { writeMode: 'confirm' });
    const saved = await seed(e.pctx.store);
    const r = await e.definitions.get('memory_update').execute({ file: saved.file, ...(deletion ? { delete: true } : { content: 'Proposed replacement.' }) }, exec);
    await e.pctx.store.updateEntry(saved.file, { content: 'Author edited this while review was pending.' });
    await assert.rejects(e.mods.pending.approvePendingWrite(e.paths, r.pendingId, { store: e.pctx.store }), { code: 'STALE_WRITE' });
    assert.equal((await e.pctx.store.readEntry(saved.file)).body, 'Author edited this while review was pending.');
    assert.ok((await e.mods.pending.listPendingWrites(e.paths)).some((p) => p.id === r.pendingId));
  }
});

test('a missing update target is rejected before confirm mode queues anything', async (t) => {
  const e = await toolsEnv(t, { writeMode: 'confirm' });
  const r = await e.definitions.get('memory_update').execute({ file: 'user_missing.md', content: 'replacement' }, exec);
  assert.equal(r.error, 'NOT_FOUND');
  assert.equal((await e.mods.pending.listPendingWrites(e.paths)).length, 0);
});
