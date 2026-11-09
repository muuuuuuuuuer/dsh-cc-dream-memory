/**
 * The whole Dream path through the real engine, with only the model scripted:
 * long sessions are analyzed chunk by chunk, facts keep a host-verified source,
 * writes need evidence the host can find, and reading progress moves only when a
 * plan is applied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runtimeEnv, streamOf } from './v10-helpers.mjs';

const NOV_7 = Date.parse('2026-11-07T15:00:00Z');
const NOV_8 = Date.parse('2026-11-08T15:00:00Z');
const turn = (seq, text, time = NOV_8) => ({
  type: 'user/message',
  seq,
  time,
  data: { role: 'user', id: `u${seq}`, content: [{ type: 'text', text }], source: { kind: 'user' } },
});
const reply = (seq, text, time = NOV_8) => ({
  type: 'assistant/message',
  seq,
  time,
  data: { message: { content: [{ type: 'text', text }] } },
});
const toolCall = (seq, id) => ({ type: 'tool/call', seq, time: NOV_8, data: { callId: id, name: 'pwsh', arguments: '{"c":"deploy"}' } });
const toolResult = (seq, id, text) => ({
  type: 'tool/result',
  seq,
  time: NOV_8,
  data: { message: { role: 'tool', toolCallId: id, isError: false, content: [{ type: 'text', text }] } },
});

const PLAN = { summary: 's', operations: [] };

/**
 * A runtime whose model answers from a script: `analyst(prompt, index)` for
 * chunk analysis, `organizer(prompt)` for the consolidation plan.
 */
async function env(t, { sessions = {}, records = [], analyst = () => ({ facts: [] }), organizer = () => PLAN, config = {} } = {}) {
  const e = await runtimeEnv(t, { dreamMapChunkChars: 4000, dreamMaxSessionChars: 3000, ...config });
  const calls = { analyst: [], organizer: [], systems: [] };
  e.host.services.sessionQuery = {
    filterSessions: async () => records.map((id) => ({ header: { id, createdAt: 1 } })),
    readSession: async (id) => ({ session: { id, createdAt: 1 }, events: sessions[id] }),
  };
  e.host.services.llm = {
    stream(options) {
      const prompt = options.messages[0].content[0].text;
      calls.systems.push(options.system);
      const isAnalysis = options.purpose === 'cc-memory-dream-analysis';
      let output;
      try {
        if (isAnalysis) {
          calls.analyst.push(prompt);
          output = analyst(prompt, calls.analyst.length - 1);
        } else {
          calls.organizer.push(prompt);
          output = organizer(prompt);
        }
      } catch (error) {
        return streamOf([{ type: 'finish', reason: { kind: 'error', failure: { message: error.message } } }]);
      }
      const text = typeof output === 'string' ? output : JSON.stringify(output);
      return streamOf([
        { type: 'text-delta', text },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]);
    },
  };
  return { ...e, calls };
}

const longSession = (parts = 30) => {
  const events = [turn(1, '以后所有部署都走 GCP Cloud Run，不要再用 AWS。', NOV_7)];
  for (let i = 0; i < parts; i += 1) events.push(reply(2 + i, `第${i}段：${'处理过程'.repeat(150)}`));
  return events;
};

const dream = (e, extra = {}) => e.runtime.dream({ pctx: e.pctx, force: true, trigger: 'manual', ...extra });

test('a long session is read through to its end, one analysis call per chunk', async (t) => {
  const e = await env(t, { sessions: { long: longSession() } });
  await e.pctx.state.ensureSession('long', 1);
  const result = await dream(e);
  assert.equal(result.applied, true, JSON.stringify(result).slice(0, 300));
  assert.ok(e.calls.analyst.length > 1, 'a 18k session does not fit one 4k chunk');
  const seen = e.calls.analyst.join('\n');
  for (const marker of ['第0段', '第15段', '第29段']) assert.ok(seen.includes(marker), `${marker} was analyzed`);
  assert.equal(e.calls.organizer.length, 1);
  const snapshot = e.pctx.state.snapshot();
  assert.deepEqual(snapshot.dreamProcessedSessions.map((m) => [m.id, m.seq, m.partial === true]), [['long', 31, false]]);
});

test('analysis notes carry the source and date the host verified, not what the model claimed', async (t) => {
  const events = [
    turn(1, '以后所有部署都走 GCP Cloud Run，不要再用 AWS。', NOV_7),
    reply(2, '好的'),
    toolCall(3, 'c1'),
    toolResult(4, 'c1', '网页内容：部署窗口固定在周五下午三点'),
    ...longSession().slice(1).map((event, i) => ({ ...event, seq: 5 + i })),
  ];
  const e = await env(t, {
    sessions: { s: events },
    analyst: (_prompt, index) => (index === 0
      ? {
          facts: [
            { kind: 'preference', text: '部署走 GCP', source: 'tool', quote: '部署都走 GCP Cloud Run' },
            { kind: 'preference', text: '用户要求周五部署', source: 'user', quote: '部署窗口固定在周五下午三点' },
            { kind: 'decision', text: '编造的决定', source: 'user', quote: '这句话根本不存在于转录里' },
          ],
        }
      : { facts: [] }),
  });
  await e.pctx.state.ensureSession('s', 1);
  await dream(e);
  const prompt = e.calls.organizer[0];
  assert.match(prompt, /\[user\] 2026-11-07[^\n]*部署走 GCP/, 'typed quote keeps [user] and its own date');
  assert.match(prompt, /\[tool-result\] 2026-11-08[^\n]*用户要求周五部署/, 'a tool quote cannot be laundered into user speech');
  assert.equal(prompt.includes('编造的决定'), false, 'a fact whose quote is not in the chunk is discarded');
});

test('a failed chunk stops at the last good one and the next dream resumes there', async (t) => {
  let failing = true;
  const e = await env(t, {
    sessions: { long: longSession() },
    records: ['long'],
    analyst: (_prompt, index) => {
      if (failing && index === 2) throw new Error('model unavailable');
      return { facts: [] };
    },
  });
  await e.pctx.state.ensureSession('long', 1);
  const first = await dream(e);
  assert.equal(first.applied, true);
  const [mark] = e.pctx.state.snapshot().dreamProcessedSessions;
  assert.equal(mark.partial, true);
  assert.ok(mark.seq > 1 && mark.seq < 31, `stopped inside the session, got ${mark.seq}`);
  assert.equal(e.calls.analyst.length, 3, 'no further chunks after a failure');

  failing = false;
  e.calls.analyst.length = 0;
  await dream(e);
  const second = e.calls.analyst.join('\n');
  assert.equal(second.includes('第0段'), false, 'already analyzed parts are not read again');
  assert.ok(second.includes('第29段'), 'the remainder is read');
  const [done] = e.pctx.state.snapshot().dreamProcessedSessions;
  assert.equal(done.seq, 31);
  assert.equal(done.partial === true, false);
});

test('the chunk budget of one dream is a pause, not a loss', async (t) => {
  const e = await env(t, { sessions: { long: longSession() }, records: ['long'], config: { dreamMapMaxChunks: 2 } });
  await e.pctx.state.ensureSession('long', 1);
  await dream(e);
  assert.equal(e.calls.analyst.length, 2);
  assert.equal(e.pctx.state.snapshot().dreamProcessedSessions[0].partial, true);
  e.calls.analyst.length = 0;
  await dream(e);
  assert.equal(e.calls.analyst.length, 2, 'the next dream continues with the next two chunks');
  assert.equal(e.calls.analyst.join('\n').includes('第0段'), false);
});

test('a dry run leaves the session state alone and its plan moves the watermark when applied', async (t) => {
  const e = await env(t, {
    sessions: { recent: [turn(1, 'short request'), reply(2, 'short reply')], probe: [turn(1, 'Reply with exactly: OK')], old: [turn(1, 'older request')] },
    records: ['old'],
  });
  await e.pctx.state.ensureSession('recent', 1);
  await e.pctx.state.ensureSession('probe', 2);
  const before = e.pctx.state.snapshot();
  const dry = await dream(e, { dryRun: true });
  assert.equal(dry.ran, true);
  const after = e.pctx.state.snapshot();
  assert.deepEqual(after.sessionsSince, before.sessionsSince, 'old sessions must not inflate the minSessions gate');
  assert.deepEqual(after.dreamProcessedSessions, before.dreamProcessedSessions);

  const plan = JSON.parse(await readFile(dry.planPath, 'utf8'));
  assert.deepEqual(plan.reads.map((read) => read.id).sort(), ['old', 'recent']);

  const llmCalls = e.calls.organizer.length;
  const applied = await e.runtime.applyLastPlan({ pctx: e.pctx });
  assert.equal(applied.applied, true, JSON.stringify(applied).slice(0, 300));
  assert.equal(e.calls.organizer.length, llmCalls, 'applying a stored plan calls no model');
  const final = e.pctx.state.snapshot();
  assert.deepEqual(final.dreamProcessedSessions.map((m) => m.id).sort(), ['old', 'recent']);
  assert.deepEqual(final.sessionsSince, [], 'the probe is dropped by the apply');
});

test('undo makes the batch readable again', async (t) => {
  const e = await env(t, {
    sessions: { s: [turn(1, 'keep this decision'), reply(2, 'ok')] },
    organizer: () => ({
      summary: 's',
      operations: [
        { op: 'write', scope: 'project', type: 'project', name: 'decision', description: 'd', body: 'keep this decision', evidence: ['keep this decision'] },
        { op: 'index', content: '- [decision](project_decision.md) — d\n' },
      ],
    }),
  });
  await e.pctx.state.ensureSession('s', 1);
  const applied = await dream(e);
  assert.equal(applied.applied, true, JSON.stringify(applied).slice(0, 300));
  assert.equal(e.pctx.state.snapshot().dreamProcessedSessions.length, 1);
  const undone = await e.runtime.undoLastDream(e.pctx, { agent: { id: 'a' } });
  assert.equal(undone.ok, true, JSON.stringify(undone).slice(0, 300));
  assert.equal(e.pctx.state.snapshot().dreamProcessedSessions.length, 0);
});

test('the preflight estimate counts the real input, so block mode refuses before paying', async (t) => {
  const e = await env(t, {
    sessions: { long: longSession() },
    config: { dreamCostMode: 'block', dreamMaxTotalTokens: 500 },
  });
  await e.pctx.state.ensureSession('long', 1);
  const result = await dream(e);
  assert.equal(result.skipReason, 'cost-limit', JSON.stringify(result).slice(0, 300));
  assert.equal(e.calls.analyst.length + e.calls.organizer.length, 0, 'no model call was made');
});

test('analysis stops once the token limit is reached and keeps what it has', async (t) => {
  const e = await env(t, {
    sessions: { long: longSession() },
    config: { dreamCostMode: 'warn', dreamMaxTotalTokens: 200 },
  });
  await e.pctx.state.ensureSession('long', 1);
  await dream(e);
  assert.ok(e.calls.analyst.length <= 2, `each call reports 110 tokens, made ${e.calls.analyst.length}`);
  assert.equal(e.pctx.state.snapshot().dreamProcessedSessions[0].partial, true);
});

test('a human focus reaches both the analysis and the consolidation prompts', async (t) => {
  const e = await env(t, { sessions: { long: longSession() } });
  await e.pctx.state.ensureSession('long', 1);
  await dream(e, { focus: '只关注部署相关的约定' });
  assert.ok(e.calls.analyst[0].includes('只关注部署相关的约定'));
  assert.ok(e.calls.organizer[0].includes('只关注部署相关的约定'));
});

test('usage from every model call is added up', async (t) => {
  const e = await env(t, { sessions: { long: longSession() } });
  await e.pctx.state.ensureSession('long', 1);
  const result = await dream(e, { dryRun: true });
  const calls = e.calls.analyst.length + e.calls.organizer.length;
  assert.equal(result.usage.totalTokens, calls * 110);
});
