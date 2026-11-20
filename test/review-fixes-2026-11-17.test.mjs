import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mountDreamFixture, toolsEnv, streamOf } from './v10-helpers.mjs';
import { ProjectState } from '../src/state.js';
import { listSwitches } from '../src/dream.js';
import { attachRecall } from '../src/recall.js';

const finish = (kind) => ({ type: 'finish', reason: { kind } });
const groundedDescription = 'Keep blue deployment.';
const toolCall = (name, args) => ({
  type: 'block-end', block: { type: 'tool-call', id: randomUUID(), name, arguments: args },
});

function script(env, steps) {
  let turn = 0;
  env.host.services.llm.stream = () => streamOf(steps[turn++] ?? [finish('stop')]);
}

async function pendingDream(t, runId) {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  const page = await env.pctx.store.saveEntry({
    name: 'Deploy', type: 'project', description: 'Old deploy hook', content: 'Keep blue deployment.',
  });
  script(env, [[
    toolCall('memory_write', { file: page.file, description: groundedDescription, body: 'Keep blue deployment.' }),
    finish('tool-calls'),
  ]]);
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, memoryOnly: true, runId });
  assert.equal(result.ready, true);
  return { ...env, page, runId };
}

test('a failed switch state write rolls back pages and index and allows the same review to retry', async (t) => {
  const env = await pendingDream(t, 'run-state-failure');
  const { pctx, runtime, page, runId } = env;
  const before = (await pctx.store.readEntry(page.file)).raw;
  const beforeIndex = await pctx.store.indexText();
  const writeState = pctx.state._writeState;
  pctx.state._writeState = async () => { throw Object.assign(new Error('state rename failed'), { code: 'EACCES' }); };
  let switched;
  try {
    switched = await runtime.switchDream({ pctx, runId });
  } finally {
    pctx.state._writeState = writeState;
  }
  assert.equal(switched.ok, false);
  assert.equal((await pctx.store.readEntry(page.file)).raw, before);
  assert.equal(await pctx.store.indexText(), beforeIndex);
  assert.equal(pctx.state.snapshot().shadowPending.runId, runId);
  assert.deepEqual(await listSwitches(pctx.paths), [], 'rolled-back writes must not become undoable switches');
  assert.equal((await runtime.switchDream({ pctx, runId })).ok, true);
  assert.equal((await pctx.store.readEntry(page.file)).frontmatter.description, groundedDescription);
  assert.equal(pctx.state.snapshot().shadowPending, null);
});

test('undo restores the changed index hook while preserving unrelated index edits', async (t) => {
  const { pctx, runtime, page, runId } = await pendingDream(t, 'run-undo-index');
  assert.equal((await runtime.switchDream({ pctx, runId })).ok, true);
  const other = await pctx.store.saveEntry({
    name: 'Other', type: 'project', description: 'An independent hook', content: 'Independent fact.',
  });
  await pctx.store.writeIndex((await pctx.store.indexText()).replace('An independent hook', 'Human edited hook'));
  const undone = await runtime.undoLastDream(pctx);
  assert.equal(undone.ok, true);
  assert.equal((await pctx.store.readEntry(page.file)).frontmatter.description, 'Old deploy hook');
  const index = await pctx.store.indexText();
  assert.ok(index.includes('- [Deploy](project_deploy.md) — Old deploy hook'));
  assert.ok(!index.includes(groundedDescription));
  assert.ok(index.includes(`- [Other](${other.file}) — Human edited hook`));
});

test('failed settlement also restores removed pages and removes newly created pages before retry', async (t) => {
  const env = await pendingDream(t, 'run-unused');
  const { pctx, runtime, page } = env;
  await runtime.discardDream({ pctx, runId: 'run-unused' });
  const old = await pctx.store.saveEntry({ name: 'Old', type: 'project', content: 'Old durable fact.' });
  const beforeIndex = await pctx.store.indexText();
  const beforeOld = (await pctx.store.readEntry(old.file)).raw;
  const beforePage = (await pctx.store.readEntry(page.file)).raw;
  script(env, [[
    toolCall('memory_write', { file: page.file, description: groundedDescription, body: 'Keep blue deployment.' }),
    toolCall('memory_write', { file: 'project_new.md', body: 'New durable fact.' }),
    toolCall('memory_delete', { file: old.file }),
    finish('tool-calls'),
  ]]);
  const runId = 'run-mixed-state-failure';
  const proposed = await runtime.dream({ pctx, force: true, memoryOnly: true, runId });
  assert.equal(proposed.ready, true);
  assert.deepEqual(proposed.counts, { added: 1, changed: 1, removed: 1 });
  const writeState = pctx.state._writeState;
  pctx.state._writeState = async () => { throw new Error('state rename failed'); };
  let result;
  try {
    result = await runtime.switchDream({ pctx, runId, confirm: [old.file, 'project_new.md'] });
  } finally {
    pctx.state._writeState = writeState;
  }
  assert.equal(result.ok, false);
  assert.equal(result.partial, false);
  assert.equal((await pctx.store.readEntry(old.file)).raw, beforeOld);
  assert.equal((await pctx.store.readEntry(page.file)).raw, beforePage);
  await assert.rejects(() => pctx.store.readEntry('project_new.md'), { code: 'NOT_FOUND' });
  assert.equal(await pctx.store.indexText(), beforeIndex);
  assert.deepEqual(await listSwitches(pctx.paths), []);
  assert.equal((await runtime.switchDream({ pctx, runId, confirm: [old.file, 'project_new.md'] })).ok, true);
  assert.equal((await pctx.store.readEntry('project_new.md')).body.trim(), 'New durable fact.');
  await assert.rejects(() => pctx.store.readEntry(old.file), { code: 'NOT_FOUND' });
});

test('undo can retry index restoration after its first index write fails', async (t) => {
  const { pctx, runtime, runId } = await pendingDream(t, 'run-retry-index');
  assert.equal((await runtime.switchDream({ pctx, runId })).ok, true);
  const atomicWrite = pctx.store._atomicWrite;
  pctx.store._atomicWrite = async function (target, content) {
    if (target === pctx.paths.indexFile) throw new Error('index write failed');
    return atomicWrite.call(this, target, content);
  };
  let result;
  try {
    result = await runtime.undoLastDream(pctx);
  } finally {
    pctx.store._atomicWrite = atomicWrite;
  }
  assert.equal(result.ok, false);
  assert.equal((await runtime.undoLastDream(pctx)).ok, true);
  assert.ok((await pctx.store.indexText()).includes('Old deploy hook'));
  assert.ok(!(await pctx.store.indexText()).includes(groundedDescription));
});

for (const stopReason of ['error', 'max-tokens']) {
  for (const changed of [false, true]) {
    test(`Dream preserves unread work when its child stops with ${stopReason}, changed=${changed}`, async (t) => {
      const env = await toolsEnv(t, { autoDreamEnabled: false });
      const event = { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Use blue deployment.' }] } };
      env.host.services.sessionQuery = {
        filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir, createdAt: Date.now() - 1000 } }],
        readSession: async () => ({ events: [event] }),
      };
      await env.pctx.state.ensureSession('s1', Date.now() - 1000);
      env.host.services.subagents.startActivation = async (spec) => {
        mountDreamFixture(env.host, spec);
        if (changed) await fs.writeFile(path.join(spec.cwd, 'project_deploy.md'), '---\nname: Deploy\ntype: project\n---\n\nUse blue deployment.\n');
        return { childId: spec.childId, result: Promise.resolve({ stopReason, output: [] }), dispose: async () => {} };
      };
      const runId = `run-${stopReason}-${changed}`;
      const result = await env.runtime.dream({ pctx: env.pctx, force: true, runId });
      assert.equal(result.status, 'paused');
      assert.equal(result.error, 'subagent-' + stopReason);
      const state = env.pctx.state.snapshot();
      assert.equal(state.shadowPending, null);
      assert.deepEqual(state.dreamProcessedSessions, []);
      assert.ok(state.sessionsSince.some(({ id }) => id === 's1'));
      assert.equal((await env.runtime.dreamRun(env.pctx, runId)).resumable, true);
    });
  }
}

test('stale pending cleanup cannot clear a newer run published after its missing-directory check', async (t) => {
  const env = await pendingDream(t, 'run-old-pending');
  const { pctx, runtime } = env;
  const stale = new ProjectState(pctx.paths);
  await stale.load();
  const old = stale.snapshot().shadowPending;
  assert.equal((await runtime.discardDream({ pctx, runId: old.runId })).ok, true);
  const stat = fs.stat;
  let observedMissing;
  let release;
  const missing = new Promise((resolve) => { observedMissing = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  let held = false;
  fs.stat = async (file, ...args) => {
    if (file !== old.dir || held) return stat(file, ...args);
    held = true;
    try {
      return await stat(file, ...args);
    } catch (error) {
      observedMissing();
      await resume;
      throw error;
    }
  };
  const dropping = stale.dropStaleShadowPending();
  try {
    await missing;
    await fs.mkdir(old.dir, { recursive: true });
    await pctx.state.setShadowPending({ ...old, runId: 'run-new-pending' });
    release();
    assert.equal(await dropping, false);
    await pctx.state.read();
    assert.equal(pctx.state.snapshot().shadowPending.runId, 'run-new-pending');
  } finally {
    release();
    await dropping;
    fs.stat = stat;
  }
});

test('an inaccessible shadow directory keeps its pending review', async (t) => {
  const { pctx } = await pendingDream(t, 'run-stat-permission');
  const pending = pctx.state.snapshot().shadowPending;
  const stat = fs.stat;
  fs.stat = async (file, ...args) => {
    if (file === pending.dir) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return stat(file, ...args);
  };
  try {
    assert.equal(await pctx.state.dropStaleShadowPending(), false);
    assert.equal(pctx.state.snapshot().shadowPending.runId, pending.runId);
  } finally {
    fs.stat = stat;
  }
});

test('cleanup rechecks a missing directory after acquiring the state lock', async (t) => {
  const env = await toolsEnv(t);
  const state = env.pctx.state;
  const pending = { runId: 'run-recreated-directory', dir: path.join(env.tmp, 'recreated-shadow'), createdAt: 1 };
  await state.setShadowPending(pending);
  const readForMutation = state._readForMutation;
  state._readForMutation = async function () {
    const fresh = await readForMutation.call(this);
    await fs.mkdir(pending.dir, { recursive: true });
    return fresh;
  };
  try {
    assert.equal(await state.dropStaleShadowPending(), false);
    assert.equal(state.snapshot().shadowPending.runId, pending.runId);
  } finally {
    state._readForMutation = readForMutation;
  }
});

test('retired memories cannot consume the selector candidate budget', async (t) => {
  const env = await toolsEnv(t, { recallMode: 'model', recallMaxCandidates: 1 });
  const retired = await env.pctx.store.saveEntry({
    name: 'Rollback deployment', type: 'project', description: 'Rollback deployment method',
    content: 'STATUS: superseded\nOld approach.',
  });
  const current = await env.pctx.store.saveEntry({
    name: 'Recovery method', type: 'project', description: 'How to recover',
    content: 'STATUS: current\nUse the stable backup to roll back.',
  });
  let hook;
  let offered = '';
  env.host.services.llm.stream = (options) => {
    offered = options.messages[0].content[0].text;
    const file = offered.includes(current.file) ? current.file : retired.file;
    return streamOf([{ type: 'text-delta', text: JSON.stringify({ selected_memories: [file] }) }, finish('stop')]);
  };
  attachRecall({
    agent: {}, agentCtx: { on: (_event, callback) => { hook = callback; } },
    runtime: { ctx: env.host, forAgent: () => env.pctx }, config: () => env.config,
  });
  const messages = [{ role: 'user', id: 'message-1', content: [{ type: 'text', text: 'Rollback deployment' }] }];
  const result = await hook({ messages }, async () => ({ kind: 'enter', messages }));
  assert.ok(!offered.includes(retired.file));
  assert.ok(offered.includes(current.file));
  assert.equal(result.messages.length, 2);
  assert.ok(result.messages[1].content[0].text.includes('Use the stable backup to roll back.'));
});
