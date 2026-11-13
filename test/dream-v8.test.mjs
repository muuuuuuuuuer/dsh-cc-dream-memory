/**
 * v8 dream metrics events + cost limit.
 *
 * Contract: docs/superpowers/specs/2026-11-07-v8-metrics-cost-contract.md §2.
 * A scripted analyzer stands in for the model (no real LLM); os.tmpdir() projects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv, scriptDream, claimOf, exists, sleep } from './v10-helpers.mjs';

const FACT = 'Run the nightly job at 02:00.';
// A claim with no target becomes a page named after the claim.
const NOTE_FILE = 'run-the-nightly-job-at-02-00.md';
const USAGE = { inputTokens: 120, outputTokens: 45, totalTokens: 165 };

async function makeEnv(t, configOverrides = {}, { usage = USAGE } = {}) {
  const env = await runtimeEnv(t, configOverrides);
  await scriptDream(env, { sessions: { s1: [FACT] }, claims: [claimOf(FACT)], usage });
  return { ...env, paths: env.pctx.paths };
}

async function readMetrics(env) {
  await sleep(80); // fire-and-forget metrics writes flush through runtime.track
  return env.mods.metrics.readMetrics(env.paths);
}

// ---------------------------------------------------------------------------
// Dream metrics events
// ---------------------------------------------------------------------------

test('v8 dream metrics: a dry run records proposed only, apply records applied + costs + ops', async (t) => {
  const env = await makeEnv(t);
  const dry = await env.runtime.dream({ pctx: env.pctx, force: true, dryRun: true, trigger: 'manual' });
  assert.equal(dry.dryRun, true);
  let metrics = await readMetrics(env);
  assert.equal(metrics.dreams.proposed, 1);
  assert.equal(metrics.dreams.applied, 0);

  const applied = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(applied.applied, true, JSON.stringify(applied));
  metrics = await readMetrics(env);
  assert.equal(metrics.dreams.proposed, 2, 'the apply run also generated a plan');
  assert.equal(metrics.dreams.applied, 1);
  assert.ok(metrics.dreams.appliedOps >= 1, 'applied operations are counted');
  assert.ok(metrics.costs.lastDurationMs > 0, 'apply records the last duration');
  assert.ok(metrics.costs.lastInputChars > 0);
  assert.ok(metrics.costs.lastOutputChars > 0);
  assert.equal(metrics.costs.lastUsage.totalTokens, 165);
});

test('v8 dream metrics: a rejected review proposal counts as rejected', async (t) => {
  const env = await makeEnv(t, { dreamMode: 'review' });
  const review = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(review.ran, true, JSON.stringify(review));
  let metrics = await readMetrics(env);
  assert.equal(metrics.dreams.proposed, 1);

  const service = env.mods.status.createStatusService(env.runtime);
  const rejected = await service.dream(env.pctx, { action: 'reject', agent: { id: 'agent-reject' } });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  metrics = await readMetrics(env);
  assert.equal(metrics.dreams.rejected, 1, 'rejecting a proposal records a rejected dream');
  assert.equal(env.pctx.state.snapshot().pendingProposal, '');
});

test('v8 dream metrics: a failed apply records a failed event', async (t) => {
  const env = await runtimeEnv(t);
  const first = await env.pctx.store.saveEntry({ name: 'first', type: 'project', content: 'First note.' });
  const second = await env.pctx.store.saveEntry({ name: 'second', type: 'project', content: 'Second note.' });
  await scriptDream(env, {
    sessions: { s1: ['Alpha listens on port 8080.', 'Beta listens on port 9090.'] },
    claims: [
      claimOf('Alpha listens on port 8080.', { target: first.file }),
      claimOf('Beta listens on port 9090.', { target: second.file }),
    ],
  });
  const dry = await env.runtime.dream({ pctx: env.pctx, force: true, dryRun: true, trigger: 'manual' });
  const plan = JSON.parse(await readFile(dry.planPath, 'utf8'));
  const writes = plan.operations.flatMap((op, index) => (op.op === 'write' ? [index] : []));
  assert.equal(writes.length, 2, JSON.stringify(plan.operations));

  let count = 0;
  const wrapped = new Proxy(env.pctx.store, {
    get(target, property) {
      if (property === 'writeRawEntry') {
        return async (file, payload) => {
          count += 1;
          if (count === 2) throw new Error('simulated second-write failure');
          return target.writeRawEntry(file, payload);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = await env.runtime.applyPlanOperations({ ...env.pctx, store: wrapped }, { indexes: writes });
  assert.equal(result.applied, false, JSON.stringify(result));
  assert.equal(result.rolledBack, true);
  const metrics = await readMetrics({ ...env, paths: env.pctx.paths });
  assert.equal(metrics.dreams.failed, 1, 'a rolled-back apply records a failed dream');
  assert.equal(metrics.dreams.applied, 0);
});

// ---------------------------------------------------------------------------
// Cost limit (dreamMaxTotalTokens)
// ---------------------------------------------------------------------------

test('v8 cost: exceeding dreamMaxTotalTokens warns and marks costExceeded but still applies', async (t) => {
  const over = { inputTokens: 400, outputTokens: 100, totalTokens: 500 };
  const env = await makeEnv(t, { dreamMaxTotalTokens: 100 }, { usage: over });
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(result.applied, true, 'the cost limit only warns; the plan still applies');
  assert.equal(result.costExceeded, true, `expected costExceeded, got ${JSON.stringify(result)}`);
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  assert.match(warnings.join(' '), /cost-limit-exceeded: totalTokens 500 > limit 100/);
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, NOTE_FILE)), true);

  // The dry-run plan JSON carries the flag too.
  const env2 = await makeEnv(t, { dreamMaxTotalTokens: 100 }, { usage: over });
  const dry = await env2.runtime.dream({ pctx: env2.pctx, force: true, dryRun: true, trigger: 'manual' });
  const planJson = JSON.parse(await readFile(dry.planPath, 'utf8'));
  assert.equal(planJson.costExceeded, true);
  assert.match(JSON.stringify(planJson.warnings ?? []), /cost-limit-exceeded/);
});

test('v8 cost: usage under the limit produces no cost warning; 0 disables the check', async (t) => {
  const okEnv = await makeEnv(t, { dreamMaxTotalTokens: 1000 });
  const okResult = await okEnv.runtime.dream({ pctx: okEnv.pctx, force: true, trigger: 'manual' });
  assert.equal(okResult.applied, true);
  assert.notEqual(okResult.costExceeded, true);
  assert.doesNotMatch(JSON.stringify(okResult.warnings ?? []), /cost-limit-exceeded/);

  const offEnv = await makeEnv(t, {}, { usage: { inputTokens: 9999, outputTokens: 9999, totalTokens: 19998 } });
  assert.equal(offEnv.config.dreamMaxTotalTokens, 0, 'dreamMaxTotalTokens defaults to 0 (off)');
  const offResult = await offEnv.runtime.dream({ pctx: offEnv.pctx, force: true, trigger: 'manual' });
  assert.equal(offResult.applied, true);
  assert.notEqual(offResult.costExceeded, true);
  assert.doesNotMatch(JSON.stringify(offResult.warnings ?? []), /cost-limit-exceeded/);
});

// ---------------------------------------------------------------------------
// previewPlan cost/usage fields
// ---------------------------------------------------------------------------

test('v8 preview: previewPlan returns durationMs/inputChars/outputChars/usage from the plan JSON', async (t) => {
  const env = await makeEnv(t);
  await env.runtime.dream({ pctx: env.pctx, force: true, dryRun: true, trigger: 'manual' });
  const preview = await env.runtime.previewPlan(env.pctx);
  assert.ok(Array.isArray(preview.ops));
  assert.equal(typeof preview.durationMs, 'number');
  assert.ok(preview.durationMs >= 0);
  assert.ok(preview.inputChars > 0);
  assert.ok(preview.outputChars > 0);
  assert.equal(preview.usage.totalTokens, 165);
});
