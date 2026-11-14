import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../src/store.js';
import { ProjectState } from '../src/state.js';
import { buildPaths } from '../src/paths.js';
import { dreamReadiness } from '../src/readiness.js';
import { resolveConfig } from '../src/config.js';
import { DreamPipeline } from '../src/dream-pipeline.js';
import { ANALYZER_SYSTEM_PROMPT } from '../src/dream-analyzer.js';

// Every unit answers with one correction, so a finished run has a page to
// write into the copy. Without a change the run would settle as `nothing-new`.
const ANALYZER_REPLY = {
  summary: 'read',
  claims: [
    {
      text: 'Run make release before publishing.',
      quote: 'Run make release before publishing.',
      kind: 'correction',
      confidence: 'high',
      target: 'release.md',
    },
  ],
  patches: [],
  verify: [],
};
const ORGANIZER_REPLY = { summary: 'nothing to change', writes: [], deletes: [], links: [], conflicts: [] };

function streamOf(text, { finish = 'stop', signal, block } = {}) {
  return (async function* generate() {
    if (block) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        const abort = () => {
          clearTimeout(timer);
          const error = new Error('aborted by signal');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (finish === 'max-tokens') {
      yield { type: 'text-delta', text: text.slice(0, 40) };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
      return;
    }
    if (finish === 'error') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'analyzer exploded' } } };
      return;
    }
    yield { type: 'text-delta', text };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

/**
 * Scripted host: `onAnalyzer(options, call)` decides each analyzer call.
 * The organizer always answers with ORGANIZER_REPLY.
 */
function scriptedCtx({ onAnalyzer, events, eventsById, startedAt = Date.parse('2026-11-11T12:00:00Z') }) {
  let analyzerCalls = 0;
  return {
    calls: () => analyzerCalls,
    ctx: {
      get(name) {
        if (name === 'llm') {
          return {
            stream(options) {
              if (options.system === ANALYZER_SYSTEM_PROMPT) {
                const call = analyzerCalls;
                analyzerCalls += 1;
                return onAnalyzer({ options, call });
              }
              return streamOf(JSON.stringify(ORGANIZER_REPLY));
            },
          };
        }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
        if (name === 'sessionQuery') {
          return {
            readSession: async (id) => ({ session: { id, createdAt: startedAt }, events: (eventsById && eventsById[id]) || events }),
            filterSessions: async () => [],
          };
        }
        return undefined;
      },
    },
  };
}

function longEvents(chars = 60_000) {
  const body = 'word '.repeat(Math.ceil(chars / 5));
  return [
    { type: 'user/message', seq: 1, time: Date.parse('2026-11-11T12:00:00Z'), data: { source: { kind: 'user' }, content: [{ type: 'text', text: `Release facts ${body}` }] } },
    { type: 'user/message', seq: 2, time: Date.parse('2026-11-11T12:01:00Z'), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run make release before publishing.' }] } },
  ];
}

async function env(t, overrides = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-memory-run-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const memoryRoot = path.join(tmp, 'data');
  const workspaceDir = path.join(tmp, 'workspace');
  const paths = buildPaths({ memoryRoot, workspaceDir });
  const config = resolveConfig({ memoryRoot, dreamPipeline: 'v2', dreamMode: 'apply', ...overrides });
  const store = new MemoryStore({ paths, getConfig: () => config });
  await store.ensure();
  const state = new ProjectState(paths);
  await state.load();
  await state.ensureSession('s1');
  await store.saveEntry({ name: 'Release', type: 'project', content: 'Run the existing release check.' });
  return { tmp, paths, config, store, state, pctx: { workspaceDir, paths, store, state } };
}

function pipelineFor(e, script) {
  const runtime = { config: e.config, invalidateAllInjections: () => {}, invalidateInjection: () => {}, track: (promise) => promise };
  return { pipeline: new DreamPipeline({ ctx: script.ctx, runtime }), script };
}

const SETTLED = ['done', 'ready', 'failed', 'cancelled', 'blocked', 'review', 'skipped'];
const settled = (value) => SETTLED.includes(value?.status);

async function waitForStatus(pipeline, pctx, runId, done) {
  for (let i = 0; i < 600; i += 1) {
    const status = await pipeline.status(pctx, runId);
    if (done(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run did not settle: ${JSON.stringify(await pipeline.status(pctx, runId))}`);
}

test('start returns a run id immediately and the run records every unit', async (t) => {
  const e = await env(t);
  const script = scriptedCtx({ events: longEvents(), onAnalyzer: () => streamOf(JSON.stringify(ANALYZER_REPLY)) });
  const { pipeline } = pipelineFor(e, script);

  const started = await pipeline.start({ pctx: e.pctx, force: true, dryRun: true, trigger: 'manual' });
  assert.equal(started.ok, true);
  assert.equal(started.started, true);
  assert.match(started.runId, /^\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f]{6}$/u);

  const status = await waitForStatus(pipeline, e.pctx, started.runId, settled);
  assert.equal(status.status, 'ready', status.error);
  assert.equal(status.coverageComplete, true);
  assert.ok(status.input.expectedUnits > 1, `expected split units, got ${status.input.expectedUnits}`);
  assert.equal(status.counts.done, status.input.expectedUnits);
  assert.equal(status.counts.pending, 0);
  assert.equal(script.calls(), status.input.expectedUnits);

  const manifest = JSON.parse(await fs.readFile(path.join(e.paths.dreamsDir, started.runId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.models.analyzer, 'fake/fake');
  for (const session of manifest.input.sessions) {
    for (const unit of session.units) {
      assert.equal(unit.status, 'done');
      const record = JSON.parse(
        await fs.readFile(path.join(e.paths.dreamsDir, started.runId, 'analysis', session.id, `${unit.unitId}.json`), 'utf8'),
      );
      assert.equal(record.status, 'done');
      assert.equal(record.unitId, unit.unitId);
    }
  }
  await started.done;
});

test('a second start while running reuses the active run', async (t) => {
  const e = await env(t);
  const script = scriptedCtx({ events: longEvents(), onAnalyzer: () => streamOf(JSON.stringify(ANALYZER_REPLY)) });
  const { pipeline } = pipelineFor(e, script);

  const first = await pipeline.start({ pctx: e.pctx, force: true, dryRun: true });
  const second = await pipeline.start({ pctx: e.pctx, force: true, dryRun: true });
  assert.equal(second.runId, first.runId);
  assert.equal(second.reused, true);
  assert.equal(second.done, first.done);
  assert.deepEqual(pipeline.liveRunIds(), [first.runId]);

  await waitForStatus(pipeline, e.pctx, first.runId, settled);
  assert.equal(script.calls(), (await pipeline.status(e.pctx, first.runId)).input.expectedUnits);
  await first.done;
  assert.deepEqual(pipeline.liveRunIds(), []);
});

test('automatic Dream uses the same throttle and backoff gates as readiness', async (t) => {
  const e = await env(t, { autoDreamEnabled: true, minSessions: 1, minHours: 0 });
  const script = scriptedCtx({ events: longEvents(), onAnalyzer: () => streamOf(JSON.stringify(ANALYZER_REPLY)) });
  const { pipeline } = pipelineFor(e, script);

  await e.state.markDreamStart();
  await e.state.markDreamFailed(new Error('temporary failure'));
  await e.state.noteScan();
  const readiness = dreamReadiness(e.pctx, { config: e.config });
  assert.deepEqual(readiness.reasons.map(({ code }) => code), ['throttle', 'backoff']);

  const run = await pipeline.start({ pctx: e.pctx, trigger: 'auto' });
  const result = await run.done;
  assert.equal(result.skipReason, readiness.reasons[0].code);
  assert.equal(script.calls(), 0);
});

test('resume cannot take a lock owned by a live worker with the same run id', async (t) => {
  const e = await env(t);
  const script = scriptedCtx({ events: longEvents(), onAnalyzer: () => streamOf('', { finish: 'error' }) });
  const { pipeline } = pipelineFor(e, script);
  const started = await pipeline.start({ pctx: e.pctx, force: true });
  await started.done;
  const lock = JSON.stringify({ pid: process.pid, startedAt: Date.now(), runId: started.runId });
  await fs.writeFile(e.paths.lockFile, lock);

  const resumed = await pipeline.resume(e.pctx, started.runId);
  assert.equal((await resumed.done).skipReason, 'lock');
  assert.equal(await fs.readFile(e.paths.lockFile, 'utf8'), lock);
});

test('a failed unit is retried on resume and finished units are not re-analyzed', async (t) => {
  const e = await env(t);
  let fail = true;
  const script = scriptedCtx({
    events: longEvents(),
    onAnalyzer: ({ call }) => {
      if (fail && call === 1) return streamOf('', { finish: 'error' });
      return streamOf(JSON.stringify(ANALYZER_REPLY));
    },
  });
  const { pipeline } = pipelineFor(e, script);

  const started = await pipeline.start({ pctx: e.pctx, force: true });
  const failed = await waitForStatus(pipeline, e.pctx, started.runId, settled);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /unit\(s\) failed/);
  assert.match((failed.errors ?? []).join(' '), /analyzer exploded/);
  assert.equal(failed.counts.failed, 1);
  assert.ok(failed.counts.done >= 1);
  assert.equal(failed.counts.pending, 0);
  const doneBefore = failed.counts.done;

  fail = false;
  const callsBefore = script.calls();
  const resumed = await pipeline.resume(e.pctx, started.runId);
  assert.equal(resumed.started, true, JSON.stringify(resumed));
  const settledRun = await waitForStatus(pipeline, e.pctx, started.runId, (value) => settled(value) && value?.running !== true);
  assert.equal(settledRun.status, 'ready', settledRun.error);
  assert.equal(settledRun.counts.done, settledRun.input.expectedUnits);
  assert.equal(settledRun.counts.failed, 0);
  assert.equal(script.calls() - callsBefore, settledRun.input.expectedUnits - doneBefore);
  await resumed.done;
});

test('cancel stops the run, keeps finished units, and resume completes only the rest', async (t) => {
  const e = await env(t);
  let blockFirst = true;
  let analyzerCalls = 0;
  const script = scriptedCtx({
    events: longEvents(),
    onAnalyzer: ({ options, call }) => {
      analyzerCalls += 1;
      if (blockFirst && call === 0) return streamOf('', { signal: options.signal, block: true });
      return streamOf(JSON.stringify(ANALYZER_REPLY));
    },
  });
  const { pipeline } = pipelineFor(e, script);

  const started = await pipeline.start({ pctx: e.pctx, force: true, dryRun: true });
  const running = await waitForStatus(pipeline, e.pctx, started.runId, (value) => value?.counts?.done > 0);
  assert.equal(running.running, true);

  const cancelled = await pipeline.cancel(e.pctx, started.runId);
  assert.equal(cancelled.ok, true);
  const stopped = await waitForStatus(pipeline, e.pctx, started.runId, (value) => settled(value) && value?.running !== true);
  assert.equal(stopped.status, 'cancelled');
  assert.ok(stopped.counts.done > 0);
  assert.equal(stopped.counts.done + stopped.counts.failed, stopped.input.expectedUnits);

  blockFirst = false;
  const doneBefore = stopped.counts.done;
  const callsBefore = analyzerCalls;
  const resumed = await pipeline.resume(e.pctx, started.runId);
  assert.equal(resumed.started, true, JSON.stringify(resumed));
  const completed = await waitForStatus(pipeline, e.pctx, started.runId, (value) => settled(value) && value?.running !== true);
  assert.equal(completed.status, 'ready', completed.error);
  assert.equal(completed.counts.done, completed.input.expectedUnits);
  assert.equal(analyzerCalls - callsBefore, completed.input.expectedUnits - doneBefore);
  await resumed.done;
});

test('a truncated unit is split and both halves are analyzed', async (t) => {
  const e = await env(t);
  const script = scriptedCtx({
    events: longEvents(),
    onAnalyzer: ({ call }) =>
      call <= 1 ? streamOf('', { finish: 'max-tokens' }) : streamOf(JSON.stringify(ANALYZER_REPLY)),
  });
  const { pipeline } = pipelineFor(e, script);
  const started = await pipeline.start({ pctx: e.pctx, force: true });
  const done = await waitForStatus(pipeline, e.pctx, started.runId, settled);
  await started.done;

  assert.equal(done.status === 'ready' || done.status === 'done', true, `unexpected status ${done.status}`);
  assert.equal(done.counts.failed, 0);
  assert.equal(done.counts.done, done.input.expectedUnits);
  assert.equal(done.coverageComplete, true);
  assert.ok(script.calls() > 2, 'the split halves must be analyzed in separate calls');
});

test('a finished run is not analyzed again after a restart', async (t) => {
  const e = await env(t);
  const script = scriptedCtx({ events: longEvents(), onAnalyzer: () => streamOf(JSON.stringify(ANALYZER_REPLY)) });
  const first = pipelineFor(e, script).pipeline;
  const started = await first.start({ pctx: e.pctx, force: true });
  const done = await waitForStatus(first, e.pctx, started.runId, settled);
  await started.done;
  assert.equal(done.status === 'ready' || done.status === 'done', true, `unexpected status ${done.status}`);
  const callsBefore = script.calls();

  const restarted = pipelineFor(e, script).pipeline;
  const again = await restarted.start({ pctx: e.pctx, force: true });
  const second = await waitForStatus(restarted, e.pctx, again.runId, settled);
  await again.done;

  // The first run left a copy waiting for the human, so a second run stops
  // before spending a model call on it.
  assert.equal(second.status, 'skipped');
  assert.equal(second.skipReason, 'pending-switch');
  assert.equal(script.calls() - callsBefore, 0, 'finished units must come from disk');
});

test('a reloaded pipeline resumes only the units that are missing', async (t) => {
  const e = await env(t);
  const failing = scriptedCtx({
    events: longEvents(),
    onAnalyzer: ({ call }) =>
      call === 0
        ? streamOf(JSON.stringify(ANALYZER_REPLY))
        : streamOf(JSON.stringify(ANALYZER_REPLY), { finish: 'error' }),
  });
  const startedPipeline = pipelineFor(e, failing).pipeline;
  const started = await startedPipeline.start({ pctx: e.pctx, force: true });
  const stopped = await waitForStatus(startedPipeline, e.pctx, started.runId, (status) => status.status === 'failed');
  await started.done;
  const doneBefore = stopped.counts.done;
  assert.ok(doneBefore > 0 && doneBefore < stopped.input.expectedUnits);

  const reloadedScript = scriptedCtx({ events: longEvents(), onAnalyzer: () => streamOf(JSON.stringify(ANALYZER_REPLY)) });
  const reloaded = pipelineFor(e, reloadedScript).pipeline;
  const resumed = await reloaded.resume(e.pctx, started.runId);
  assert.equal(resumed.started, true);
  await resumed.done;
  const completed = await reloaded.status(e.pctx, started.runId);

  assert.equal(completed.status === 'ready' || completed.status === 'done', true, `unexpected status ${completed.status}: ${JSON.stringify(completed.errors)}`);
  assert.equal(completed.counts.done, completed.input.expectedUnits);
  assert.equal(reloadedScript.calls(), completed.input.expectedUnits - doneBefore);
});

test('a unit that stays truncated fails with its range and reason', async (t) => {
  const e = await env(t);
  const script = scriptedCtx({
    events: longEvents(9_000),
    onAnalyzer: () => streamOf('', { finish: 'max-tokens' }),
  });
  const { pipeline } = pipelineFor(e, script);
  const started = await pipeline.start({ pctx: e.pctx, force: true });
  const done = await waitForStatus(pipeline, e.pctx, started.runId, settled);
  await started.done;

  assert.equal(done.status, 'failed');
  assert.ok(done.counts.failed > 0);
  const failed = done.pendingUnits.find((unit) => unit.status === 'failed');
  assert.ok(failed, 'the failed range must stay visible');
  assert.equal(failed.sessionId, 's1');
  assert.ok(Number.isInteger(failed.firstSeq) && Number.isInteger(failed.lastSeq));
  assert.match(failed.error, /max-tokens/);
});

test('status reports unknown and empty runs without throwing', async (t) => {
  const e = await env(t);
  const script = scriptedCtx({ events: [], onAnalyzer: () => streamOf(JSON.stringify(ANALYZER_REPLY)) });
  const { pipeline } = pipelineFor(e, script);

  assert.equal((await pipeline.status(e.pctx)).status, 'none');
  const unknown = await pipeline.status(e.pctx, '2026-11-11T00-00-00-abcdef');
  assert.deepEqual([unknown.ok, unknown.error], [false, 'unknown-run']);
  assert.deepEqual((await pipeline.cancel(e.pctx, '')).error, 'not-running');
  assert.deepEqual((await pipeline.resume(e.pctx, '2026-11-11T00-00-00-abcdef')).error, 'unknown-run');
});

test('eight long sessions survive one truncated unit and one transport failure without duplicate analysis', async (t) => {
  const e = await env(t, { dreamInputMaxChars: 500_000 });
  const ids = Array.from({ length: 8 }, (_, index) => `s${index + 1}`);
  for (const id of ids) await e.state.ensureSession(id);
  const eventsById = Object.fromEntries(ids.map((id, index) => [id, longEvents(index === 0 ? 80_000 : 30_000)]));
  let truncating = true;
  let failing = true;
  const script = scriptedCtx({
    eventsById,
    onAnalyzer: ({ call }) => {
      if (truncating && call === 0) {
        truncating = false;
        return streamOf(JSON.stringify(ANALYZER_REPLY), { finish: 'max-tokens' });
      }
      if (failing && call === 3) {
        failing = false;
        return streamOf('', { finish: 'error' });
      }
      return streamOf(JSON.stringify(ANALYZER_REPLY));
    },
  });
  const { pipeline } = pipelineFor(e, script);
  const started = await pipeline.start({ pctx: e.pctx, force: true });
  const first = await waitForStatus(pipeline, e.pctx, started.runId, settled);
  assert.equal(first.status, 'failed', 'a unit out of retries is a resumable failure');
  assert.equal(first.counts.failed, 1);
  assert.match(first.error, /unit\(s\) failed/u);
  assert.equal(first.counts.done + first.counts.failed, first.input.expectedUnits);
  const doneBefore = first.counts.done;
  assert.ok(first.input.sessions.length === 8, 'every session is in the plan');
  await started.done;

  const resumedScript = scriptedCtx({ eventsById, onAnalyzer: () => streamOf(JSON.stringify(ANALYZER_REPLY)) });
  const resumed = pipelineFor(e, resumedScript);
  const again = await resumed.pipeline.resume(e.pctx, started.runId);
  assert.equal(again.started, true);
  await again.done;
  const second = await waitForStatus(resumed.pipeline, e.pctx, started.runId, settled);
  assert.equal(second.status, 'ready', second.error);
  assert.equal(second.coverageComplete, true);
  assert.equal(second.counts.done, second.input.expectedUnits);
  assert.equal(second.counts.failed, 0);
  assert.equal(
    resumedScript.calls(),
    second.input.expectedUnits - doneBefore,
    'resume must only analyze the units that were not done',
  );
});

test('a run left marked running by a stopped process reads as failed and resumable', async (t) => {
  const e = await env(t);
  const failing = scriptedCtx({
    events: longEvents(),
    onAnalyzer: ({ call }) => (call === 0 ? streamOf(JSON.stringify(ANALYZER_REPLY)) : streamOf('', { finish: 'error' })),
  });
  const first = pipelineFor(e, failing).pipeline;
  const started = await first.start({ pctx: e.pctx, force: true });
  await started.done;
  const file = path.join(e.paths.dreamsDir, started.runId, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...manifest, status: 'running', error: '' }));

  const reloaded = pipelineFor(e, failing).pipeline;
  const status = await reloaded.status(e.pctx, started.runId);
  assert.equal(status.running, false);
  assert.equal(status.status, 'failed');
  assert.equal(status.interrupted, true);
  assert.match(status.error, /resume/);
  assert.equal((await reloaded.status(e.pctx)).status, 'failed', 'the newest-run view must agree');
});

test('a resume blocked by the lock keeps the stopped run record', async (t) => {
  const e = await env(t);
  const failing = scriptedCtx({
    events: longEvents(),
    onAnalyzer: ({ call }) => (call === 0 ? streamOf(JSON.stringify(ANALYZER_REPLY)) : streamOf('', { finish: 'error' })),
  });
  const { pipeline } = pipelineFor(e, failing);
  const started = await pipeline.start({ pctx: e.pctx, force: true });
  await started.done;
  const before = await pipeline.status(e.pctx, started.runId);
  assert.equal(before.status, 'failed');

  await fs.writeFile(e.paths.lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), runId: 'another-run' }));
  const resumed = await pipeline.resume(e.pctx, started.runId);
  assert.equal(resumed.started, true);
  await resumed.done;

  const after = await pipeline.status(e.pctx, started.runId);
  assert.equal(after.status, 'failed', 'a skipped resume must not erase the failed run');
  assert.equal(after.skipReason, 'lock');
  assert.deepEqual(after.counts, before.counts);
  assert.equal(after.input.expectedUnits, before.input.expectedUnits);
});

test('a second run stops while a copy waits for the human', async (t) => {
  const e = await env(t);
  const script = scriptedCtx({ events: longEvents(), onAnalyzer: () => streamOf(JSON.stringify(ANALYZER_REPLY)) });
  const { pipeline } = pipelineFor(e, script);
  await (await pipeline.start({ pctx: e.pctx, force: true })).done;
  const second = await (await pipeline.start({ pctx: e.pctx, force: true })).done;
  assert.equal(second.skipReason, 'pending-switch');
  assert.equal(second.skipped, true);
  assert.ok(second.shadow && second.shadow.dir, 'the waiting copy is reported back');
});

test('a second runtime checks the latest pending copy before analyzing', async (t) => {
  const e = await env(t);
  const script = scriptedCtx({ events: longEvents(), onAnalyzer: () => streamOf(JSON.stringify(ANALYZER_REPLY)) });
  const otherState = new ProjectState(e.paths);
  await otherState.load();
  const otherProject = { ...e.pctx, state: otherState };

  const { pipeline } = pipelineFor(e, script);
  const first = await pipeline.start({ pctx: e.pctx, force: true });
  assert.equal((await first.done).ready, true);
  assert.equal(otherState.snapshot().shadowPending, null);
  const previousCalls = script.calls();

  const second = await pipelineFor(e, script).pipeline.start({ pctx: otherProject, force: true });
  assert.equal((await second.done).skipReason, 'pending-switch');
  assert.equal(script.calls(), previousCalls);
});

test('a human focus reaches the analyzer prompt', async (t) => {
  const e = await env(t);
  const prompts = [];
  const script = scriptedCtx({
    events: longEvents(4000),
    onAnalyzer: ({ options }) => {
      prompts.push((options.messages ?? []).flatMap((message) => message.content ?? []).map((part) => part.text ?? '').join(''));
      return streamOf(JSON.stringify(ANALYZER_REPLY));
    },
  });
  const { pipeline } = pipelineFor(e, script);
  const result = await (await pipeline.start({ pctx: e.pctx, force: true, focus: 'only care about deployment' })).done;
  assert.equal(result.ready, true, JSON.stringify(result).slice(0, 300));
  assert.ok(prompts.length > 0, 'the analyzer must be called');
  for (const prompt of prompts) assert.match(prompt, /only care about deployment/u);
});
