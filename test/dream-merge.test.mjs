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

test('a note edited while the dream ran is refused instead of overwritten', async (t) => {
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'data');
  const workspaceDir = path.join(tmp, 'workspace');
  const paths = buildPaths({ memoryRoot, workspaceDir });
  const config = resolveConfig({ memoryRoot });
  const store = new MemoryStore({ paths, getConfig: () => config });
  await store.ensure();
  const saved = await store.saveEntry({ scope: 'project', name: 'Deploy', type: 'project', description: 'Release steps', content: '- Run make check first.' });
  const state = new ProjectState(paths);
  await state.load();
  const { prepareShadow, applyShadowOperations, shadowPathsOf, shadowDirOf } = (await import('../src/dream-shadow.js'));
  const { shadowStore, base } = await prepareShadow({ store, paths, config });
  await applyShadowOperations({
    shadowStore,
    operations: [{
      op: 'write',
      scope: 'project',
      type: 'project',
      file: saved.file,
      name: 'Deploy',
      description: 'Release steps',
      body: '- Run make check first.\n- Deploy with make release. ^[s1#1, 2026-11-12]\n',
    }],
  });
  await state.setShadowPending({
    dir: shadowDirOf(paths),
    createdAt: Date.now(),
    runId: 'run-conflict',
    summary: 'one page',
    base,
    files: [{ file: saved.file, action: 'changed' }],
    counts: { added: 0, changed: 1, removed: 0 },
    sessions: [],
    verifiedFiles: [],
  });
  // The human edits the live note while the copy waits.
  await store.updateEntry(saved.file, { content: '- Run make check first.\n- HUMAN EDIT' });
  const pctx = { paths, store, state, config };
  const engine = new DreamEngine({ runtime: { config, invalidateAllInjections: () => {}, invalidateInjection: () => {} } });
  const result = await engine.switchShadow({ pctx });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, 'conflict');
  assert.equal(result.conflicts[0].file, saved.file);
  const after = await store.readEntry(saved.file, 'project');
  assert.doesNotMatch(after.body, /Deploy with make release/);
  assert.match(after.body, /HUMAN EDIT/);
  assert.ok(shadowPathsOf(paths).memoryDir);
});
function scriptedCtx(payload, counters) {
  return {
    get(name) {
      if (name === 'llm') {
        return {
          stream() {
            counters.calls += 1;
            const body = JSON.stringify(payload);
            return (async function* generate() {
              yield { type: 'text-delta', text: body };
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

test('the default pipeline only merges in the host, with no organizer model', async (t) => {
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'data');
  const workspaceDir = path.join(tmp, 'workspace');
  const paths = buildPaths({ memoryRoot, workspaceDir });
  const config = resolveConfig({ memoryRoot });
  const store = new MemoryStore({ paths, getConfig: () => config });
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
  const pipeline = new DreamPipeline({ ctx, runtime: { config, track: (promise) => promise } });
  const { done } = await pipeline.start({ pctx, force: true, trigger: 'manual' });
  const run = await done;
  assert.equal(run.ready, true, JSON.stringify(run).slice(0, 300));
  assert.equal(counters.calls, 1);
  assert.equal(run.manifest.organizer.merge, 'host');
  const change = run.files.find((item) => item.file === saved.file);
  assert.equal(change.action, 'changed');
  assert.equal((await store.readEntry(saved.file)).body.trim(), '- Run make check first.', 'nothing is applied by the run itself');
});
test('a better one-line summary is proposed on its own, even for a known fact', () => {
  const result = mergeClaims({
    analyses: [{
      sessionId: 's1',
      claims: [claim({ description: 'How this project ships a release' })],
      verify: [],
    }],
    memoryPages: [page({
      body: '- Deploy with make release. ^[s0#1, 2026-11-01]\n',
      description: 'Release steps',
    })],
  });

  const write = result.operations.find((op) => op.op === 'write');
  assert.ok(write, 'a summary-only change is still one operation');
  assert.equal(write.description, 'How this project ships a release');
  assert.equal(write.body, '- Deploy with make release. ^[s0#1, 2026-11-01]\n', 'the body is not rewritten');
  assert.match(write.baseHash ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(result.touched, ['project_deploy.md']);
});

test('a summary that repeats the current line is not a change', () => {
  const result = mergeClaims({
    analyses: [{
      sessionId: 's1',
      claims: [claim({ description: 'Release steps' })],
      verify: [],
    }],
    memoryPages: [page({ body: '- Deploy with make release. ^[s0#1, 2026-11-01]\n' })],
  });
  assert.deepEqual(result.operations, []);
});

test('an untargeted Chinese claim joins the Chinese page it shares terms with', () => {
  const deploy = page({ name: '部署流程', description: '发布前的检查步骤', body: '- 部署前先跑单元测试。 ^[s0#1, 2026-11-01]\n' });
  const other = page({ file: 'project_style.md', name: '代码风格', description: '格式化约定', body: '- 缩进用两个空格。\n' });
  const result = mergeClaims({
    analyses: [{ sessionId: 's1', claims: [claim({ text: '部署前必须先跑 pnpm test', quote: '部署前必须先跑 pnpm test', target: '' })], verify: [] }],
    memoryPages: [deploy, other],
  });
  const writes = result.operations.filter((op) => op.op === 'write').map((op) => op.file);
  assert.deepEqual(writes, ['project_deploy.md']);
  const body = result.operations.find((op) => op.file === 'project_deploy.md').body;
  assert.doesNotMatch(body, /project_style/, 'an unrelated Chinese page must not be linked');
});

test('an unrelated Chinese claim still gets its own page', () => {
  const result = mergeClaims({
    analyses: [{ sessionId: 's1', claims: [claim({ text: '数据库备份每天凌晨执行', quote: '数据库备份每天凌晨执行', target: '' })], verify: [] }],
    memoryPages: [page({ name: '部署流程', description: '发布前的检查步骤', body: '- 部署前先跑单元测试。\n' })],
  });
  const writes = result.operations.filter((op) => op.op === 'write').map((op) => op.file);
  assert.equal(writes.length, 1);
  assert.notEqual(writes[0], 'project_deploy.md');
});

test('two Chinese pages about the same topic get a Related line', () => {
  const result = mergeClaims({
    analyses: [{ sessionId: 's1', claims: [claim({ text: '镜像构建在发布流水线里完成', quote: '镜像构建在发布流水线里完成' })], verify: [] }],
    memoryPages: [
      page({ name: '部署流程', description: '发布流水线', body: '- 发布流水线每晚构建镜像。\n' }),
      page({ file: 'project_images.md', name: '镜像构建', description: '镜像仓库', body: '- 镜像构建后推送到仓库。\n' }),
    ],
  });
  const deploy = result.operations.find((op) => op.op === 'write' && op.file === 'project_deploy.md');
  assert.ok(deploy);
  assert.match(deploy.body, /^Related: \[\[project_images\]\]$/m);
});
