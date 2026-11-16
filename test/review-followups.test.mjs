/**
 * Follow-ups from the 2026-11-16 review: headings carry meaning in the
 * fact-preservation check, an unsourced change can be accepted after reading
 * its diff, recall sees relevant old pages past the manifest cap, rejections
 * record the exact change, and auto-extract refuses instead of truncating.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toolsEnv, streamOf } from './v10-helpers.mjs';
import { runAutoExtract } from '../src/auto-extract.js';
import { rankForQuery, recallManifest } from '../src/recall.js';

const exec = { agent: { id: 's1' }, sessionId: 's1' };
const save = (env, name, content) => env.pctx.store.saveEntry({ name, content, type: 'project' });
const dream = (env, options = {}) => env.runtime.dream({ pctx: env.pctx, force: true, ...options });
const proofOf = (env, file) => env.pctx.state.snapshot().shadowPending.proofs.find((item) => item.file === file);

function model(env, steps) {
  const requests = [];
  env.host.services.llm.stream = (options) => {
    const calls = steps[requests.length] ?? [];
    requests.push(options);
    return streamOf([
      ...calls.map(([name, args], index) => ({
        type: 'block-end', block: { type: 'tool-call', id: 'c' + requests.length + '-' + index, name, arguments: args },
      })),
      ...(!calls.length ? [{ type: 'text-delta', text: 'DONE' }] : []),
      { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } },
    ]);
  };
  return requests;
}

test('renaming the heading above unchanged lines is not a preserved edit', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'drinks', '## 用户喜欢\n\n- 咖啡');
  model(env, [[['memory_write', { file, body: '## 用户讨厌\n\n- 咖啡' }]]]);
  await dream(env);
  assert.equal(proofOf(env, file).kind, 'missing');
});

test('reformatting the same facts under the same heading stays preserved', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'drinks', '## 用户喜欢\n\n- 咖啡\n- 茶');
  model(env, [[['memory_write', { file, body: '##  用户喜欢\n\n* 咖啡\n\n* 茶' }]]]);
  await dream(env);
  assert.equal(proofOf(env, file).kind, 'preserved');
});

test('an unsourced rewrite applies only after the reviewer confirms it', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'language', '用户偏好使用中文进行沟通');
  model(env, [[['memory_write', { file, body: '用户更喜欢用中文交流' }]]]);
  const pending = await dream(env);
  assert.equal(proofOf(env, file).kind, 'missing');
  const refused = await env.runtime.switchDream({ pctx: env.pctx, runId: pending.runId });
  assert.equal(refused.error, 'evidence-required');
  const applied = await env.runtime.switchDream({ pctx: env.pctx, runId: pending.runId, confirm: [file] });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.confirmedWithoutSource, [file]);
  assert.match((await env.pctx.store.readEntry(file)).body, /用户更喜欢用中文交流/);
});

test('deferring an unsourced change keeps the page and records no rejection', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'language', '用户偏好使用中文进行沟通');
  model(env, [[['memory_write', { file, body: '用户更喜欢用中文交流' }]]]);
  const pending = await dream(env);
  const result = await env.runtime.switchDream({ pctx: env.pctx, runId: pending.runId, defer: [file] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.decision, 'deferred');
  assert.match((await env.pctx.store.readEntry(file)).body, /用户偏好使用中文进行沟通/);
  assert.deepEqual(env.pctx.state.snapshot().dreamRejected, []);
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
});

test('a relevant old page reaches the capped recall manifest ahead of newer ones', () => {
  const entries = Array.from({ length: 200 }, (_, index) => ({
    file: `project_note_${index}.md`, name: `note ${index}`, description: `routine update ${index}`,
    type: 'project', modified: `2026-11-${String(10 + (index % 5)).padStart(2, '0')}T00:00:00Z`,
  }));
  entries.push({
    file: 'project_database_choice.md', name: 'database choice', description: 'We chose Postgres over MySQL for billing',
    type: 'project', modified: '2025-01-01T00:00:00Z',
  });
  rankForQuery(entries, 'Which database do we use for billing?');
  assert.equal(entries[0].file, 'project_database_choice.md');
  assert.match(recallManifest(entries, { maxCandidates: 200 }), /project_database_choice\.md/);
});

test('a rejection records the exact change and is shown with the next proposal on that page', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'preferences', '周四发布。\n用中文回答。');
  model(env, [[['memory_write', { file, body: '周一发布。\n用中文回答。' }]]]);
  const first = await dream(env);
  await env.runtime.switchDream({ pctx: env.pctx, runId: first.runId, reject: [file] });
  const [line] = env.pctx.state.snapshot().dreamRejected;
  assert.match(line, new RegExp(`^changed ${file.replace('.', '\\.')} \\(page [0-9a-f]{8}\\)`));
  assert.match(line, /removed "周四发布。"/);
  assert.match(line, /added "周一发布。"/);

  const requests = model(env, [[['memory_write', { file, body: '周四发布。\n用英文回答。' }]]]);
  await dream(env);
  assert.ok(JSON.stringify(requests[0].messages).includes('周一发布'), 'the next run sees the exact rejected change');
  assert.deepEqual(env.pctx.state.snapshot().shadowPending.rejectedBefore[file], [line]);
});

test('auto-extract refuses over-long content instead of saving a cut copy', async (t) => {
  const env = await toolsEnv(t, { autoExtract: true });
  env.host.services.sessionQuery.readSession = async () => ({ events: [
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Remember the full release checklist.' }] } },
  ] });
  const requests = model(env, [[['memory_save', { name: 'Release checklist', content: 'step. '.repeat(1_000) }]]]);
  const result = await runAutoExtract({ runtime: env.runtime, pctx: env.pctx, ...exec });
  assert.notEqual(result.ok, true);
  assert.deepEqual(await env.pctx.store.listEntries('project'), []);
  const feedback = JSON.stringify(requests[1]?.messages ?? []);
  assert.match(feedback, /TOO_LONG/);
  const dir = env.pctx.store._scopeDir('project');
  const names = await fs.readdir(dir).catch(() => []);
  assert.ok(!names.some((name) => name.endsWith('.md') && name !== 'MEMORY.md'), names.join(','));
  assert.equal(path.basename(dir), 'memory');
});
