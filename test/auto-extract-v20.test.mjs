/**
 * Auto-extraction (v24): a turn-end agent uses memory tools directly.
 *
 * The loop is bounded and runs in-process; writes go through memory_save. This
 * test scripts one tool-call turn followed by a final DONE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsEnv, commandEnv, waitFor } from './v10-helpers.mjs';
import { removeProposal, writeProposal } from '../src/inbox.js';
import { registerScheduler } from '../src/scheduler.js';
import { streamOf } from './v10-helpers.mjs';

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

function memorySaveCall(id = 'call-1') {
  return {
    type: 'block-end',
    block: {
      type: 'tool-call',
      id,
      name: 'memory_save',
      arguments: {
        name: 'deploy command',
        type: 'project',
        description: 'Releases use make release',
        content: 'Run `make release` to deploy.',
      },
    },
  };
}

/**
 * Fake a two-call loop: first a memory_save tool call, then DONE.
 * Any additional call returns DONE so the test can also assert the turn cap.
 */
function scriptToolLoop(env) {
  let calls = 0;
  env.host.services.llm.stream = (options) => {
    calls += 1;
    env.toolCalls = calls;
    if (calls === 1) {
      return streamOf([
        memorySaveCall(),
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]);
    }
    return streamOf([
      { type: 'text-delta', text: 'DONE' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
  };
  return () => calls;
}

async function extractEnv(t, overrides = {}) {
  const env = await toolsEnv(t, {
    autoExtract: true,
    autoExtractEveryTurns: 1,
    autoDreamEnabled: false,
    ...overrides,
  });
  scriptToolLoop(env);
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

test('a turn-end agent calls memory_save and writes the note directly', async (t) => {
  const env = await extractEnv(t);
  turn(env);
  const entries = await waitFor(async () => {
    const list = await env.pctx.store.listEntries();
    return list.length > 0 ? list : null;
  });
  assert.equal(entries[0].name, 'deploy command');
  assert.equal(entries[0].type, 'project');
  assert.equal(entries[0].description, 'Releases use make release');

  const state = await waitFor(async () => {
    const snapshot = env.pctx.state.snapshot();
    return snapshot.lastExtractAt > 0 ? snapshot : null;
  });
  assert.equal(env.toolCalls, 2, 'one tool turn plus a final answer');
  assert.ok(state.lastExtractAttemptAt > 0);
  assert.equal(state.lastExtractReason, 'direct');
  assert.equal(state.lastExtractCount, 1);
});

test('a write by the main agent skips extraction for that turn', async (t) => {
  const env = await extractEnv(t);
  env.runtime.noteMemoryWrite('s1');
  turn(env);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await env.pctx.store.listEntries()).length, 0, 'the model write is the mutex');
});

test('autoExtractEveryTurns waits for the Nth turn', async (t) => {
  const env = await extractEnv(t, { autoExtractEveryTurns: 2 });
  turn(env);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await env.pctx.store.listEntries()).length, 0, 'turn 1 is not a multiple');

  turn(env);
  const entries = await waitFor(async () => {
    const list = await env.pctx.store.listEntries();
    return list.length > 0 ? list : null;
  });
  assert.equal(entries.length, 1);
});

test('/memory inbox still accepts a manually staged proposal', async (t) => {
  const env = await commandEnv(t, { autoExtract: false, autoDreamEnabled: false });
  const record = await writeProposal(env.pctx.paths, {
    sessionId: 's1',
    cwd: env.workspaceDir,
    items: [{
      name: 'deploy command',
      type: 'project',
      description: 'Releases use make release',
      content: 'Run `make release` to deploy.',
    }],
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
  await removeProposal(env.pctx.paths, record.id);
});
