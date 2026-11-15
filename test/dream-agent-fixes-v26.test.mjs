/**
 * Regression tests for the v26 Dream agent fixes: page metadata kept on a
 * partial write, session review marks, remembered rejections, notes created
 * while (or after) a run, and a shadow that stays out of live trash/history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toolsEnv, streamOf, exists } from './v10-helpers.mjs';

const now = Date.parse('2026-11-15T10:00:00Z');

function toolCall(id, name, args) {
  return { type: 'block-end', block: { type: 'tool-call', id, name, arguments: args } };
}

/** Script the model: each step is a list of tool calls; `before(call)` runs side effects. */
function script(env, steps, { before } = {}) {
  let call = 0;
  const prompts = [];
  env.host.services.llm.stream = (options) => {
    call += 1;
    prompts.push(options.messages?.map((message) => message.content?.map((block) => block.text ?? '').join('')).join('\n') ?? '');
    return (async function* run() {
      if (typeof before === 'function') await before(call);
      const tools = steps[call - 1] ?? [];
      for (const [index, item] of tools.entries()) yield toolCall(`c-${call}-${index}`, item.name, item.arguments);
      if (tools.length === 0) yield { type: 'text-delta', text: 'DONE' };
      yield { type: 'finish', reason: { kind: tools.length > 0 ? 'tool-calls' : 'stop' } };
    })();
  };
  return prompts;
}

async function dreamEnv(t, sessions = [{ id: 's1', lastSeq: 9 }]) {
  const env = await toolsEnv(t, { autoDreamEnabled: false, sessionLookback: 8 });
  await env.pctx.store.saveEntry({
    name: 'Style',
    type: 'feedback',
    description: 'Answer in short sentences',
    content: 'Keep answers short.',
    source: { via: 'test' },
  });
  const headers = sessions.map((item) => ({ header: { id: item.id, cwd: env.workspaceDir, createdAt: now - 1000, lastSeq: item.lastSeq } }));
  env.sessions = headers;
  env.host.services.sessionQuery = {
    filterSessions: async () => env.sessions,
    searchEvents: async () => ({ items: [] }),
    readEvent: async () => ({ events: [] }),
  };
  return env;
}

const styleFile = 'feedback_style.md';

test('a write without type or description keeps the page metadata', async (t) => {
  const env = await dreamEnv(t);
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, styleFile)), true);
  script(env, [[{ name: 'memory_write', arguments: { file: styleFile, body: 'Keep answers short. Use bullet lists.' } }]]);
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-meta' });
  assert.equal(result.ready, true);
  const switched = await env.runtime.switchDream({ pctx: env.pctx });
  assert.equal(switched.ok, true);
  const page = await env.pctx.store.readEntry(styleFile);
  assert.equal(page.frontmatter.type, 'feedback');
  assert.equal(page.frontmatter.description, 'Answer in short sentences');
  assert.match(await env.pctx.store.indexText('project'), /Answer in short sentences/u);
});

test('a run with nothing to change still marks its sessions reviewed', async (t) => {
  const env = await dreamEnv(t);
  script(env, [[]]);
  const first = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-review-1' });
  assert.equal(first.skipReason, 'nothing-new');
  const mark = env.pctx.state.snapshot().dreamProcessedSessions.find((item) => item.id === 's1');
  assert.equal(mark?.seq, 9);
  assert.equal(mark?.partial, undefined);

  // Unchanged session: not a candidate again.
  let prompts = script(env, [[]]);
  await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-review-2' });
  assert.ok(!prompts[0].includes('s1'), 'a reviewed session must not be offered again');

  // The session grew: it comes back, with the point to read from.
  env.sessions = [{ header: { id: 's1', cwd: env.workspaceDir, createdAt: now - 1000, lastSeq: 20 } }];
  prompts = script(env, [[]]);
  await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-review-3' });
  assert.match(prompts[0], /s1 .*new events after seq 9/u);
});

test('a run cut short by the turn cap keeps unread sessions eligible', async (t) => {
  const env = await dreamEnv(t);
  const steps = Array.from({ length: 20 }, () => [{ name: 'memory_index', arguments: {} }]);
  steps[0] = [{ name: 'memory_write', arguments: { file: styleFile, body: 'Keep answers very short.' } }];
  script(env, steps);
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-cap' });
  assert.equal(result.ready, true);
  const mark = env.pctx.state.snapshot().dreamProcessedSessions.find((item) => item.id === 's1');
  assert.equal(mark, undefined);
});

test('a discarded change is remembered and shown to the next Dream', async (t) => {
  const env = await dreamEnv(t);
  script(env, [[{ name: 'memory_write', arguments: { file: styleFile, description: 'Answer in long essays', body: 'Write long essays.' } }]]);
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-reject' });
  assert.equal(result.ready, true);
  const discarded = await env.runtime.discardDream({ pctx: env.pctx });
  assert.equal(discarded.discarded, true);
  const rejected = env.pctx.state.snapshot().dreamRejected;
  assert.ok(rejected.some((item) => item.includes(styleFile) && item.includes('Answer in long essays')), JSON.stringify(rejected));

  const prompts = script(env, [[]]);
  env.sessions = [{ header: { id: 's2', cwd: env.workspaceDir, createdAt: now, lastSeq: 3 } }];
  await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-after-reject' });
  assert.match(prompts[0], /rejected/iu);
  assert.ok(prompts[0].includes('Answer in long essays'));
});

test('a note created during the run neither fails the run nor gets removed by the switch', async (t) => {
  const env = await dreamEnv(t);
  let lateFile = '';
  script(env, [[{ name: 'memory_write', arguments: { file: styleFile, body: 'Keep answers short. No tables.' } }]], {
    before: async (call) => {
      if (call !== 1) return;
      const saved = await env.pctx.store.saveEntry({
        name: 'Late',
        type: 'project',
        description: 'Saved while Dream ran',
        content: 'Keep me.',
        source: { via: 'test' },
      });
      lateFile = saved.file;
    },
  });
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-late' });
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.deepEqual(result.files.map((item) => item.file), [styleFile]);

  // And one more note after the run, before the human switches.
  const after = await env.pctx.store.saveEntry({
    name: 'After',
    type: 'project',
    description: 'Saved after Dream finished',
    content: 'Keep me too.',
    source: { via: 'test' },
  });
  const switched = await env.runtime.switchDream({ pctx: env.pctx });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, lateFile)), true);
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, after.file)), true);
  const index = await env.pctx.store.indexText('project');
  assert.ok(index.includes(lateFile) && index.includes(after.file), index);
});

test('a live edit to a page Dream rewrote still blocks the run', async (t) => {
  const env = await dreamEnv(t);
  script(env, [[{ name: 'memory_write', arguments: { file: styleFile, body: 'Dream version.' } }]], {
    before: async (call) => {
      if (call !== 2) return;
      await env.pctx.store.updateEntry(styleFile, { content: 'Human version.' });
    },
  });
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-edit' });
  assert.equal(result.error, 'conflict');
});

test('shadow deletes and rewrites stay out of the live trash and history', async (t) => {
  const env = await dreamEnv(t);
  await env.pctx.store.saveEntry({
    name: 'Old',
    type: 'project',
    description: 'Stale page',
    content: 'stale',
    source: { via: 'test' },
  });
  script(env, [[
    { name: 'memory_delete', arguments: { file: 'project_old.md' } },
    { name: 'memory_write', arguments: { file: styleFile, body: 'Rewritten in the copy.' } },
  ]]);
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-trash' });
  assert.equal(result.ready, true);
  const entries = async (dir) => (await fs.readdir(dir).catch(() => [])).length;
  assert.equal(await entries(env.pctx.paths.trashRoot), 0, 'live trash must stay empty');
  assert.equal(await entries(path.join(env.pctx.paths.projectDir, '.history')), 0, 'live history must stay empty');
  await env.runtime.discardDream({ pctx: env.pctx });
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, 'project_old.md')), true);
});
