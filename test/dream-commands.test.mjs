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
  assert.match(messageOf(result), /continue: \/memory dream resume 2026-11-11T08-00-00-aaaaaa/);

  const overview = await e.invokeMemory('dream status');
  assert.match(messageOf(overview), /^dream status/m, 'without a run id the overview stays');
});
