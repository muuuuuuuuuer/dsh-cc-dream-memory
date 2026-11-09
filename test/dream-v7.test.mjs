/**
 * v7 dream diff / per-operation apply / restore helpers / lock / metrics.
 *
 * FIXES-v7 §4:
 *   - runtime.previewPlan: before/after/changed for write/delete/index,
 *     no-plan error, pending-proposal precedence;
 *   - runtime.applyPlanOperations: subset execution, invalid indexes, backup
 *     rollback on mid-apply failure, clearing plan/sessions on success;
 *   - runtime.applyPendingDream: `.consolidate-lock` conflict => dream-locked;
 *   - duration/chars/usage metrics persisted in the plan JSON, state and
 *     changelog (mock `ctx.llm.stream`, no real LLM).
 *
 * Real store/state/runtime in os.tmpdir(); plan files are written by the test
 * where no LLM output is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
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

function streamOf(chunks) {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  })();
}

/**
 * Fake host: workingDirectory + a mock llm whose stream replays one plan JSON
 * plus an optional usage chunk and a normal finish.
 */
function fakeHost({ workspaceDir, plan, usage = { inputTokens: 120, outputTokens: 45, totalTokens: 165 } }) {
  const listeners = new Map();
  const llmCalls = [];
  const services = {
    workingDirectory: { ensure: async () => workspaceDir },
    llm: {
      stream(options) {
        llmCalls.push(options);
        const text = typeof plan === 'string' ? plan : JSON.stringify(plan);
        const chunks = [{ type: 'text-delta', text }];
        if (usage) chunks.push({ type: 'usage', usage });
        chunks.push({ type: 'finish', reason: { kind: 'stop' } });
        return streamOf(chunks);
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    sessionQuery: {
      filterSessions: async () => [],
      readSession: async () => undefined,
    },
  };
  return {
    host: {
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
    },
    llmCalls,
    services,
  };
}

async function makeEnv(t, configOverrides = {}, { plan = null } = {}) {
  const mods = await modules();
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const host = fakeHost({ workspaceDir, plan });
  const runtime = new mods.runtime.MemoryRuntime(host.host, config);
  const pctx = await runtime.storeFor(workspaceDir);
  const paths = mods.paths.buildPaths({ memoryRoot: config.memoryRoot, workspaceDir });
  return { mods, tmp, memoryRoot, workspaceDir, config, host, runtime, pctx, paths };
}

async function writePlanFile(env, plan, { asPending = false } = {}) {
  const planPath = path.join(env.tmp, `plan-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
  if (asPending) await env.pctx.state.setPendingProposal(planPath);
  else await env.pctx.state.setLastPlan(planPath, 'dry-run');
  return planPath;
}

const WRITE_PLAN = {
  summary: 'v7 dream plan',
  operations: [
    {
      op: 'write',
      scope: 'project',
      type: 'user',
      name: 'dreamed note',
      description: 'dreamed description',
      body: 'dreamed body',
    },
  ],
  sessions: [],
  truncatedFiles: [],
};

/** Wrap a real store so the Nth writeRawEntry call throws (rollback test). */
function failingSecondWriteStore(store) {
  let writes = 0;
  return new Proxy(store, {
    get(target, property) {
      if (property === 'writeRawEntry') {
        return async (file, payload) => {
          writes += 1;
          if (writes === 2) throw new Error(`simulated failure writing ${file}`);
          return target.writeRawEntry(file, payload);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------
// previewPlan
// ---------------------------------------------------------------------------

test('v7 dream: previewPlan diffs write/delete/index operations against current memory', async (t) => {
  const env = await makeEnv(t);
  const first = await env.pctx.store.saveEntry({
    name: 'one',
    type: 'feedback',
    description: 'one note',
    content: 'old body',
  });
  const second = await env.pctx.store.saveEntry({
    name: 'two',
    type: 'feedback',
    description: 'two note',
    content: 'two body',
  });
  const plan = {
    summary: 'v7 preview',
    operations: [
      { op: 'write', scope: 'project', type: 'feedback', name: 'one', file: first.file, body: 'new body' },
      { op: 'write', scope: 'project', type: 'user', name: 'brand new', file: 'user_brand_new.md', body: 'new file body' },
      { op: 'write', scope: 'project', type: 'feedback', name: 'two', file: second.file, body: 'two body' },
      { op: 'delete', scope: 'project', file: second.file, reason: 'duplicate' },
      { op: 'index', scope: 'project', content: '- [one](feedback_one.md) — one note\n' },
    ],
    sessions: [],
    truncatedFiles: [],
  };
  const planPath = await writePlanFile(env, plan);
  const preview = await env.runtime.previewPlan(env.pctx);
  assert.equal(preview.path, planPath);
  assert.equal(preview.summary, 'v7 preview');
  assert.equal(preview.ops.length, 5);
  assert.ok(Array.isArray(preview.truncatedFiles));

  const [writeExisting, writeNew, writeUnchanged, deleteOp, indexOp] = preview.ops;
  assert.equal(writeExisting.index, 0);
  assert.equal(writeExisting.op, 'write');
  assert.equal(writeExisting.file, first.file);
  assert.match(writeExisting.before, /old body/, 'before is the current raw file');
  assert.equal(writeExisting.after, 'new body');
  assert.equal(writeExisting.changed, true);

  assert.equal(writeNew.file, 'user_brand_new.md');
  assert.equal(writeNew.before, '', 'a missing file previews an empty before');
  assert.equal(writeNew.changed, true);

  assert.equal(writeUnchanged.changed, false, 'an identical body is not a change');

  assert.equal(deleteOp.op, 'delete');
  assert.match(deleteOp.before, /two body/);
  assert.equal(deleteOp.after, '');
  assert.equal(deleteOp.changed, true);

  assert.equal(indexOp.op, 'index');
  assert.equal(indexOp.file, 'MEMORY.md');
  assert.match(indexOp.before, new RegExp(first.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(indexOp.after, '- [one](feedback_one.md) — one note\n');
  assert.equal(indexOp.changed, true);

  // No plan at all.
  const empty = await makeEnv(t);
  const none = await empty.runtime.previewPlan(empty.pctx);
  assert.equal(none.error, 'no-plan');
  assert.deepEqual(none.ops, []);

  // A pending proposal takes precedence over lastPlanPath.
  const pendingPlan = { ...WRITE_PLAN, summary: 'pending proposal plan' };
  const pendingPath = await writePlanFile(env, pendingPlan, { asPending: true });
  const pendingPreview = await env.runtime.previewPlan(env.pctx);
  assert.equal(pendingPreview.path, pendingPath);
  assert.equal(pendingPreview.summary, 'pending proposal plan');
});

// ---------------------------------------------------------------------------
// applyPlanOperations
// ---------------------------------------------------------------------------

test('v7 dream: applyPlanOperations executes only the selected subset and backs up first', async (t) => {
  const env = await makeEnv(t);
  await env.pctx.store.saveEntry({ name: 'keep', type: 'feedback', description: 'keep me', content: 'keep body' });
  await env.pctx.state.ensureSession('sess-plan');
  const plan = {
    summary: 'subset plan',
    operations: [
      { op: 'write', scope: 'project', type: 'user', name: 'sub a', file: 'user_sub_a.md', body: 'A body' },
      { op: 'write', scope: 'project', type: 'user', name: 'sub b', file: 'user_sub_b.md', body: 'B body' },
      { op: 'write', scope: 'project', type: 'user', name: 'sub c', file: 'user_sub_c.md', body: 'C body' },
    ],
    sessions: ['sess-plan'],
    truncatedFiles: [],
  };
  await writePlanFile(env, plan);

  const result = await env.runtime.applyPlanOperations(env.pctx, { indexes: [0, 2] });
  assert.equal(result.applied, true, JSON.stringify(result));
  assert.equal(result.ops, 2);
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, 'user_sub_a.md')), true);
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, 'user_sub_b.md')), false, 'unselected op is not applied');
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, 'user_sub_c.md')), true);

  const backups = (await readdir(env.pctx.paths.dreamsDir)).filter((name) => !name.endsWith('.json'));
  assert.ok(backups.length >= 1, 'apply must create a pre-apply backup');

  const snapshot = env.pctx.state.snapshot();
  assert.equal(snapshot.lastPlanPath, '', 'a successful apply clears lastPlanPath');
  assert.deepEqual(snapshot.sessionsSince, [], 'plan sessions are consumed after apply');
  const audit = await env.pctx.store.auditIndex();
  assert.equal(audit.missing.length, 0, 'reconcile keeps the index in sync after a subset apply');

  // Out-of-range indexes are refused before touching the disk.
  await writePlanFile(env, plan);
  const invalid = await env.runtime.applyPlanOperations(env.pctx, { indexes: [99] });
  assert.equal(invalid.applied, false);
  assert.equal(invalid.error, 'invalid-indexes');
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, 'user_sub_b.md')), false);
});

test('v7 dream: a mid-apply failure rolls back the backup and clears the plan state', async (t) => {
  const env = await makeEnv(t);
  const original = await env.pctx.store.saveEntry({
    name: 'original',
    type: 'feedback',
    description: 'original',
    content: 'ORIGINAL BODY',
  });
  const plan = {
    summary: 'rollback plan',
    operations: [
      { op: 'write', scope: 'project', type: 'feedback', name: 'original', file: original.file, body: 'REWRITTEN' },
      { op: 'write', scope: 'project', type: 'user', name: 'second', file: 'user_rollback_second.md', body: 'SECOND' },
    ],
    sessions: [],
    truncatedFiles: [],
  };
  await writePlanFile(env, plan);

  const wrappedPctx = { ...env.pctx, store: failingSecondWriteStore(env.pctx.store) };
  const result = await env.runtime.applyPlanOperations(wrappedPctx, { indexes: [0, 1] });
  assert.equal(result.applied, false, JSON.stringify(result));
  assert.equal(result.rolledBack, true, 'a failed apply reports rolledBack:true');
  assert.ok(result.error, 'a failed apply reports its error');

  const restored = await env.pctx.store.readEntry(original.file);
  assert.equal(restored.body.trim(), 'ORIGINAL BODY', 'the backup restores the original body');
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, 'user_rollback_second.md')), false);
  assert.match(await readFile(env.pctx.paths.changelogFile, 'utf8'), /rollback: true/i);
});

// ---------------------------------------------------------------------------
// applyPendingDream lock
// ---------------------------------------------------------------------------

test('v7 dream: applyPendingDream returns dream-locked while the consolidate lock is held', async (t) => {
  const env = await makeEnv(t);
  const plan = {
    summary: 'pending plan',
    operations: [
      { op: 'write', scope: 'project', type: 'user', name: 'pending note', file: 'user_pending_note.md', body: 'pending body' },
    ],
    sessions: [],
    truncatedFiles: [],
  };
  const proposalPath = await writePlanFile(env, plan, { asPending: true });

  await writeFile(env.pctx.paths.lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
  const locked = await env.runtime.applyPendingDream({ pctx: env.pctx });
  // v12 Bug 4: the unified shape is {applied:false,error:'dream-locked'}.
  assert.equal(locked.applied, false, JSON.stringify(locked));
  assert.equal(locked.error, 'dream-locked');
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, 'user_pending_note.md')), false);
  assert.equal(env.pctx.state.snapshot().pendingProposal, proposalPath, 'the pending proposal survives the conflict');

  await unlink(env.pctx.paths.lockFile);
  const applied = await env.runtime.applyPendingDream({ pctx: env.pctx });
  assert.equal(applied.applied, true, JSON.stringify(applied));
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, 'user_pending_note.md')), true);
  assert.equal(env.pctx.state.snapshot().pendingProposal, '', 'a successful apply clears the pending proposal');

  const again = await env.runtime.applyPendingDream({ pctx: env.pctx });
  assert.equal(again.applied, false);
  assert.equal(again.error, 'no-pending-proposal');
});

// ---------------------------------------------------------------------------
// duration / chars / usage metrics
// ---------------------------------------------------------------------------

test('v7 dream: dry-run plan and apply run record durationMs/inputChars/outputChars/usage', async (t) => {
  const plan = {
    summary: 'metrics dream',
    operations: [
      { op: 'write', scope: 'project', type: 'user', name: 'metrics note', description: 'metrics', body: 'metrics body' },
    ],
  };
  const env = await makeEnv(t, {}, { plan });

  // Dry run: the plan JSON carries the metrics.
  const dry = await env.runtime.dream({ pctx: env.pctx, force: true, dryRun: true, trigger: 'manual' });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.applied, false);
  assert.equal(typeof dry.path, 'string', 'the dream result exposes the plan path');
  assert.equal(typeof dry.durationMs, 'number');
  const planPath = env.pctx.state.snapshot().lastPlanPath;
  assert.equal(planPath, dry.path);
  const savedPlan = JSON.parse(await readFile(planPath, 'utf8'));
  assert.equal(typeof savedPlan.durationMs, 'number');
  assert.ok(savedPlan.inputChars > 0, 'plan records the prompt input size');
  assert.ok(savedPlan.outputChars > 0, 'plan records the model output size');
  assert.equal(savedPlan.usage.inputTokens, 120);
  assert.equal(savedPlan.usage.outputTokens, 45);

  // Apply run: state and changelog carry the same metrics.
  const applied = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(applied.applied, true, JSON.stringify(applied));
  assert.equal(typeof applied.durationMs, 'number');
  const snapshot = env.pctx.state.snapshot();
  assert.equal(typeof snapshot.lastDreamDurationMs, 'number');
  assert.ok(snapshot.lastDreamDurationMs >= 0);
  assert.ok(
    Math.abs(applied.durationMs - snapshot.lastDreamDurationMs) < 5000,
    'the state duration and the result duration must describe the same run',
  );
  assert.ok(snapshot.lastDreamInputChars > 0);
  assert.ok(snapshot.lastDreamOutputChars > 0);
  assert.equal(snapshot.lastDreamUsage.inputTokens, 120);
  assert.equal(snapshot.lastDreamUsage.outputTokens, 45);
  const changelog = await readFile(env.pctx.paths.changelogFile, 'utf8');
  assert.match(changelog, /durationMs \d+/);
  assert.match(changelog, /usage: inputTokens=120, outputTokens=45/);

  // The status service exposes the duration field to the UI.
  const service = env.mods.status.createStatusService(env.runtime);
  const status = await service.status(env.pctx);
  assert.equal(status.state.lastDreamDurationMs, snapshot.lastDreamDurationMs);
});

test('v7 dream: legacy state files without metric fields load with zero defaults', async (t) => {
  const env = await makeEnv(t);
  await mkdir(path.dirname(env.pctx.paths.stateFile), { recursive: true });
  await writeFile(
    env.pctx.paths.stateFile,
    JSON.stringify({
      version: 1,
      lastDreamAt: 123,
      lastDreamAttemptAt: 100,
      lastScanAt: 0,
      lastDreamSessions: 2,
      lastDreamOps: 1,
      lastDreamFiles: 1,
      lastDreamSummary: 'legacy',
      lastError: '',
      sessionsSince: [],
      counters: { dreams: 1, skipped: 0, failures: 0 },
      pendingProposal: '',
      lastPlanPath: '',
      lastDreamMode: '',
      consecutiveFailures: 0,
    }),
    'utf8',
  );
  const state = new env.mods.state.ProjectState(env.pctx.paths);
  await state.load();
  const snapshot = state.snapshot();
  assert.equal(snapshot.lastDreamAt, 123);
  assert.equal(snapshot.lastDreamDurationMs, 0, 'missing metrics tolerate to zero');
  assert.equal(snapshot.lastDreamInputChars, 0);
  assert.equal(snapshot.lastDreamUsage, null);
});
