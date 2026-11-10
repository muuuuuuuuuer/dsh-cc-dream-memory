/**
 * v9 P0: write policy layer + pending writes queue + surfaces.
 *
 * Contract: docs/superpowers/specs/2026-11-07-v9-p0-contract.md §1.
 * Real store/state/runtime in os.tmpdir(); no LLM is invoked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadModule, makeTempDir } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Modules / fixtures
// ---------------------------------------------------------------------------

let modulesPromise;

function modules() {
  if (!modulesPromise) {
    modulesPromise = (async () => ({
      config: await loadModule('../src/config.js', { requireExports: ['resolveConfig'] }),
      paths: await loadModule('../src/paths.js', { requireExports: ['buildPaths'] }),
      store: await loadModule('../src/store.js', { requireExports: ['MemoryStore'] }),
      state: await loadModule('../src/state.js', { requireExports: ['ProjectState'] }),
      runtime: await loadModule('../src/runtime.js', { requireExports: ['MemoryRuntime'] }),
      policy: await loadModule('../src/policy.js', {
        requireExports: ['POLICY_DEFAULTS', 'textSimilarity', 'entrySimilarity', 'detectConflict', 'evaluateWrite'],
      }),
      pending: await loadModule('../src/pending-writes.js', {
        requireExports: ['listPendingWrites', 'queuePendingWrite', 'approvePendingWrite', 'rejectPendingWrite'],
      }),
      tools: await loadModule('../src/tools.js', { requireExports: ['registerTools'] }),
      commands: await loadModule('../src/commands.js', { requireExports: ['registerCommands'] }),
      http: await loadModule('../src/http.js', { requireExports: ['createHttpHandler', 'API_PREFIX'] }),
      status: await loadModule('../src/status.js', { requireExports: ['createStatusService'] }),
    }))();
  }
  return modulesPromise;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function fakeHost({ workspaceDir }) {
  const listeners = new Map();
  const services = { workingDirectory: { ensure: async () => workspaceDir } };
  return {
    services,
    get: (name) => services[name],
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      return () => set.delete(handler);
    },
    effect(factory) {
      const dispose = factory();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };
}

async function makeEnv(t, configOverrides = {}) {
  const mods = await modules();
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const paths = mods.paths.buildPaths({ memoryRoot: config.memoryRoot, homeDir: path.join(tmp, 'home'), workspaceDir });
  const store = new mods.store.MemoryStore({ paths, config });
  await store.ensure();
  const state = new mods.state.ProjectState(paths);
  await state.load();
  const pctx = { workspaceDir, paths, store, state };
  return { mods, tmp, memoryRoot, workspaceDir, config, paths, store, state, pctx };
}

async function runtimeEnv(t, configOverrides = {}) {
  const env = await makeEnv(t, configOverrides);
  const host = fakeHost({ workspaceDir: env.workspaceDir });
  const runtime = new env.mods.runtime.MemoryRuntime(host, env.config);
  const pctx = await runtime.storeFor(env.workspaceDir);
  return { ...env, host, runtime, pctx };
}

async function toolsEnv(t, configOverrides = {}) {
  const env = await runtimeEnv(t, configOverrides);
  const definitions = new Map();
  const toolCtx = {
    tools: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => {};
      },
    },
  };
  const dispose = env.mods.tools.registerTools(toolCtx, env.runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  return { ...env, definitions };
}

async function commandEnv(t, configOverrides = {}) {
  const env = await toolsEnv(t, configOverrides);
  const commandDefs = new Map();
  const commandCtx = {
    commands: {
      register(definition) {
        commandDefs.set(definition.name, definition);
        return () => commandDefs.delete(definition.name);
      },
    },
    get: () => undefined,
    on: () => () => {},
    effect: (factory) => (typeof factory === 'function' ? factory() : undefined),
  };
  const dispose = env.mods.commands.registerCommands(commandCtx, env.runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  const memory = commandDefs.get('memory');
  assert.ok(memory, '/memory command must be registered');
  const invoke = (rawInput) => memory.handler({ rawInput, agent: { id: 'agent-1' }, sessionId: 'session-1' });
  return { ...env, commandDefs, invoke };
}

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
      }
      return this;
    },
    write(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
      return this;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return false;
    },
  };
  res.bodyText = () => Buffer.concat(chunks).toString('utf8');
  res.json = () => JSON.parse(res.bodyText() || 'null');
  return res;
}

async function callHttp(env, { method = 'GET', path: route = '/status', token, body, origin } = {}) {
  const { http } = await modules();
  const headers = { host: '127.0.0.1:61784' };
  if (token !== undefined) headers['x-cc-memory-token'] = token;
  if (origin !== undefined) headers.origin = origin;
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.url = `${http.API_PREFIX}${route}`;
  req.headers = headers;
  req.httpVersion = '1.1';
  req.socket = { remoteAddress: '127.0.0.1', remotePort: 50000 };
  const res = fakeRes();
  await env.handle(req, res);
  return res;
}

async function httpEnv(t, configOverrides = {}) {
  const env = await runtimeEnv(t, configOverrides);
  const token = 'v9-policy-token-abcdef';
  const handler = env.mods.http.createHttpHandler({ runtime: env.runtime, token });
  const handle = typeof handler === 'function' ? handler : handler.handle.bind(handler);
  return { ...env, token, handle };
}

// ---------------------------------------------------------------------------
// Pure policy functions
// ---------------------------------------------------------------------------

test('v9 policy: textSimilarity scores identity high, related text mid, unrelated low', async (t) => {
  await makeEnv(t); // warm module cache + temp cleanup
  const { textSimilarity } = (await modules()).policy;

  assert.equal(textSimilarity('用户喜欢用中文回复', '用户喜欢用中文回复'), 1);
  assert.ok(
    textSimilarity('用户喜欢用中文回复', '用户喜欢用中文回复，技术名词保留英文。') > 0.6,
    'a superset text is still highly similar',
  );
  const related = textSimilarity(
    '用户偏好中文回复，技术名词保留英文',
    '用户喜欢中文交流，术语用英文',
  );
  assert.ok(related > 0.15, `related CJK texts should share tokens (got ${related})`);
  const unrelated = textSimilarity('数据库使用 SQLite 存储', '今天天气很好适合散步');
  assert.ok(unrelated < 0.15, `unrelated texts must score low (got ${unrelated})`);
  assert.ok(related > unrelated, 'related text scores higher than unrelated text');
  assert.equal(textSimilarity('', ''), 0);
  assert.equal(textSimilarity('abc', ''), 0);
  const mixed = textSimilarity('prefer tabs for indentation', 'prefer spaces for indentation');
  assert.ok(mixed > 0.4, 'shared latin words dominate the score');
});

test('v9 policy: detectConflict finds Chinese and English polarity conflicts on the same topic', async (t) => {
  await makeEnv(t);
  const { detectConflict } = (await modules()).policy;
  const entries = [
    {
      file: 'user_language.md',
      name: '回复语言',
      description: '用户喜欢中文回复',
      body: '用户喜欢用中文回复所有问题。',
      type: 'user',
    },
    {
      file: 'user_indent.md',
      name: 'indent style',
      description: 'prefer tabs for indentation',
      body: 'Always prefer tabs when editing code.',
      type: 'feedback',
    },
  ];

  const cnConflict = detectConflict(
    { name: '回复语言', description: '用户讨厌中文回复', body: '用户讨厌中文回复，希望用英文。', type: 'user' },
    entries,
  );
  assert.ok(cnConflict, 'expected a Chinese polarity conflict');
  assert.equal(cnConflict.existingFile, 'user_language.md');

  const enConflict = detectConflict(
    { name: 'indent style', description: 'avoid tabs in indentation', body: 'Never use tabs when editing code.', type: 'feedback' },
    entries,
  );
  assert.ok(enConflict, 'expected an English polarity conflict');
  assert.equal(enConflict.existingFile, 'user_indent.md');

  const noConflict = detectConflict(
    { name: '回复语言', description: '用户喜欢中文回复', body: '用户喜欢用中文回复，很好。', type: 'user' },
    entries,
  );
  assert.equal(noConflict, null, 'same polarity is not a conflict');
});

test('v9 policy: evaluateWrite returns allow/duplicate/possible-duplicate/conflict/low-confidence', async (t) => {
  const env = await makeEnv(t);
  const { evaluateWrite, entrySimilarity, POLICY_DEFAULTS } = env.mods.policy;
  assert.equal(POLICY_DEFAULTS.duplicateThreshold, 0.82);
  assert.equal(POLICY_DEFAULTS.suggestThreshold, 0.55);

  const entries = [
    {
      file: 'user_language.md',
      name: '回复语言',
      description: '用户喜欢中文回复',
      body: '用户喜欢用中文回复所有问题。',
      type: 'user',
    },
  ];
  const config = env.config;

  const allowed = evaluateWrite({
    candidate: { name: '部署流程', description: 'CI pipeline 在 GitHub Actions', body: '部署走 GitHub Actions，测试后发布。', type: 'project' },
    entries,
    config,
  });
  assert.equal(allowed.action, 'allow');

  const duplicate = evaluateWrite({
    candidate: { name: '回复语言', description: '用户喜欢中文回复', body: '用户喜欢用中文回复所有问题。', type: 'user' },
    entries,
    config,
  });
  assert.equal(duplicate.action, 'duplicate');
  assert.equal(duplicate.existingFile, 'user_language.md');
  assert.ok(duplicate.similarity >= 0.82);

  // Force the middle band deterministically: measure the entry similarity and
  // put the configured thresholds around it.
  const similarCandidate = {
    name: '回复语言偏好',
    type: 'user',
    description: '用户喜欢中文回复，术语保留英文',
    content: '用户喜欢用中文回复，技术名词保留英文，偶尔可以英文。',
  };
  const estimated = entrySimilarity(similarCandidate, entries[0]);
  assert.ok(estimated > 0.2 && estimated < 0.99, `band fixture similarity ${estimated}`);
  const bandConfig = env.mods.config.resolveConfig({
    memoryRoot: env.memoryRoot,
    policyDuplicateThreshold: Math.min(0.99, estimated + 0.05),
    policySuggestThreshold: Math.max(0.01, estimated - 0.05),
  });
  const possible = evaluateWrite({ candidate: similarCandidate, entries, config: bandConfig });
  assert.equal(possible.action, 'possible-duplicate', JSON.stringify(possible));
  assert.ok(Array.isArray(possible.candidates) && possible.candidates.length >= 1);
  assert.equal(possible.candidates[0].file, 'user_language.md');
  assert.ok(possible.similarity >= bandConfig.policySuggestThreshold);

  const conflict = evaluateWrite({
    candidate: { name: 'reply preference', description: 'Chinese replies', body: '用户讨厌中文回复。', type: 'user' },
    entries,
    config,
  });
  assert.equal(conflict.action, 'conflict');
  assert.equal(conflict.advisory, true);
  assert.ok(Array.isArray(conflict.conflicts) && conflict.conflicts.length >= 1);
  assert.equal(conflict.conflicts[0].file, 'user_language.md');
  assert.equal(typeof conflict.conflicts[0].reason, 'string');

  const lowConfidence = evaluateWrite({
    candidate: { name: 'tmp', description: 'd', body: 'short', type: 'user', confidence: 'low' },
    entries,
    config,
  });
  assert.equal(lowConfidence.action, 'low-confidence');
  assert.ok(Array.isArray(lowConfidence.reasons) && lowConfidence.reasons.length > 0);
});

// ---------------------------------------------------------------------------
// pending-writes store
// ---------------------------------------------------------------------------

test('v9 pending writes: queue, list, approve (writes file + index), reject', async (t) => {
  const env = await makeEnv(t);
  const { queuePendingWrite, listPendingWrites, approvePendingWrite, rejectPendingWrite } = env.mods.pending;

  const queued = await queuePendingWrite(env.paths, {
    candidate: {
      name: 'queued note',
      type: 'user',
      description: 'queued description',
      body: 'queued body that is long enough',
    },
    reasons: ['write-mode-confirm'],
    source: { sessionId: 'sess-1', via: 'tool:memory_save' },
  });
  assert.equal(typeof queued.id, 'string');
  assert.equal(typeof queued.file, 'string');
  assert.equal(await exists(queued.file), true, 'the pending write is persisted as JSON');

  let items = await listPendingWrites(env.paths);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, queued.id);
  assert.equal(items[0].candidate.name, 'queued note');
  assert.deepEqual(items[0].reasons, ['write-mode-confirm']);
  assert.equal(items[0].source.via, 'tool:memory_save', 'the provenance source is recorded on the queued write');
  assert.equal(items[0].source.sessionId, 'sess-1');

  const approved = await approvePendingWrite(env.paths, queued.id, { store: env.store });
  assert.equal(approved.written, true, JSON.stringify(approved));
  assert.equal(typeof approved.file, 'string');
  assert.equal(await exists(path.join(env.paths.memoryDir, approved.file)), true, 'approve writes the memory file');
  assert.match(await env.store.indexText(), new RegExp(approved.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(await listPendingWrites(env.paths), [], 'approved items leave the queue');

  const second = await queuePendingWrite(env.paths, {
    candidate: { name: 'reject me', type: 'user', description: 'd', body: 'reject body long enough' },
    reasons: ['low-confidence'],
    source: 'tool:memory_save',
  });
  const rejected = await rejectPendingWrite(env.paths, second.id, 'not useful');
  assert.equal(rejected.rejected, true);
  assert.deepEqual(await listPendingWrites(env.paths), [], 'rejected items leave the queue');
});

// ---------------------------------------------------------------------------
// Tools: memory_save policy outcomes
// ---------------------------------------------------------------------------

test('v9 tools: memory_save duplicate/conflict/low-confidence/confirm outcomes', async (t) => {
  const env = await toolsEnv(t);
  await env.pctx.store.saveEntry({
    name: '回复语言',
    type: 'user',
    description: '用户喜欢中文回复',
    content: '用户喜欢用中文回复所有问题。',
  });
  const save = env.definitions.get('memory_save');
  assert.ok(save);
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };

  const duplicate = await save.execute(
    { name: '回复语言', type: 'user', description: '用户喜欢中文回复', content: '用户喜欢用中文回复所有问题。' },
    exec,
  );
  assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
  assert.equal(duplicate.written, false);
  assert.equal(duplicate.action, 'duplicate');
  assert.equal(typeof duplicate.existingFile, 'string');
  assert.equal(typeof duplicate.similarity, 'number');
  assert.equal(typeof duplicate.hint, 'string');

  const conflict = await save.execute(
    { name: 'reply preference', type: 'user', description: 'Chinese replies', content: '用户讨厌中文回复。' },
    exec,
  );
  assert.equal(conflict.ok, true, JSON.stringify(conflict));
  assert.equal(conflict.written, false, 'conflicts must not create a second active fact');
  assert.equal(conflict.action, 'queued-review', JSON.stringify(conflict));
  assert.ok((await env.mods.pending.listPendingWrites(env.pctx.paths)).some((item) => item.id === conflict.pendingId));
  assert.ok(Array.isArray(conflict.conflicts) && conflict.conflicts.length >= 1, JSON.stringify(conflict));
  assert.equal(typeof conflict.conflicts[0].file, 'string');
  assert.equal(typeof conflict.conflicts[0].reason, 'string');

  const lowConfidence = await save.execute(
    { name: 'low conf', type: 'user', description: 'd', content: 'short body', confidence: 'low' },
    exec,
  );
  assert.equal(lowConfidence.ok, true, JSON.stringify(lowConfidence));
  assert.equal(lowConfidence.written, false);
  assert.equal(lowConfidence.action, 'queued-review');
  assert.equal(typeof lowConfidence.pendingId, 'string');
  const pendingItems = await env.mods.pending.listPendingWrites(env.pctx.paths);
  assert.ok(pendingItems.some((item) => item.id === lowConfidence.pendingId));

  // writeMode: confirm queues even a clean candidate.
  const confirmEnv = await toolsEnv(t, { writeMode: 'confirm' });
  const confirmSave = confirmEnv.definitions.get('memory_save');
  const queued = await confirmSave.execute(
    { name: 'confirm note', type: 'user', description: 'clean description', content: 'a clean durable note body' },
    exec,
  );
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(queued.written, false);
  assert.equal(queued.action, 'queued-review');
  assert.equal(typeof queued.pendingId, 'string');
});

test('v9 tools: possible-duplicate is advisory and force still writes', async (t) => {
  const env = await toolsEnv(t, { policyDuplicateThreshold: 0.99, policySuggestThreshold: 0.01 });
  await env.pctx.store.saveEntry({
    name: 'indent style',
    type: 'feedback',
    description: 'prefer tabs for indentation',
    content: 'The project prefers tabs for indentation everywhere.',
  });
  const save = env.definitions.get('memory_save');
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const candidate = {
    name: 'indent style preference',
    type: 'feedback',
    description: 'prefer tabs for indentation in code',
    content: 'The project prefers tabs for indentation in all source files.',
  };
  const suspected = await save.execute(candidate, exec);
  assert.equal(suspected.ok, true, JSON.stringify(suspected));
  assert.equal(suspected.written, true, 'v11: possible-duplicate is advisory, the write proceeds');
  assert.equal(suspected.advisory, true);
  assert.ok(Array.isArray(suspected.candidates) && suspected.candidates.length >= 1);
  assert.equal(typeof suspected.hint, 'string');
  assert.equal((await env.pctx.store.listEntries()).length, 2);

  const forced = await save.execute({ ...candidate, force: true }, exec);
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(typeof forced.file, 'string', 'force:true still writes the candidate');
  // Same name/type targets the same topic file, so force upserts rather than
  // creating a third memory.
  const entries = await env.pctx.store.listEntries();
  assert.equal(entries.length, 2, 'force reuses the candidate topic file');
  assert.equal(forced.file, suspected.file);
});

// ---------------------------------------------------------------------------
// HTTP + status + commands surfaces
// ---------------------------------------------------------------------------

test('v9 pending writes: status.pendingWrites, GET/POST /pending-writes', async (t) => {
  const env = await httpEnv(t, { writeMode: 'confirm' });
  // Queue one through the real tool path.
  const definitions = new Map();
  env.host.services.tools = {
    register(definition) {
      definitions.set(definition.name, definition);
      return () => {};
    },
  };
  const toolDispose = env.mods.tools.registerTools(env.host, env.runtime);
  t.after(() => toolDispose?.());
  const saved = await definitions.get('memory_save').execute(
    { name: 'http pending', type: 'user', description: 'http queued note', content: 'http queued body long enough' },
    { agent: { id: 'agent-1' }, sessionId: 'sess-1' },
  );
  assert.equal(saved.action, 'queued-review', JSON.stringify(saved));

  const status = (await callHttp(env, { token: env.token, path: '/status' })).json();
  assert.equal(status.ok, true);
  assert.equal(status.pendingWrites.count, 1);
  assert.ok(Array.isArray(status.pendingWrites.items));
  assert.equal(status.pendingWrites.items[0].candidate.name, 'http pending');

  const list = await callHttp(env, { token: env.token, path: '/pending-writes' });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().ok, true);
  assert.equal(list.json().items.length, 1);
  const pendingId = list.json().items[0].id;
  assert.equal(list.json().items[0].id, pendingId);

  const approved = await callHttp(env, {
    method: 'POST',
    path: '/pending-writes',
    token: env.token,
    body: { action: 'approve', id: pendingId },
    origin: 'http://127.0.0.1:61784',
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().ok, true);
  assert.equal(approved.json().written, true);
  const statusAfter = (await callHttp(env, { token: env.token, path: '/status' })).json();
  assert.equal(statusAfter.pendingWrites.count, 0);

  const queueTwo = await env.mods.pending.queuePendingWrite(env.pctx.paths, {
    candidate: { name: 'reject http', type: 'user', description: 'd', body: 'reject body long enough' },
    reasons: ['test'],
    source: 'api',
  });
  const rejected = await callHttp(env, {
    method: 'POST',
    path: '/pending-writes',
    token: env.token,
    body: { action: 'reject', id: queueTwo.id },
  });
  assert.equal(rejected.json().ok, true);
  assert.equal(rejected.json().rejected, true);

  // Token still required.
  assert.equal((await callHttp(env, { path: '/pending-writes' })).statusCode, 401);
});

test('v9 commands: /memory writes / approve / reject', async (t) => {
  const env = await commandEnv(t, { writeMode: 'confirm' });
  const queued = await env.mods.pending.queuePendingWrite(env.pctx.paths, {
    candidate: { name: 'command pending', type: 'user', description: 'queued from command', body: 'command queued body long enough' },
    reasons: ['write-mode-confirm'],
    source: 'tool:memory_save',
  });

  const writes = await env.invoke('writes');
  assert.equal(writes.kind, 'success', writes.text);
  assert.match(writes.text, /command pending/);
  assert.match(writes.text, new RegExp(queued.id));

  const approve = await env.invoke(`approve ${queued.id}`);
  assert.equal(approve.kind, 'success', approve.text);
  assert.match(approve.text, /written|approv/i);
  const entries = await env.pctx.store.listEntries();
  assert.ok(entries.some((entry) => entry.name === 'command pending'), 'approve writes the memory file');

  const second = await env.mods.pending.queuePendingWrite(env.pctx.paths, {
    candidate: { name: 'command reject', type: 'user', description: 'd', body: 'reject body long enough' },
    reasons: ['low-confidence'],
    source: 'tool:memory_save',
  });
  const reject = await env.invoke(`reject ${second.id}`);
  assert.equal(reject.kind, 'success', reject.text);
  assert.deepEqual(await env.mods.pending.listPendingWrites(env.pctx.paths), []);
});

test('v9 config: writeMode/policy thresholds default and override', async (t) => {
  const env = await makeEnv(t);
  assert.equal(env.config.writeMode, 'auto');
  assert.equal(env.config.policyDuplicateThreshold, 0.82);
  assert.equal(env.config.policySuggestThreshold, 0.55);
  const custom = env.mods.config.resolveConfig({
    memoryRoot: env.memoryRoot,
    writeMode: 'confirm',
    policyDuplicateThreshold: 0.9,
    policySuggestThreshold: 0.4,
  });
  assert.equal(custom.writeMode, 'confirm');
  assert.equal(custom.policyDuplicateThreshold, 0.9);
  assert.equal(custom.policySuggestThreshold, 0.4);
  const invalid = env.mods.config.resolveConfig({ memoryRoot: env.memoryRoot, writeMode: 'sometimes' });
  assert.equal(invalid.writeMode, 'auto', 'invalid writeMode falls back to auto');
});
