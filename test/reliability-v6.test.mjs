/**
 * v6 reliability tests:
 *   1. awaited `createMemoryPlugin().dispose()` drains every tracked background
 *      write, so removing the temp dir afterwards never races (20 iterations);
 *   2. HTTP security: loopback-only socket check + same-origin check for
 *      mutations, token auth, stable token file;
 *   3. rules audit log (.memory-rules.log) records scope/source/bytes/sha256;
 *   4. the process.cwd() fallback is gone: an unresolved workspace yields
 *      `no-project`, never a project directory;
 *   5. Chinese search works without spaces (CJK bigrams);
 *   6. client.js carries the new bridge/token banners, reload button and
 *      markdown rendering, with locale keys synced.
 *
 * Everything uses fake Host contexts and os.tmpdir() memory roots.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT, loadModule, makeTempDir } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Modules / shared helpers
// ---------------------------------------------------------------------------

let modulesPromise;

function modules() {
  if (!modulesPromise) {
    modulesPromise = (async () => ({
      index: await loadModule('../index.js', { requireExports: ['apply', 'createMemoryPlugin', 'inject'] }),
      meta: await loadModule('../src/meta.js', { requireExports: ['VERSION', 'DATA_SCHEMA', 'buildHealth'] }),
      config: await loadModule('../src/config.js', { requireExports: ['resolveConfig'] }),
      paths: await loadModule('../src/paths.js', { requireExports: ['buildPaths'] }),
      state: await loadModule('../src/state.js', { requireExports: ['ProjectState'] }),
      store: await loadModule('../src/store.js', { requireExports: ['MemoryStore'] }),
      runtime: await loadModule('../src/runtime.js', { requireExports: ['MemoryRuntime'] }),
      inject: await loadModule('../src/inject.js', { requireExports: ['registerInjection'] }),
      tools: await loadModule('../src/tools.js', { requireExports: ['registerTools'] }),
      http: await loadModule('../src/http.js', {
        requireExports: ['createHttpHandler', 'registerHttpApi', 'API_PREFIX'],
      }),
    }))();
  }
  return modulesPromise;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    try {
      const { stat } = await import('node:fs/promises');
      await stat(file);
      return true;
    } catch {
      return false;
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 4000, interval = 20 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const value = await check();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error('condition was not satisfied within the timeout');
}

async function makeEnv(t, configOverrides = {}) {
  const mods = await modules();
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  return { mods, tmp, memoryRoot, workspaceDir, config };
}

/** Capture console output for one async block; returns the block's result too. */
async function withConsoleCapture(fn) {
  const warnings = [];
  const infos = [];
  const format = (args) =>
    args
      .map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : String(arg ?? '')))
      .join(' ');
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = (...args) => warnings.push(format(args));
  console.info = (...args) => infos.push(format(args));
  try {
    const result = await fn();
    return { result, warnings, infos };
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
}

/** Fake Cordis plugin context: get()/on()/effect() + registration trackers. */
function trackingHost(services = {}) {
  const records = {
    tools: [],
    toolDisposers: [],
    commands: [],
    commandDisposers: [],
    promptRegistrations: [],
    promptDisposers: [],
    listeners: new Map(),
    effects: [],
  };
  const host = {
    get(name) {
      return services[name];
    },
    on(event, handler) {
      const set = records.listeners.get(event) ?? new Set();
      set.add(handler);
      records.listeners.set(event, set);
      return () => set.delete(event === undefined ? handler : handler);
    },
    effect(factory) {
      const dispose = factory();
      records.effects.push(dispose);
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };
  return { host, records, services };
}

function toolsService(records) {
  return {
    register(definition) {
      records.tools.push(definition);
      return () => {
        records.toolDisposers.push(definition.name);
      };
    },
  };
}

function commandsService(records) {
  return {
    register(definition) {
      records.commands.push(definition);
      return () => {
        records.commandDisposers.push(definition.name);
      };
    },
  };
}

function makeAgent(records, id) {
  const calls = [];
  const agent = {
    id,
    contextCalls: calls,
    ctx: {
      systemPrompt: {
        context(options) {
          records.promptRegistrations.push({ agentId: id, options });
          calls.push(options);
          return () => {
            records.promptDisposers.push(id);
          };
        },
      },
    },
  };
  return agent;
}

function pendingListenerCount(records) {
  let total = 0;
  for (const set of records.listeners.values()) total += set.size;
  return total;
}

// ---------------------------------------------------------------------------
// 1. Deterministic dispose: drain tracked background work before cleanup
// ---------------------------------------------------------------------------

test('v6: awaited dispose drains in-flight prewarm writes (20 iterations, no ENOTEMPTY)', async () => {
  const mods = await modules();
  const capturedWarnings = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = (...args) => capturedWarnings.push(args.map(String).join(' '));
  console.info = () => {};
  try {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc-memory-v6-drain-'));
      try {
        const memoryRoot = path.join(tmp, 'memory-root');
        const workspaceDir = path.join(tmp, 'workspace');
        await mkdir(workspaceDir, { recursive: true });
        const { host, records, services } = trackingHost();
        services.tools = toolsService(records);
        services.systemPrompt = {};
        const agent = makeAgent(records, `drain-agent-${iteration}`);
        services.agents = { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) };
        // Slow cwd resolution widens the write-vs-cleanup race window on purpose.
        services.workingDirectory = {
          ensure: async () => {
            await sleep(35);
            return workspaceDir;
          },
        };

        const plugin = mods.index.createMemoryPlugin(host, { memoryRoot });
        assert.ok(plugin && typeof plugin.dispose === 'function');
        assert.ok(plugin.runtime, 'createMemoryPlugin must expose the runtime');
        await plugin.dispose();

        assert.equal(plugin.runtime.pending.size, 0, `iteration ${iteration}: drain must leave no pending work`);
        // Without drain() the prewarm write can still be in flight here and
        // recursive removal races with mkdir/writeFile => ENOTEMPTY / ENOENT.
        await rm(tmp, { recursive: true, force: false });
        assert.equal(await exists(tmp), false, `iteration ${iteration}: temp dir must be removable after awaited dispose`);

        // dispose is idempotent even after the drain.
        await assert.doesNotReject(() => plugin.dispose());
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    }
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
});

test('v6: runtime exposes track/drain and a double mount/dispose cycle stays clean', async (t) => {
  const env = await makeEnv(t);
  const { host, records, services } = trackingHost();
  services.tools = toolsService(records);
  services.systemPrompt = {};
  const agent = makeAgent(records, 'double-agent');
  services.agents = { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) };
  services.workingDirectory = { ensure: async () => env.workspaceDir };
  services.commands = commandsService(records);

  const { result: plugins } = await withConsoleCapture(() => [
    env.mods.index.createMemoryPlugin(host, { memoryRoot: env.memoryRoot }),
    env.mods.index.createMemoryPlugin(host, { memoryRoot: env.memoryRoot }),
  ]);
  const [first, second] = plugins;
  for (const plugin of plugins) {
    assert.equal(typeof plugin.runtime.track, 'function', 'runtime.track must exist');
    assert.equal(typeof plugin.runtime.drain, 'function', 'runtime.drain must exist');
  }
  await Promise.all([first.dispose(), second.dispose()]);
  await assert.doesNotReject(() => first.dispose());
  await assert.doesNotReject(() => second.dispose());
  for (const plugin of plugins) assert.equal(plugin.runtime.pending.size, 0);
  assert.equal(pendingListenerCount(records), 0, 'no listeners may survive a double dispose');
  assert.equal(records.toolDisposers.length, records.tools.length, 'every tool disposer ran');
});

// ---------------------------------------------------------------------------
// 2. HTTP loopback + Origin checks
// ---------------------------------------------------------------------------

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    writeHead(status, headers) {
      this.statusCode = status;
      this.headersSent = true;
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
      this.headersSent = true;
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

async function callHttp(
  handle,
  {
    method = 'GET',
    path: route = '/status',
    token,
    body,
    origin,
    host = '127.0.0.1:61784',
    remoteAddress = '127.0.0.1',
  } = {},
) {
  const { http } = await modules();
  const prefix = http.API_PREFIX;
  const headers = { host };
  if (token !== undefined) headers['x-cc-memory-token'] = token;
  if (origin !== undefined) headers.origin = origin;
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.url = `${prefix}${route}`;
  req.headers = headers;
  req.httpVersion = '1.1';
  req.socket = remoteAddress === undefined ? {} : { remoteAddress, remotePort: 50000 };
  const res = fakeRes();
  await handle(req, res);
  return res;
}

async function httpHarness(t) {
  const env = await makeEnv(t);
  const { host, services } = trackingHost();
  services.workingDirectory = { ensure: async () => env.workspaceDir };
  const runtime = new env.mods.runtime.MemoryRuntime(host, env.config);
  const pctx = await runtime.storeFor(env.workspaceDir);
  const token = 'v6-fixed-test-token-abcdef';
  const handler = env.mods.http.createHttpHandler({ runtime, token });
  const handle = typeof handler === 'function' ? handler : handler.handle.bind(handler);
  return { env, host, services, runtime, pctx, token, handle };
}

test('v6: HTTP API rejects non-loopback sockets with 403 loopback-only', async (t) => {
  const { token, handle } = await httpHarness(t);

  const remote = await callHttp(handle, { token, path: '/status', remoteAddress: '10.0.0.5' });
  assert.equal(remote.statusCode, 403);
  assert.equal(remote.json().ok, false);
  assert.equal(remote.json().error, 'loopback-only');

  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const local = await callHttp(handle, { token, path: '/status', remoteAddress: address });
    assert.equal(local.statusCode, 200, `loopback address ${address} must be allowed`);
    assert.equal(local.json().ok, true);
  }
});

test('v6: HTTP API rejects cross-origin mutations with 403 bad-origin, GET unaffected', async (t) => {
  const { token, handle } = await httpHarness(t);

  const evil = await callHttp(handle, {
    method: 'POST',
    path: '/toggle',
    token,
    body: { autoMemoryEnabled: false },
    origin: 'https://evil.example',
    host: '127.0.0.1:61784',
  });
  assert.equal(evil.statusCode, 403);
  assert.equal(evil.json().error, 'bad-origin');

  const sameOrigin = await callHttp(handle, {
    method: 'POST',
    path: '/toggle',
    token,
    body: { autoMemoryEnabled: false },
    origin: 'http://127.0.0.1:61784',
    host: '127.0.0.1:61784',
  });
  assert.equal(sameOrigin.statusCode, 200, 'same-host origin must be allowed');
  assert.equal(sameOrigin.json().ok, true);

  const loopbackOrigin = await callHttp(handle, {
    method: 'POST',
    path: '/toggle',
    token,
    body: { autoMemoryEnabled: true },
    origin: 'http://localhost:61784',
    host: '127.0.0.1:61784',
  });
  assert.equal(loopbackOrigin.statusCode, 200, 'a loopback origin host must be allowed');

  const noOrigin = await callHttp(handle, {
    method: 'POST',
    path: '/toggle',
    token,
    body: { autoDreamEnabled: true },
  });
  assert.equal(noOrigin.statusCode, 200, 'mutations without an Origin header (non-browser) stay allowed');

  const read = await callHttp(handle, {
    token,
    path: '/status',
    origin: 'https://evil.example',
    host: '127.0.0.1:61784',
  });
  assert.equal(read.statusCode, 200, 'GET requests are not origin-restricted');
});

// ---------------------------------------------------------------------------
// 3. Stable API token (persisted to <memoryRoot>/.api-token)
// ---------------------------------------------------------------------------

function extractTokenFromIndex(html) {
  const match = /window\.__CC_MEMORY_API__=(\{.*?\});<\/script>/.exec(String(html ?? ''));
  if (!match) return '';
  try {
    const parsed = JSON.parse(match[1]);
    return typeof parsed.token === 'string' ? parsed.token : '';
  } catch {
    return '';
  }
}

test('v6: API token persists in <memoryRoot>/.api-token across plugin reloads', async (t) => {
  const env = await makeEnv(t);
  const { host, services, records } = trackingHost();
  services.workingDirectory = { ensure: async () => env.workspaceDir };
  const runtime = new env.mods.runtime.MemoryRuntime(host, env.config);

  const registrations = [];
  services.webServer = {
    register(options) {
      registrations.push(options);
      return () => {};
    },
  };
  const tokenFile = env.mods.paths.buildPaths({ memoryRoot: env.memoryRoot, workspaceDir: env.workspaceDir }).apiTokenFile;
  assert.equal(tokenFile, path.join(env.memoryRoot, '.api-token'), 'paths.apiTokenFile lives in the memory root');

  const { result } = await withConsoleCapture(() => {
    const first = env.mods.http.registerHttpApi(host, runtime);
    const second = env.mods.http.registerHttpApi(host, runtime);
    return { first, second };
  });
  const disposeFirst = result.first;
  const disposeSecond = result.second;

  assert.equal(await exists(tokenFile), true, 'the API token must be persisted to <memoryRoot>/.api-token');
  const persisted = (await readFile(tokenFile, 'utf8')).trim();
  assert.match(persisted, /^[A-Za-z0-9_-]{24,}$/, 'the persisted token must be a base64url string');

  // v11: the bridge is a webserver/index-inject listener instead of tapIndex.
  const ownerListeners = [...(records.listeners.get('webserver/index-inject') ?? [])];
  assert.equal(ownerListeners.length, 2, 'both registrations must register an index-inject listener');
  const injectedTokens = ownerListeners.map((listener) => {
    const rows = [];
    listener(rows, { principal: { kind: 'owner' } });
    const row = rows.find((item) => item && item.name === '__CC_MEMORY_API__');
    assert.ok(row, 'an owner peer receives the API row');
    assert.equal(row.kind, 'global');
    assert.equal(row.value.base, '/api/cc-memory');
    return row.value.token;
  });
  assert.equal(injectedTokens[0], injectedTokens[1], 'reloading the plugin must not rotate the token');
  assert.equal(injectedTokens[0], persisted, 'each registration must serve the persisted token');

  const viewerRows = [];
  ownerListeners[0](viewerRows, { principal: { kind: 'share-viewer' } });
  assert.equal(viewerRows.some((item) => item.name === '__CC_MEMORY_API__'), false, 'non-owner peers get no token row');
  assert.equal(registrations.length, 2, 'the API route is registered once per load');

  if (typeof disposeFirst === 'function') disposeFirst();
  if (typeof disposeSecond === 'function') disposeSecond();
});

// ---------------------------------------------------------------------------
// 4. Rules audit log
// ---------------------------------------------------------------------------

test('v6: saveRules/resetRules append audit lines with scope/source/bytes/sha256', async (t) => {
  const env = await makeEnv(t);
  const { host, services } = trackingHost();
  services.workingDirectory = { ensure: async () => env.workspaceDir };
  const runtime = new env.mods.runtime.MemoryRuntime(host, env.config);
  const pctx = await runtime.storeFor(env.workspaceDir);

  const text = '- V6 AUDIT RULE: prefer evidence over memory';
  await runtime.saveRules(pctx, 'project', text);
  const logFile = pctx.paths.rulesLogFile;
  assert.equal(await exists(logFile), true, 'rules audit log must be created');
  const firstLine = (await readFile(logFile, 'utf8')).trim().split(/\r?\n/).at(-1);
  assert.match(firstLine, /scope=project/, `audit line missing scope: ${firstLine}`);
  assert.match(firstLine, /source=api/, `audit line missing source: ${firstLine}`);
  assert.match(firstLine, /bytes=\d+/, `audit line missing bytes: ${firstLine}`);
  assert.match(firstLine, /sha256=[0-9a-f]{16}/, `audit line missing sha256: ${firstLine}`);
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
  assert.match(firstLine, new RegExp(`sha256=${digest}`), 'audit sha256 must hash the saved rules text');

  await runtime.resetRules(pctx, 'project');
  const lines = (await readFile(logFile, 'utf8')).trim().split(/\r?\n/);
  assert.equal(lines.length, 2, 'resetRules must append a second audit line');
  assert.match(lines[1], /scope=project/);
  assert.match(lines[1], /source=api/);
  assert.match(lines[1], /bytes=0/, 'reset records an empty rules payload');
});

test('v6: HTTP POST /rules is audited with source=api', async (t) => {
  const { env, token, handle, pctx } = await httpHarness(t);
  const res = await callHttp(handle, {
    method: 'POST',
    path: '/rules',
    token,
    body: { scope: 'project', text: '- V6 HTTP RULE from the web view' },
    origin: 'http://127.0.0.1:61784',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().rules.source, 'project');
  const logFile = pctx.paths.rulesLogFile;
  assert.equal(await exists(logFile), true);
  const lastLine = (await readFile(logFile, 'utf8')).trim().split(/\r?\n/).at(-1);
  assert.match(lastLine, /source=api/, `HTTP rules change must be audited as api: ${lastLine}`);
  assert.match(lastLine, /scope=project/);
});

// ---------------------------------------------------------------------------
// 5. No process.cwd() fallback when the working directory is unresolved
// ---------------------------------------------------------------------------

test('v6: unresolved working directory yields no-project and never writes process.cwd() memory', async (t) => {
  const env = await makeEnv(t);
  const { host, records, services } = trackingHost();
  services.tools = toolsService(records);
  services.systemPrompt = {};
  const agent = makeAgent(records, 'no-cwd-agent');
  services.agents = { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) };
  services.workingDirectory = { ensure: async () => undefined };

  const { result: plugin } = await withConsoleCapture(() => env.mods.index.createMemoryPlugin(host, { memoryRoot: env.memoryRoot }));
  assert.ok(plugin && plugin.runtime);

  const projectContext = await plugin.runtime.forAgent(agent);
  assert.equal(projectContext, undefined, 'forAgent must not fall back to process.cwd()');
  assert.equal(
    await exists(path.join(env.memoryRoot, 'projects')),
    false,
    'no project memory directory may be created from the Host process cwd',
  );

  const saveDefinition = records.tools.find((definition) => definition.name === 'memory_save');
  assert.ok(saveDefinition, 'memory_save must be registered');
  const saved = await saveDefinition.execute(
    { name: 'no cwd memory', type: 'user', description: 'd', content: 'c' },
    { agent },
  );
  assert.equal(saved.ok, false, `memory_save must fail without a project: ${JSON.stringify(saved)}`);
  assert.match(String(saved.error), /no-project/, `unexpected error: ${JSON.stringify(saved.error)}`);

  // injection must degrade quietly: a context may exist but its text stays empty.
  await sleep(120);
  for (const options of agent.contextCalls) {
    assert.equal(String(options?.text?.() ?? '').trim(), '', 'injection text must be empty when the project is unresolved');
  }
  await plugin.dispose();
});

// ---------------------------------------------------------------------------
// 6. Chinese search (CJK bigrams)
// ---------------------------------------------------------------------------

test('v6: store.search matches Chinese queries without spaces (single char + bigram)', async (t) => {
  const env = await makeEnv(t);
  const paths = env.mods.paths.buildPaths({ memoryRoot: env.memoryRoot, workspaceDir: env.workspaceDir });
  const store = new env.mods.store.MemoryStore({ paths, config: env.config });
  await store.ensure();
  await store.saveEntry({
    name: 'project-preference',
    type: 'project',
    description: '交流方式',
    content: '用户的偏好需要跨多个会话保持一致，回复以中文为主。',
  });

  const bigram = await store.search('跨会话');
  assert.ok(bigram.length >= 1, 'a 3-char Chinese query must match through its bigrams');
  assert.equal(bigram[0].file, 'project_project_preference.md');

  const twoChar = await store.search('会话');
  assert.ok(twoChar.length >= 1, 'a 2-char Chinese query must match');

  const singleChar = await store.search('跨');
  assert.ok(singleChar.length >= 1, 'a single Chinese character must match');

  const miss = await store.search('完全不存在的词汇');
  assert.deepEqual(miss, [], 'unrelated Chinese queries must return no hits');
});

// ---------------------------------------------------------------------------
// 7. client.js static guarantees + version consistency
// ---------------------------------------------------------------------------

test('v6: client.js has bridge/token banners with reload + markdown rendering, locale keys synced', async () => {
  const client = await readFile(path.join(PLUGIN_ROOT, 'client.js'), 'utf8');
  // v4 UI keys: the missing bridge is `banner.apiMissing` (read-only commands
  // fallback) or `banner.noBackend`; global switches are labelled by
  // `settings.switchesHint` ("these apply to every project").
  const keys = ['banner.apiMissing', 'banner.noBackend', 'banner.tokenExpired', 'btn.reload', 'settings.switchesHint'];
  for (const needle of [...keys, 'renderMarkdown']) {
    assert.equal(client.includes(needle), true, `client.js must reference ${needle}`);
  }

  const reloadIndex = client.indexOf('function reloadButton(');
  assert.notEqual(reloadIndex, -1, 'client.js must keep a shared reload button');
  const reloadBlock = client.slice(reloadIndex, reloadIndex + 600);
  assert.equal(reloadBlock.includes('window.location.reload'), true, 'the reload button must reload the page');
  assert.equal(reloadBlock.includes('btn.reload'), true, 'the reload button must be labelled');

  const bannersIndex = client.indexOf('// ---- banners');
  assert.notEqual(bannersIndex, -1, 'client.js must keep the degraded-mode banner branch');
  const bannersBlock = client.slice(bannersIndex, bannersIndex + 1500);
  assert.equal(bannersBlock.includes('banner.apiMissing'), true, 'a banner must explain a missing bridge');
  assert.equal(bannersBlock.includes('banner.tokenExpired'), true, 'a banner must explain a rotated token');
  assert.equal(bannersBlock.includes('reloadButton(t)'), true, 'degraded banners must offer a reload button');

  for (const localeName of ['en', 'zh']) {
    const localePath = path.join(PLUGIN_ROOT, 'locale', `${localeName}.json`);
    const locale = JSON.parse(await readFile(localePath, 'utf8'));
    for (const key of keys) {
      assert.equal(typeof locale[key], 'string', `${localeName}.json is missing ${key}`);
      assert.ok(locale[key].length > 0, `${localeName}.json key ${key} must not be empty`);
    }
  }
});

test('v6: meta.VERSION is a semver consistent with package.json and CHANGELOG', async () => {
  const { meta } = await modules();
  const pkg = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  assert.match(meta.VERSION, SEMVER, `VERSION must be semver, got ${meta.VERSION}`);
  assert.equal(meta.VERSION, pkg.version, 'meta.VERSION must come from package.json');
  const changelog = await readFile(path.join(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes(pkg.version), `CHANGELOG.md must document release ${pkg.version}`);
});
