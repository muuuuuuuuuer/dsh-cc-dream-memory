/**
 * A dream plan must show where new statements came from. The host checks the
 * quotes itself, because a model can be wrong about its own sources.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildEvidenceCorpus, checkPlanEvidence, collectStaleReferences } from '../src/dream-evidence.js';

const input = {
  memory: {
    files: [
      { file: 'project_deploy.md', body: '部署在 AWS ECS。\n回滚走蓝绿切换。', truncated: false },
      { file: 'feedback_style.md', body: '回答要简短。', truncated: false },
    ],
  },
  sessions: [
    {
      id: 's1',
      excerpt: [
        '--- 2026-11-08 ---',
        '[user] 以后部署都走 GCP Cloud Run',
        '[assistant] 好的，我记录这个决定',
        '[user-pasted] ## 审计报告\n其他 agent 的汇报不直接采信',
        '[tool-call] pwsh {"c":"deploy"}',
        '[tool-result] pwsh: 部署窗口固定在周五下午',
      ].join('\n'),
    },
    {
      id: 's2',
      excerpt: '',
      facts: [{ source: 'user', quote: '测试必须用 vitest', text: '测试框架', date: '2026-11-08', kind: 'preference' }],
    },
  ],
};

const write = (over) => ({ op: 'write', scope: 'project', type: 'project', file: 'project_deploy.md', name: 'deploy', description: 'd', body: '新的内容行', ...over });
const check = (operations, options = {}) => checkPlanEvidence(operations, { corpus: buildEvidenceCorpus(input), memoryFiles: input.memory.files, requireEvidence: true, ...options });

test('a project write with a quote the host can find is kept', () => {
  const result = check([write({ evidence: ['部署都走 GCP Cloud Run'] })]);
  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.dropped, []);
});

test('whitespace and markdown differences do not defeat a real quote', () => {
  const result = check([write({ evidence: ['部署都走  GCP   cloud run'] })]);
  assert.equal(result.operations.length, 1);
});

test('new statements without evidence are dropped with a reason', () => {
  const result = check([write({})]);
  assert.equal(result.operations.length, 0);
  assert.match(result.dropped[0], /project_deploy\.md.*evidence/);
});

test('an invented quote is not evidence', () => {
  const result = check([write({ evidence: ['这句话从来没有人说过'] })]);
  assert.equal(result.operations.length, 0);
});

test('a very short quote proves nothing', () => {
  const result = check([write({ evidence: ['部署'] })]);
  assert.equal(result.operations.length, 0);
});

test('user and feedback memories need something the user typed', () => {
  const feedback = (quote) => write({ type: 'feedback', file: 'feedback_new.md', evidence: [quote] });
  assert.equal(check([feedback('部署都走 GCP Cloud Run')]).operations.length, 1, 'typed line');
  assert.equal(check([feedback('测试必须用 vitest')]).operations.length, 1, 'a typed fact from analysis notes');
  for (const [label, quote] of [
    ['pasted material', '其他 agent 的汇报不直接采信'],
    ['assistant text', '我记录这个决定'],
    ['tool output', '部署窗口固定在周五下午'],
    ['existing memory', '回滚走蓝绿切换'],
  ]) {
    const result = check([feedback(quote)]);
    assert.equal(result.operations.length, 0, label);
    assert.match(result.dropped[0], /\[user\]/, label);
  }
});

test('project memory may rest on tool output, pasted material or existing memory', () => {
  for (const quote of ['部署窗口固定在周五下午', '其他 agent 的汇报不直接采信', '回滚走蓝绿切换']) {
    assert.equal(check([write({ evidence: [quote] })]).operations.length, 1, quote);
  }
});

test('reorganizing what a file already says needs no evidence', () => {
  const result = check([write({ body: '回滚走蓝绿切换。\n部署在 AWS ECS。' })]);
  assert.equal(result.operations.length, 1);
});

test('without sessions there is nothing to cite, so evidence is not required', () => {
  const result = check([write({})], { requireEvidence: false });
  assert.equal(result.operations.length, 1);
});

test('deletes and index operations pass through', () => {
  const operations = [{ op: 'delete', scope: 'project', file: 'x.md', reason: 'r' }, { op: 'index', scope: 'project', content: '- x\n' }];
  assert.deepEqual(check(operations).operations, operations);
});

test('a large shrink is retained with a warning so unattended review can inspect it', () => {
  const files = [{ file: 'project_big.md', body: `${'重要事实。\n'.repeat(100)}`, truncated: false }];
  const shrink = { op: 'write', scope: 'project', type: 'project', file: 'project_big.md', name: 'big', description: 'd', body: '重要事实。' };
  const auto = checkPlanEvidence([shrink], { corpus: [], memoryFiles: files, requireEvidence: false, unattended: true });
  assert.equal(auto.operations.length, 1);
  assert.match(auto.warnings[0], /project_big\.md/);
  const manual = checkPlanEvidence([shrink], { corpus: [], memoryFiles: files, requireEvidence: false, unattended: false });
  assert.equal(manual.operations.length, 1);
  assert.match(manual.warnings[0], /project_big\.md/);
});

test('stale references: an absolute path under the project counts, a rooted route does not', () => {
  const stale = collectStaleReferences(
    [{ file: 'project_a.md', body: 'Old entry `/srv/acme/src/gone.js`. Route `/api/users.js`.' }],
    ['/srv/acme'],
  );
  assert.deepEqual(stale.map((item) => item.reference), ['/srv/acme/src/gone.js']);
});

test('stale references: only paths that no longer exist are reported', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'alive.js'), '');
  const stale = collectStaleReferences(
    [{
      file: 'project_a.md',
      body: [
        '入口在 `src/alive.js`，旧逻辑在 `src/gone.js`。',
        '配置 `dreamMaxOps`、命令 `node --test`、地址 `https://example.com/a/b.js`、家目录 `~/.dsh/x.md`、通配 `src/*.js`。',
        `绝对路径 \`${path.join(root, 'src', 'missing.js')}\` 和 \`${path.join(root, 'src', 'alive.js')}\`。`,
      ].join('\n'),
    }],
    [root],
  );
  assert.deepEqual(stale.map((item) => [item.file, path.basename(item.reference)]).sort(), [
    ['project_a.md', 'gone.js'],
    ['project_a.md', 'missing.js'],
  ]);
});
