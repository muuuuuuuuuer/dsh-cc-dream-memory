/**
 * v23 input pinning: an estimate prices a range; the start must honour it.
 *
 * Why: the estimate is what the user confirms. Between the estimate and the
 * start a session can grow or a new one can appear; without pinning the run
 * quietly does more work (and costs more) than the confirmed number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeEnv, scriptDream, seedUserMessages } from './v10-helpers.mjs';

test('v23 pinning: the estimate hands back an id and the ranges it priced', async (t) => {
  const env = await runtimeEnv(t, {});
  await env.pctx.state.ensureSession('pending-session', 1);
  seedUserMessages(env, 'Deploy with make release.');
  const service = env.mods.status.createStatusService(env.runtime);
  const response = await service.dream(env.pctx, { action: 'estimate' });
  assert.equal(response.ok, true, JSON.stringify(response));
  const result = response.result;
  assert.equal(typeof result.inputId, 'string');
  assert.ok(result.inputId.length > 0);
  assert.ok(Array.isArray(result.ranges) && result.ranges.length > 0, JSON.stringify(result.ranges));
  assert.equal(typeof result.units, 'number');
  assert.ok(result.units > 0);
  assert.equal(result.focus, '');
});

test('v23 pinning: a start whose pinned input no longer matches is refused before any model call', async (t) => {
  const env = await runtimeEnv(t, {});
  await scriptDream(env, { sessions: { s1: ['Deploy with make release.'] }, claims: [] });
  const before = env.host.llmCalls.length;
  const run = await env.runtime.dream({
    pctx: env.pctx,
    force: true,
    trigger: 'manual',
    dryRun: true,
    inputId: 'not-the-estimated-id',
    inputRanges: [{ id: 's1', lastSeq: 1 }],
  });
  assert.equal(run.error, 'stale-input', JSON.stringify(run).slice(0, 400));
  assert.equal(run.skipReason, 'input-changed');
  assert.equal(env.host.llmCalls.length, before, 'a stale input must not reach the analyzer');
});
