/**
 * Auto-extract cursor (v26): a finished loop always moves the cursor, a loop
 * cut off by the turn cap does not, and a backlog longer than the budget is
 * read oldest-first instead of losing its head.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsEnv, streamOf } from './v10-helpers.mjs';
import { runAutoExtract } from '../src/auto-extract.js';

const now = Date.parse('2026-11-15T10:00:00Z');

function userEvent(seq, text) {
  return { type: 'user/message', seq, time: now + seq, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } };
}

function assistantEvent(seq, text) {
  return { type: 'assistant/message', seq, time: now + seq, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } };
}

async function extractEnv(t, log, overrides = {}) {
  const env = await toolsEnv(t, { autoExtract: true, autoDreamEnabled: false, ...overrides });
  env.log = log;
  env.host.services.sessionQuery = {
    filterSessions: async () => [],
    readSession: async (id) => ({ session: { id, cwd: env.workspaceDir }, events: env.log }),
  };
  env.prompts = [];
  return env;
}

/** Every model call answers with `reply(call)`: a list of tool calls, or [] for DONE. */
function scriptModel(env, reply) {
  let call = 0;
  env.host.services.llm.stream = (options) => {
    call += 1;
    env.prompts.push(options.messages?.[0]?.content?.[0]?.text ?? '');
    const tools = reply(call);
    if (tools.length === 0) return streamOf([{ type: 'text-delta', text: 'DONE' }, { type: 'finish', reason: { kind: 'stop' } }]);
    return streamOf([
      ...tools.map((item, index) => ({ type: 'block-end', block: { type: 'tool-call', id: `c${call}-${index}`, name: item.name, arguments: item.arguments } })),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]);
  };
  return () => call;
}

const run = (env) => runAutoExtract({ ctx: env.host, runtime: env.runtime, pctx: env.pctx, sessionId: 's1', agent: { id: 's1' } });
const cursor = (env) => env.pctx.state.snapshot().extractSeqs?.s1;

test('DONE without any tool call still moves the cursor', async (t) => {
  const env = await extractEnv(t, [userEvent(1, 'Please rename the variable in this function for me.'), assistantEvent(2, 'Renamed.')]);
  const calls = scriptModel(env, () => []);
  const first = await run(env);
  assert.equal(first.reason, 'no-writes');
  assert.equal(cursor(env), 2);

  const second = await run(env);
  assert.equal(second.reason, 'no-new-events');
  assert.equal(calls(), 1, 'the same turn must not be sent to the model again');
});

test('a loop cut off by the turn cap keeps the cursor', async (t) => {
  const env = await extractEnv(t, [userEvent(1, 'Remember that releases are cut on Fridays only.'), assistantEvent(2, 'Noted.')]);
  scriptModel(env, () => [{ name: 'memory_search', arguments: { query: 'release' } }]);
  const result = await run(env);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max-turns');
  assert.equal(cursor(env), undefined);
});

test('a backlog longer than the budget is read oldest-first, without losing its head', async (t) => {
  const first = `FIRST ${'a'.repeat(1_400)}`;
  const second = `SECOND ${'b'.repeat(1_400)}`;
  const third = `THIRD ${'c'.repeat(1_400)}`;
  const env = await extractEnv(t, [userEvent(1, first), userEvent(2, second), userEvent(3, third)], { autoExtractMaxChars: 2_000 });
  scriptModel(env, () => []);

  const seen = [];
  for (let attempt = 0; attempt < 5 && (cursor(env) ?? 0) < 3; attempt += 1) {
    await run(env);
    seen.push(env.prompts.at(-1));
  }
  assert.ok(seen[0].includes('FIRST'), 'the oldest unread message goes first');
  assert.ok(!seen[0].includes('THIRD'));
  for (const marker of ['FIRST', 'SECOND', 'THIRD']) {
    assert.ok(seen.some((prompt) => prompt.includes(marker)), `${marker} was never shown to the extractor`);
  }
  assert.equal(cursor(env), 3);
});
