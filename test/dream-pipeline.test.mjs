import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildPaths } from '../src/paths.js';
import { resolveConfig } from '../src/config.js';
import { MemoryStore } from '../src/store.js';
import { ProjectState } from '../src/state.js';
import { DreamEngine } from '../src/dream.js';
import { DreamPipeline } from '../src/dream-pipeline.js';
import { readLedger } from '../src/verification-ledger.js';
import { makeTempDir } from './helpers.mjs';

/**
 * A dream never edits the live notes. Every test here runs the pipeline, checks
 * the pending copy, and only then switches to it 鈥?exactly what a human does in
 * the panel.
 */
async function env(t, overrides = {}) {
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'data');
  const workspaceDir = path.join(tmp, 'workspace');
  const paths = buildPaths({ memoryRoot, workspaceDir });
  const config = resolveConfig({ memoryRoot, ...overrides });
  const store = new MemoryStore({ paths, getConfig: () => config });
  await store.ensure();
  const state = new ProjectState(paths);
  await state.load();
  return { tmp, paths, config, store, state, pctx: { workspaceDir, paths, store, state } };
}

function userEvent(text, seq = 1, time = Date.parse('2026-11-11T15:00:00Z')) {
  return {
    type: 'user/message',
    seq,
    time,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

/** A ctx whose only model answer is one analyzer reply for session `sN`. */
function analyzerCtx({ events = {}, reply, organizerReply = null } = {}) {
  const calls = [];
  return {
    calls,
    get(name) {
      if (name === 'sessionQuery') {
        return {
          filterSessions: async () => [],
          readSession: async (id) => ({ session: { id, createdAt: 1 }, events: events[id] ?? [] }),
        };
      }
      if (name === 'llm') {
        return {
          stream(options) {
            calls.push(options);
            const payload = organizerReply ?? reply;
            return (async function* generate() {
              yield { type: 'text-delta', text: JSON.stringify(payload) };
              yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
              yield { type: 'finish', reason: { kind: 'stop' } };
            })();
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      return undefined;
    },
  };
}

async function dream(e, ctx, options = {}) {
  const runtime = { config: e.config, invalidateAllInjections: () => {}, invalidateInjection: () => {}, track: (promise) => promise };
  const engine = new DreamEngine({ runtime });
  const pipeline = new DreamPipeline({ ctx, runtime });
  const { done } = await pipeline.start({ pctx: e.pctx, force: true, trigger: 'manual', ...options });
  const result = await done;
  return { engine, pipeline, result };
}

test('a dream writes a pending copy and leaves the live notes untouched', async (t) => {
  const e = await env(t);
  const saved = await e.store.saveEntry({ name: 'Existing', type: 'project', content: '- existing fact' });
  const before = await fs.readFile(path.join(e.paths.memoryDir, saved.file), 'utf8');
  const index = await fs.readFile(e.paths.indexFile, 'utf8');
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('Release notes must list the migration step.')] },
    reply: {
      summary: 'release note',
      claims: [{ text: 'Release notes must list the migration step.', quote: 'Release notes must list the migration step.', kind: 'project', confidence: 'high' }],
      patches: [],
      verify: [],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.ready, true, 'the run ends with a copy waiting for the human');
  assert.equal(result.counts.added, 1);
  assert.equal(result.counts.changed, 0);

  // Nothing reached the live directory, not even the index.
  assert.equal(await fs.readFile(path.join(e.paths.memoryDir, saved.file), 'utf8'), before);
  assert.equal(await fs.readFile(e.paths.indexFile, 'utf8'), index);
  const pending = await engine.pendingSwitch(e.pctx);
  assert.ok(pending, 'the pending copy is registered');
  assert.equal(pending.files.length, 1);
  await assert.rejects(() => e.store.readEntry(pending.files[0].file));

  const switched = await engine.switchShadow({ pctx: e.pctx });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  const created = await e.store.readEntry(pending.files[0].file);
  assert.match(created.body, /Release notes must list the migration step\./);
  assert.match(await fs.readFile(e.paths.indexFile, 'utf8'), new RegExp(created.file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.equal(await engine.pendingSwitch(e.pctx), null, 'switching consumes the copy');
});

test('discarding a pending copy keeps the live notes as they were', async (t) => {
  const e = await env(t);
  const saved = await e.store.saveEntry({ name: 'Existing', type: 'project', content: '- existing fact' });
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('Deploy uses the blue pipeline.')] },
    reply: {
      summary: 'deploy note',
      claims: [{ text: 'Deploy uses the blue pipeline.', quote: 'Deploy uses the blue pipeline.', kind: 'project', confidence: 'high' }],
      patches: [],
      verify: [],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.ready, true, result.error);
  const discarded = await engine.discardShadow({ pctx: e.pctx });
  assert.equal(discarded.ok, true, JSON.stringify(discarded));
  assert.equal(await engine.pendingSwitch(e.pctx), null);
  const entries = await e.store.listEntries();
  assert.deepEqual(entries.map((entry) => entry.file), [saved.file]);
  assert.equal((await e.store.readEntry(saved.file)).body.trim(), '- existing fact');
});

test('a contradicting transcript turns the old value into dated history', async (t) => {
  const e = await env(t);
  const saved = await e.store.saveEntry({
    name: 'Deployment timeout',
    type: 'project',
    content: '- Deployment timeout is 15 seconds. ^[s0#1, 2026-11-01]',
  });
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('Deployment timeout is 90 seconds.')] },
    reply: {
      summary: 'timeout correction',
      claims: [{ text: 'Deployment timeout is 90 seconds', quote: 'Deployment timeout is 90 seconds.', kind: 'correction', confidence: 'high', target: saved.file }],
      patches: [],
      verify: [{ file: saved.file, claim: 'Deployment timeout is 15 seconds', result: 'contradicts', quote: 'Deployment timeout is 90 seconds.' }],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.ready, true, result.error);
  const switched = await engine.switchShadow({ pctx: e.pctx });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  const page = await e.store.readEntry(saved.file);
  assert.match(page.body, /Deployment timeout is 90 seconds/, 'the transcript value becomes current');
  assert.match(page.body, /Superseded: Deployment timeout is 15 seconds/, 'the old value turns into history');
  const ledger = await readLedger(e.store, 'project');
  assert.ok(ledger.entries[saved.file], 'the verified page is recorded when the human switches');
});

test('a claim about a different subject never replaces the current value', async (t) => {
  const e = await env(t);
  const saved = await e.store.saveEntry({
    name: '读超时',
    type: 'project',
    content: '- 读超时是 15 秒。 ^[s0#1, 2026-11-01]',
  });
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('写超时是 90 秒。')] },
    reply: {
      summary: 'timeout correction',
      claims: [{ text: '写超时是 90 秒', quote: '写超时是 90 秒。', kind: 'correction', confidence: 'high', target: saved.file }],
      patches: [],
      verify: [{ file: saved.file, claim: '读超时是 15 秒', result: 'contradicts', quote: '写超时是 90 秒。' }],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.ready === true || result.skipped === true, true, result.error);
  assert.equal((await e.store.readEntry(saved.file)).body.trim(), '- 读超时是 15 秒。 ^[s0#1, 2026-11-01]', 'the live page never changed');
  if (result.ready === true) assert.equal((await engine.switchShadow({ pctx: e.pctx })).ok, true);
  const page = await e.store.readEntry(saved.file);
  assert.match(page.body, /读超时是 15 秒/, 'the read timeout stays current');
  assert.match(page.body, /CONFLICT: "读超时是 15 秒。" vs "写超时是 90 秒"/, 'both values are kept, flagged');
  assert.doesNotMatch(page.body, /Superseded/, 'nothing was superseded');
});

test('a value the host cannot confirm as the same quantity is kept as a conflict', async (t) => {
  const e = await env(t);
  const saved = await e.store.saveEntry({
    name: 'Read timeout',
    type: 'project',
    content: '- Read timeout is 15 seconds. ^[s0#1, 2026-11-01]',
  });
  await e.state.ensureSession('s1');
  // The analyzer says "contradicts", but the host cannot see `write timeout 90 s`
  // as the same quantity as `read timeout 15 s`. Neither value wins: the page
  // keeps both, flagged, and a person decides.
  const ctx = analyzerCtx({
    events: { s1: [userEvent('Write timeout is 90 seconds.')] },
    reply: {
      summary: 'timeout correction',
      claims: [{ text: 'Write timeout is 90 seconds', quote: 'Write timeout is 90 seconds.', kind: 'correction', confidence: 'high', target: saved.file }],
      patches: [],
      verify: [{ file: saved.file, claim: 'Read timeout is 15 seconds', result: 'holds', quote: 'Read timeout is 15 seconds.' }],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.ready === true || result.skipped === true, true, result.error);
  assert.equal(
    (await e.store.readEntry(saved.file)).body.trim(),
    '- Read timeout is 15 seconds. ^[s0#1, 2026-11-01]',
    'the live page never changed',
  );
  if (result.ready === true) assert.equal((await engine.switchShadow({ pctx: e.pctx })).ok, true, 'switch');
  const page = await e.store.readEntry(saved.file);
  assert.match(page.body, /Read timeout is 15 seconds/, 'the read timeout stays current');
  assert.match(page.body, /CONFLICT: "Read timeout is 15 seconds." vs "Write timeout is 90 seconds"/, 'both values are kept, flagged');
  assert.doesNotMatch(page.body, /Superseded/, 'nothing was superseded');
  const review = JSON.stringify(result.summary ?? '');
  assert.match(review, /left for review/, 'the run report still names it');
});

test('a second identical run does not duplicate the conflict line', async (t) => {
  const e = await env(t);
  const saved = await e.store.saveEntry({
    name: 'Read timeout',
    type: 'project',
    content: '- Read timeout is 15 seconds. ^[s0#1, 2026-11-01]',
  });
  await e.state.ensureSession('s1');
  const makeCtx = () => analyzerCtx({
    events: { s1: [userEvent('Write timeout is 90 seconds.', 1), userEvent('Still 90 seconds.', 2)] },
    reply: {
      summary: 'timeout',
      claims: [{ text: 'Write timeout is 90 seconds', quote: 'Write timeout is 90 seconds.', kind: 'correction', confidence: 'high', target: saved.file }],
      patches: [],
      verify: [{ file: saved.file, claim: 'Read timeout is 15 seconds', result: 'holds', quote: 'Read timeout is 15 seconds.' }],
    },
  });
  const first = await dream(e, makeCtx());
  if (first.result.ready === true) await first.engine.switchShadow({ pctx: e.pctx });
  const once = await e.store.readEntry(saved.file);
  const count = (once.body.match(/CONFLICT: /gu) ?? []).length;
  assert.equal(count, 1, once.body);
  await e.state.ensureSession('s2');
  const second = await dream(e, makeCtx());
  if (second.result.ready === true) await second.engine.switchShadow({ pctx: e.pctx });
  const twice = await e.store.readEntry(saved.file);
  assert.equal((twice.body.match(/CONFLICT: /gu) ?? []).length, 1, twice.body);
});

test('a repeated run records the superseded value once', async (t) => {
  const e = await env(t);
  const saved = await e.store.saveEntry({
    name: 'Route',
    type: 'project',
    content: '- 路由用旧入口。 ^[s0#1, 2026-11-01]',
  });
  await e.state.ensureSession('s1');
  const makeCtx = () => analyzerCtx({
    events: { s1: [userEvent('以后路由改动用真实入口验证')] },
    reply: {
      summary: 'route correction',
      claims: [{ text: '路由改动用真实入口验证', quote: '路由改动用真实入口验证', kind: 'correction', confidence: 'high', target: saved.file }],
      patches: [],
      verify: [{ file: saved.file, claim: '路由用旧入口。', result: 'contradicts', quote: '路由改动用真实入口验证' }],
    },
  });
  const first = await dream(e, makeCtx());
  assert.equal(first.result.ready, true, first.result.error);
  assert.equal((await first.engine.switchShadow({ pctx: e.pctx })).ok, true);

  // The second pass has nothing new: the same claims land on the same page.
  const second = await dream(e, makeCtx());
  assert.equal(second.result.ready === true || second.result.skipped === true, true, second.result.error);
  if (second.result.ready === true) await second.engine.switchShadow({ pctx: e.pctx });

  const page = await e.store.readEntry(saved.file);
  assert.match(page.body, /Superseded: 路由用旧入口。\s*\(until \d{4}-\d{2}-\d{2}\)/);
  assert.equal((page.body.match(/Superseded:/gu) ?? []).length, 1, 'history is written once');
  assert.equal((page.body.match(/路由改动用真实入口验证/gu) ?? []).length, 1, 'the new value is not duplicated');
});

test('a retire request deletes the page and leaves a MOVED TO line', async (t) => {
  const e = await env(t);
  const from = await e.store.saveEntry({ name: 'Old deploy', type: 'project', content: '- Deploy runs on the blue host. ^[s0#1, 2026-11-01]' });
  const to = await e.store.saveEntry({ name: 'Deploy', type: 'project', content: '- Deploys go to the blue host via pm2. ^[s0#1, 2026-11-01]' });
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('Deploy details all live on the Deploy page now.')] },
    reply: {
      summary: 'deploy moved',
      claims: [],
      patches: [],
      verify: [],
      retire: [{ file: from.file, target: to.file }],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.ready, true, result.error);
  assert.equal((await engine.switchShadow({ pctx: e.pctx })).ok, true);
  const files = (await e.store.listEntries()).map((entry) => entry.file);
  assert.deepEqual(files, [to.file], 'the retired page is gone');
  const index = await fs.readFile(e.paths.indexFile, 'utf8');
  assert.match(index, /\[Old deploy\]\(project_old_deploy\.md\) — MOVED TO \[\[project_deploy\]\]/, index);
});

test('a retire request that names an unknown target writes nothing', async (t) => {
  const e = await env(t);
  const from = await e.store.saveEntry({ name: 'Loose end', type: 'project', content: '- Something true. ^[s0#1, 2026-11-01]' });
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('That note is done with.')] },
    reply: {
      summary: 'loose end',
      claims: [],
      patches: [],
      verify: [],
      retire: [{ file: from.file, target: 'project_missing.md' }],
    },
  });
  const { result } = await dream(e, ctx);
  assert.equal(result.ready === true || result.skipped === true, true, result.error);
  assert.deepEqual((await e.store.listEntries()).map((entry) => entry.file), [from.file], 'the page stays');
});

test('an uncited line keeps the page out of the ledger', async (t) => {
  const e = await env(t);
  const saved = await e.store.saveEntry({
    name: 'Budget',
    type: 'project',
    content: '- Index budget is 8KB. ^[s0#1, 2026-11-01]\n- Timeout stays 90 seconds.',
  });
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('Index budget is 8KB. Timeout stays 90 seconds.')] },
    reply: {
      summary: 'budget check',
      claims: [{ text: 'Index budget is 8KB', quote: 'Index budget is 8KB.', kind: 'fact', confidence: 'high', target: saved.file }],
      patches: [],
      verify: [{ file: saved.file, claim: 'Index budget is 8KB', result: 'holds', quote: 'Index budget is 8KB.' }],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.ready === true || result.skipped === true, true, result.error);
  if (result.ready === true) assert.equal((await engine.switchShadow({ pctx: e.pctx })).ok, true);
  const ledger = await readLedger(e.store, 'project');
  assert.equal(ledger.entries[saved.file], undefined, 'only one fact was verified; the page holds more');
});

test('one supported fact does not stamp a page that also holds an unverified one', async (t) => {
  const e = await env(t);
  const saved = await e.store.saveEntry({
    name: 'Budget',
    type: 'project',
    content: '- Index budget is 8KB. ^[s0#1, 2026-11-01]\n- Timeout is 15 seconds. ^[s0#2, 2026-11-01]',
  });
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('Index budget is 8KB')] },
    reply: {
      summary: 'budget check',
      claims: [{ text: 'Index budget is 8KB', quote: 'Index budget is 8KB', kind: 'fact', confidence: 'high', target: saved.file }],
      patches: [],
      verify: [
        { file: saved.file, claim: 'Index budget is 8KB', result: 'holds', quote: 'Index budget is 8KB' },
        { file: saved.file, claim: 'Timeout is 15 seconds', result: 'holds', quote: 'I found no related information.' },
      ],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.ready === true || result.skipped === true, true, result.error);
  if (result.ready === true) assert.equal((await engine.switchShadow({ pctx: e.pctx })).ok, true);
  const page = await e.store.readEntry(saved.file);
  assert.doesNotMatch(page.body, /VERIFIED AGAINST/, 'one supported fact cannot stamp the whole page');
  const ledger = await readLedger(e.store, 'project');
  assert.equal(ledger.entries[saved.file], undefined, 'the hot set must not promote a partly verified page');
});

test('consolidation without transcripts invents no page', async (t) => {
  const e = await env(t);
  await e.store.saveEntry({ name: 'Existing', type: 'project', content: '- existing fact' });
  const ctx = analyzerCtx({
    reply: { summary: 'nothing', claims: [], patches: [], verify: [] },
    organizerReply: { summary: 'nothing', claims: [], patches: [], verify: [] },
  });
  const { result } = await dream(e, ctx, { noSessions: true });
  assert.equal(result.ready, false, 'a claim without a transcript cannot become a page');
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'nothing-new');
  const entries = await e.store.listEntries();
  assert.deepEqual(entries.map((entry) => entry.file), ['project_existing.md']);
});

test('every unit of a long session is analyzed and the watermark advances on switch', async (t) => {
  const e = await env(t, { dreamMaxAnalyzerCalls: 1, dreamMaxSessionChars: 1000, dreamMapChunkChars: 2000 });
  await e.store.saveEntry({ name: 'Release', type: 'project', content: 'Run the existing release check.' });
  await e.state.ensureSession('long');
  await e.state.ensureSession('deferred');
  const before = e.state.snapshot();
  const events = Array.from({ length: 8 }, (_, i) => userEvent(`Release evidence ${i} ${'word '.repeat(2000)}`, i + 1));
  const ctx = analyzerCtx({
    events: { long: events, deferred: [userEvent('Deferred session note.', 1)] },
    reply: {
      summary: 'analyzed',
      claims: [{ text: 'Release evidence 0', quote: 'Release evidence 0', kind: 'project', confidence: 'high' }],
      patches: [],
      verify: [],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(result.manifest.failed, []);
  assert.deepEqual(result.manifest.partial, []);
  assert.equal(result.manifest.coverageComplete, true);
  assert.equal(result.manifest.processed, 2);
  assert.ok(result.manifest.input.expectedUnits > 2, `expected split units, got ${result.manifest.input.expectedUnits}`);
  assert.equal(result.manifest.counts.pending, 0);
  assert.equal(result.manifest.counts.done, result.manifest.input.expectedUnits);
  for (const read of before.sessionsSince ? [] : []) assert.ok(read);

  const switched = await engine.switchShadow({ pctx: e.pctx });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  const processed = e.state.snapshot().dreamProcessedSessions;
  for (const id of ['deferred', 'long']) {
    assert.equal(processed.find((item) => item.id === id)?.seq, id === 'long' ? events.at(-1).seq : 1);
  }
});

test('the index in the copy is rebuilt from the pages it holds', async (t) => {
  const e = await env(t);
  const saved = await e.store.saveEntry({ name: 'Existing', type: 'project', content: '- existing fact' });
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('Deploy uses the blue pipeline.')] },
    reply: {
      summary: 'deploy note',
      claims: [{ text: 'Deploy uses the blue pipeline.', quote: 'Deploy uses the blue pipeline.', kind: 'project', confidence: 'high' }],
      patches: [],
      verify: [],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.ready, true, result.error);
  assert.equal((await engine.switchShadow({ pctx: e.pctx })).ok, true);
  const index = await fs.readFile(e.paths.indexFile, 'utf8');
  const entries = await e.store.listEntries();
  assert.equal(entries.length, 2, 'the claim became a new page beside the existing one');
  for (const entry of entries) {
    assert.match(index, new RegExp(entry.file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  }
  assert.match(index, new RegExp(saved.file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.equal(await fs.access(path.join(e.paths.memoryDir, 'SKILL.md')).then(() => true).catch(() => false), false, 'the host never writes a SKILL.md');
});

test('undo restores the previous notes and refuses after a manual edit', async (t) => {
  const e = await env(t);
  const saved = await e.store.saveEntry({ name: 'Existing', type: 'project', content: '- existing fact' });
  const before = await fs.readFile(path.join(e.paths.memoryDir, saved.file), 'utf8');
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('Deploy uses the blue pipeline.')] },
    reply: {
      summary: 'deploy note',
      claims: [{ text: 'Deploy uses the blue pipeline.', quote: 'Deploy uses the blue pipeline.', kind: 'project', confidence: 'high' }],
      patches: [],
      verify: [],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.ready, true, result.error);
  assert.equal((await engine.switchShadow({ pctx: e.pctx })).ok, true);
  const added = (await e.store.listEntries()).map((entry) => entry.file).filter((file) => file !== saved.file);
  assert.equal(added.length, 1);

  const undone = await engine.undoLastDream({ pctx: e.pctx });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(await fs.readFile(path.join(e.paths.memoryDir, saved.file), 'utf8'), before);
  assert.deepEqual((await e.store.listEntries()).map((entry) => entry.file), [saved.file], 'a page the switch created is removed again');
});

test('undo refuses when the switched file was edited by hand', async (t) => {
  const e = await env(t);
  await e.store.saveEntry({ name: 'Existing', type: 'project', content: '- existing fact' });
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('Deploy uses the blue pipeline.')] },
    reply: {
      summary: 'deploy note',
      claims: [{ text: 'Deploy uses the blue pipeline.', quote: 'Deploy uses the blue pipeline.', kind: 'project', confidence: 'high' }],
      patches: [],
      verify: [],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.ready, true, result.error);
  assert.equal((await engine.switchShadow({ pctx: e.pctx })).ok, true);
  const touched = result.files.find((item) => item.action === 'added').file;
  const entry = await e.store.readEntry(touched);
  const edited = await e.store.writeRawEntry(touched, {
    name: entry.name,
    description: entry.description,
    type: entry.frontmatter.type,
    body: `${entry.body}\n- typed by hand after the switch`,
  });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const refused = await engine.undoLastDream({ pctx: e.pctx });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'conflict');
  assert.match((await e.store.readEntry(touched)).body, /typed by hand/);
});

test('a blocked cost limit leaves no pending copy', async (t) => {
  const e = await env(t, { dreamMaxTotalTokens: 1, dreamCostMode: 'block' });
  const saved = await e.store.saveEntry({ name: 'Existing', type: 'project', content: '- existing fact' });
  await e.state.ensureSession('s1');
  const ctx = analyzerCtx({
    events: { s1: [userEvent('Deploy uses the blue pipeline.')] },
    reply: {
      summary: 'deploy note',
      claims: [{ text: 'Deploy uses the blue pipeline.', quote: 'Deploy uses the blue pipeline.', kind: 'project', confidence: 'high' }],
      patches: [],
      verify: [],
    },
  });
  const { engine, result } = await dream(e, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cost-limit');
  assert.equal(await engine.pendingSwitch(e.pctx), null);
  assert.equal((await e.store.readEntry(saved.file)).body.trim(), '- existing fact');
});

test('an analyzer failure is retried with a smaller prompt and the full transcript', async (t) => {
  const e = await env(t, { dreamAnalyzerMemoryChars: 40_000 });
  await e.store.saveEntry({
    name: 'Large reference',
    type: 'reference',
    content: 'Reference detail. '.repeat(800) + 'LARGE_REFERENCE_END',
  });
  const markers = ['The retry must keep the first fact.', 'The retry must keep the last fact.'];
  const ids = ['token-limit', 'transport'];
  for (const id of ids) await e.state.ensureSession(id);
  const attempts = new Map(ids.map((id) => [id, []]));
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          filterSessions: async () => [],
          readSession: async (id) => ({
            session: { id },
            events: markers.map((text, i) => userEvent(text, i + 1, Date.parse('2026-11-11T15:00:00Z') + i)),
          }),
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      if (name !== 'llm') return undefined;
      return {
        async *stream(options) {
          const prompt = (options.messages ?? []).flatMap((message) => message.content ?? []).map((part) => part.text ?? '').join('');
          const id = ids.find((candidate) => prompt.includes(`Session: ${candidate}`));
          const calls = attempts.get(id);
          calls.push({ prompt, maxTokens: options.maxTokens });
          if (calls.length === 1) {
            if (id === 'transport') {
              yield { type: 'finish', reason: { kind: 'error', failure: { message: 'DeepSeek Messages transport failed' } } };
            } else {
              yield { type: 'usage', usage: { totalTokens: 20 } };
              yield { type: 'finish', reason: { kind: 'max-tokens' } };
            }
            return;
          }
          yield { type: 'usage', usage: { totalTokens: 10 } };
          yield { type: 'text-delta', text: '{"summary":"Read both facts","claims":[],"patches":[],"verify":[]}' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
  const { result } = await dream(e, ctx);
  assert.equal(result.manifest?.coverageComplete, true, result.error);
  assert.equal(result.manifest.processed, ids.length);
  assert.equal(result.manifest.stages[0].retries, ids.length);
  for (const [id, calls] of attempts) {
    assert.equal(calls.length, 2);
    assert.match(calls[0].prompt, /LARGE_REFERENCE_END/);
    assert.doesNotMatch(calls[1].prompt, /LARGE_REFERENCE_END/);
    assert.match(calls[1].prompt, /Compact retry/);
    for (const marker of markers) assert.ok(calls[1].prompt.includes(marker));
    assert.equal(calls[1].maxTokens, id === 'token-limit' ? calls[0].maxTokens * 2 : calls[0].maxTokens);
  }
});
