import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPaths } from '../src/paths.js';
import { resolveConfig } from '../src/config.js';
import { MemoryStore } from '../src/store.js';
import { ProjectState } from '../src/state.js';
import { DreamPipeline } from '../src/dream-pipeline.js';
import { DreamEngine } from '../src/dream.js';
import { mergeClaims } from '../src/dream-merge.js';
import { makeTempDir } from './helpers.mjs';

const DATE = '2026-11-12';

function claim(overrides = {}) {
  return {
    text: 'Deploy with make release.',
    quote: 'Deploy with make release.',
    kind: 'project',
    confidence: 'high',
    target: 'project_deploy.md',
    seq: 3,
    date: DATE,
    ...overrides,
  };
}

function page(overrides = {}) {
  return {
    file: 'project_deploy.md',
    name: 'Deploy',
    description: 'Release steps',
    type: 'project',
    body: '- Run make check first. ^[s0#1, 2026-11-01]\n',
    ...overrides,
  };
}

test('a verified claim becomes one cited line and nothing else changes', () => {
  const result = mergeClaims({
    analyses: [{ sessionId: 's1', claims: [claim()], verify: [] }],
    memoryPages: [page(), page({ file: 'project_other.md', name: 'Other', body: '- Keep this line.\n' })],
  });

  const write = result.operations.find((op) => op.op === 'write');
  assert.ok(write);
  assert.equal(write.file, 'project_deploy.md');
  assert.match(write.body, /^- Run make check first\./m);
  assert.match(write.body, /^- Deploy with make release\. \^\[s1#3, 2026-11-12\]$/m);
  assert.equal(result.operations.some((op) => op.file === 'project_other.md'), false);
  assert.deepEqual(result.touched, ['project_deploy.md']);
  assert.match(write.baseHash ?? '', /^[0-9a-f]{64}$/);
});

test('a page no claim mentions is never written', () => {
  const result = mergeClaims({
    analyses: [{ sessionId: 's1', claims: [claim()], verify: [] }],
    memoryPages: [page()],
  });
  assert.deepEqual(result.operations.filter((op) => op.op === 'write').map((op) => op.file), ['project_deploy.md']);

  const untouched = mergeClaims({
    analyses: [{ sessionId: 's1', claims: [], verify: [] }],
    memoryPages: [page()],
  });
  assert.deepEqual(untouched.operations, []);
});

test('identical facts from two sessions merge into one line with both citations', () => {
  const result = mergeClaims({
    analyses: [
      { sessionId: 's1', claims: [claim()], verify: [] },
      { sessionId: 's2', claims: [claim({ seq: 9, date: '2026-11-12' })], verify: [] },
    ],
    memoryPages: [page()],
  });
  const write = result.operations.find((op) => op.op === 'write');
  const lines = write.body.split('\n').filter((line) => line.includes('Deploy with make release.'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\^\[s1#3, 2026-11-12\]/);
  assert.match(lines[0], /\^\[s2#9, 2026-11-12\]/);
});

test('a verified contradiction replaces one line and moves the old value into history', () => {
  const result = mergeClaims({
    analyses: [{
      sessionId: 's1',
      claims: [claim({ text: 'Release runs make release on the host.', quote: 'Use make release on the host.' })],
      verify: [{ file: 'project_deploy.md', claim: 'Release runs make check only.', result: 'contradicts', quote: 'We dropped make check.' }],
    }],
    memoryPages: [page({ body: '- Release runs make check only. ^[s0#1, 2026-11-01]\n' })],
  });
  const write = result.operations.find((op) => op.op === 'write');
  assert.match(write.body, /^STATUS: current$/m);
  assert.match(write.body, /^- Release runs make release on the host\. \^\[s1#3, 2026-11-12\]$/m);
  assert.match(write.body, /^## History$/m);
  assert.match(write.body, /^- Superseded: Release runs make check only\. \(until 2026-11-12\)/m);
});

test('an ambiguous contradiction becomes a review item instead of a write', () => {
  const body = '- Release runs make check only. ^[s0#1, 2026-11-01]\n- Release runs make check only on CI. ^[s0#2, 2026-11-01]\n';
  const result = mergeClaims({
    analyses: [{
      sessionId: 's1',
      claims: [claim({ text: 'Release runs make release.' })],
      verify: [{ file: 'project_deploy.md', claim: 'Release runs make check', result: 'contradicts', quote: 'We dropped make check.' }],
    }],
    memoryPages: [page({ body })],
  });
  assert.deepEqual(result.operations.filter((op) => op.op === 'write'), []);
  assert.equal(result.review.length, 1);
  assert.match(result.review[0].reason, /more than one line/);
});

test('a low-confidence claim waits for review and an uncitable claim is skipped', () => {
  const result = mergeClaims({
    analyses: [{
      sessionId: 's1',
      claims: [
        claim({ text: 'Maybe the cluster is in Osaka.', confidence: 'low' }),
        claim({ text: 'The cluster is in Osaka.', date: '' }),
      ],
      verify: [],
    }],
    memoryPages: [page()],
  });
  assert.deepEqual(result.operations, []);
  assert.equal(result.review.length, 1);
  assert.match(result.review[0].reason, /low-confidence/);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /without a citable position/);
});

test('two pages that share vocabulary get one host-written Related line', () => {
  const result = mergeClaims({
    analyses: [
      { sessionId: 's1', claims: [claim({ text: 'Release builds docker images.' })], verify: [] },
      { sessionId: 's1', claims: [claim({ text: 'Docker images release nightly.', target: 'project_images.md' })], verify: [] },
    ],
    memoryPages: [
      page({ body: '- Docker images are built nightly. ^[s0#1, 2026-11-01]\n' }),
      page({ file: 'project_images.md', name: 'Docker images', description: 'Image build', body: '- Docker images live in the registry.\n' }),
    ],
  });
  const deploy = result.operations.find((op) => op.op === 'write' && op.file === 'project_deploy.md');
  assert.ok(deploy);
  assert.match(deploy.body, /^Related: \[\[project_images\]\]$/m);
});

test('a page edited after the plan was built is refused instead of overwritten', async (t) => {
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'data');
  const workspaceDir = path.join(tmp, 'workspace');
  const paths = buildPaths({ memoryRoot, workspaceDir });
  const config = resolveConfig({ memoryRoot, dreamPipeline: 'v2', dreamMode: 'apply' });
  const store = new MemoryStore({ paths, config });
  await store.ensure();
  const saved = await store.saveEntry({ scope: 'project', name: 'Deploy', type: 'project', description: 'Release steps', content: '- Run make check first.' });
  const engine = new DreamEngine({ ctx: { get: () => undefined }, config });
  const plan = {
    summary: 'add a fact',
    operations: [{
      op: 'write',
      scope: 'project',
      type: 'project',
      file: saved.file,
      name: 'Deploy',
      description: 'Release steps',
      body: '- Run make check first.\n- Deploy with make release. ^[s1#1, 2026-11-12]\n',
      baseHash: 'deadbeef',
    }],
  };
  const result = await engine.executePlan({ store, paths, plan, config, changelog: { at: 0, trigger: 'manual' } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'conflict');
  assert.equal(result.conflicts[0].file, saved.file);
  const after = await store.readEntry(saved.file, 'project');
  assert.doesNotMatch(after.body, /Deploy with make release/);
});

function scriptedCtx(payload, counters) {
  return {
    get(name) {
      if (name === 'llm') {
        return {
          stream() {
            counters.calls += 1;
            const text = JSON.stringify(payload);
            return (async function* generate() {
              yield { type: 'text-delta', text };
              yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
              yield { type: 'finish', reason: { kind: 'stop' } };
            })();
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      if (name === 'sessionQuery') {
        return {
          filterSessions: async () => [],
          readSession: async (id) => ({
            session: { id, createdAt: '2026-11-12T09:00:00Z' },
            events: [{
              type: 'user/message',
              seq: 1,
              time: Date.parse('2026-11-12T09:00:00Z'),
              data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Deploy with make release.' }] },
            }],
          }),
        };
      }
      return undefined;
    },
  };
}

test('the default pipeline path never calls the organizer', async (t) => {
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'data');
  const workspaceDir = path.join(tmp, 'workspace');
  const paths = buildPaths({ memoryRoot, workspaceDir });
  const config = resolveConfig({ memoryRoot, dreamPipeline: 'v2', dreamMode: 'apply' });
  assert.equal(config.dreamOrganizerMode, 'claims');
  const store = new MemoryStore({ paths, config });
  await store.ensure();
  const saved = await store.saveEntry({
    scope: 'project',
    name: 'Deploy',
    type: 'project',
    description: 'Release steps',
    content: '- Run make check first.',
  });
  const state = new ProjectState(paths);
  await state.load();
  await state.ensureSession('s1');
  const counters = { calls: 0 };
  const ctx = scriptedCtx({
    summary: 'deploy changed',
    claims: [{
      text: 'Deploy with make release.',
      quote: 'Deploy with make release.',
      kind: 'project',
      confidence: 'high',
      target: saved.file,
      seq: 1,
      date: DATE,
    }],
    patches: [],
    verify: [],
  }, counters);
  const pctx = { workspaceDir, paths, store, state };
  const pipeline = new DreamPipeline({ ctx, runtime: { config }, config, getConfig: () => config, engine: async () => ({}) });
  const run = await pipeline.run({ pctx, force: true, trigger: 'manual', dryRun: true });
  assert.equal(run.skipped, undefined);
  const plan = JSON.parse(await (await import('node:fs/promises')).readFile(run.planPath, 'utf8'));
  assert.equal(counters.calls, 1);
  assert.equal(plan.manifest.organizer.merge, 'host');
  assert.equal(plan.manifest.models.organizer, '');
  const write = plan.operations.find((op) => op.op === 'write');
  assert.equal(write.file, saved.file);
  assert.match(write.body, /Deploy with make release\./);
});
