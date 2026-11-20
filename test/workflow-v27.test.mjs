/**
 * 0.24 workflow: corrections land in the live note and feed a focused
 * automatic Dream; per-session switches; recall "not relevant"; usage-ordered
 * index and archive hints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolveConfig } from '../src/config.js';
import { DreamEngine } from '../src/dream.js';
import { MEMORY_INSTRUCTIONS } from '../src/inject.js';
import { readMetrics, recordRead, recordRecall } from '../src/metrics.js';
import { registerScheduler } from '../src/scheduler.js';
import { archiveCandidates, buildFocus } from '../src/dream-focus.js';
import { attachRecall } from '../src/recall.js';
import { registerInjection } from '../src/inject.js';
import { callHttp, commandEnv, httpEnv, streamOf, toolsEnv, waitFor } from './v10-helpers.mjs';
import { PLUGIN_ROOT } from './helpers.mjs';

const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- corrections

test('the instructions and the extractor both put corrections first', async () => {
  assert.match(MEMORY_INSTRUCTIONS, /When the user corrects something a note says, update that note now with memory_update/);
  assert.match(MEMORY_INSTRUCTIONS, /change only the wrong passage and keep the conditions that still hold/);
  assert.match(await readFile(path.join(PLUGIN_ROOT, 'src', 'auto-extract.js'), 'utf8'), /Corrections first: when the user corrected something an existing note says, edit the matching passage of that note via memory_update/);
});

test('a body change through memory_update is recorded as a correction; a subagent edit and a no-op are not', async (t) => {
  const env = await toolsEnv(t, { userMemory: 'project', subagentMemory: 'shared' });
  const saved = await env.pctx.store.saveEntry({ name: 'port', type: 'project', description: 'dev port', content: 'STATUS: current\nThe dev server uses port 3000.' });
  const read = (agent) => env.definitions.get('memory_read').execute({ file: saved.file }, agent);
  const update = (content, agent) => env.definitions.get('memory_update').execute({ file: saved.file, content }, agent);

  const sub = { agent: { id: 'child', session: { header: { parentSession: 'agent-1' } } }, sessionId: 'child' };
  await read(sub);
  assert.equal((await update('STATUS: current\nThe dev server uses port 4000.', sub)).ok, true);
  assert.deepEqual(env.pctx.state.snapshot().correctedFiles, [], 'a delegated session is not a user correction');

  await read(exec);
  assert.equal((await update('STATUS: current\nThe dev server uses port 5000.', exec)).ok, true);
  assert.deepEqual(env.pctx.state.snapshot().correctedFiles, [saved.file]);

  await env.pctx.state.clearCorrected();
  await read(exec);
  await env.definitions.get('memory_update').execute({ file: saved.file, description: 'dev server port' }, exec);
  assert.deepEqual(env.pctx.state.snapshot().correctedFiles, [], 'a description-only edit is not a body correction');
});

test('buildFocus orders corrected, broken, recalled, archive and caps each group', async (t) => {
  const env = await toolsEnv(t, { userMemory: 'project', archiveHintDays: 30 });
  const store = env.pctx.store;
  const note = (name, extra = {}) => store.saveEntry({ name, type: 'project', description: name, content: `STATUS: current\n${name} fact.`, ...extra });
  const corrected = await note('corrected');
  const broken = await note('broken', { sources: ['missing-file.js'] });
  const recalled = await note('recalled');
  const old = await note('old');
  await note('quiet');
  await recordRecall(env.pctx.paths, 1, [recalled.file]);
  await env.pctx.state.noteCorrected(corrected.file);
  await env.pctx.state.noteCorrected('deleted_since.md');
  // An old note nobody reads: age the file itself, then nothing has touched it.
  const oldPath = path.join(env.pctx.paths.memoryDir, old.file);
  const text = (await readFile(oldPath, 'utf8')).replace(/modified: .*/, `modified: ${new Date(Date.now() - 90 * DAY).toISOString()}`);
  await writeFile(oldPath, text);
  await env.pctx.store.listEntries();

  const focus = await buildFocus(env.pctx, env.runtime.config);
  assert.deepEqual(focus.files, [
    { file: corrected.file, reason: 'corrected' },
    { file: broken.file, reason: 'broken' },
    { file: recalled.file, reason: 'recalled' },
    { file: old.file, reason: 'archive' },
  ]);
  assert.match(focus.text, /priority order/);
  assert.ok(focus.text.indexOf(corrected.file) < focus.text.indexOf(old.file));
  assert.doesNotMatch(focus.text, /deleted_since|quiet/);
});

test('archiveCandidates needs both no recent read/recall and no recent write', () => {
  const now = Date.parse('2026-11-18T00:00:00Z');
  const old = new Date(now - 100 * DAY).toISOString();
  const metrics = { entries: { 'read.md': { lastReadAt: now - DAY }, 'recalled.md': { lastRecallAt: now - 2 * DAY } } };
  const entries = ['read.md', 'recalled.md', 'idle.md', 'fresh.md'].map((file) => ({ file, modified: file === 'fresh.md' ? new Date(now - DAY).toISOString() : old }));
  assert.deepEqual(archiveCandidates(entries, metrics, 60, now), [{ file: 'idle.md', idleDays: 100 }]);
});

async function schedulerEnv(t) {
  const env = await toolsEnv(t, { userMemory: 'project', autoDreamEnabled: true, autoExtract: false, minHours: 0, minSessions: 1 });
  const starts = [];
  env.runtime.startDream = async (_pctx, options) => {
    starts.push(options);
    return { ok: true, started: true, runId: 'r1', done: Promise.resolve({ ok: true }) };
  };
  const dispose = registerScheduler(env.host, env.runtime);
  t.after(() => dispose());
  return { env, starts };
}

const turnEnd = (env) => env.host.emit('session/event', { id: 's1', header: { cwd: env.workspaceDir } }, { type: 'turn/end', time: Date.now() });

test('the automatic Dream skips with no-focus when nothing names a target', async (t) => {
  const { env, starts } = await schedulerEnv(t);
  turnEnd(env);
  await waitFor(() => env.pctx.state.snapshot().lastDreamSkipReason === 'no-focus');
  await env.runtime.drain();
  assert.deepEqual(starts, []);
  assert.equal(env.pctx.state.snapshot().counters.skipped, 1);
});

test('the automatic Dream runs with the focus list; a Dream switch consumes the corrections', async (t) => {
  const { env, starts } = await schedulerEnv(t);
  const saved = await env.pctx.store.saveEntry({ name: 'port', type: 'project', description: 'dev port', content: 'STATUS: current\nPort 3000.' });
  await env.pctx.state.noteCorrected(saved.file);
  turnEnd(env);
  await waitFor(() => starts.length === 1);
  assert.equal(starts[0].trigger, 'auto');
  assert.match(starts[0].focus, new RegExp(saved.file));

  // The engine's answer is stubbed: only the bookkeeping after a successful switch is under test.
  const real = DreamEngine.prototype.switchShadow;
  DreamEngine.prototype.switchShadow = async () => ({ ok: true });
  t.after(() => { DreamEngine.prototype.switchShadow = real; });
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).ok, true);
  assert.deepEqual(env.pctx.state.snapshot().correctedFiles, []);
  await env.pctx.state.noteCorrected(saved.file);
  DreamEngine.prototype.switchShadow = async () => ({ ok: false, error: 'stale' });
  await env.runtime.switchDream({ pctx: env.pctx });
  assert.deepEqual(env.pctx.state.snapshot().correctedFiles, [saved.file], 'a failed switch keeps the record');

  // A pending run records the corrections it saw; one made later survives the switch.
  await env.pctx.state.noteCorrected('later.md');
  await env.pctx.state.setShadowPending({ dir: path.join(env.pctx.paths.projectDir, '.dreams', 'shadow'), runId: 'r1', corrected: [saved.file] });
  DreamEngine.prototype.switchShadow = async () => ({ ok: true });
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).ok, true);
  assert.deepEqual(env.pctx.state.snapshot().correctedFiles, ['later.md']);
});

// ------------------------------------------------------------- session flags

const NOW = Date.parse('2026-11-13T10:00:00Z');
const transcript = (tool) => [
  { type: 'user/message', seq: 1, time: NOW - 1000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'We deploy with make release. Remember that.' }] } },
  ...(tool ? [{ type: 'tool/call', seq: 2, time: NOW - 500, data: { id: 'c1', name: tool, arguments: '{}' } }] : []),
  { type: 'assistant/message', seq: 3, time: NOW, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Understood: releases use make release.' }] } } },
];

async function extractEnv(t, overrides, tool) {
  const env = await toolsEnv(t, { userMemory: 'project', autoExtract: true, autoExtractEveryTurns: 1, autoDreamEnabled: false, ...overrides });
  let calls = 0;
  env.host.services.llm.stream = () => {
    calls += 1;
    env.modelCalls = calls;
    return calls === 1
      ? streamOf([{ type: 'block-end', block: { type: 'tool-call', id: 'c', name: 'memory_save', arguments: { name: 'deploy command', type: 'project', description: 'Releases use make release', content: 'Run make release.' } } }, { type: 'finish', reason: { kind: 'tool-calls' } }])
      : streamOf([{ type: 'text-delta', text: 'DONE' }, { type: 'finish', reason: { kind: 'stop' } }]);
  };
  env.host.services.sessionQuery = { filterSessions: async () => [], readSession: async (id) => ({ session: { id, cwd: env.workspaceDir }, events: transcript(tool) }) };
  const dispose = registerScheduler(env.host, env.runtime);
  t.after(() => dispose());
  return env;
}

test('/memory session learn off stops auto-extract for that conversation; explicit saves still work', async (t) => {
  const env = await extractEnv(t, {});
  const { invokeMemory } = await commandEnvOn(t, env);
  const off = await invokeMemory('session learn off', { id: 's1' });
  assert.equal(off.kind, 'success', off.text);
  assert.match(off.text, /learn from this conversation: OFF/);
  turnEnd(env);
  await sleep(250);
  assert.equal(env.modelCalls ?? 0, 0);
  assert.deepEqual(await env.pctx.store.listEntries(), []);
  const saved = await env.definitions.get('memory_save').execute({ name: 'manual', type: 'project', description: 'd', content: 'still saved' }, { agent: { id: 's1' }, sessionId: 's1' });
  assert.equal(saved.ok, true);

  assert.equal((await invokeMemory('session learn on', { id: 's1' })).kind, 'success');
  assert.deepEqual(env.pctx.state.snapshot().sessionFlags, {});
});

/** Run the slash commands over an already built tools env. */
async function commandEnvOn(t, env) {
  const definitions = new Map();
  const commandCtx = { commands: { register: (definition) => { definitions.set(definition.name, definition); return () => {}; } }, get: (name) => (name === 'commands' ? commandCtx.commands : undefined), on: () => () => {}, effect: (factory) => factory() };
  const { registerCommands } = await import('../src/commands.js');
  t.after(registerCommands(commandCtx, env.runtime));
  return { invokeMemory: (rawInput, agent = { id: 's1' }) => definitions.get('memory').handler({ rawInput, agent, sessionId: agent.id }) };
}

test('autoExtractSkipExternal skips a window with mcp or web tool calls and moves the cursor on', async (t) => {
  assert.equal(resolveConfig({}).autoExtractSkipExternal, false);
  const env = await extractEnv(t, { autoExtractSkipExternal: true }, 'web_fetch');
  turnEnd(env);
  const state = await waitFor(() => (env.pctx.state.snapshot().lastExtractReason === 'external-tools' ? env.pctx.state.snapshot() : null));
  assert.equal(env.modelCalls ?? 0, 0);
  assert.equal(state.extractSeqs.s1, 3, 'the same window is not offered again');
  for (const name of ['mcp__server__tool', 'web_search']) {
    const other = await extractEnv(t, { autoExtractSkipExternal: true }, name);
    turnEnd(other);
    await waitFor(() => other.pctx.state.snapshot().lastExtractReason === 'external-tools');
  }
  const plain = await extractEnv(t, { autoExtractSkipExternal: true }, 'read_file');
  turnEnd(plain);
  await waitFor(async () => (await plain.pctx.store.listEntries()).length === 1);
});

test('/memory session use off empties the injected snapshot and recall attaches nothing', async (t) => {
  const env = await toolsEnv(t, { userMemory: 'project', recallMode: 'model' });
  await env.pctx.store.saveEntry({ name: 'deploy', type: 'project', description: 'how we deploy', content: 'STATUS: current\nDeploys use make release.' });
  const { invokeMemory } = await commandEnvOn(t, env);
  const agentCtx = { systemPrompt: null, handlers: [], on(_event, handler) { this.handlers.push(handler); return () => {}; } };
  let contextText = () => '';
  const systemPrompt = { context: ({ text }) => { contextText = text; return () => {}; } };
  const agent = { id: 's1', ctx: { get: () => systemPrompt, effect: (factory) => factory(), on: agentCtx.on.bind(agentCtx) } };
  env.host.services.agents = { list: () => [agent], get: () => agent };
  env.host.on = (event, handler) => { if (event === 'agent/created') env.created = handler; return () => {}; };
  const dispose = registerInjection(env.host, env.runtime);
  t.after(dispose);
  await waitFor(() => contextText().includes('how we deploy'));

  assert.equal((await invokeMemory('session use off', agent)).kind, 'success');
  await waitFor(() => contextText() === '');
  env.runtime.forAgent = async () => env.pctx;
  env.host.services.llm.stream = () => { throw new Error('recall must not call the selector'); };
  const messages = [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'how do we deploy' }], source: { kind: 'user' } }];
  const recallCtx = { handlers: [], on(_event, handler) { this.handlers.push(handler); return () => {}; } };
  attachRecall({ agent, agentCtx: recallCtx, runtime: env.runtime, config: () => env.runtime.config });
  const decision = await recallCtx.handlers[0]({ messages, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [...messages] }));
  assert.equal(decision.messages.length, 1);

  assert.equal((await invokeMemory('session use on', agent)).kind, 'success');
  await waitFor(() => contextText().includes('how we deploy'));
  assert.equal((await invokeMemory('session bogus', agent)).kind, 'error');
});

test('Dream leaves a learn-off conversation out of its candidate sessions', async (t) => {
  const env = await toolsEnv(t, { userMemory: 'project' });
  env.host.services.sessionQuery = {
    filterSessions: async () => ['keep', 'private'].map((id) => ({ header: { id, cwd: env.workspaceDir, createdAt: 1 } })),
    readSession: async () => undefined,
  };
  await env.pctx.state.ensureSession('keep');
  await env.pctx.state.ensureSession('private');
  await env.pctx.state.setSessionFlag('private', 'learn', false);
  const estimate = await env.runtime.estimateDream(env.pctx, {});
  assert.equal(estimate.sessions, 1);
});

test('the status payload carries the session switches of the active conversation', async (t) => {
  const env = await commandEnv(t, {});
  await env.pctx.state.setSessionFlag('agent-1', 'use', false);
  const { createStatusService } = await import('../src/status.js');
  const payload = await createStatusService(env.runtime).status(env.pctx, { sessionId: 'agent-1' });
  assert.deepEqual(payload.session, { id: 'agent-1', use: false, learn: true });
  assert.equal((await createStatusService(env.runtime).status(env.pctx)).session, undefined);
});

// ------------------------------------------------------------ recall dismiss

test('"not relevant": the route marks the file dismissed for that session and counts it', async (t) => {
  const env = await httpEnv(t, { userMemory: 'global' });
  const saved = await env.pctx.store.saveEntry({ name: 'deploy', type: 'project', description: 'how we deploy', content: 'STATUS: current\nDeploys use make release.' });
  const res = await callHttp(env, { method: 'POST', path: '/recall-dismiss', body: { sessionId: 's1', file: saved.file } });
  assert.equal(res.statusCode, 200, res.bodyText());
  assert.deepEqual(res.json(), { ok: true, dismissed: true, file: saved.file, scope: 'project', sessionId: 's1' });
  const retry = await callHttp(env, { method: 'POST', path: '/recall-dismiss', body: { sessionId: 's1', file: saved.file } });
  assert.equal(retry.statusCode, 200, retry.bodyText());
  assert.ok((await env.pctx.state.readRecallDismissals('s1')).has(`project/${saved.file}`));
  const metrics = await readMetrics(env.pctx.paths);
  assert.equal(metrics.recalls.dismissed, 1);
  assert.equal(metrics.entries[saved.file].dismissals, 1);

  const user = await callHttp(env, { method: 'POST', path: '/recall-dismiss', body: { sessionId: 's1', file: 'user_role.md', scope: 'user' } });
  assert.equal(user.json().scope, 'user');
  assert.equal((await readMetrics((await env.runtime.userContext(env.pctx)).paths)).recalls.dismissed, 1);

  for (const body of [{ sessionId: 's1', file: '../x.md' }, { sessionId: 's1', file: 'a.md', scope: 'team' }, { file: 'a.md' }]) {
    const bad = await callHttp(env, { method: 'POST', path: '/recall-dismiss', body });
    assert.equal(bad.statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await callHttp(env, { method: 'POST', path: '/recall-dismiss', token: 'wrong', body: { sessionId: 's1', file: 'a.md' } })).statusCode, 401);
});

test('a dismissed note stays hidden after reopening the conversation, while another session still gets it', async (t) => {
  const env = await toolsEnv(t, { userMemory: 'project', recallMode: 'model' });
  const saved = await env.pctx.store.saveEntry({ name: 'deploy', type: 'project', description: 'how we deploy', content: 'STATUS: current\nDeploys use make release.' });
  env.host.services.llm.stream = () => streamOf([{ type: 'text-delta', text: JSON.stringify({ selected_memories: [saved.file] }) }, { type: 'finish', reason: { kind: 'stop' } }]);
  const reopened = new env.mods.runtime.MemoryRuntime(env.host, env.config);
  const attach = (id) => {
    const ctx = { handlers: [], on(_event, handler) { this.handlers.push(handler); return () => {}; } };
    attachRecall({ agent: { id, ctx }, agentCtx: ctx, runtime: reopened, config: () => reopened.config });
    return async (n) => {
      const messages = [{ role: 'user', id: `u${n}`, content: [{ type: 'text', text: `question ${n}` }], source: { kind: 'user' } }];
      return (await ctx.handlers[0]({ messages, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [...messages] }))).messages.length;
    };
  };
  const first = attach('s1');
  const second = attach('s2');
  const { createStatusService } = await import('../src/status.js');
  await createStatusService(env.runtime).dismissRecall(env.pctx, { sessionId: 's1', file: saved.file });
  assert.equal(await first(1), 1, 'nothing attached after "not relevant"');
  assert.equal(await second(1), 2, 'another conversation is unaffected');
  await reopened.drain();
});

test('/memory recall dismiss shares the implementation', async (t) => {
  const env = await commandEnv(t, {});
  const result = await env.invokeMemory('recall dismiss project_deploy.md', { id: 'agent-1' });
  assert.equal(result.kind, 'success', result.text);
  assert.ok((await env.pctx.state.readRecallDismissals('agent-1')).has('project/project_deploy.md'));
  assert.equal((await env.invokeMemory('recall dismiss', { id: 'agent-1' })).kind, 'error');
});

test('recall counts attached files per note', async (t) => {
  const env = await toolsEnv(t, { userMemory: 'project' });
  await recordRecall(env.pctx.paths, 2, ['a.md', 'b.md']);
  await recordRecall(env.pctx.paths, 1, ['a.md']);
  const metrics = await readMetrics(env.pctx.paths);
  assert.equal(metrics.entries['a.md'].recalls, 2);
  assert.ok(metrics.entries['a.md'].lastRecallAt > 0);
  assert.equal(metrics.recalls.count, 2);
});

// ------------------------------------------------- the recall row in the chat

async function loadClient() {
  const registered = {};
  const window = { __ModuleLoader__: { load: (module) => { registered.module = module; } }, location: { origin: 'http://127.0.0.1' } };
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), Fragment: 'Fragment', Component: class {}, useState: (value) => [value, () => {}], useEffect() {}, useMemo: (factory) => factory(), useRef: (current) => ({ current }), useCallback: (fn) => fn, memo: (component) => component };
  vm.runInNewContext(await readFile(path.join(PLUGIN_ROOT, 'client.js'), 'utf8'), { window, console: { warn() {}, error() {}, info() {}, log() {} }, fetch: async () => { throw new Error('offline'); }, setTimeout, clearTimeout, setInterval, clearInterval });
  const plugin = registered.module.factory((name) => { assert.equal(name, 'react'); return React; });
  return { plugin, internals: window.__CC_MEMORY_INTERNALS__ };
}

test('the recall message is claimed by a chat definition and its text parsed back into files', async () => {
  const { internals } = await loadClient();
  const { RECALL_DEFINITION: definition, parseRecall } = internals;
  const event = (extra = {}) => ({ type: 'user/message', surfaceOp: 'append', seq: 7, time: 1, data: { id: 'm1', source: { kind: 'plugin:cc-memory-recall' }, content: [{ type: 'text', text: 'x' }] }, ...extra });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(definition.match(event())), { id: 'm1', role: 'start', exclusive: true });
  assert.equal(definition.match(event({ surfaceOp: { op: 'replace' } })), null, 'a replacement copy is not drawn');
  assert.equal(definition.match({ ...event(), data: { id: 'm2', source: { kind: 'user' } } }), null);
  assert.equal(definition.match({ type: 'assistant/message', data: {} }), null);

  const text = '<system-reminder>\nCurrent memories.\n\n## project/project_deploy.md (updated 2026-11-12)\nDeploys use make release.\n\n## user/user_role.md\nBackend engineer.\n</system-reminder>';
  assert.deepEqual(plain(parseRecall(text)), [
    { scope: 'project', file: 'project_deploy.md', body: 'Deploys use make release.' },
    { scope: 'user', file: 'user_role.md', body: 'Backend engineer.' },
  ]);
  const start = definition.start(null, { event: { seq: 7, data: { content: [{ type: 'text', text }] } } });
  const node = definition.buildViewNode({ key: 'k', id: 'm1', state: start, start: { location: { kind: 'turn' } }, matches: [] });
  assert.deepEqual(plain([node.kind, node.target, node.anchorSeq, node.visibility, node.location]), ['cc-memory-recall', 'chat', 7, 'visible', { kind: 'turn' }]);
  // Without this a completed Turn folds the Step-level row into its hidden process group (seen in DSH 0.2.2-rc.3).
  assert.equal(node.groupTree, 'turn');
});

// ------------------------------------------------ usage-ordered index, archive

test('an over-budget index keeps the most used entries first; the file on disk is unchanged', async (t) => {
  const env = await toolsEnv(t, { userMemory: 'project', indexMaxLines: 4 });
  const files = [];
  for (const name of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) files.push((await env.pctx.store.saveEntry({ name, type: 'project', description: `${name} note`, content: `${name} body` })).file);
  const before = await env.pctx.store.indexText();
  await recordRead(env.pctx.paths, files[4], 's');
  await recordRead(env.pctx.paths, files[4], 's');
  await recordRecall(env.pctx.paths, 1, [files[3]]);
  const { entries } = await readMetrics(env.pctx.paths);
  const usage = Object.fromEntries(Object.entries(entries).map(([file, row]) => [file, row.reads + (row.recalls ?? 0)]));
  const head = await env.pctx.store.injectedIndex('project', { usage });
  assert.equal(head.overflow, true, 'the budget notice still applies');
  const shown = head.text.split('\n').filter((line) => line.startsWith('- ')).map((line) => /\((.*?)\)/.exec(line)[1]);
  assert.deepEqual(shown, [files[4], files[3], files[0]], 'most read, then recalled, then file order');
  assert.equal(await env.pctx.store.indexText(), before);
  const plain = await env.pctx.store.injectedIndex('project');
  assert.deepEqual(plain.text.split('\n').filter((line) => line.startsWith('- ')).map((line) => /\((.*?)\)/.exec(line)[1]), files.slice(0, 3));
});

test('the status lists archive candidates and /memory status says so', async (t) => {
  const env = await commandEnv(t, { userMemory: 'project', archiveHintDays: 30 });
  const saved = await env.pctx.store.saveEntry({ name: 'ancient', type: 'project', description: 'old', content: 'old body' });
  const file = path.join(env.pctx.paths.memoryDir, saved.file);
  await writeFile(file, (await readFile(file, 'utf8')).replace(/modified: .*/, `modified: ${new Date(Date.now() - 45 * DAY).toISOString()}`));
  const { createStatusService } = await import('../src/status.js');
  const payload = await createStatusService(env.runtime).status(env.pctx);
  assert.deepEqual(payload.archive.candidates, [{ file: saved.file, idleDays: 45 }]);
  assert.equal(payload.archive.days, 30);
  const text = (await env.invokeMemory('status')).text;
  assert.match(text, /archive candidates \(not read or recalled for 30\+ days; nothing is deleted automatically\): project_ancient\.md/);
  assert.equal((await env.pctx.store.listEntries()).length, 1, 'nothing was deleted');
});
