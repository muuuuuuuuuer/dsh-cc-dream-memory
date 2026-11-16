/**
 * Regressions for the problems found by using the plugin in a real DSH web
 * session (2026-11-16): memories-only Dream could not apply its own proposals,
 * corrections flattened Why/How lines into history, memory_read leaked
 * superseded values, /remember wrote contradictions silently, and the run
 * record hid what a Dream actually did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { commandEnv, toolsEnv, streamOf } from './v10-helpers.mjs';
import { composeCorrection } from '../src/write-review.js';
import { runToolLoop } from '../src/tool-loop.js';

const exec = { agent: { id: 's1' }, sessionId: 's1' };
const save = (env, name, content, extra = {}) => env.pctx.store.saveEntry({ name, content, type: 'project', ...extra });
const dream = (env, options = {}) => env.runtime.dream({ pctx: env.pctx, force: true, ...options });

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
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
      { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } },
    ]);
  };
  return requests;
}

test('memories-only Dream can delete a page contradicted by another current page it quotes', async (t) => {
  const env = await toolsEnv(t);
  const kept = await save(env, 'release host', 'Release runs on release-box-03. release-box-02 is retired.');
  const stale = await save(env, 'old host', 'Release runs on release-box-02.');
  model(env, [[['memory_delete', {
    file: stale.file,
    citations: [{ memory_file: kept.file, quote: 'release-box-02 is retired' }],
  }]]]);
  const pending = await dream(env, { noSessions: true });
  assert.equal(pending.ready, true);
  const proof = env.pctx.state.snapshot().shadowPending.proofs.find((item) => item.file === stale.file);
  assert.equal(proof.kind, 'citation');
  const switched = await env.runtime.switchDream({ pctx: env.pctx, runId: pending.runId });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  await assert.rejects(env.pctx.store.readEntry(stale.file));
});

test('a page quote does not count when the quoted page is removed or the quote is only in its History', async (t) => {
  const env = await toolsEnv(t);
  const a = await save(env, 'a', 'Release runs on box-03.\n\n## History\n\n- Superseded: box-02 is the release host');
  const b = await save(env, 'b', 'Release runs on box-02.');
  model(env, [[
    ['memory_delete', { file: b.file, citations: [{ memory_file: a.file, quote: 'box-02 is the release host' }] }],
    ['memory_delete', { file: a.file, citations: [{ memory_file: b.file, quote: 'Release runs on box-02.' }] }],
  ]]);
  const pending = await dream(env, { noSessions: true });
  const proofs = env.pctx.state.snapshot().shadowPending.proofs;
  assert.equal(proofs.find((item) => item.file === b.file).kind, 'missing', 'History is not current text');
  assert.equal(proofs.find((item) => item.file === a.file).kind, 'missing', 'the quoted page is deleted too');
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: pending.runId })).error, 'evidence-required');
});

test('a Dream that ran and changed nothing is recorded as done with its usage', async (t) => {
  const env = await toolsEnv(t);
  await save(env, 'note', 'Something durable.');
  model(env, [[]]);
  const result = await dream(env, { runId: 'trial-run-1' });
  assert.equal(result.skipReason, 'nothing-new');
  const status = await env.runtime.dreamRun(env.pctx, 'trial-run-1');
  assert.equal(status.status, 'done');
  assert.equal(status.usage.totalTokens, 110);
});

test('a Dream that runs out of turns without a change says so instead of "nothing to change"', async (t) => {
  const env = await toolsEnv(t);
  await save(env, 'note', 'Something durable.');
  model(env, Array.from({ length: 30 }, () => [['memory_index', {}]]));
  const result = await dream(env, { runId: 'trial-run-2' });
  assert.equal(result.skipReason, 'unfinished');
  const status = await env.runtime.dreamRun(env.pctx, 'trial-run-2');
  assert.equal(status.status, 'done');
  assert.equal(status.skipReason, 'unfinished');
});

test('a session with no text to review is settled instead of offered to the agent', async (t) => {
  const env = await toolsEnv(t);
  await save(env, 'note', 'Something durable.');
  const events = [{ seq: 1, type: 'system/message', data: {} }];
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 'command-only', cwd: env.workspaceDir } }],
    listEvents: async () => events,
    readEvent: async () => ({ events }),
  };
  const requests = model(env, [[]]);
  await dream(env);
  const prompt = JSON.stringify(requests[0].messages);
  assert.doesNotMatch(prompt, /command-only/, 'the agent is not asked to read it');
  const processed = env.pctx.state.snapshot().dreamProcessedSessions;
  assert.ok(processed.some((item) => item.id === 'command-only' && !item.partial), JSON.stringify(processed));
});

test('the Dream estimate counts every turn of the tool loop', async (t) => {
  const env = await toolsEnv(t);
  for (let index = 0; index < 4; index += 1) await save(env, 'note ' + index, 'Fact ' + index + '.');
  const estimate = await env.runtime.estimateDream(env.pctx, { noSessions: true });
  assert.ok(estimate.turns >= 2);
  // One turn alone re-sends the system prompt and tool schemas (several KB).
  assert.ok(estimate.estimatedTokens > 2_000 * estimate.turns, String(estimate.estimatedTokens));
});

test('a correction keeps the new Why/How lines and does not copy the old ones into History', () => {
  const result = composeCorrection({
    existingBody: 'Release on box-02.\n\n**Why:** ops said so.\n\n**How to apply:** use box-02.',
    content: 'Release on box-03.\n\n**Why:** box-02 was retired.\n\n**How to apply:** use box-03.',
    date: '2026-11-16',
  });
  assert.match(result.content, /\*\*Why:\*\* box-02 was retired\./);
  assert.match(result.content, /- Superseded: Release on box-02\. \(until 2026-11-16\)/);
  assert.doesNotMatch(result.content, /ops said so|use box-02/);
});

test('memory_read returns the current text only', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'host', 'Use box-03.\n\n## History\n\n- Superseded: Use box-02.');
  const result = await env.definitions.get('memory_read').execute({ file }, exec);
  assert.equal(result.ok, true);
  assert.equal(result.raw, undefined);
  assert.doesNotMatch(JSON.stringify(result), /box-02/);
});

test('/remember refuses a duplicate unless --force, and lists related notes', async (t) => {
  const env = await commandEnv(t);
  const remember = env.commandDefinitions.get('remember');
  const call = (rawInput) => remember.handler({ rawInput, agent: { id: 'sess-1' }, sessionId: 'sess-1' });
  assert.equal((await call('--type=project Deploys use make release from the ops box')).kind, 'success');
  const again = await call('--type=project Deploys use make release from the ops box');
  assert.notEqual(again.kind, 'success');
  assert.match(again.text, /already covers this/);
  assert.match(again.text, /--force/);
  const forced = await call('--force --type=project Deploys use make release from the ops box');
  assert.equal(forced.kind, 'success', forced.text);
  const related = await call('--type=project make release runs on the ops box only on weekdays');
  assert.equal(related.kind, 'success', related.text);
  assert.match(related.text, /related: /);
});

test('/remember does not cut a Latin word in half when it names the note', async (t) => {
  const env = await commandEnv(t);
  const remember = env.commandDefinitions.get('remember');
  const result = await remember.handler({
    rawInput: '--type=project 发布由 ops 在 release-box-02 上执行 make release',
    agent: { id: 'sess-1' },
    sessionId: 'sess-1',
  });
  assert.equal(result.kind, 'success', result.text);
  assert.doesNotMatch(result.text, /mak(\s|$|\.md)/);
});

test('the verification ledger is a dot file and replaces the old file name', async (t) => {
  const env = await toolsEnv(t);
  const dir = env.pctx.store._scopeDir('project');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'verification.json'), '{"version":2,"entries":{}}\n');
  const { recordVerification } = await import('../src/verification-ledger.js');
  await recordVerification({ store: env.pctx.store, file: 'project_note.md', name: 'note', description: 'd', body: 'A fact.' });
  const names = await fs.readdir(dir);
  assert.ok(names.includes('.verification.json'));
  assert.ok(!names.includes('verification.json'));
});

test('a transport failure in one Dream turn is retried once', async () => {
  let calls = 0;
  const llm = {
    stream: () => {
      calls += 1;
      if (calls === 1) {
        return streamOf([{ type: 'finish', reason: { kind: 'error', failure: { message: 'DeepSeek Messages transport failed' } } }]);
      }
      return streamOf([{ type: 'text-delta', text: 'DONE' }, { type: 'finish', reason: { kind: 'stop' } }]);
    },
  };
  const result = await runToolLoop({
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    model: { provider: 'p', model: 'm' },
    prompt: 'go',
    executeTool: async () => '',
  });
  assert.equal(calls, 2);
  assert.equal(result.text, 'DONE');
});
