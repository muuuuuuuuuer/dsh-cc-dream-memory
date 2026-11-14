/**
 * v9 P0: dream readiness / memory health / pending TTL / cost mode.
 *
 * Contract: docs/superpowers/specs/2026-11-07-v9-p0-contract.md §4-§5.
 * Real store/state/runtime in os.tmpdir(); LLM is mocked (no real calls).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadModule, makeTempDir } from './helpers.mjs';
import { runtimeEnv as dreamEnvBase, scriptDream, claimOf } from './v10-helpers.mjs';

// A Dream whose analyzer reports `usage` and places one new page.
const COST_FACT = 'Keep cost reports short.';
const COST_FILE = 'keep-cost-reports-short.md';
async function dreamEnv(t, config, usage) {
  const env = await dreamEnvBase(t, config);
  await scriptDream(env, { sessions: { s1: [COST_FACT] }, claims: [claimOf(COST_FACT)], usage });
  return env;
}

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
      readiness: await loadModule('../src/readiness.js', {
        requireExports: ['dreamReadiness', 'memoryHealth'],
      }),
      status: await loadModule('../src/status.js', { requireExports: ['createStatusService'] }),
    }))();
  }
  return modulesPromise;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function streamOf(chunks) {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  })();
}

function fakeHost({ workspaceDir, plan = null, usage = null }) {
  const listeners = new Map();
  const llmCalls = [];
  const services = {
    workingDirectory: { ensure: async () => workspaceDir },
    llm: {
      stream() {
        llmCalls.push(true);
        const text = typeof plan === 'string' ? plan : JSON.stringify(plan ?? { summary: 'plan', operations: [] });
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
    llmCalls,
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

async function makeEnv(t, configOverrides = {}) {
  const mods = await modules();
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const paths = mods.paths.buildPaths({ memoryRoot: config.memoryRoot, homeDir: path.join(tmp, 'home'), workspaceDir });
  const store = new mods.store.MemoryStore({ paths, getConfig: () => config });
  await store.ensure();
  const state = new mods.state.ProjectState(paths);
  await state.load();
  const pctx = { workspaceDir, paths, store, state };
  return { mods, tmp, memoryRoot, workspaceDir, config, paths, store, state, pctx };
}

/** Overwrite the state file then reload pctx.state (test-only shortcut). */
async function setState(env, fields) {
  await mkdir(path.dirname(env.paths.stateFile), { recursive: true });
  const current = env.pctx.state.snapshot();
  await writeFile(env.paths.stateFile, JSON.stringify({ ...current, ...fields }, null, 2), 'utf8');
  env.pctx.state = new env.mods.state.ProjectState(env.paths);
  await env.pctx.state.load();
  return env.pctx.state;
}

async function runtimeEnv(t, configOverrides = {}, llmOptions = {}) {
  const env = await makeEnv(t, configOverrides);
  const host = fakeHost({ workspaceDir: env.workspaceDir, ...llmOptions });
  const runtime = new env.mods.runtime.MemoryRuntime(host, env.config);
  const pctx = await runtime.storeFor(env.workspaceDir);
  return { ...env, host, runtime, pctx };
}

const PLAN = {
  summary: 'v9 plan',
  operations: [
    {
      op: 'write',
      scope: 'project',
      type: 'user',
      name: 'cost note',
      description: 'cost note description',
      body: 'cost note body',
      file: 'user_cost_note.md',
    },
  ],
  sessions: [],
  truncatedFiles: [],
};

function reasonCodes(readiness) {
  return (readiness.reasons ?? []).map((reason) => reason.code);
}

// ---------------------------------------------------------------------------
// dreamReadiness
// ---------------------------------------------------------------------------

test('v9 readiness: disabled / auto-dream-off are reported first', async (t) => {
  const env = await makeEnv(t, { autoDreamEnabled: false });
  const disabledConfig = env.mods.config.resolveConfig({ memoryRoot: env.memoryRoot, enabled: false, autoDreamEnabled: true });
  const disabled = env.mods.readiness.dreamReadiness(env.pctx, { config: disabledConfig, now: Date.now() });
  assert.equal(disabled.eligible, false);
  assert.equal(reasonCodes(disabled).includes('disabled'), true, JSON.stringify(disabled.reasons));
  assert.equal(disabled.gates.auto, false);

  const off = env.mods.readiness.dreamReadiness(env.pctx, { config: env.config, now: Date.now() });
  assert.equal(off.eligible, false);
  assert.equal(reasonCodes(off).includes('auto-dream-off'), true, JSON.stringify(off.reasons));
  assert.equal(off.gates.auto, false);
});

test('v9 readiness: min-hours gate reports remaining time and nextEligibleAt', async (t) => {
  const now = Date.now();
  const env = await makeEnv(t, { autoDreamEnabled: true, minHours: 24, minSessions: 1 });
  await setState(env, { lastDreamAt: now - 60 * 60 * 1000, sessionsSince: [{ id: 's1', at: now }] });
  const readiness = env.mods.readiness.dreamReadiness(env.pctx, { config: env.config, now });
  assert.equal(readiness.eligible, false);
  assert.equal(reasonCodes(readiness).includes('min-hours'), true, JSON.stringify(readiness.reasons));
  assert.equal(readiness.gates.minHours.ok, false);
  assert.ok(readiness.gates.minHours.remainingMs > 0);
  assert.ok(readiness.nextEligibleAt > now, 'nextEligibleAt is in the future');
  assert.ok(
    Math.abs(readiness.nextEligibleAt - (now - 60 * 60 * 1000 + 24 * 60 * 60 * 1000)) < 60_000,
    'nextEligibleAt is lastDreamAt + minHours',
  );
});

test('v9 readiness: min-sessions gate reports current/required', async (t) => {
  const now = Date.now();
  const env = await makeEnv(t, { autoDreamEnabled: true, minHours: 1, minSessions: 5, scanThrottleMs: 0 });
  await setState(env, {
    lastDreamAt: now - 48 * 60 * 60 * 1000,
    sessionsSince: [{ id: 'a', at: now }, { id: 'b', at: now }],
    lastScanAt: 0,
  });
  const readiness = env.mods.readiness.dreamReadiness(env.pctx, { config: env.config, now });
  assert.equal(readiness.eligible, false);
  assert.equal(reasonCodes(readiness).includes('min-sessions'), true, JSON.stringify(readiness.reasons));
  assert.equal(readiness.gates.minSessions.ok, false);
  assert.equal(readiness.gates.minSessions.current, 2);
  assert.equal(readiness.gates.minSessions.required, 5);
});

test('v9 readiness: throttle / pending-switch / lock gates', async (t) => {
  const now = Date.now();
  const env = await makeEnv(t, { autoDreamEnabled: true, minHours: 1, minSessions: 1, scanThrottleMs: 600_000 });
  await setState(env, {
    lastDreamAt: now - 48 * 60 * 60 * 1000,
    sessionsSince: [{ id: 'a', at: now }],
    lastScanAt: now - 1000,
    shadowPending: null,
  });

  const throttled = env.mods.readiness.dreamReadiness(env.pctx, { config: env.config, now });
  assert.equal(reasonCodes(throttled).includes('throttle'), true, JSON.stringify(throttled.reasons));

  await setState(env, { lastScanAt: 0, shadowPending: { dir: '/tmp/shadow', createdAt: new Date(now).toISOString() } });
  const pending = env.mods.readiness.dreamReadiness(env.pctx, { config: env.config, now });
  assert.equal(reasonCodes(pending).includes('pending-switch'), true, JSON.stringify(pending.reasons));

  await setState(env, { lastScanAt: 0, shadowPending: null });
  await mkdir(path.dirname(env.paths.lockFile), { recursive: true });
  await writeFile(env.paths.lockFile, JSON.stringify({ pid: process.pid, startedAt: now }), 'utf8');
  const locked = env.mods.readiness.dreamReadiness(env.pctx, { config: env.config, now });
  assert.equal(reasonCodes(locked).includes('lock'), true, JSON.stringify(locked.reasons));

  const eligibleEnv = await makeEnv(t, { autoDreamEnabled: true, minHours: 1, minSessions: 1, scanThrottleMs: 600_000 });
  await setState(eligibleEnv, {
    lastDreamAt: now - 48 * 60 * 60 * 1000,
    sessionsSince: [{ id: 'a', at: now }],
    lastScanAt: 0,
    shadowPending: null,
  });
  const eligible = eligibleEnv.mods.readiness.dreamReadiness(eligibleEnv.pctx, { config: eligibleEnv.config, now });
  assert.equal(eligible.eligible, true, JSON.stringify(eligible.reasons));
  assert.deepEqual(reasonCodes(eligible), []);
  assert.equal(eligible.nextEligibleAt <= now || eligible.nextEligibleAt === 0, true);
});

// ---------------------------------------------------------------------------
// memoryHealth
// ---------------------------------------------------------------------------

test('v9 health: score/dimensions/suggestions baseline and over-budget/neverRead/overdue', async (t) => {
  const env = await makeEnv(t);
  await env.pctx.store.saveEntry({ name: 'one', type: 'user', description: 'one note', content: 'one body' });
  const baseline = env.mods.readiness.memoryHealth(env.pctx, { config: env.config });
  assert.equal(typeof baseline.score, 'number');
  assert.ok(baseline.score >= 0 && baseline.score <= 100);
  for (const key of [
    'indexBudget',
    'neverReadRatio',
    'dreamStaleness',
    'pendingSwitch',
    'truncatedFiles',
    'rules',
    'identity',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(baseline.dimensions, key), `dimensions.${key} is missing`);
  }
  assert.ok(Array.isArray(baseline.suggestions));

  // Index over budget (201 lines).
  await env.pctx.store.writeIndex(Array.from({ length: 201 }, (_, i) => `- [e${i}](user_e${i}.md) — note ${i}`).join('\n') + '\n');
  const overBudget = env.mods.readiness.memoryHealth(env.pctx, { config: env.config });
  assert.equal(overBudget.dimensions.indexBudget.ok, false);
  assert.ok(overBudget.suggestions.some((item) => item.code === 'over-budget'), JSON.stringify(overBudget.suggestions));
  assert.ok(overBudget.score < baseline.score, 'over-budget lowers the health score');

  // Never-read entries: metrics file has no reads for these files.
  const neverReadEnv = await makeEnv(t);
  await neverReadEnv.pctx.store.saveEntry({ name: 'unread', type: 'user', description: 'never read', content: 'never read body' });
  const neverRead = neverReadEnv.mods.readiness.memoryHealth(neverReadEnv.pctx, { config: neverReadEnv.config });
  assert.ok(
    neverRead.suggestions.some((item) => item.code === 'many-never-read'),
    JSON.stringify(neverRead.suggestions),
  );

  // Dream staleness is reported for the readiness view; it is not a daily
  // health signal, so the test asserts the reported shape only.
  const staleEnv = await makeEnv(t);
  const stale = staleEnv.mods.readiness.memoryHealth(staleEnv.pctx, { config: staleEnv.config });
  assert.equal(stale.dimensions.dreamStaleness.overdue, true, JSON.stringify(stale.dimensions.dreamStaleness));
  assert.ok(
    !stale.suggestions.some((item) => item.code === 'dream-overdue'),
    'an idle dream must not be a daily health suggestion',
  );

  // Truncated rules.
  const rulesEnv = await makeEnv(t, { rulesMaxChars: 200 });
  await writeFile(
    rulesEnv.paths.projectRulesFile,
    Array.from({ length: 60 }, (_, i) => `- rule line ${i} with enough characters`).join('\n'),
    'utf8',
  );
  const rulesHealth = rulesEnv.mods.readiness.memoryHealth(rulesEnv.pctx, { config: rulesEnv.config });
  assert.ok(rulesHealth.suggestions.some((item) => item.code === 'rules-truncated'), JSON.stringify(rulesHealth.suggestions));
});

test('v9 health: non-git workspace adds the sharing suggestion', async (t) => {
  const env = await makeEnv(t);
  const health = env.mods.readiness.memoryHealth(env.pctx, { config: env.config });
  assert.ok(
    health.suggestions.some((item) => item.code === 'non-git-sharing'),
    `expected non-git-sharing suggestion: ${JSON.stringify(health.suggestions)}`,
  );
});

// ---------------------------------------------------------------------------
// dream cost modes
// ---------------------------------------------------------------------------

test('v9 cost: block mode preflight refuses before calling the LLM', async (t) => {
  const env = await dreamEnv(t, { dreamMaxTotalTokens: 100, dreamCostMode: 'block' }, null);
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(env.host.llmCalls.length, 0, 'the preflight must not call the LLM');
  const text = JSON.stringify(result);
  assert.match(text, /cost-limit/, `expected a cost-limit refusal, got ${text.slice(0, 400)}`);
  assert.ok(
    Number(result.estimatedTokens ?? result.error?.estimatedTokens ?? NaN) > 100 ||
      /estimated/i.test(text),
    'the refusal reports the estimated token count',
  );
  const entries = await env.pctx.store.listEntries();
  assert.deepEqual(entries, [], 'block preflight writes no memory');
});

test('v9 cost: warn keeps the new copy with costExceeded; block post-hoc refuses', async (t) => {
  const overUsage = { inputTokens: 4000, outputTokens: 1000, totalTokens: 5000 };

  const warnEnv = await dreamEnv(t, { dreamMaxTotalTokens: 100, dreamCostMode: 'warn' }, overUsage);
  const warned = await warnEnv.runtime.dream({ pctx: warnEnv.pctx, force: true, trigger: 'manual' });
  assert.equal(warned.ready, true, 'warn mode still produces the new copy');
  assert.equal(warned.costExceeded, true, JSON.stringify(warned).slice(0, 400));
  assert.match(JSON.stringify(warned.warnings ?? []), /cost-limit-exceeded/i);
  assert.equal(await exists(path.join(warnEnv.pctx.paths.memoryDir, COST_FILE)), false, 'nothing is written before the switch');
  assert.equal(warnEnv.pctx.state.snapshot().lastDreamCostExceeded, true);
  assert.ok(warnEnv.pctx.state.snapshot().shadowPending, 'the copy waits for the human');

  const reviewEnv = await dreamEnv(t, { dreamMaxTotalTokens: 100, dreamCostMode: 'review' }, overUsage);
  const reviewed = await reviewEnv.runtime.dream({ pctx: reviewEnv.pctx, force: true, trigger: 'manual' });
  assert.equal(reviewed.ready, true, 'v24 review mode is the same as warn: the copy waits for the human');
  assert.match(JSON.stringify(reviewed), /cost-limit-exceeded|costExceeded/);
  assert.equal(await exists(path.join(reviewEnv.pctx.paths.memoryDir, COST_FILE)), false);

  // Post-hoc block: estimate stays under the limit (so the LLM is called),
  // but the reported usage is over it.
  const blockEnv = await dreamEnv(t, { dreamMaxTotalTokens: 4000, dreamCostMode: 'block' }, overUsage);
  const blocked = await blockEnv.runtime.dream({ pctx: blockEnv.pctx, force: true, trigger: 'manual' });
  assert.ok(blockEnv.host.llmCalls.length > 0, 'the post-hoc check requires the LLM call');
  assert.match(JSON.stringify(blocked), /cost-limit/);
  assert.notEqual(blocked.ready, true, 'block mode does not produce a copy');
  assert.equal(await exists(path.join(blockEnv.pctx.paths.memoryDir, COST_FILE)), false, 'block mode writes no memory');
  const blockState = blockEnv.pctx.state.snapshot();
  assert.equal(blockState.lastDreamCostExceeded, true);
  assert.ok(String(blockState.lastError ?? '').length > 0, 'block markDreamFailed records an error');
});

// ---------------------------------------------------------------------------
// status integration
// ---------------------------------------------------------------------------

test('v9 readiness: status exposes readiness and memoryHealth', async (t) => {
  const env = await runtimeEnv(t, { autoDreamEnabled: true, minHours: 1, minSessions: 1 }, { plan: PLAN });
  await env.pctx.state.ensureSession('s1');
  const service = env.mods.status.createStatusService(env.runtime);
  const status = await service.status(env.pctx);
  assert.ok(status.readiness, 'status must include readiness');
  assert.equal(typeof status.readiness.eligible, 'boolean');
  assert.ok(Array.isArray(status.readiness.reasons));
  assert.ok(status.health.memoryHealth, 'health must include memoryHealth');
  assert.equal(typeof status.health.memoryHealth.score, 'number');
  assert.ok(status.health.memoryHealth.score >= 0 && status.health.memoryHealth.score <= 100);
  assert.ok(Array.isArray(status.health.memoryHealth.suggestions));
  assert.ok(status.healthScore !== undefined, 'status exposes the health score');
});
