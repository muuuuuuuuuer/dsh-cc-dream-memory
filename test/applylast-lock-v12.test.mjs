/**
 * v12 Bug 4: a lock conflict must not clear the last-plan pointer.
 * Contract `docs/superpowers/specs/2026-11-08-v12-review-fixes.md` Bug 4.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv, writePlan, writePlanOf } from './v10-helpers.mjs';

const PLAN = writePlanOf(
  [
    {
      op: 'write',
      scope: 'project',
      type: 'user',
      name: 'apply last',
      description: 'applied from the saved plan',
      body: 'apply last body',
      file: 'user_apply_last.md',
    },
  ],
  { summary: 'apply-last plan' },
);

async function heldLock(env) {
  await writeFile(env.pctx.paths.lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
}

test('v12 applylast: dream-locked keeps lastPlanPath; retry after release applies and clears it', async (t) => {
  const env = await runtimeEnv(t);
  const planPath = await writePlan(env, PLAN);
  await env.pctx.state.setLastPlan(planPath, 'dry-run');
  await heldLock(env);

  const blocked = await env.runtime.applyLastPlan({ pctx: env.pctx, agent: { id: 'agent-1' } });
  assert.equal(blocked.applied, false, JSON.stringify(blocked).slice(0, 300));
  assert.equal(blocked.error, 'dream-locked');
  assert.equal(env.pctx.state.snapshot().lastPlanPath, planPath, 'the last-plan pointer survives a lock conflict');

  await unlink(env.pctx.paths.lockFile);
  const applied = await env.runtime.applyLastPlan({ pctx: env.pctx, agent: { id: 'agent-1' } });
  assert.equal(applied.applied, true, JSON.stringify(applied).slice(0, 300));
  assert.equal(env.pctx.state.snapshot().lastPlanPath, '', 'a successful apply clears the pointer');
});

test('v12 applylast: applyPendingDream has the unified {applied:boolean,...} shape', async (t) => {
  const env = await runtimeEnv(t);
  await writePlan(env, PLAN, { asPending: true });
  await heldLock(env);
  const pending = await env.runtime.applyPendingDream({ pctx: env.pctx, agent: { id: 'agent-1' } });
  assert.equal('applied' in pending, true, JSON.stringify(pending).slice(0, 300));
  assert.equal(pending.applied, false);
  assert.equal(pending.error, 'dream-locked');
});
