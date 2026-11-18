import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { MemoryRuntime } from '../src/runtime.js';
import { streamOf, toolsEnv } from './v10-helpers.mjs';

const file = 'project_release.md';
const first = 'Use make release for deployments.';
const second = 'Archive the release manifest.';
const tool = (name, args = {}) => ({ type: 'block-end', block: { type: 'tool-call', id: name, name, arguments: args } });
const end = (kind) => ({ type: 'finish', reason: { kind } });

async function setup(t) {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  const events = [first, second].map((text, i) => ({ seq: i + 1, type: 'user/message', data: { content: [{ type: 'text', text }] } }));
  const reads = [];
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir } }],
    listEvents: async () => events,
    readEvent: async ({ seq, before, after }) => {
      reads.push({ seq, before, after });
      return { events: events.filter((event) => event.seq >= seq - before && event.seq <= seq + after) };
    },
  };
  return { ...env, events, reads };
}

async function pause(env, runId) {
  let turn = 0;
  env.host.services.llm.stream = () => streamOf(turn++ === 0 ? [
    tool('session_read', { session_id: 's1', seq: 1, before: 0, after: 0 }),
    tool('memory_write', { file, body: first, citations: [{ session_id: 's1', seq: 1, quote: first }] }),
    tool('work_done', { session_id: 's1', through_seq: 1, summary: 'Captured the release command.' }),
    end('tool-calls'),
  ] : [tool('memory_index'), end('tool-calls')]);
  return env.runtime.dream({ pctx: env.pctx, force: true, runId });
}

test('a new host resumes the same run and retains its saved analysis and draft', async (t) => {
  const env = await setup(t);
  const runId = 'run-durable-checkpoint';
  const paused = await pause(env, runId);
  assert.equal(paused.status, 'paused');
  await assert.rejects(env.pctx.store.readEntry(file), { code: 'NOT_FOUND' });
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);

  const runtime = new MemoryRuntime(env.host, env.config);
  const pctx = await runtime.storeFor(env.workspaceDir);
  let prompt;
  let turn = 0;
  env.host.services.llm.stream = ({ messages, tools }) => {
    assert.ok(tools.some(({ name }) => name === 'work_done'));
    assert.ok(tools.every(({ name }) => name !== 'session_done'));
    if (turn++ > 0) return streamOf([{ type: 'text-delta', text: 'DONE' }, end('stop')]);
    prompt = messages[0].content[0].text;
    return streamOf([
      tool('session_read', { session_id: 's1', seq: 2, before: 0, after: 0 }),
      tool('work_done', { session_id: 's1', through_seq: 2, summary: 'Reviewed the release manifest step.' }),
      end('tool-calls'),
    ]);
  };

  assert.equal((await runtime.dreamRun(pctx, runId)).status, 'paused');
  const resumed = await runtime.dream({ pctx, force: true, runId, resume: true });
  assert.equal(resumed.runId, runId);
  assert.equal(resumed.ready, true);
  assert.match(prompt, /Captured the release command/u);
  assert.match(prompt, /first unreviewed text event seq 2/u);
  assert.equal((await runtime.switchDream({ pctx, runId })).ok, true);
  assert.equal((await pctx.store.readEntry(file)).body, first);
  assert.equal(pctx.state.snapshot().dreamProcessedSessions.find(({ id }) => id === 's1')?.seq, 2);
});

test('resume refuses a checkpoint whose reviewed source event changed', async (t) => {
  const env = await setup(t);
  const runId = 'run-checkpoint-source';
  assert.equal((await pause(env, runId)).status, 'paused');
  env.events[0].data.content[0].text = 'Use a different deployment command.';
  env.host.services.llm.stream = () => assert.fail('a stale checkpoint must stop before the first model call');
  const resumed = await env.runtime.dream({ pctx: env.pctx, force: true, runId, resume: true });
  assert.equal(resumed.error, 'checkpoint-conflict');
  const status = await env.runtime.dreamRun(env.pctx, runId);
  assert.equal(status.status, 'failed');
  assert.equal(status.resumable, false);
  assert.equal((await env.runtime.startDream(env.pctx, { runId, resume: true })).error, 'not-resumable');
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);
  await assert.rejects(env.pctx.store.readEntry(file), { code: 'NOT_FOUND' });
});

test('a failure after publishing review keeps the saved batch available', async (t) => {
  const env = await setup(t);
  const runId = 'run-published-review';
  assert.equal((await pause(env, runId)).status, 'paused');
  env.host.services.llm.stream = () => streamOf([{ type: 'text-delta', text: 'DONE' }, end('stop')]);
  env.pctx.state.markDreamDone = async () => { throw new Error('simulated post-publish statistics failure'); };
  const resumed = await env.runtime.dream({ pctx: env.pctx, force: true, runId, resume: true });
  assert.equal(resumed.ready, true);
  assert.equal((await env.runtime.dreamRun(env.pctx, runId)).resumable, false);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId })).ok, true);
  assert.equal((await env.pctx.store.readEntry(file)).body, first);
});

test('resume rechecks a memory page that informed a saved no-change decision', async (t) => {
  const env = await setup(t);
  await env.pctx.store.writeRawEntry(file, { body: first, type: 'project' });
  let turn = 0;
  env.host.services.llm.stream = () => streamOf(turn++ === 0 ? [
    tool('memory_read', { file }),
    tool('session_read', { session_id: 's1', seq: 1, before: 0, after: 0 }),
    tool('work_done', { session_id: 's1', through_seq: 1, summary: 'The release command is already in memory.' }),
    end('tool-calls'),
  ] : [tool('memory_index'), end('tool-calls')]);
  const runId = 'run-read-dependency';
  assert.equal((await env.runtime.dream({ pctx: env.pctx, runId })).status, 'paused');
  await env.pctx.store.updateEntry(file, { content: second });
  env.host.services.llm.stream = () => assert.fail('a changed source page must stop resume before asking the model');
  assert.equal((await env.runtime.dream({ pctx: env.pctx, runId, resume: true })).error, 'checkpoint-conflict');
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);
});

test('an unchecked tail cannot delete a checkpointed draft and consume its source', async (t) => {
  const env = await setup(t);
  const runId = 'run-unchecked-tail';
  assert.equal((await pause(env, runId)).status, 'paused');
  let turn = 0;
  env.host.services.llm.stream = () => streamOf(turn++ === 0 ? [
    tool('session_read', { session_id: 's1', seq: 2, before: 0, after: 0 }),
    tool('memory_delete', { file }),
    end('tool-calls'),
  ] : [{ type: 'text-delta', text: 'DONE' }, end('stop')]);
  const stopped = await env.runtime.dream({ pctx: env.pctx, runId, resume: true });
  assert.equal(stopped.status, 'paused');
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);

  env.host.services.llm.stream = () => streamOf([{ type: 'text-delta', text: 'DONE' }, end('stop')]);
  assert.equal((await env.runtime.dream({ pctx: env.pctx, runId, resume: true })).ready, true);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId })).ok, true);
  assert.equal((await env.pctx.store.readEntry(file)).body, first);
});

test('a checkpoint and its drafts survive a killed host with a fresh project lock', { timeout: 15_000 }, async (t) => {
  const env = await setup(t);
  const runId = 'run-killed-host';
  const worker = spawn(process.execPath, ['--input-type=module', '-e', `
    import { MemoryRuntime } from './src/runtime.js';
    import { fakeHost, streamOf } from './test/v10-helpers.mjs';
    const [runId, workspaceDir, config, events] = JSON.parse(process.argv[1]);
    const host = fakeHost({ workspaceDir });
    host.services.sessionQuery = {
      filterSessions: async () => [{ header: { id: 's1', cwd: workspaceDir } }],
      listEvents: async () => events,
      readEvent: async ({ seq }) => ({ events: events.filter((event) => event.seq === seq) }),
    };
    const tool = (name, args) => ({ type: 'block-end', block: { type: 'tool-call', id: name, name, arguments: args } });
    const quote = events[0].data.content[0].text;
    let turn = 0;
    host.services.llm.stream = () => turn++ === 0 ? streamOf([
      tool('session_read', { session_id: 's1', seq: 1, before: 0, after: 0 }),
      tool('memory_write', { file: 'project_release.md', body: quote, citations: [{ session_id: 's1', seq: 1, quote }] }),
      tool('work_done', { session_id: 's1', through_seq: 1, summary: 'Release command analyzed.' }),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]) : (async function* () {
      process.stdout.write('checkpoint published\\n');
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    })();
    const runtime = new MemoryRuntime(host, config);
    await runtime.dream({ pctx: await runtime.storeFor(workspaceDir), runId });
  `, JSON.stringify([runId, env.workspaceDir, env.config, env.events])], { windowsHide: true });
  t.after(() => { if (worker.exitCode === null) worker.kill(); });
  let output = '';
  const exit = once(worker, 'exit');
  await Promise.race([
    new Promise((resolve) => worker.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('checkpoint published')) resolve();
    })),
    exit.then(() => assert.fail('the host exited before announcing the checkpoint')),
  ]);
  worker.kill();
  await exit;
  assert.equal((await env.runtime.dreamRun(env.pctx, runId)).resumable, true);
  env.host.services.llm.stream = () => streamOf([{ type: 'text-delta', text: 'DONE' }, end('stop')]);
  const resumed = await env.runtime.dream({ pctx: env.pctx, force: true, runId, resume: true });
  assert.equal(resumed.ready, true, JSON.stringify(resumed));
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId })).ok, true);
  assert.equal((await env.pctx.store.readEntry(file)).body, first);
});
