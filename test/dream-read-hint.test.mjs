/**
 * session_read names the window it covered and where the next text is.
 *
 * A window that lands inside a long run of tool calls used to answer "No
 * visible text in this window." with no seq to move to, so the agent re-read
 * the same event with other widths until its turns ran out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsEnv, streamOf } from './v10-helpers.mjs';

const now = Date.parse('2026-11-15T10:00:00Z');

function toolCall(id, name, args) {
  return { type: 'block-end', block: { type: 'tool-call', id, name, arguments: args } };
}

function script(env, steps) {
  let call = 0;
  const prompts = [];
  env.host.services.llm.stream = (options) => {
    call += 1;
    prompts.push(options.messages?.map((message) => message.content?.map((block) => block.text ?? '').join('')).join('\n') ?? '');
    const step = steps[call - 1];
    if (!step) return streamOf([{ type: 'finish', reason: { kind: 'stop' } }]);
    return streamOf([
      ...step.tools.map((item, index) => toolCall(`c-${call}-${index}`, item.name, item.arguments)),
      { type: 'text-delta', text: step.text ?? '' },
      { type: 'finish', reason: { kind: step.tools.length > 0 ? 'tool-calls' : 'stop' } },
    ]);
  };
  return { prompts };
}

// One tool call per event: nothing to read, exactly like a long tool run.
const EVENTS = [
  { seq: 4, type: 'tool/call', data: { toolName: 'read' } },
  { seq: 5, type: 'tool/call', data: { toolName: 'read' } },
  { seq: 6, type: 'tool/call', data: { toolName: 'read' } },
  { seq: 7, type: 'tool/call', data: { toolName: 'read' } },
  { seq: 8, type: 'tool/call', data: { toolName: 'read' } },
  { seq: 9, type: 'tool/call', data: { toolName: 'read' } },
  { seq: 10, type: 'tool/call', data: { toolName: 'read' } },
  { seq: 11, type: 'tool/call', data: { toolName: 'read' } },
  { seq: 12, type: 'tool/call', data: { toolName: 'read' } },
  { seq: 13, type: 'tool/call', data: { toolName: 'read' } },
  { seq: 14, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'we switched to pnpm' }] } } },
];

async function windowEnv(t) {
  const env = await toolsEnv(t, { autoDreamEnabled: false, sessionLookback: 8 });
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir, createdAt: now - 1000 } }],
    listEvents: async () => EVENTS.map(({ seq, type }) => ({ seq, type })),
    readEvent: async ({ seq, before = 0, after = 0 }) => ({
      events: EVENTS.filter((event) => event.seq >= seq - before && event.seq <= seq + after),
    }),
  };
  return env;
}

test('a window with no text names its range and the next text seq', async (t) => {
  const env = await windowEnv(t);
  const { prompts } = script(env, [
    { tools: [{ name: 'session_read', arguments: { session_id: 's1', seq: 6 } }] },
    { tools: [], text: 'DONE' },
  ]);

  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-hint-1' });
  assert.equal(result.ok, true);

  const seen = prompts[1];
  assert.match(seen, /\[window seq 4–10: 7 events, 7 without text; next text at seq 14\]/u);
  assert.ok(!seen.includes('No visible text in this window.'));
});

test('a window with text keeps it and still reports the range', async (t) => {
  const env = await windowEnv(t);
  const { prompts } = script(env, [
    { tools: [{ name: 'session_read', arguments: { session_id: 's1', seq: 13, after: 4 } }] },
    { tools: [], text: 'DONE' },
  ]);

  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-hint-2' });
  assert.equal(result.ok, true);

  const seen = prompts[1];
  assert.match(seen, /\[window seq 11–14: 4 events, 3 without text; no more text in this session\]/u);
  assert.ok(seen.includes('we switched to pnpm'));
});
