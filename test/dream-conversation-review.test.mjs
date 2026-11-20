import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { streamOf, toolsEnv } from './v10-helpers.mjs';

const message = (seq, role, text) => ({
  seq, type: role === 'tool' ? 'tool/result' : role + '/message',
  data: { message: { role, content: [{ type: 'text', text }] } },
});
const call = (name, args) => ({ type: 'block-end', block: { type: 'tool-call', id: name, name, arguments: args } });
const end = (kind) => ({ type: 'finish', reason: { kind } });

async function setup(t, config = {}) {
  const env = await toolsEnv(t, { autoDreamEnabled: false, ...config });
  const events = [
    message(0, 'user', 'The staging deploy uses npm release.'),
    message(1, 'tool', 'unrelated verbose output\n'.repeat(4_000) + 'FINAL_ASSERTION: release smoke passed'),
    message(2, 'assistant', 'The build and staging deploy completed.'),
    message(3, 'user', '纠正一下，默认用 pnpm release，staging 仍用 npm release。'),
  ];
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir } }],
    readSession: async () => ({ events: structuredClone(events) }),
    listEvents: async () => events.map(({ seq, type }) => ({ seq, type })),
    readEvent: async ({ seq, before, after }) => ({ events: events.filter((event) => event.seq >= seq - before && event.seq <= seq + after) }),
    searchEvents: async () => { throw new Error('SESSION_QUERY_SEARCH_DISABLED'); },
  };
  return { ...env, events };
}

test('resume accepts a checkpoint from the old token cap and keeps appended events out of its range', async (t) => {
  const env = await setup(t);
  const runId = 'run-frozen-review';
  // The child fails, so the run pauses with its frozen ranges saved.
  env.host.services.llm.stream = () => streamOf([end('error')]);
  const first = await env.runtime.dream({ pctx: env.pctx, force: true, runId });
  assert.equal(first.status, 'paused');
  const dir = path.join(env.pctx.paths.dreamsDir, runId);
  const checkpointPath = path.join(dir, 'checkpoint.json');
  const saved = JSON.parse(await readFile(checkpointPath, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.ranges[0].lastSeq, 3);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(checkpointPath, JSON.stringify({ ...saved, budgetSpent: 16_000 }));
  await writeFile(manifestPath, JSON.stringify({
    ...manifest, error: 'cost-limit', budgetLimit: 16_000, usage: { totalTokens: 16_000 },
  }));
  env.events.push(message(4, 'user', 'Newly appended decision.'));
  let turn = 0;
  env.host.services.llm.stream = async function* ({ messages }) {
    // The child's source file stops at the frozen range.
    assert.match(messages[0].content[0].text, /session_id=s1,/u);
    assert.doesNotMatch(env.host.dreamSourcePages.join('\n'), /Newly appended decision/u);
    yield* streamOf(turn++ === 0
      ? [call('work_done', { session_id: 's1', through_seq: 3, summary: 'Reviewed the staging exception.' }), end('tool-calls')]
      : [end('stop')]);
  };
  const resumed = await env.runtime.dream({ pctx: env.pctx, force: true, runId, resume: true });
  assert.equal(resumed.skipReason, 'nothing-new');
  assert.equal((await env.runtime.dreamRun(env.pctx, runId)).usage.totalTokens, 16_000);
  assert.equal(env.pctx.state.snapshot().dreamProcessedSessions[0].seq, 3);
});

test('Dream completes after more than 14 turns and keeps reporting usage above old caps', async (t) => {
  const env = await setup(t, { dreamMaxTotalTokens: 1_000, dreamCostMode: 'block' });
  let sent = 0;
  env.host.services.llm.stream = (request) => {
    assert.equal(request.maxTokens, undefined);
    sent += 1;
    if (sent > 17) return streamOf([end('stop')]);
    return streamOf([
      { type: 'usage', usage: { totalTokens: 2_000 } },
      sent <= 16
        ? call('memory_read', { file: 'project_missing.md' })
        : call('work_done', { session_id: 's1', through_seq: 3, summary: 'Reviewed the staging exception.' }),
      end('tool-calls'),
    ]);
  };
  const result = await env.runtime.dream({ pctx: env.pctx, force: true });
  assert.equal(sent, 18);
  assert.equal(result.skipReason, 'nothing-new');
  assert.equal((await env.runtime.dreamRun(env.pctx, result.runId)).usage.totalTokens, 34_000);
});

test('a long running request stays active until the user cancels it', async (t) => {
  const env = await setup(t, { dreamTimeoutMs: 1_000 });
  env.host.services.llm.stream = async function* () { await new Promise(() => {}); };
  const run = await env.runtime.startDream(env.pctx, { trigger: 'manual' });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal((await env.runtime.dreamRun(env.pctx, run.runId)).status, 'running');
  await env.runtime.cancelDreamRun(env.pctx, run.runId);
  const result = await run.done;
  assert.equal(result.error, 'cancelled');
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
});

test('an exact user correction becomes a reviewable Markdown note with its exception', async (t) => {
  const env = await setup(t);
  const body = '纠正一下，默认用 pnpm release，staging 仍用 npm release。';
  const quoted = body + '记住它。';
  env.events.at(-1).data.message.content[0].text = quoted;
  const file = 'project_release.md';
  let sent = 0;
  env.host.services.llm.stream = () => {
    sent += 1;
    if (sent > 1) return streamOf([end('stop')]);
    return streamOf([
      call('memory_write', { file, body: quoted, citations: [{ session_id: 's1', seq: 3, quote: quoted }] }),
      call('work_done', { session_id: 's1', through_seq: 3, summary: 'Recorded the release command with its staging exception.' }),
      end('tool-calls'),
    ]);
  };
  const result = await env.runtime.dream({ pctx: env.pctx, force: true });
  assert.equal(result.ready, true);
  assert.equal(sent, 2);
  await assert.rejects(env.pctx.store.readEntry(file), { code: 'NOT_FOUND' });
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId })).ok, true);
  assert.equal((await env.pctx.store.readEntry(file)).body, body);
  assert.equal(env.pctx.state.snapshot().dreamProcessedSessions[0].coverageVersion, 2);
});

test('citations alone cannot turn a transcript into a note body', async (t) => {
  const env = await setup(t);
  const first = '这个项目的内部代号是 Aurora，但仓库里不会写这个名字';
  const second = '补充：Aurora 只在内部沟通使用，不要写进 README。';
  env.events[0].data.message.content[0].text = first + '；记住它。';
  env.events.at(-1).data.message.content[0].text = second;
  const file = 'project_aurora.md';
  env.host.services.llm.stream = () => streamOf([
    call('memory_write', { file, citations: [
      { session_id: 's1', seq: 0, quote: first + '；记住它。' },
      { session_id: 's1', seq: 3, quote: second },
    ] }),
    call('work_done', { session_id: 's1', through_seq: 3, summary: 'Captured the release exception.' }),
    end('tool-calls'),
  ]);
  const result = await env.runtime.dream({ pctx: env.pctx, force: true });
  assert.equal(result.error, 'unfinished-writes');
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
  await assert.rejects(env.pctx.store.readEntry(file), { code: 'NOT_FOUND' });
});


for (const supported of [true, false]) {
  test(`usage above the former budget still reaches normal evidence review (${supported})`, async (t) => {
    const env = await setup(t);
    const quote = '纠正一下，默认用 pnpm release，staging 仍用 npm release。';
    const file = 'project_release.md';
    let sent = 0;
    env.host.services.llm.stream = () => {
      sent += 1;
      if (sent > 1) return streamOf([end('stop')]);
      return streamOf([
        call('memory_write', { file, body: supported ? quote : 'Staging deploys use yarn.', citations: [{ session_id: 's1', seq: 3, quote }] }),
        { type: 'usage', usage: { totalTokens: 13_500 } },
        end('tool-calls'),
      ]);
    };
    const run = await env.runtime.dream({ pctx: env.pctx, force: true });
    assert.equal(sent, 2);
    assert.equal(run.ready, true);
    if (supported) {
      assert.equal(run.sessionsReviewed, 0);
      assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: run.runId })).ok, true);
      assert.equal((await env.pctx.store.readEntry(file)).body, quote);
    } else {
      assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: run.runId })).error, 'evidence-required');
      await assert.rejects(env.pctx.store.readEntry(file), { code: 'NOT_FOUND' });
    }
    assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);
  });
}
