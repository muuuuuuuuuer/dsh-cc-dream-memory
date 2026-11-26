import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamOf, toolsEnv } from './v10-helpers.mjs';

const facts = { s1: 'Use make release for deployments.', s2: 'Keep bug reports in Markdown.' };
const release = 'project_release.md';
const reports = 'project_reports.md';

async function setup(t, options = {}, sourceFacts = facts) {
  const env = await toolsEnv(t, { autoDreamEnabled: false, ...options });
  const events = new Map(Object.entries(sourceFacts).map(([id, text]) => [id, {
    seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }]));
  env.host.services.sessionQuery = {
    filterSessions: async () => [...events.keys()].map((id) => ({ header: { id, cwd: env.workspaceDir } })),
    listEvents: async (id) => [events.get(id)],
    readSession: async (id) => ({ events: [events.get(id)] }),
    readEvent: async ({ sessionId }) => ({ events: [events.get(sessionId)] }),
  };
  const run = (calls, runId) => {
    env.host.services.llm.stream = ({ messages }) => {
      if (messages.length > 1) {
        env.assertFeedback?.(messages);
        return streamOf([{ type: 'text-delta', text: 'DONE' }, { type: 'finish', reason: { kind: 'stop' } }]);
      }
      const session = /session_id=(\S+?),/u.exec(messages[0].content[0].text)?.[1];
      const taskCalls = calls.filter(([, args]) => (args.session_id ?? args.citations?.[0]?.session_id ?? events.keys().next().value) === session);
      return streamOf([
        ...taskCalls.map(([name, args], i) => ({
          type: 'block-end', block: { type: 'tool-call', id: `call-${i}`, name, arguments: args },
        })),
        { type: 'finish', reason: { kind: taskCalls.length ? 'tool-calls' : 'stop' } },
      ]);
    };
    return env.runtime.dream({ pctx: env.pctx, force: true, runId });
  };
  return Object.assign(env, { run });
}

const citations = (session_id) => [{ session_id, seq: 1, quote: facts[session_id] }];
const read = (session_id) => ['session_read', { session_id, seq: 1 }];
const review = (session_id) => ['work_done', { session_id, through_seq: 1, summary: facts[session_id] }];
const write = (file, id, body = facts[id]) => ['memory_write', { file, body, citations: citations(id) }];

test('a cross-sentence citation supports its original Chinese conclusions under a grounded heading', async (t) => {
  const first = '这个项目的内部代号是 Aurora。';
  const second = 'Aurora 只在内部沟通使用。';
  const quote = first + second;
  const { pctx, runtime, run } = await setup(t, {}, { s1: quote });
  const body = '## Aurora\n\n' + first + '\n' + second;
  const result = await run([read('s1'), ['memory_write', { file: release, body, citations: [{ session_id: 's1', seq: 1, quote }] }]], 'run-chinese-span');
  assert.equal(result.ready, true);
  assert.equal((await runtime.switchDream({ pctx, runId: result.runId })).ok, true);
  const applied = await runtime.dreamRun(pctx, result.runId);
  assert.deepEqual([applied.status, applied.decision, applied.applied], ['done', 'applied', true]);
  assert.equal((await pctx.store.readEntry(release)).body, body);
});

test('a sourced correction updates the command and retains its separate staging exception', async (t) => {
  const quote = 'Replace use make release with use pnpm release.';
  const { pctx, runtime, definitions, run } = await setup(t, {}, { s1: quote });
  const exception = '## Staging\n\nStaging still uses npm release.';
  await pctx.store.writeRawEntry(release, { type: 'project', body: 'Use make release.\n\n' + exception });
  const body = 'Use pnpm release.\n\n' + exception + '\n\n## History\n\n- Superseded: Use make release.';
  const result = await run([read('s1'), ['memory_write', { file: release, body, citations: [{ session_id: 's1', seq: 1, quote }] }]], 'run-sourced-correction');
  assert.equal((await runtime.switchDream({ pctx, runId: result.runId })).ok, true);
  const readBack = await definitions.get('memory_read').execute({ file: release }, { agent: { id: 'fresh-session' } });
  assert.match(readBack.body, /Use pnpm release/u);
  assert.match(readBack.body, /Staging still uses npm release/u);
  assert.doesNotMatch(readBack.body, /make release/u);
});

test('a failed write reports unfinished work and only blocks the linked session', async (t) => {
  const { pctx, runtime, run } = await setup(t, { dreamAllowDelete: false });
  const runId = 'run-failed-write';
  await pctx.store.writeRawEntry(release, { type: 'project', body: 'Use make release for deployments.' });
  const result = await run([
    read('s1'), read('s2'),
    ['memory_delete', { file: release, citations: citations('s1') }],
    review('s1'), review('s2'),
  ], runId);
  assert.equal(result.error, 'unfinished-writes');
  assert.equal((await runtime.dreamRun(pctx, runId)).status, 'failed');
  assert.deepEqual(pctx.state.snapshot().dreamProcessedSessions.map(({ id }) => id), ['s2']);
});

test('deferring one sourced proposal lets an independent accepted proposal settle', async (t) => {
  const { pctx, runtime, run } = await setup(t);
  const runId = 'run-partial-review';
  const result = await run([read('s1'), read('s2'), write(release, 's1'), write(reports, 's2'), review('s1'), review('s2')], runId);
  assert.equal(result.ready, true);
  assert.equal((await runtime.switchDream({ pctx, runId, defer: [release] })).ok, true);
  assert.deepEqual(pctx.state.snapshot().dreamProcessedSessions.map(({ id }) => id), ['s2']);
  await assert.rejects(pctx.store.readEntry(release), { code: 'NOT_FOUND' });
  assert.equal((await pctx.store.readEntry(reports)).body, facts.s2);
  assert.equal((await runtime.undoLastDream(pctx)).ok, true);
  assert.deepEqual(pctx.state.snapshot().dreamProcessedSessions, []);
});

test('undo reopens the applied session and leaves an independently rejected session settled', async (t) => {
  const { pctx, runtime, run } = await setup(t);
  const result = await run([read('s1'), read('s2'), write(release, 's1'), write(reports, 's2'), review('s1'), review('s2')], 'run-undo-partial-review');
  assert.equal((await runtime.switchDream({ pctx, runId: result.runId, reject: [release] })).ok, true);
  assert.deepEqual(pctx.state.snapshot().dreamProcessedSessions.map(({ id }) => id), ['s1', 's2']);
  assert.equal((await runtime.undoLastDream(pctx)).ok, true);
  const undone = await runtime.dreamRun(pctx, result.runId);
  assert.deepEqual([undone.status, undone.decision, undone.applied], ['done', 'undone', false]);
  assert.deepEqual(pctx.state.snapshot().dreamProcessedSessions.map(({ id }) => id), ['s1']);
});
