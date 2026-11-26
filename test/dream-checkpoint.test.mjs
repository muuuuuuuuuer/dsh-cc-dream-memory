import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryRuntime } from '../src/runtime.js';
import { streamOf, toolsEnv } from './v10-helpers.mjs';

const file = 'project_release.md';
const first = 'Use make release for deployments.';
const second = 'Archive the release manifest.';
const tool = (name, args = {}) => ({ type: 'block-end', block: { type: 'tool-call', id: name, name, arguments: args } });
const end = (kind) => ({ type: 'finish', reason: { kind } });

// Two sessions, one child each: s1 holds the release command, s2 the manifest step.
async function setup(t) {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  const events = [first, second].map((text, i) => ({ seq: i + 1, type: 'user/message', data: { content: [{ type: 'text', text }] } }));
  const of = (id) => events.filter((event) => event.seq === (id === 's1' ? 1 : 2));
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir, createdAt: 1 } }, { header: { id: 's2', cwd: env.workspaceDir, createdAt: 2 } }],
    readSession: async (id) => ({ events: structuredClone(of(id)) }),
  };
  return { ...env, events };
}

const failed = () => streamOf([end('error')]);

/** The s1 child drafts the note and finishes; the s2 child fails, so the run pauses with s1 checkpointed. */
async function pause(env, runId, firstTurn = [
  tool('memory_write', { file, body: first, citations: [{ session_id: 's1', seq: 1, quote: first }] }),
  tool('work_done', { session_id: 's1', through_seq: 1, summary: 'Captured the release command.' }),
]) {
  let turn = 0;
  env.host.services.llm.stream = () => {
    turn += 1;
    if (turn === 1) return streamOf([...firstTurn, end('tool-calls')]);
    if (turn === 2) return streamOf([{ type: 'text-delta', text: 'DONE' }, end('stop')]);
    return failed();
  };
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
  t.after(runtime.subagents.attach(env.host));
  const pctx = await runtime.storeFor(env.workspaceDir);
  pctx.agent = env.host.dreamParent;
  const prompts = [];
  let turn = 0;
  env.host.services.llm.stream = ({ messages }) => {
    if (turn++ > 0) return streamOf([{ type: 'text-delta', text: 'DONE' }, end('stop')]);
    prompts.push(messages[0].content[0].text);
    return streamOf([
      tool('work_done', { session_id: 's2', through_seq: 2, summary: 'Reviewed the release manifest step.' }),
      end('tool-calls'),
    ]);
  };

  assert.equal((await runtime.dreamRun(pctx, runId)).status, 'paused');
  const resumed = await runtime.dream({ pctx, force: true, runId, resume: true });
  assert.equal(resumed.runId, runId);
  assert.equal(resumed.ready, true);
  // Only the unfinished session gets a new child.
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /session_id=s2/u);
  assert.equal((await runtime.switchDream({ pctx, runId })).ok, true);
  assert.equal((await pctx.store.readEntry(file)).body, first);
  const processed = pctx.state.snapshot().dreamProcessedSessions;
  assert.equal(processed.find(({ id }) => id === 's1')?.seq, 1);
  assert.equal(processed.find(({ id }) => id === 's2')?.seq, 2);
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

test('status does not offer to resume a damaged checkpoint', async (t) => {
  const env = await setup(t);
  const runId = 'run-damaged-checkpoint';
  assert.equal((await pause(env, runId)).status, 'paused');
  await writeFile(path.join(env.pctx.paths.dreamsDir, runId, 'checkpoint.json'), '{"version":1,');
  env.host.services.llm.stream = () => assert.fail('damaged checkpoints must not call the model');
  const status = await env.runtime.dreamRun(env.pctx, runId);
  assert.equal(status.status, 'failed');
  assert.equal(status.resumable, false);
  assert.equal(status.error, 'checkpoint-unavailable');
  assert.equal((await env.runtime.startDream(env.pctx, { runId, resume: true })).error, 'not-resumable');
  await assert.rejects(env.pctx.store.readEntry(file), { code: 'NOT_FOUND' });
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);
});

test('a parsed checkpoint with broken saved work is unavailable', async (t) => {
  const env = await setup(t);
  const runId = 'run-broken-saved-work';
  assert.equal((await pause(env, runId)).status, 'paused');
  await writeFile(path.join(env.pctx.paths.dreamsDir, runId, 'checkpoint.json'), JSON.stringify({
    version: 1, work: [null], sessionIds: ['s1'], bases: [], draft: { index: '', pages: [] }, evidence: [],
  }));
  assert.equal((await env.runtime.dreamRun(env.pctx, runId)).resumable, false);
  assert.equal((await env.runtime.startDream(env.pctx, { runId, resume: true })).error, 'not-resumable');
});

test('repeating resume reuses the running Dream and its completion', async (t) => {
  const env = await setup(t);
  const runId = 'run-resume-twice';
  assert.equal((await pause(env, runId)).status, 'paused');
  const replyGate = Promise.withResolvers();
  env.host.services.llm.stream = async function* () {
    await replyGate.promise;
    yield* streamOf([{ type: 'text-delta', text: 'DONE' }, end('stop')]);
  };
  const initial = await env.runtime.startDream(env.pctx, { runId, resume: true });
  assert.equal(initial.started, true);
  try {
    const repeat = await env.runtime.startDream(env.pctx, { runId, resume: true });
    assert.equal(repeat.reused, true);
    assert.equal(repeat.done, initial.done);
  } finally {
    replyGate.resolve();
    await initial.done;
  }
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
  const runId = 'run-read-dependency';
  assert.equal((await pause(env, runId, [
    tool('memory_read', { file }),
    tool('work_done', { session_id: 's1', through_seq: 1, summary: 'The release command is already in memory.' }),
  ])).status, 'paused');
  await env.pctx.store.updateEntry(file, { content: second });
  env.host.services.llm.stream = () => assert.fail('a changed source page must stop resume before asking the model');
  assert.equal((await env.runtime.dream({ pctx: env.pctx, runId, resume: true })).error, 'checkpoint-conflict');
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);
});

test('an uncited tail deletion is refused and cannot remove a checkpointed draft', async (t) => {
  const env = await setup(t);
  const runId = 'run-unchecked-tail';
  assert.equal((await pause(env, runId)).status, 'paused');
  let turn = 0;
  env.host.services.llm.stream = () => streamOf(turn++ === 0 ? [
    tool('memory_delete', { file }),
    end('tool-calls'),
  ] : [{ type: 'text-delta', text: 'DONE' }, end('stop')]);
  const resumed = await env.runtime.dream({ pctx: env.pctx, runId, resume: true });
  assert.equal(resumed.ready, true);
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);
  assert.deepEqual(env.pctx.state.snapshot().shadowPending.reviewRecords.map(({ id }) => id), ['s1']);
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
      filterSessions: async () => [{ header: { id: 's1', cwd: workspaceDir, createdAt: 1 } }, { header: { id: 's2', cwd: workspaceDir, createdAt: 2 } }],
      readSession: async (id) => ({ events: events.filter((event) => event.seq === (id === 's1' ? 1 : 2)) }),
    };
    const tool = (name, args) => ({ type: 'block-end', block: { type: 'tool-call', id: name, name, arguments: args } });
    const quote = events[0].data.content[0].text;
    let turn = 0;
    host.services.llm.stream = () => ++turn === 1 ? streamOf([
      tool('memory_write', { file: 'project_release.md', body: quote, citations: [{ session_id: 's1', seq: 1, quote }] }),
      tool('work_done', { session_id: 's1', through_seq: 1, summary: 'Release command analyzed.' }),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]) : turn === 2 ? streamOf([{ type: 'text-delta', text: 'DONE' }, { type: 'finish', reason: { kind: 'stop' } }]) : (async function* () {
      process.stdout.write('checkpoint published\\n');
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    })();
    const runtime = new MemoryRuntime(host, config);
    runtime.subagents.attach(host);
    const pctx = await runtime.storeFor(workspaceDir);
    pctx.agent = host.dreamParent;
    await runtime.dream({ pctx, runId });
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
