/**
 * v8 effect metrics: src/metrics.js store + wiring into status/http/tools/inject/commands.
 *
 * Contract: docs/superpowers/specs/2026-11-07-v8-metrics-cost-contract.md 搂1-搂3.
 * Every test uses os.tmpdir(); no LLM is invoked.
 */
import { withCordis } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
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
      metrics: await loadModule('../src/metrics.js', {
        requireExports: ['readMetrics', 'recordInjection', 'recordRead', 'recordWrite', 'recordSearch', 'recordDream', 'metricsSummary'],
      }),
      status: await loadModule('../src/status.js', { requireExports: ['createStatusService'] }),
      http: await loadModule('../src/http.js', { requireExports: ['createHttpHandler', 'API_PREFIX'] }),
      tools: await loadModule('../src/tools.js', { requireExports: ['registerTools'] }),
      inject: await loadModule('../src/inject.js', { requireExports: ['registerInjection'] }),
      commands: await loadModule('../src/commands.js', { requireExports: ['registerCommands'] }),
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Project fixtures: real paths/store/state, plus the metrics file paths. */
async function makeEnv(t, configOverrides = {}) {
  const mods = await modules();
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const paths = mods.paths.buildPaths({ memoryRoot: config.memoryRoot, homeDir: path.join(tmp, 'home'), workspaceDir });
  const store = new mods.store.MemoryStore({ paths, getConfig: () => config });
  await store.ensure();
  const state = new mods.state.ProjectState(paths);
  await state.load();
  const pctx = { workspaceDir, paths, store, state };
  assert.equal(typeof paths.metricsFile, 'string', 'paths.metricsFile must be added by v8a');
  assert.equal(typeof paths.metricsLockFile, 'string', 'paths.metricsLockFile must be added by v8a');
  return { mods, tmp, memoryRoot, workspaceDir, config, paths, store, state, pctx };
}

async function runtimeEnv(t, configOverrides = {}) {
  const env = await makeEnv(t, configOverrides);
  const host = fakeHost({ workspaceDir: env.workspaceDir });
  const runtime = new env.mods.runtime.MemoryRuntime(host, env.config);
  const pctx = await runtime.storeFor(env.workspaceDir);
  return { ...env, host, runtime, pctx };
}

async function readMetricsFile(env) {
  return JSON.parse(await readFile(env.paths.metricsFile, 'utf8'));
}

// ---------------------------------------------------------------------------
// Metrics store
// ---------------------------------------------------------------------------

test('v8 metrics: missing file reads as empty schema v1', async (t) => {
  const env = await makeEnv(t);
  const metrics = await env.mods.metrics.readMetrics(env.paths);
  assert.equal(metrics.version, 1);
  assert.equal(typeof metrics.since, 'number');
  assert.equal(typeof metrics.updatedAt, 'number');
  assert.deepEqual(metrics.injections, { count: 0, lastAt: 0 });
  assert.deepEqual(metrics.entries, {});
  assert.deepEqual(metrics.searches, { count: 0, hits: 0 });
  assert.deepEqual(metrics.dreams, { proposed: 0, applied: 0, rejected: 0, failed: 0 });
  assert.deepEqual(metrics.costs, {
    lastDurationMs: 0,
    lastInputChars: 0,
    lastOutputChars: 0,
    lastUsage: null,
  });
});

test('v8 metrics: corrupt file rebuilds from an empty metrics object without throwing', async (t) => {
  const env = await makeEnv(t);
  await mkdir(path.dirname(env.paths.metricsFile), { recursive: true });
  await writeFile(env.paths.metricsFile, '{ this is not json', 'utf8');
  const metrics = await env.mods.metrics.readMetrics(env.paths);
  assert.equal(metrics.version, 1);
  assert.equal(metrics.injections.count, 0);
  assert.deepEqual(metrics.entries, {});
});

test('v8 metrics: record helpers accumulate and persist (concurrent-safe merge)', async (t) => {
  const { readMetrics, recordInjection, recordRead, recordWrite, recordSearch } = (await modules()).metrics;
  const env = await makeEnv(t);

  await Promise.all([
    recordInjection(env.paths),
    recordInjection(env.paths),
    recordRead(env.paths, 'user_a.md'),
    recordRead(env.paths, 'user_a.md'),
    recordWrite(env.paths, 'user_b.md'),
    recordSearch(env.paths, 2),
    recordSearch(env.paths, 3),
  ]);

  const metrics = await readMetrics(env.paths);
  assert.equal(metrics.injections.count, 2);
  assert.ok(metrics.injections.lastAt > 0);
  assert.equal(metrics.entries['user_a.md'].reads, 2);
  assert.ok(metrics.entries['user_a.md'].lastReadAt > 0);
  assert.equal(metrics.entries['user_b.md'].writes, 1);
  assert.ok(metrics.entries['user_b.md'].lastWriteAt > 0);
  assert.equal(metrics.searches.count, 2);
  assert.equal(metrics.searches.hits, 5);

  // The data is really on disk (fresh read without cache).
  const onDisk = await readMetricsFile(env);
  assert.equal(onDisk.injections.count, 2);
  assert.equal(onDisk.entries['user_a.md'].reads, 2);

  // 20 parallel increments must not lose updates.
  await Promise.all(Array.from({ length: 20 }, () => recordInjection(env.paths)));
  const afterBurst = await readMetrics(env.paths);
  assert.equal(afterBurst.injections.count, 22, 'concurrent writes must merge, not overwrite');
});

test('v8 metrics: recordDream events count and record costs', async (t) => {
  const { readMetrics, recordDream } = (await modules()).metrics;
  const env = await makeEnv(t);

  await recordDream(env.paths, { event: 'proposed', ops: 3 });
  let metrics = await readMetrics(env.paths);
  assert.equal(metrics.dreams.proposed, 1);
  assert.equal(metrics.dreams.applied, 0);
  assert.equal(metrics.costs.lastDurationMs, 0, 'proposed does not record costs');

  await recordDream(env.paths, {
    event: 'applied',
    ops: 2,
    durationMs: 1234,
    inputChars: 5000,
    outputChars: 700,
    usage: { inputTokens: 800, outputTokens: 120, totalTokens: 920 },
  });
  metrics = await readMetrics(env.paths);
  assert.equal(metrics.dreams.applied, 1);
  assert.equal(metrics.dreams.appliedOps, 2);
  assert.equal(metrics.costs.lastDurationMs, 1234);
  assert.equal(metrics.costs.lastInputChars, 5000);
  assert.equal(metrics.costs.lastOutputChars, 700);
  assert.equal(metrics.costs.lastUsage.totalTokens, 920);

  await recordDream(env.paths, { event: 'rejected' });
  await recordDream(env.paths, { event: 'failed', durationMs: 10 });
  metrics = await readMetrics(env.paths);
  assert.equal(metrics.dreams.rejected, 1);
  assert.equal(metrics.dreams.failed, 1);
  assert.equal(metrics.dreams.applied, 1);
});

test('v8 metrics: metricsSummary reports totals, top, neverRead, acceptance and costs', async (t) => {
  const { readMetrics, recordInjection, recordRead, recordWrite, recordDream, metricsSummary } =
    (await modules()).metrics;
  const env = await makeEnv(t);

  await recordInjection(env.paths);
  await recordInjection(env.paths);
  await recordRead(env.paths, 'user_a.md');
  await recordRead(env.paths, 'user_a.md');
  await recordRead(env.paths, 'user_a.md');
  await recordRead(env.paths, 'user_b.md');
  await recordWrite(env.paths, 'user_c.md');
  await recordDream(env.paths, { event: 'proposed', ops: 4 });
  await recordDream(env.paths, {
    event: 'applied',
    ops: 2,
    durationMs: 900,
    inputChars: 3000,
    outputChars: 400,
    usage: { totalTokens: 500 },
  });
  await recordDream(env.paths, { event: 'rejected' });

  const metrics = await readMetrics(env.paths);
  const summary = metricsSummary(metrics, { files: ['user_a.md', 'user_b.md', 'user_c.md'] });
  assert.equal(summary.injections.count, 2);
  assert.equal(typeof summary.injections.lastAt, 'number');
  assert.equal(summary.reads.total, 4);
  assert.deepEqual(
    summary.reads.top.map((item) => item.file),
    ['user_a.md', 'user_b.md'],
  );
  assert.deepEqual(summary.reads.neverRead, ['user_c.md']);
  assert.equal(summary.writes.total, 1);
  assert.equal(summary.searches.count, 0);
  assert.equal(summary.dreams.proposed, 1);
  assert.equal(summary.dreams.applied, 1);
  assert.equal(summary.dreams.rejected, 1);
  assert.equal(summary.dreams.acceptanceRate, 0.5);
  assert.equal(summary.dreams.appliedOps, 2);
  assert.equal(summary.costs.lastDurationMs, 900);
  assert.equal(summary.costs.lastUsage.totalTokens, 500);
  assert.equal(typeof summary.updatedAt, 'number');
  assert.equal(typeof summary.since, 'number');
});

// ---------------------------------------------------------------------------
// Exposed through status service / HTTP / commands
// ---------------------------------------------------------------------------

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

async function callHttp(handle, { method = 'GET', path: route = '/status', token, body, origin } = {}) {
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
  await handle(req, res);
  return res;
}

async function httpEnv(t) {
  const env = await runtimeEnv(t);
  await env.pctx.store.saveEntry({ name: 'metrics one', type: 'user', description: 'd', content: 'body' });
  await env.mods.metrics.recordInjection(env.paths);
  await env.mods.metrics.recordRead(env.paths, 'user_metrics_one.md');
  const token = 'v8-metrics-token-abcdef';
  const handler = env.mods.http.createHttpHandler({ runtime: env.runtime, token });
  const handle = typeof handler === 'function' ? handler : handler.handle.bind(handler);
  return { ...env, token, handle };
}

test('v8 metrics: /status payload and GET /metrics expose the metrics block', async (t) => {
  const env = await httpEnv(t);
  const status = await callHttp(env.handle, { token: env.token, path: '/status' });
  assert.equal(status.statusCode, 200);
  const payload = status.json();
  assert.equal(payload.ok, true);
  assert.ok(payload.metrics, 'status payload must include metrics');
  assert.equal(payload.metrics.injections.count, 1);
  assert.equal(payload.metrics.reads.total, 1);
  assert.equal(payload.metrics.reads.top[0].file, 'user_metrics_one.md');
  assert.equal(typeof payload.metrics.writes.total, 'number');
  assert.equal(typeof payload.metrics.searches, 'object');
  assert.equal(typeof payload.metrics.dreams.acceptanceRate, 'number');
  assert.equal(typeof payload.metrics.costs, 'object');

  const metrics = await callHttp(env.handle, { token: env.token, path: '/metrics' });
  assert.equal(metrics.statusCode, 200);
  assert.equal(metrics.json().ok, true);
  assert.equal(metrics.json().metrics.injections.count, 1);
  assert.equal(metrics.json().metrics.reads.total, 1);

  assert.equal((await callHttp(env.handle, { path: '/metrics' })).statusCode, 401);
});

test('v8 metrics: /memory metrics and /memory json expose the summary', async (t) => {
  const env = await runtimeEnv(t);
  await env.pctx.store.saveEntry({ name: 'cmd metrics', type: 'user', description: 'd', content: 'body' });
  await env.mods.metrics.recordInjection(env.paths);
  await env.mods.metrics.recordRead(env.paths, 'user_cmd_metrics.md');
  const definitions = new Map();
  const commandCtx = {
    commands: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name);
      },
    },
    get: (name) => (name === 'commands' ? commandCtx.commands : undefined),
    on: () => () => {},
    effect: (factory) => (typeof factory === 'function' ? factory() : undefined),
  };
  const dispose = env.mods.commands.registerCommands(commandCtx, env.runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  const memory = definitions.get('memory');
  assert.ok(memory);
  const invocation = { rawInput: 'metrics', agent: { id: 'agent-1' }, sessionId: 'session-1' };
  const text = await memory.handler(invocation);
  assert.equal(text.kind, 'success', text.text);
  assert.match(text.text, /inject/i);
  assert.match(text.text, /read/i);
  assert.match(text.text, /acceptance|acceptanceRate|applied/i);
  assert.match(text.text, /cost/i);

  const json = await memory.handler({ ...invocation, rawInput: 'json' });
  assert.equal(json.kind, 'success');
  const payload = JSON.parse(json.text);
  assert.equal(payload.ok, true);
  assert.ok(payload.metrics, '/memory json must include metrics');
  assert.equal(payload.metrics.injections.count, 1);
});

// ---------------------------------------------------------------------------
// Wiring: tools + inject
// ---------------------------------------------------------------------------

test('v8 metrics: memory tools record read/save/search events', async (t) => {
  const env = await runtimeEnv(t);
  const definitions = new Map();
  const toolCtx = withCordis({
    tools: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => {};
      },
    },
  });
  const dispose = env.mods.tools.registerTools(toolCtx, env.runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  const exec = { agent: { id: 'agent-tools' }, sessionId: 'sess-tools' };

  // v9 policy: short bodies are queued for review; force the write so the
  // metrics wiring is what this test exercises.
  const saved = await definitions.get('memory_save').execute(
    { name: 'metrics tool note', type: 'project', description: 'd', content: 'body', force: true },
    exec,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  await definitions.get('memory_read').execute({ file: saved.file }, exec);
  await definitions.get('memory_search').execute({ query: 'metrics' }, exec);

  // The fire-and-forget records are tracked; give them a moment to flush.
  await sleep(150);
  const metrics = await env.mods.metrics.readMetrics(env.paths);
  assert.ok(metrics.injections.count >= 0); // injections are recorded by the inject module only
  assert.equal(metrics.entries[saved.file].writes, 1, 'memory_save records one write');
  assert.equal(metrics.entries[saved.file].reads, 1, 'memory_read records one read');
  assert.equal(metrics.searches.count, 1, 'memory_search records one search');
  assert.ok(metrics.searches.hits >= 1);
});

test('v8 metrics: building a non-empty injection records one injection (runtime.track)', async (t) => {
  const env = await runtimeEnv(t);
  await env.pctx.store.saveEntry({ name: 'inject metrics', type: 'user', description: 'd', content: 'body' });
  const contextCalls = [];
  const agent = {
    id: 'agent-inject',
    ctx: withCordis({
      systemPrompt: {
        context(options) {
          contextCalls.push(options);
          return () => {};
        },
      },
    }),
  };
  env.host.services.agents = { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) };
  env.host.services.tools = { register: () => () => {} };
  env.host.services.systemPrompt = {};
  const dispose = env.mods.inject.registerInjection(env.host, env.runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && contextCalls.every((options) => String(options?.text?.() ?? '') === '')) {
    await sleep(25);
  }
  await env.runtime.drain();
  const metrics = await env.mods.metrics.readMetrics(env.paths);
  assert.equal(metrics.injections.count, 1, 'a successful injection build records exactly one injection');
  assert.ok(metrics.injections.lastAt > 0);
});

// ---------------------------------------------------------------------------
// Lossless JSON regressions (v8e): the live-host memory_status bug
// ---------------------------------------------------------------------------

/**
 * Recursively assert a value survives a lossless-JSON check: no undefined,
 * NaN, Infinity, functions, symbols or cycles. Mirrors the host's tool output
 * validator that rejected `memory_status`.
 */
function assertLosslessJson(value, path = 'metrics', seen = new Set()) {
  if (value === undefined) assert.fail(`${path} is undefined: JSON.stringify would drop it (lossless check fails)`);
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true, `${path} must be a finite number, got ${value}`);
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  assert.equal(typeof value, 'object', `${path} must be JSON data, got ${typeof value}`);
  assert.equal(seen.has(value), false, `${path} is a circular reference`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLosslessJson(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) assertLosslessJson(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

test('v8 lossless: service.status metrics survive JSON.stringify and never alias inject/injections', async (t) => {
  const env = await runtimeEnv(t);
  await env.pctx.store.saveEntry({ name: 'lossless one', type: 'user', description: 'd', content: 'body' });
  await env.mods.metrics.recordInjection(env.paths);
  await env.mods.metrics.recordRead(env.paths, 'user_lossless_one.md');
  const service = env.mods.status.createStatusService(env.runtime);
  const pctx = env.pctx;

  const payload = await service.status(pctx);
  assert.doesNotThrow(() => JSON.stringify(payload), 'the /status payload must be lossless JSON');

  const metrics = payload.metrics;
  assert.ok(metrics && typeof metrics === 'object', 'status must expose metrics');
  // The live bug: `inject` and `injections` pointed at the same object, which
  // made JSON.stringify throw on a "circular" reference.
  assert.notEqual(metrics.inject, metrics.injections, 'metrics.inject and metrics.injections must be distinct objects');
  assert.deepEqual(metrics.inject, metrics.injections, '鈥ith identical content');
  assert.equal(Array.isArray(metrics.reads.top), true);
  assert.equal(Array.isArray(metrics.reads.neverRead), true);
  assert.equal(typeof metrics.writes.total, 'number');
  assert.equal(typeof metrics.searches.count, 'number');
  // `appliedOps` must default to a number even before the first applied dream.
  assert.equal(typeof metrics.dreams.appliedOps, 'number', 'dreams.appliedOps must never be undefined');
  assert.equal(metrics.dreams.appliedOps, 0);
  assertLosslessJson(metrics, 'status.metrics');

  // Round-trip equality for the metrics block (no undefined leaves to drop).
  const roundTripped = JSON.parse(JSON.stringify(metrics));
  assert.deepEqual(roundTripped, metrics, 'metrics must survive a JSON round-trip unchanged');

  // The dedicated service.metrics view is serializable too.
  const view = await service.metrics(pctx);
  assert.doesNotThrow(() => JSON.stringify(view));
  assert.notEqual(view.inject, view.injections);
  assert.deepEqual(view.inject, view.injections);
  assert.equal(view.dreams.appliedOps, 0);
  assertLosslessJson(view, 'service.metrics');
});

test('v8 lossless: GET /status and GET /metrics bodies are JSON round-trip safe', async (t) => {
  const env = await httpEnv(t);

  for (const route of ['/status', '/metrics']) {
    const res = await callHttp(env.handle, { token: env.token, path: route });
    assert.equal(res.statusCode, 200, `${route} must succeed`);
    const bodyText = res.bodyText();
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(bodyText);
    }, `${route} response body must be valid JSON (the live bug produced invalid JSON)`);
    assert.equal(parsed.ok, true);
    const metrics = route === '/metrics' ? parsed.metrics : parsed.metrics;
    assert.ok(metrics && typeof metrics === 'object', `${route} must include metrics`);
    assertLosslessJson(metrics, `${route}.metrics`);
    assert.equal(typeof metrics.dreams.appliedOps, 'number');
    assert.equal(metrics.dreams.appliedOps, 0);
    assert.equal(JSON.stringify(parsed), JSON.stringify(JSON.parse(JSON.stringify(parsed))), `${route} JSON is stable`);
    // No JS-only values leaked into the wire format.
    assert.doesNotMatch(bodyText, /undefined|NaN|Infinity/);
  }
});

test('v8 lossless: status service payload is JSON-serializable and exposes safe metrics', async (t) => {
  const env = await runtimeEnv(t);
  await env.pctx.store.saveEntry({ name: 'status tool note', type: 'user', description: 'd', content: 'body' });
  // v11: memory_status is no longer a model tool; the same payload is served by
  // the status service (and GET /status).
  const service = env.mods.status.createStatusService(env.runtime);
  const result = await service.status(env.pctx, { sessionId: 'agent-status' });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.doesNotThrow(() => JSON.stringify(result), 'the status payload must be lossless JSON (host rejects undefined/cycles)');
  assert.ok(result.metrics && typeof result.metrics === 'object', 'status must expose metrics');
  // The status payload exposes both `inject` and `injections`; they must not
  // alias the same object (the v8 live bug).
  const injectBlock = result.metrics.inject ?? result.metrics.injections;
  assert.ok(injectBlock && typeof injectBlock === 'object', 'status must expose the injection counter block');
  assert.equal(typeof injectBlock.count, 'number');
  assert.equal(typeof injectBlock.lastAt, 'number');
  if (result.metrics.inject !== undefined && result.metrics.injections !== undefined) {
    assert.notEqual(result.metrics.inject, result.metrics.injections);
    assert.deepEqual(result.metrics.inject, result.metrics.injections);
  }
  assert.equal(typeof result.metrics.dreams.appliedOps, 'number');
  assert.equal(result.metrics.dreams.appliedOps, 0);
  assertLosslessJson(result.metrics, 'status.metrics');
  // The whole payload round-trips through JSON unchanged (no undefined leaves).
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
