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
    readEvent: async ({ sessionId }) => ({ events: [events.get(sessionId)] }),
  };
  const run = (calls, runId) => {
    let turn = 0;
    env.host.services.llm.stream = () => streamOf(turn++ === 0 ? [
      ...calls.map(([name, args], i) => ({
        type: 'block-end', block: { type: 'tool-call', id: `call-${i}`, name, arguments: args },
      })),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] : [{ type: 'text-delta', text: 'DONE' }, { type: 'finish', reason: { kind: 'stop' } }]);
    return env.runtime.dream({ pctx: env.pctx, force: true, runId });
  };
  return { ...env, run };
}

const citations = (session_id) => [{ session_id, seq: 1, quote: facts[session_id] }];
const read = (session_id) => ['session_read', { session_id, seq: 1 }];
const review = (session_id) => ['work_done', { session_id, through_seq: 1, summary: facts[session_id] }];
const write = (file, id, body = facts[id]) => ['memory_write', { file, body, citations: citations(id) }];

test('a checked quote leaves an unrelated sentence on the same line for direct confirmation', async (t) => {
  const { pctx, runtime, mods, run } = await setup(t);
  const runId = 'run-mixed-evidence';
  const unsupported = 'Every deployment requires a production restart.';
  assert.equal((await run([write(release, 's1', `${facts.s1} ${unsupported}`)], runId)).ready, true);
  const service = mods.status.createStatusService(runtime);
  const blocked = await runtime.switchDream({ pctx, runId });
  assert.equal(blocked.error, 'evidence-required');
  await assert.rejects(pctx.store.readEntry(release), { code: 'NOT_FOUND' });
  const diff = await service.dreamDiff(pctx, runId, release);
  assert.deepEqual(diff.unsupportedClaims, [unsupported]);
  assert.deepEqual(diff.evidence[0].claims, [facts.s1]);
  assert.equal((await runtime.switchDream({ pctx, runId, confirm: [release] })).ok, true);
  const [history] = (await service.fileHistory(pctx, release)).planRefs;
  assert.equal(history.confirmedWithoutSource, true);
  assert.deepEqual(history.evidence[0].claims, [facts.s1]);
  assert.equal(history.evidence[0].sessionId, 's1');
});

test('a failed write reports unfinished work and only blocks the linked session', async (t) => {
  const { pctx, runtime, run } = await setup(t, { dreamAllowDelete: false });
  const runId = 'run-failed-write';
  const result = await run([
    read('s1'), read('s2'),
    ['memory_delete', { file: release, citations: citations('s1') }],
    review('s1'), review('s2'),
  ], runId);
  assert.equal(result.error, 'unfinished-writes');
  assert.equal((await runtime.dreamRun(pctx, runId)).status, 'failed');
  assert.deepEqual(pctx.state.snapshot().dreamProcessedSessions.map(({ id }) => id), ['s2']);
});

for (const [name, source, quote, body] of [
  ['a quote drops a negation', 'Never restart the production service.', 'restart the production service', 'Restart the production service.'],
  ['a claim reverses actors', 'Staging can access production.', 'Staging can access production.', 'Production can access staging.'],
]) {
  test(`a checked quote still needs confirmation when ${name}`, async (t) => {
    const { pctx, runtime, run } = await setup(t, {}, { s1: source });
    const result = await run([['memory_write', { file: release, body, citations: [{ session_id: 's1', seq: 1, quote }] }]], 'run-changed-meaning');
    assert.equal(result.ready, true);
    assert.equal((await runtime.switchDream({ pctx, runId: result.runId })).error, 'evidence-required');
  });
}

test('a checked quote about an unrelated note cannot authorize a standalone deletion', async (t) => {
  const { pctx, runtime, run } = await setup(t);
  await pctx.store.writeRawEntry(release, { type: 'project', body: facts.s1 });
  const result = await run([['memory_delete', { file: release, citations: citations('s2') }]], 'run-unrelated-delete');
  assert.equal(result.ready, true);
  assert.equal((await runtime.switchDream({ pctx, runId: result.runId })).error, 'evidence-required');
  assert.equal((await pctx.store.readEntry(release)).body, facts.s1);
});

test('a supported addition does not authorize dropping an unrelated active claim', async (t) => {
  const { pctx, runtime, run } = await setup(t);
  await pctx.store.writeRawEntry(release, { type: 'project', body: 'Keep the previous stable release available.' });
  const result = await run([write(release, 's1')], 'run-unrelated-removal');
  assert.equal(result.ready, true);
  assert.equal((await runtime.switchDream({ pctx, runId: result.runId })).error, 'evidence-required');
  assert.equal((await pctx.store.readEntry(release)).body, 'Keep the previous stable release available.');
});

test('a replacement quote cannot support recommending the value it replaces', async (t) => {
  const quote = 'Replace make release with pnpm release.';
  const { pctx, runtime, run } = await setup(t, {}, { s1: quote });
  const result = await run([['memory_write', { file: release, body: 'Use make release.',
    citations: [{ session_id: 's1', seq: 1, quote }] }]], 'run-retired-as-current');
  assert.equal(result.ready, true);
  assert.equal((await runtime.switchDream({ pctx, runId: result.runId })).error, 'evidence-required');
});

test('a successful write does not clear an unresolved deletion for the same file', async (t) => {
  const { pctx, runtime, run } = await setup(t, { dreamAllowDelete: false });
  const result = await run([
    read('s1'), read('s2'),
    ['memory_delete', { file: release, citations: citations('s1') }],
    write(release, 's2'),
    review('s1'), review('s2'),
  ], 'run-separate-operations');
  assert.equal(result.ready, true);
  assert.equal((await runtime.dreamRun(pctx, result.runId)).skipReason, 'unfinished-writes');
  assert.equal((await runtime.switchDream({ pctx, runId: result.runId })).ok, true);
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
  assert.deepEqual(pctx.state.snapshot().dreamProcessedSessions.map(({ id }) => id), ['s1']);
});
