/**
 * v8 dream metrics events + cost limit.
 *
 * Contract: docs/superpowers/specs/2026-11-07-v8-metrics-cost-contract.md §2.
 * Uses mock ctx.llm.stream (no real LLM) and os.tmpdir() project dirs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadModule, makeTempDir } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Modules / fixtures
// ---------------------------------------------------------------------------

let modulesPromise;

function modules() {
  if (!modulesPromise) {
    modulesPromise = (async () => ({
      config: await loadModule('../src/config.js', { requireExports: ['resolveConfig'] }),
      paths: await loadModule('../src/paths.js', { requireExports: ['buildPaths'] }),
      store: await loadModule('../src/store.js', { requireExports: ['MemoryStore'] }),
      state: await loadModule('../src/state.js', { requireExports: ['ProjectState'] }),
      runtime: await loadModule('../src/runtime.js', { requireExports: ['MemoryRuntime'] }),
      metrics: await loadModule('../src/metrics.js', { requireExports: ['readMetrics'] }),
      status: await loadModule('../src/status.js', { requireExports: ['createStatusService'] }),
    }))();
  }
  return modulesPromise;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function streamOf(chunks) {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  })();
}

function fakeHost({ workspaceDir, plan, usage = { inputTokens: 120, outputTokens: 45, totalTokens: 165 } }) {
  const listeners = new Map();
  const services = {
    workingDirectory: { ensure: async () => workspaceDir },
    llm: {
      stream() {
        const text = typeof plan === 'string' ? plan : JSON.stringify(plan);
        const chunks = [{ type: 'text-delta', text }];
        if (usage) chunks.push({ type: 'usage', usage });
        chunks.push({ type: 'finish', reason: { kind: 'stop' } });
        return streamOf(chunks);
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    sessionQuery: { filterSessions: async () => [], readSession: async () => undefined },
  };
  return {
    services,
    get: (name) => services[name],
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      return () => set.delete(handler);
    },
    effect(factory) {
      const dispose = factory();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };
}

async function makeEnv(t, configOverrides = {}, { plan = null, usage } = {}) {
  const mods = await modules();
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const host = fakeHost({ workspaceDir, plan, ...(usage ? { usage } : {}) });
  const runtime = new mods.runtime.MemoryRuntime(host, config);
  const pctx = await runtime.storeFor(workspaceDir);
  const paths = mods.paths.buildPaths({ memoryRoot: config.memoryRoot, workspaceDir });
  return { mods, tmp, memoryRoot, workspaceDir, config, host, runtime, pctx, paths };
}

async function readMetrics(env) {
  await sleep(80); // fire-and-forget metrics writes flush through runtime.track
  return env.mods.metrics.readMetrics(env.paths);
}

const WRITE_PLAN = {
  summary: 'v8 dream metrics plan',
  operations: [
    {
      op: 'write',
      scope: 'project',
      type: 'user',
      name: 'dream metrics note',
      description: 'metrics',
      body: 'dream metrics body',
      file: 'user_dream_metrics_note.md',
    },
  ],
  sessions: [],
  truncatedFiles: [],
};

// ---------------------------------------------------------------------------
// Dream metrics events
// ---------------------------------------------------------------------------

test('v8 dream metrics: a dry run records proposed only, apply records applied + costs + ops', async (t) => {
  const env = await makeEnv(t, {}, { plan: WRITE_PLAN });
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
  const env = await makeEnv(t, { dreamMode: 'review' }, { plan: WRITE_PLAN });
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
  const env = await makeEnv(t, {}, { plan: WRITE_PLAN });
  const plan = {
    summary: 'failing plan',
    operations: [
      { op: 'write', scope: 'project', type: 'user', name: 'first', file: 'user_fail_first.md', body: 'FIRST' },
      { op: 'write', scope: 'project', type: 'user', name: 'second', file: 'user_fail_second.md', body: 'SECOND' },
    ],
    sessions: [],
    truncatedFiles: [],
  };
  const planPath = path.join(env.tmp, 'failing-plan.json');
  await writeFile(planPath, JSON.stringify(plan), 'utf8');
  await env.pctx.state.setLastPlan(planPath, 'dry-run');
  let writes = 0;
  const wrapped = new Proxy(env.pctx.store, {
    get(target, property) {
      if (property === 'writeRawEntry') {
        return async (file, payload) => {
          writes += 1;
          if (writes === 2) throw new Error('simulated second-write failure');
          return target.writeRawEntry(file, payload);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = await env.runtime.applyPlanOperations({ ...env.pctx, store: wrapped }, { indexes: [0, 1] });
  assert.equal(result.applied, false);
  assert.equal(result.rolledBack, true);
  const metrics = await readMetrics(env);
  assert.equal(metrics.dreams.failed, 1, 'a rolled-back apply records a failed dream');
  assert.equal(metrics.dreams.applied, 0);
});

// ---------------------------------------------------------------------------
// Cost limit (dreamMaxTotalTokens)
// ---------------------------------------------------------------------------

test('v8 cost: exceeding dreamMaxTotalTokens warns and marks costExceeded but still applies', async (t) => {
  const env = await makeEnv(
    t,
    { dreamMaxTotalTokens: 100 },
    { plan: WRITE_PLAN, usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 } },
  );
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(result.applied, true, 'the cost limit only warns; the plan still applies');
  assert.equal(result.costExceeded, true, `expected costExceeded, got ${JSON.stringify(result)}`);
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  assert.match(warnings.join(' '), /cost-limit-exceeded: totalTokens 500 > limit 100/);
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, 'user_dream_metrics_note.md')), true);

  // The dry-run plan JSON carries the flag too.
  const env2 = await makeEnv(
    t,
    { dreamMaxTotalTokens: 100 },
    { plan: WRITE_PLAN, usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 } },
  );
  const dry = await env2.runtime.dream({ pctx: env2.pctx, force: true, dryRun: true, trigger: 'manual' });
  const planJson = JSON.parse(await readFile(dry.path, 'utf8'));
  assert.equal(planJson.costExceeded, true);
  assert.match(JSON.stringify(planJson.warnings ?? []), /cost-limit-exceeded/);
});

test('v8 cost: usage under the limit produces no cost warning; 0 disables the check', async (t) => {
  const okEnv = await makeEnv(t, { dreamMaxTotalTokens: 1000 }, { plan: WRITE_PLAN });
  const okResult = await okEnv.runtime.dream({ pctx: okEnv.pctx, force: true, trigger: 'manual' });
  assert.equal(okResult.applied, true);
  assert.notEqual(okResult.costExceeded, true);
  assert.doesNotMatch(JSON.stringify(okResult.warnings ?? []), /cost-limit-exceeded/);

  const offEnv = await makeEnv(t, {}, { plan: WRITE_PLAN, usage: { inputTokens: 9999, outputTokens: 9999, totalTokens: 19998 } });
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
  const env = await makeEnv(t, {}, { plan: WRITE_PLAN });
  await env.runtime.dream({ pctx: env.pctx, force: true, dryRun: true, trigger: 'manual' });
  const preview = await env.runtime.previewPlan(env.pctx);
  assert.ok(Array.isArray(preview.ops));
  assert.equal(typeof preview.durationMs, 'number');
  assert.ok(preview.durationMs >= 0);
  assert.ok(preview.inputChars > 0);
  assert.ok(preview.outputChars > 0);
  assert.equal(preview.usage.totalTokens, 165);
});
