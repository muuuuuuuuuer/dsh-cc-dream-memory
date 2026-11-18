/**
 * `/memory dream` routing: flags reach the background start, and a run id
 * after `status` shows that run instead of the newest one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { commandEnv } from './v10-helpers.mjs';

function messageOf(result) {
  return result.message ?? result.text ?? JSON.stringify(result);
}

test('dream status <runId> shows that run, not the newest', async (t) => {
  const e = await commandEnv(t, { dreamPipeline: 'v2' });
  const asked = [];
  e.runtime.dreamRun = async (pctx, runId) => {
    asked.push(runId);
    return { ok: true, running: false, runId, status: 'failed', stage: 'analyze', counts: { done: 1, failed: 1, pending: 0 }, input: { expectedUnits: 2 } };
  };
  const result = await e.invokeMemory('dream status 2026-11-11T08-00-00-aaaaaa');
  assert.deepEqual(asked, ['2026-11-11T08-00-00-aaaaaa']);
  assert.match(messageOf(result), /dream run 2026-11-11T08-00-00-aaaaaa — failed/);
  assert.match(messageOf(result), /run again: \/memory dream run/);
  assert.doesNotMatch(messageOf(result), /resume/);

  const overview = await e.invokeMemory('dream status');
  assert.match(messageOf(overview), /^dream status/m, 'without a run id the overview stays');
});

test('dream switch --reject and dream run --memory-only reach the runtime', async (t) => {
  const e = await commandEnv(t);
  const switches = [];
  e.runtime.switchDream = async (options) => {
    switches.push(options.reject);
    return { ok: true, counts: { added: 0, changed: 1, removed: 0 }, rejected: options.reject };
  };
  const switched = await e.invokeMemory('dream switch --reject a.md,b.md');
  assert.deepEqual(switches, [['a.md', 'b.md']]);
  assert.doesNotMatch(messageOf(switched), /not switched/, 'a successful switch is reported as one');

  const starts = [];
  e.runtime.startDream = async (pctx, options) => {
    starts.push(options.noSessions);
    return { ok: true, started: true, runId: 'run-1', status: 'running' };
  };
  await e.invokeMemory('dream run --memory-only');
  await e.invokeMemory('dream run');
  assert.deepEqual(starts, [true, false]);
});

test('dream resume --wait continues the named run and reports its result', async (t) => {
  const env = await commandEnv(t);
  const runId = '2026-11-17T08-00-00-aaaaaa';
  env.runtime.dreamRun = async () => ({ ok: true, status: 'paused', resumable: true, runId, checkpointed: 1 });
  assert.match(messageOf(await env.invokeMemory(`dream status ${runId}`)), new RegExp(`dream resume ${runId}`));
  env.runtime.startDream = async (_pctx, options) => {
    assert.equal(options.runId, runId);
    assert.equal(options.resume, true);
    return { started: true, runId, done: Promise.resolve({ ran: true, summary: 'Draft restored' }) };
  };
  assert.match(messageOf(await env.invokeMemory(`dream resume ${runId} --wait`)), /Draft restored/u);
});
