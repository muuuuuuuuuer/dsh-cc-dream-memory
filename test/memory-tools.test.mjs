/**
 * What the model can do with its own memory: remove a note that no longer holds,
 * and see how old a note is when it reads one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { toolsEnv } from './v10-helpers.mjs';

const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };

test('memory_update can delete a note: it leaves the index and stays recoverable', async (t) => {
  const env = await toolsEnv(t);
  const saved = await env.pctx.store.saveEntry({ name: 'obsolete', type: 'project', description: 'old fact', content: 'no longer true' });
  const result = await env.definitions.get('memory_update').execute({ file: saved.file, delete: true }, exec);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.deleted, true);
  assert.deepEqual((await env.pctx.store.listEntries()).map((entry) => entry.file), []);
  assert.equal((await env.pctx.store.indexText()).includes('obsolete'), false);
  const trashed = await readdir(env.paths.trashRoot, { recursive: true });
  assert.ok(trashed.some((item) => item.endsWith(saved.file)), 'the note is in the recycle bin');
});

test('memory_save keeps a name clean when the model writes it like a file name', async (t) => {
  const env = await toolsEnv(t);
  const result = await env.definitions.get('memory_save').execute(
    { name: 'deploy-process.md', type: 'project', description: 'how we deploy', content: 'Deploy with make release.' }, exec);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.file, 'project_deploy_process.md');
  const [entry] = await env.pctx.store.listEntries();
  assert.equal(entry.name, 'deploy-process');
});

test('deleting a note that does not exist is a clear error', async (t) => {
  const env = await toolsEnv(t);
  const result = await env.definitions.get('memory_update').execute({ file: 'project_nope.md', delete: true }, exec);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NOT_FOUND');
});

test('in confirm mode a delete waits for the human, and approval carries it out', async (t) => {
  const env = await toolsEnv(t, { writeMode: 'confirm' });
  const saved = await env.pctx.store.saveEntry({ name: 'review_me', type: 'project', description: 'd', content: 'body' });
  const queued = await env.definitions.get('memory_update').execute({ file: saved.file, delete: true }, exec);
  assert.equal(queued.written, false);
  assert.ok(queued.pendingId);
  assert.deepEqual((await env.pctx.store.listEntries()).map((entry) => entry.file), [saved.file], 'nothing happens before approval');
  const approved = await env.mods.pending.approvePendingWrite(env.pctx.paths, queued.pendingId, { store: env.pctx.store, source: { sessionId: 's', via: 'tool:memory_update' } });
  assert.equal(approved.written, true);
  assert.deepEqual(await env.pctx.store.listEntries(), []);
});

test('a read-only subagent cannot delete', async (t) => {
  const env = await toolsEnv(t, { subagentWriteMode: 'off' });
  const saved = await env.pctx.store.saveEntry({ name: 'keep', type: 'project', description: 'd', content: 'body' });
  const child = { agent: { id: 'child', session: { header: { parentSession: 'parent' } } }, sessionId: 'child' };
  const result = await env.definitions.get('memory_update').execute({ file: saved.file, delete: true }, child);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'subagent-readonly');
  assert.equal((await env.pctx.store.listEntries()).length, 1);
});

test('memory_read says how old a note is and warns when it is old', async (t) => {
  const env = await toolsEnv(t);
  const saved = await env.pctx.store.saveEntry({ name: 'fresh', type: 'project', description: 'd', content: 'body' });
  const fresh = await env.definitions.get('memory_read').execute({ file: saved.file }, exec);
  assert.equal(fresh.ageDays, 0);
  assert.equal(fresh.staleness, undefined);

  const realNow = Date.now;
  Date.now = () => realNow() + 45 * 24 * 60 * 60 * 1000;
  t.after(() => { Date.now = realNow; });
  const old = await env.definitions.get('memory_read').execute({ file: saved.file }, exec);
  assert.equal(old.ageDays, 45);
  assert.match(old.staleness, /45 days/);
});

test('the over-budget warning points at something the model can actually do', async (t) => {
  const env = await toolsEnv(t, { indexMaxLines: 2 });
  let last;
  for (let i = 0; i < 3; i += 1) {
    last = await env.pctx.store.saveEntry({ name: `n${i}`, type: 'project', description: `note ${i}`, content: `body ${i}` });
  }
  assert.match(last.warning ?? last.index?.warning ?? '', /delete/i);
});

test('injected guidance covers dates, reasons, verification and past sessions', async () => {
  const { buildInjectionText } = await import('../src/inject.js');
  const text = buildInjectionText({ memoryDir: 'x', index: { text: '' }, config: {}, rules: '' });
  assert.match(text, /absolute date/i);
  assert.match(text, /\*\*Why:\*\*/);
  assert.match(text, /still exists/i);
  assert.match(text, /session_search/);
});
