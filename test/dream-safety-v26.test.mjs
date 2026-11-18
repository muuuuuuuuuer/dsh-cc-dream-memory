/**
 * Dream safety regressions (v26): the secret gate on agent writes, undo after
 * a switch, checked citations, the token cap, and the cancel command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { toolsEnv, commandEnv, exists } from './v10-helpers.mjs';

const now = Date.parse('2026-11-15T10:00:00Z');
const AWS_KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const QUOTE = 'We moved to pnpm for installs';
const RELEASE = 'Replace make release with pnpm release.';
const correction = [{ session_id: 's1', seq: 7, quote: RELEASE }];
const ciSource = [{ session_id: 's1', seq: 8, quote: 'CI runs on every push.' }];
const deletion = [{ session_id: 's1', seq: 9, quote: 'Remove project_old.md because it is obsolete.' }];

function toolCall(id, name, args) {
  return { type: 'block-end', block: { type: 'tool-call', id, name, arguments: args } };
}

/** Each step is a tool-call list ([] = DONE); `usage` is reported on every call. */
function script(env, steps, { usage, before } = {}) {
  let call = 0;
  const replies = [];
  env.host.services.llm.stream = (options) => {
    call += 1;
    return (async function* run() {
      if (typeof before === 'function') await before(call);
      const tools = steps[call - 1] ?? [];
      replies.push(options.messages);
      for (const [index, item] of tools.entries()) yield toolCall(`c-${call}-${index}`, item.name, item.arguments);
      if (tools.length === 0) yield { type: 'text-delta', text: 'DONE' };
      if (usage) yield { type: 'usage', usage };
      yield { type: 'finish', reason: { kind: tools.length > 0 ? 'tool-calls' : 'stop' } };
    })();
  };
  return { calls: () => call, replies };
}

/** Text of the tool results the model received, in order. */
function toolResults(replies) {
  const last = replies.at(-1) ?? [];
  return last.filter((message) => message.role === 'tool').map((message) => message.content?.[0]?.text ?? '');
}

async function seed(env) {
  const save = (name, type, description, content) => env.pctx.store.saveEntry({ name, type, description, content, source: { via: 'test' } });
  await save('Deploy', 'project', 'Release process', 'Use make release.');
  await save('Style', 'feedback', 'Answer briefly', 'Keep answers short.');
  await save('Old', 'project', 'Stale page', 'stale');
}

async function dreamEnv(t, overrides = {}, make = toolsEnv) {
  const env = await make(t, { autoDreamEnabled: false, ...overrides });
  await seed(env);
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir, createdAt: now - 1000, lastSeq: 9 } }],
    searchEvents: async () => ({ items: [{ seq: 7, snippet: QUOTE }] }),
    readEvent: async ({ seq }) => ({
      events: seq === 7 ? [{ seq: 7, type: 'user/message', data: { content: [{ type: 'text', text: `${QUOTE} last week. ${RELEASE}` }] } }] : [{ seq, type: 'user/message', data: { content: [{ type: 'text', text: seq === 8 ? ciSource[0].quote : deletion[0].quote }] } }],
    }),
  };
  return env;
}

const dream = (env, runId) => env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId });
const file = (env, name) => path.join(env.pctx.paths.memoryDir, name);

test('a Dream write carrying a secret is refused and never reaches the copy', async (t) => {
  const env = await dreamEnv(t);
  const { replies } = script(env, [
    [{ name: 'memory_write', arguments: { file: 'reference_aws.md', type: 'reference', description: 'AWS access', body: `Key: ${AWS_KEY}` } }],
    [],
  ]);
  const result = await dream(env, 'run-secret');
  assert.match(toolResults(replies).join('\n'), /^ERROR: .*secret/imu);
  assert.equal(result.error, 'unfinished-writes');
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
  assert.equal(await exists(file(env, 'reference_aws.md')), false);
});

test('undo after a switch restores changed and removed pages and trashes added ones', async (t) => {
  const env = await dreamEnv(t);
  script(env, [[
    { name: 'memory_write', arguments: { file: 'project_deploy.md', body: 'Use pnpm release.', citations: correction } },
    { name: 'memory_write', arguments: { file: 'project_ci.md', type: 'project', description: 'CI runs on push', body: 'CI runs on every push.', citations: ciSource } },
    { name: 'memory_delete', arguments: { file: 'project_old.md', citations: deletion } },
  ]]);
  assert.equal((await dream(env, 'run-undo')).ready, true);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).ok, true);
  assert.equal(await exists(file(env, 'project_old.md')), false);
  assert.equal(await exists(file(env, 'project_ci.md')), true);

  // Edited after the switch, but not by Dream: undo must leave it alone.
  await env.pctx.store.updateEntry('feedback_style.md', { content: 'Keep answers short. Human edit.' });
  const later = await env.pctx.store.saveEntry({ name: 'Later', type: 'project', description: 'Saved after the switch', content: 'keep', source: { via: 'test' } });

  const undone = await env.runtime.undoLastDream(env.pctx);
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.match((await env.pctx.store.readEntry('project_deploy.md')).body, /make release/u);
  assert.equal(await exists(file(env, 'project_old.md')), true, 'a page Dream removed comes back');
  assert.equal(await exists(file(env, 'project_ci.md')), false, 'a page Dream added goes away');
  assert.match((await env.pctx.store.readEntry('feedback_style.md')).body, /Human edit/u);
  assert.equal(await exists(file(env, later.file)), true);
  const index = await env.pctx.store.indexText('project');
  assert.ok(index.includes('project_old.md') && !index.includes('project_ci.md'), index);

  assert.equal((await env.runtime.undoLastDream(env.pctx)).error, 'no-undoable-batch');
});

test('undo refuses when a page Dream changed was edited after the switch', async (t) => {
  const env = await dreamEnv(t);
  script(env, [[{ name: 'memory_write', arguments: { file: 'project_deploy.md', body: 'Use pnpm release.', citations: correction } }]]);
  await dream(env, 'run-undo-conflict');
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).ok, true);
  await env.pctx.store.updateEntry('project_deploy.md', { content: 'Human rewrite after the switch.' });
  const undone = await env.runtime.undoLastDream(env.pctx);
  assert.equal(undone.ok, false);
  assert.match((await env.pctx.store.readEntry('project_deploy.md')).body, /Human rewrite/u);
});

test('undo refuses to overwrite a removed page that was recreated after the switch', async (t) => {
  const env = await dreamEnv(t);
  script(env, [[{ name: 'memory_delete', arguments: { file: 'project_old.md', citations: deletion } }]]);
  await dream(env, 'run-undo-recreated');
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).ok, true);
  await env.pctx.store.saveEntry({ name: 'Old', type: 'project', description: 'Written again by hand', content: 'new text', source: { via: 'test' } });
  const undone = await env.runtime.undoLastDream(env.pctx);
  assert.equal(undone.ok, false);
  assert.ok(undone.conflicts.some((item) => item.file === 'project_old.md'), JSON.stringify(undone));
  assert.match((await env.pctx.store.readEntry('project_old.md')).body, /new text/u);
});

test('only citations count as evidence, and each one is checked against the session', async (t) => {
  const env = await dreamEnv(t);
  const { replies } = script(env, [
    [{ name: 'session_search', arguments: { session_id: 's1', query: 'pnpm' } }],
    [{
      name: 'memory_write',
      arguments: {
        file: 'project_deploy.md',
        body: 'Use pnpm for installs.',
        citations: [
          { session_id: 's1', seq: 7, quote: 'we moved to  PNPM for installs' },
          { session_id: 's1', seq: 7, quote: 'The user loves yarn' },
        ],
      },
    }],
    [],
  ]);
  assert.equal((await dream(env, 'run-evidence')).ready, true);
  assert.match(toolResults(replies).at(-1), /1 citation\(s\) did not match/u);
  const evidence = env.pctx.state.snapshot().shadowPending.evidence;
  assert.deepEqual(evidence.map((item) => [item.source, item.verified]), [['citation', true], ['citation', false]]);

  const diff = await env.mods.status.createStatusService(env.runtime).dreamDiff(env.pctx, 'run-evidence', 'project_deploy.md');
  assert.deepEqual(diff.evidence.map((item) => item.verified), [true, false]);
});

test('warn mode stops the agent at the token cap and keeps the flagged copy', async (t) => {
  const env = await dreamEnv(t, { dreamMaxTotalTokens: 5_000, dreamCostMode: 'warn' });
  const steps = Array.from({ length: 10 }, () => [{ name: 'memory_index', arguments: {} }]);
  steps[0] = [{ name: 'memory_write', arguments: { file: 'project_deploy.md', body: 'Use pnpm release.', citations: correction } }];
  const { calls } = script(env, steps, { usage: { inputTokens: 2_000, outputTokens: 500, totalTokens: 2_500 } });
  const result = await dream(env, 'run-cap-warn');
  assert.equal(calls(), 2, 'no model call after the cap is reached');
  assert.equal(result.ready, true);
  assert.equal(result.costExceeded, true);
  assert.equal(env.pctx.state.snapshot().lastDreamCostExceeded, true);
});

test('block mode throws away a copy built past the token cap', async (t) => {
  const env = await dreamEnv(t, { dreamMaxTotalTokens: 5_000, dreamCostMode: 'block' });
  const steps = Array.from({ length: 10 }, () => [{ name: 'memory_index', arguments: {} }]);
  steps[0] = [{ name: 'memory_write', arguments: { file: 'project_deploy.md', body: 'Use pnpm release.', citations: correction } }];
  script(env, steps, { usage: { totalTokens: 2_500 } });
  const result = await dream(env, 'run-cap-block');
  assert.equal(result.error, 'cost-limit-exceeded');
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
  assert.equal(await exists(path.join(env.pctx.paths.dreamsDir, 'shadow')), false);
});

test('block mode does not call the model when the first prompt is already over the cap', async (t) => {
  const env = await dreamEnv(t, { dreamMaxTotalTokens: 1_000, dreamCostMode: 'block' });
  const { calls } = script(env, [[]]);
  const result = await dream(env, 'run-cap-preflight');
  assert.equal(result.skipReason, 'cost-limit');
  assert.equal(calls(), 0);
});

test('/memory dream cancel discards the run and prevents resume', async (t) => {
  const env = await dreamEnv(t, {}, commandEnv);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  script(env, [[{ name: 'memory_index', arguments: {} }], []], { before: async (call) => { if (call === 1) await gate; } });
  const started = await env.runtime.startDream(env.pctx, { trigger: 'manual', runId: 'run-cancel' });
  const cancelled = await env.invokeMemory('dream cancel run-cancel');
  release();
  assert.match(cancelled.message ?? cancelled.text ?? '', /is stopping/u);
  const result = await started.done;
  assert.equal(result.error, 'cancelled');
  const resumed = await env.invokeMemory('dream resume run-cancel');
  assert.match(resumed.message ?? resumed.text ?? '', /not-resumable/u);
});
