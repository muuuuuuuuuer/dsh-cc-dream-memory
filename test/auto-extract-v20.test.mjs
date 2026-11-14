/**
 * Auto-extraction (v20): a turn-end hook proposes durable notes, stages them
 * in the Inbox, never directly in the store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsEnv, commandEnv, waitFor } from './v10-helpers.mjs';
import { parseExtraction } from '../src/auto-extract.js';
import { listProposals, removeProposal, writeProposal } from '../src/inbox.js';
import { registerScheduler } from '../src/scheduler.js';

const now = Date.parse('2026-11-13T10:00:00Z');

function events() {
  return [
    {
      type: 'user/message',
      seq: 1,
      time: now - 1_000,
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'We deploy with make release. Remember that I prefer pnpm for this repo.' }],
      },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: now,
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Understood: releases use make release, and pnpm is the package manager.' }],
        },
      },
    },
  ];
}

function plan() {
  return {
    memories: [
      {
        name: 'deploy command',
        type: 'project',
        description: 'Releases use make release',
        content: 'Run `make release` to deploy.',
      },
    ],
  };
}

async function extractEnv(t, overrides = {}) {
  const env = await toolsEnv(t, {
    autoExtract: true,
    autoExtractEveryTurns: 1,
    autoDreamEnabled: false,
    ...overrides,
  }, { plan: JSON.stringify(plan()) });
  env.host.services.sessionQuery = {
    filterSessions: async () => [],
    readSession: async (id) => ({ session: { id, cwd: env.workspaceDir }, events: events() }),
  };
  const dispose = registerScheduler(env.host, env.runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  return env;
}

function turn(env, id = 's1') {
  env.host.emit('session/event', { id, header: { cwd: env.workspaceDir } }, { type: 'turn/end', time: now });
}

test('parseExtraction keeps valid proposals and ignores the model wrapper', () => {
  const items = parseExtraction('```json\n{"memories":[{"name":"x","type":"project","description":"d","content":"body"}]}\n```');
  assert.deepEqual(items, [{ name: 'x', type: 'project', description: 'd', content: 'body' }]);
  assert.deepEqual(parseExtraction('{"memories":[]}'), []);
  assert.deepEqual(parseExtraction('not json'), []);
  assert.deepEqual(parseExtraction('{"memories":[{"name":"","content":"x"}]}'), []);
});

test('a turn-end stages a proposal in the Inbox instead of writing memory', async (t) => {
  const env = await extractEnv(t);
  turn(env);
  const records = await waitFor(async () => {
    const list = await listProposals(env.pctx.paths);
    return list.length > 0 ? list : null;
  });
  const record = records[0];
  assert.equal(record.sessionId, 's1');
  assert.equal(record.items.length, 1);
  assert.equal(record.items[0].name, 'deploy command');
  assert.equal(record.status, 'pending');
  assert.equal((await env.pctx.store.listEntries()).length, 0, 'the main store is untouched');
  const state = await waitFor(async () => {
    const snapshot = env.pctx.state.snapshot();
    return snapshot.lastExtractAt > 0 ? snapshot : null;
  });
  assert.ok(state.lastExtractAttemptAt > 0);
  assert.equal(state.lastExtractReason, 'inbox');
  assert.equal(state.lastExtractCount, 1);
});

test('a write by the main agent skips extraction for that turn', async (t) => {
  const env = await extractEnv(t);
  turn(env);
  const list = await waitFor(async () => {
    const records = await listProposals(env.pctx.paths);
    return records.length > 0 ? records : null;
  });
  await removeProposal(env.pctx.paths, list[0].id);

  env.runtime.noteMemoryWrite('s1');
  turn(env);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await listProposals(env.pctx.paths)).length, 0, 'a model write is the mutex');
});

test('autoExtractEveryTurns waits for the Nth turn', async (t) => {
  const env = await extractEnv(t, { autoExtractEveryTurns: 2 });
  turn(env);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await listProposals(env.pctx.paths)).length, 0, 'turn 1 is not a multiple');

  turn(env);
  const records = await waitFor(async () => {
    const next = await listProposals(env.pctx.paths);
    return next.length > 0 ? next : null;
  });
  assert.equal(records.length, 1);
});

test('/memory inbox lists and accepts a proposal through memory_save', async (t) => {
  const env = await commandEnv(t, { autoExtract: true, autoDreamEnabled: false });
  const record = await writeProposal(env.pctx.paths, {
    sessionId: 's1',
    cwd: env.workspaceDir,
    items: plan().memories,
    model: 'fake',
    trigger: 'manual',
  });

  const listed = await env.invokeMemory('inbox list');
  assert.equal(listed.kind, 'success');
  assert.match(listed.text, new RegExp(record.id));
  assert.match(listed.text, /deploy command/);

  const accepted = await env.invokeMemory(`inbox accept ${record.id}`);
  assert.equal(accepted.kind, 'success', accepted.text);
  const entries = await env.pctx.store.listEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'deploy command');
  assert.equal((await listProposals(env.pctx.paths)).length, 0, 'accepted proposals are removed');
});
