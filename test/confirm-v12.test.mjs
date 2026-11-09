/**
 * v12 Bug 2: writeMode:'confirm' cannot be bypassed by force:true or by
 * memory_update; approving a queued update keeps `created`.
 * Contract `docs/superpowers/specs/2026-11-08-v12-review-fixes.md` Bug 2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsEnv } from './v10-helpers.mjs';

test('v12 confirm: force:true still queues a save under writeMode confirm', async (t) => {
  const env = await toolsEnv(t, { writeMode: 'confirm' });
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const saved = await env.definitions.get('memory_save').execute(
    { name: 'confirm force', type: 'user', description: 'd', content: 'a clean durable body', force: true },
    exec,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.written, false);
  assert.equal(saved.action, 'queued-review');
  assert.equal(typeof saved.pendingId, 'string');
  const pending = await env.mods.pending.listPendingWrites(env.pctx.paths);
  const record = pending.find((item) => item.id === saved.pendingId);
  assert.ok(record);
  assert.match(JSON.stringify(record.reasons), /confirm/i);
  assert.equal(await env.pctx.store.listEntries().then((entries) => entries.some((entry) => entry.name === 'confirm force')), false);
});

test('v12 confirm: memory_update queues an update that keeps created after approval', async (t) => {
  const env = await toolsEnv(t, { writeMode: 'confirm' });
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const seed = await env.pctx.store.saveEntry({
    name: 'update confirm',
    type: 'user',
    description: 'original description',
    content: 'ORIGINAL BODY',
  });
  const before = await env.pctx.store.readEntry(seed.file);

  const updated = await env.definitions.get('memory_update').execute(
    { file: seed.file, content: 'UPDATED BODY', description: 'new description' },
    exec,
  );
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.written, false);
  assert.equal(updated.action, 'queued-review');
  assert.equal(typeof updated.pendingId, 'string');
  const pending = await env.mods.pending.listPendingWrites(env.pctx.paths);
  const record = pending.find((item) => item.id === updated.pendingId);
  assert.ok(record, 'the pending record is listed');
  assert.equal(record.action, 'update', JSON.stringify(record));
  assert.equal(record.file, seed.file);
  assert.match(JSON.stringify(record), /UPDATED BODY/);

  const approved = await env.mods.pending.approvePendingWrite(env.pctx.paths, updated.pendingId, {
    store: env.pctx.store,
  });
  assert.equal(approved.written, true, JSON.stringify(approved));
  const after = await env.pctx.store.readEntry(seed.file);
  assert.match(after.body, /UPDATED BODY/, 'approval applies the queued body');
  assert.equal(after.frontmatter.created, before.frontmatter.created, 'created survives the queued update');
  assert.equal(after.frontmatter.description, 'new description');
});

test('v12 confirm: queued update+rename is applied atomically after approval', async (t) => {
  const env = await toolsEnv(t, { writeMode: 'confirm' });
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const seed = await env.pctx.store.saveEntry({
    name: 'old deployment name',
    type: 'project',
    description: 'old description',
    content: 'OLD BODY',
  });
  const before = await env.pctx.store.readEntry(seed.file);
  const queued = await env.definitions.get('memory_update').execute(
    { file: seed.file, name: 'deployment gcp', content: 'GCP BODY', description: 'GCP description' },
    exec,
  );
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(queued.written, false, 'confirm mode queues the rename');
  const record = (await env.mods.pending.listPendingWrites(env.pctx.paths)).find((item) => item.id === queued.pendingId);
  assert.equal(record.name, 'deployment gcp', 'pending record must retain the requested name');
  const approved = await env.mods.pending.approvePendingWrite(env.pctx.paths, queued.pendingId, {
    store: env.pctx.store,
  });
  assert.equal(approved.written, true, JSON.stringify(approved));
  const entries = await env.pctx.store.listEntries();
  assert.equal(entries.some((entry) => entry.file === seed.file), false, 'old file moved to trash');
  const renamed = entries.find((entry) => entry.name === 'deployment gcp');
  assert.ok(renamed, 'approved rename wrote the new name');
  const after = await env.pctx.store.readEntry(renamed.file);
  assert.equal(after.body, 'GCP BODY');
  assert.equal(after.frontmatter.description, 'GCP description');
  if (before.frontmatter.created) {
    assert.equal(after.frontmatter.created, before.frontmatter.created, 'created survives update+rename');
  }
  const index = await env.pctx.store.indexText();
  assert.match(index, /deployment gcp/i);
  assert.doesNotMatch(index, /old deployment name/i);
});

test('v12 confirm: without confirm, force writes immediately (unchanged)', async (t) => {
  const env = await toolsEnv(t);
  const saved = await env.definitions.get('memory_save').execute(
    { name: 'plain force', type: 'user', description: 'd', content: 'plain force body that is long enough', force: true },
    { agent: { id: 'agent-1' }, sessionId: 'sess-1' },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.written, true);
  assert.equal(typeof saved.file, 'string');
  const pending = await env.mods.pending.listPendingWrites(env.pctx.paths);
  assert.equal(pending.length, 0, 'no queue entry outside confirm mode');
});
