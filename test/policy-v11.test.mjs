/**
 * v11 step 2: write-policy advisory semantics.
 * Contract §2 (policy.js). os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsEnv, makeEnv, sleep } from './v10-helpers.mjs';

test('v11 policy: a very short body is written directly (no low-confidence gate)', async (t) => {
  const env = await toolsEnv(t);
  const save = env.definitions.get('memory_save');
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };

  const short = await save.execute(
    { name: 'brevity', type: 'user', description: 'reply style', content: '用户要求回答简短。' },
    exec,
  );
  assert.equal(short.ok, true, JSON.stringify(short));
  assert.equal(short.written !== false, true, 'a short body is no longer queued');
  assert.notEqual(short.action, 'queued-review');
  assert.equal(typeof short.file, 'string');
  const entry = await env.pctx.store.readEntry(short.file);
  assert.match(entry.body, /用户要求回答简短/);
});

test('v11 policy: "vitest --run ..." short bodies are written directly', async (t) => {
  const env = await toolsEnv(t);
  const save = env.definitions.get('memory_save');
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const result = await save.execute(
    { name: 'test cmd', type: 'reference', description: 'how to run tests', content: 'vitest --run --silent' },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.action, 'queued-review', 'short commands are durable notes, not low-confidence');
  assert.equal(typeof result.file, 'string');
  const pending = await env.mods.pending.listPendingWrites(env.pctx.paths);
  assert.equal(pending.length, 0, 'nothing lands in the review queue');
});

test('policy: conflicting writes stop and identify the owning memory', async (t) => {
  const env = await toolsEnv(t);
  const save = env.definitions.get('memory_save');
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  await save.execute(
    { name: 'language', type: 'user', description: 'reply language', content: '用户喜欢中文回复。' },
    exec,
  );

  // Same topic, opposite polarity, but worded differently enough to avoid the
  // duplicate gate: the tool refuses a second active contradictory fact.
  const conflicting = await save.execute(
    { name: 'reply preference', type: 'user', description: 'Chinese replies', content: '用户讨厌中文回复。' },
    exec,
  );
  assert.equal(conflicting.ok, true, JSON.stringify(conflicting));
  assert.equal(conflicting.written, false, 'a conflict must not become another active fact');
  assert.equal(conflicting.action, 'queued-review', JSON.stringify(conflicting));
  assert.ok((await env.mods.pending.listPendingWrites(env.pctx.paths)).some((item) => item.id === conflicting.pendingId));
  assert.ok(Array.isArray(conflicting.conflicts) && conflicting.conflicts.length >= 1, JSON.stringify(conflicting));
  const conflict = conflicting.conflicts[0];
  assert.equal(conflict.file, 'user_language.md');
  assert.equal(typeof conflict.reason, 'string');
  assert.equal(conflicting.error, undefined, 'conflicts no longer abort the save');

  const entries = await env.pctx.store.listEntries();
  assert.equal(entries.some((entry) => entry.name === 'language'), true);
  assert.equal(entries.some((entry) => entry.name === 'reply preference'), false);
});

test('v11 policy: a high-similarity duplicate is still blocked', async (t) => {
  const env = await toolsEnv(t);
  const save = env.definitions.get('memory_save');
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const first = await save.execute(
    { name: 'dup note', type: 'user', description: 'duplicate target', content: 'the same durable body' },
    exec,
  );
  assert.equal(first.ok, true, JSON.stringify(first));

  const duplicate = await save.execute(
    { name: 'dup note', type: 'user', description: 'duplicate target', content: 'the same durable body' },
    exec,
  );
  assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
  assert.equal(duplicate.written, false);
  assert.equal(duplicate.action, 'duplicate');
  assert.equal(typeof duplicate.existingFile, 'string');
});

test('v11 policy: possible-duplicate is advisory (write + candidates, not blocked)', async (t) => {
  const env = await toolsEnv(t);
  const save = env.definitions.get('memory_save');
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  await save.execute(
    { name: 'indent style', type: 'feedback', description: 'prefer tabs for indentation', content: 'Prefer tabs for indentation in code.' },
    exec,
  );
  const similar = await save.execute(
    {
      name: 'indent style preference',
      type: 'feedback',
      description: 'prefer tabs for indentation in code',
      content: 'Prefer tabs for indentation in all source files.',
    },
    exec,
  );
  assert.equal(similar.ok, true, JSON.stringify(similar));
  assert.notEqual(similar.written, false, 'possible-duplicate writes are no longer blocked');
  assert.ok(Array.isArray(similar.candidates) && similar.candidates.length >= 1, JSON.stringify(similar));
  assert.equal(typeof similar.candidates[0].file, 'string');
});

test('v11 policy: explicit confidence:"low" still queues for review', async (t) => {
  const env = await toolsEnv(t);
  const save = env.definitions.get('memory_save');
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const queued = await save.execute(
    { name: 'low confidence', type: 'user', description: 'maybe', content: 'a normal-length body for the queue', confidence: 'low' },
    exec,
  );
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(queued.written, false);
  assert.equal(queued.action, 'queued-review');
  assert.equal(typeof queued.pendingId, 'string');
  const pending = await env.mods.pending.listPendingWrites(env.pctx.paths);
  assert.ok(pending.some((item) => item.id === queued.pendingId));
});

test('v11 policy: evaluateWrite reports advisory payloads directly', async (t) => {
  const env = await makeEnv(t);
  const { evaluateWrite } = env.mods.policy;
  const entries = [
    { file: 'user_a.md', name: 'language', description: 'reply language', body: '用户喜欢中文回复。', type: 'user' },
  ];
  const short = evaluateWrite({
    candidate: { name: 'brevity', type: 'user', description: 'reply style', content: '用户要求回答简短。' },
    entries,
    config: env.config,
  });
  assert.equal(short.action, 'allow', JSON.stringify(short));

  const conflict = evaluateWrite({
    candidate: { name: 'reply preference', type: 'user', description: 'Chinese replies', content: '用户讨厌中文回复。' },
    entries,
    config: env.config,
  });
  assert.equal(conflict.action, 'conflict');
  assert.equal(conflict.advisory, true);
  assert.ok(Array.isArray(conflict.conflicts) && conflict.conflicts.length >= 1, JSON.stringify(conflict));
  assert.equal(conflict.conflicts[0].file, 'user_a.md');
  assert.equal(typeof conflict.conflicts[0].reason, 'string');
});
