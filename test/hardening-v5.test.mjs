/**
 * v5 hardening tests (plugin-ness + update safety):
 *   1. only `tools` + `systemPrompt` are hard dependencies; missing optional
 *      services degrade one capability instead of throwing out of `apply()`;
 *   2. dispose/reload leaves no listener, tool, command, prompt context or
 *      `runtime.getInjectedText` behind, and repeats cleanly;
 *   3. `/status` and `memory_status` report a semver `version` and a `health`
 *      block whose warnings fire for overlong rules / last dream error /
 *      missing optional services;
 *   4. corrupt state / override / rules data degrades to defaults, unknown
 *      config keys are ignored, `DATA_SCHEMA` exists;
 *   5. package version is 0.4.0 and CHANGELOG.md documents it.
 *
 * Everything runs against fake Host contexts and os.tmpdir() memory roots.
 */
import { withCordis } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PLUGIN_ROOT, loadModule, makeTempDir } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Module loading / helpers
// ---------------------------------------------------------------------------

let modulesPromise;

function modules() {
  if (!modulesPromise) {
    modulesPromise = (async () => ({
      index: await loadModule('../index.js', { requireExports: ['apply', 'inject'] }),
      meta: await loadModule('../src/meta.js', { requireExports: ['VERSION', 'DATA_SCHEMA', 'buildHealth'] }),
      config: await loadModule('../src/config.js', { requireExports: ['resolveConfig'] }),
      paths: await loadModule('../src/paths.js', { requireExports: ['buildPaths'] }),
      state: await loadModule('../src/state.js', { requireExports: ['ProjectState'] }),
      runtime: await loadModule('../src/runtime.js', { requireExports: ['MemoryRuntime'] }),
      inject: await loadModule('../src/inject.js', { requireExports: ['registerInjection'] }),
      tools: await loadModule('../src/tools.js', { requireExports: ['registerTools'] }),
      http: await loadModule('../src/http.js', { requireExports: ['createHttpHandler'] }),
    }))();
  }
  return modulesPromise;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
// v11: the model-facing tool surface is trimmed to four tools.
const TOOL_NAMES = ['memory_read', 'memory_save', 'memory_search', 'memory_update'];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
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

/** Create a temp memory root + workspace + resolved config. */
async function makeEnv(t, configOverrides = {}) {
  const mods = await modules();
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  return { mods, tmp, memoryRoot, workspaceDir, config };
}

/** Run `fn` while capturing console.warn/info. */
function withCapturedConsole(fn) {
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
    fn();
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
  return { warnings, infos };
}

/**
 * Fake Cordis plugin context: services through get(), a listener registry with
 * unsubscribe handles, and effect() collecting cleanup functions like the Host.
 */
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
      return () => set.delete(handler);
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

function makeAgent(records, id, { withPrompt = true } = {}) {
  const services = {};
  const agent = { id, ctx: withCordis(services) };
  if (withPrompt) {
    services.systemPrompt = {
      context(options) {
        records.promptRegistrations.push({ agentId: id, options });
        return () => {
          records.promptDisposers.push(id);
        };
      },
    };
  }
  return agent;
}

function pendingListenerCount(records) {
  let total = 0;
  for (const set of records.listeners.values()) total += set.size;
  return total;
}

function disposeEffects(records) {
  for (const dispose of records.effects.splice(0)) {
    if (typeof dispose === 'function') dispose();
  }
}

// ---------------------------------------------------------------------------
// 1. Minimal host: only tools + systemPrompt are required
// ---------------------------------------------------------------------------

test('v5: inject list is reduced to tools + systemPrompt', async () => {
  const { index } = await modules();
  assert.deepEqual(index.inject, ['tools', 'systemPrompt']);
});

test('v5: apply() mounts with only the hard services and degrades the rest', async (t) => {
  const env = await makeEnv(t);
  const { host, records, services } = trackingHost({});
  services.tools = toolsService(records);
  services.systemPrompt = { context: () => () => {} };

  const { warnings } = withCapturedConsole(() => {
    assert.doesNotThrow(() => env.mods.index.apply(host, { memoryRoot: env.memoryRoot }));
  });
  t.after(() => disposeEffects(records));

  const names = records.tools.map((definition) => definition.name).sort();
  assert.deepEqual(
    names.filter((name) => name.startsWith('memory_')),
    [...TOOL_NAMES].sort(),
    'the four memory tools must register while the tools service is available',
  );
  assert.equal(records.commands.length, 0, 'no commands service => /memory commands are not registered (no throw)');
  assert.ok(pendingListenerCount(records) > 0, 'prompt injection must still register its listeners');
  assert.ok(records.listeners.has('agent/created'), 'injection registers the agent/created listener');
  assert.ok(records.listeners.has('session/event'), 'injection registers the session/event (compaction) listener');
  assert.equal(
    warnings.some((warning) => /command/i.test(warning)),
    true,
    `missing commands service should be logged, warnings: ${JSON.stringify(warnings)}`,
  );
  assert.equal(
    warnings.some((warning) => /web/i.test(warning)),
    true,
    `missing webServer should degrade the HTTP API with a warning, warnings: ${JSON.stringify(warnings)}`,
  );
});

test('v5: a missing systemPrompt degrades injection without throwing', async (t) => {
  const env = await makeEnv(t);
  const { host, records, services } = trackingHost({});
  services.tools = toolsService(records);
  const noPromptAgent = makeAgent(records, 'agent-no-prompt', { withPrompt: false });
  services.agents = {
    list: () => [noPromptAgent],
    get: (id) => (id === noPromptAgent.id ? noPromptAgent : undefined),
  };
  // No workingDirectory either: the runtime falls back to process.cwd() but the
  // memory root is a temp dir, so nothing real is touched.

  const { warnings } = withCapturedConsole(() => {
    assert.doesNotThrow(() => env.mods.index.apply(host, { memoryRoot: env.memoryRoot }));
  });
  t.after(() => disposeEffects(records));

  assert.equal(records.tools.length, 4, 'the memory tools must still mount');
  assert.equal(records.promptRegistrations.length, 0, 'agents without systemPrompt get no injection context');
  assert.equal(
    warnings.some((warning) => /systemPrompt|agent context/i.test(warning)),
    true,
    `the degraded injection should be logged, warnings: ${JSON.stringify(warnings)}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Dispose is complete and repeatable
// ---------------------------------------------------------------------------

test('v5: dispose removes tools/commands/prompt/listeners and repeats cleanly', async (t) => {
  const env = await makeEnv(t);
  const { host, records, services } = trackingHost({});
  services.tools = toolsService(records);
  services.systemPrompt = {};
  services.commands = commandsService(records);
  const agent = makeAgent(records, 'agent-dispose');
  services.agents = {
    list: () => [agent],
    get: (id) => (id === agent.id ? agent : undefined),
  };
  services.workingDirectory = { ensure: async () => env.workspaceDir };

  // createMemoryPlugin() exposes an awaitable dispose(), so the test can wait
  // for in-flight background writes before the temp dir cleanup runs.
  let plugin = null;
  withCapturedConsole(() => {
    plugin = env.mods.index.createMemoryPlugin(host, { memoryRoot: env.memoryRoot });
  });
  await waitFor(() => records.promptRegistrations.length === 1);

  assert.ok(plugin && typeof plugin.dispose === 'function');
  assert.equal(records.tools.length, 4);
  assert.equal(records.commands.length, 3, '/memory, /remember and /dream (short alias) must be registered');
  assert.ok(pendingListenerCount(records) > 0);

  await assert.doesNotReject(() => plugin.dispose(), 'first dispose must not throw');
  assert.equal(records.toolDisposers.length, 4, 'every tool registration disposer must run');
  assert.equal(records.commandDisposers.length, 3, 'every command registration disposer must run');
  assert.equal(records.promptDisposers.length, 1, 'the systemPrompt context disposer must run');
  assert.equal(pendingListenerCount(records), 0, 'every event listener must be removed on dispose');

  // Idempotent dispose: a second unload (no registrations left) must be a no-op.
  await assert.doesNotReject(() => plugin.dispose());

  // Double mount + double dispose must stay exception-free.
  let pluginA = null;
  let pluginB = null;
  withCapturedConsole(() => {
    pluginA = env.mods.index.createMemoryPlugin(host, { memoryRoot: env.memoryRoot });
    pluginB = env.mods.index.createMemoryPlugin(host, { memoryRoot: env.memoryRoot });
  });
  await waitFor(() => records.promptRegistrations.length === 3);
  await assert.doesNotReject(() => pluginA.dispose());
  await assert.doesNotReject(() => pluginB.dispose());
  await assert.doesNotReject(() => pluginA.dispose());
  assert.equal(pendingListenerCount(records), 0, 'no listeners may survive a double mount/dispose cycle');
  assert.equal(records.toolDisposers.length, records.tools.length, 'all tool disposers ran across mounts');
});

test('v5: injection disposer removes runtime.getInjectedText and its listeners', async (t) => {
  const env = await makeEnv(t);
  const { host, records, services } = trackingHost({});
  services.workingDirectory = { ensure: async () => env.workspaceDir };

  const runtime = new env.mods.runtime.MemoryRuntime(host, env.config);
  const dispose = env.mods.inject.registerInjection(host, runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });

  assert.equal(typeof runtime.getInjectedText, 'function', 'injection exposes runtime.getInjectedText');
  assert.ok(pendingListenerCount(records) > 0);
  dispose();
  assert.equal(runtime.getInjectedText, undefined, 'dispose must delete runtime.getInjectedText');
  assert.equal(pendingListenerCount(records), 0, 'dispose must remove every injection listener');
});

// ---------------------------------------------------------------------------
// 3. Version + health on HTTP /status and memory_status
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

async function callHttp(handle, { method = 'GET', path: route = '/status', token, body } = {}) {
  const { http } = await modules();
  const prefix = typeof http.API_PREFIX === 'string' ? http.API_PREFIX : '/api/cc-memory';
  const headers = { host: '127.0.0.1:61784' };
  if (token !== undefined) headers['x-cc-memory-token'] = token;
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.url = `${prefix}${route}`;
  req.headers = headers;
  req.httpVersion = '1.1';
  req.socket = { remoteAddress: '127.0.0.1', remotePort: 50000 };
  const res = fakeRes();
  await handle(req, res);
  return res;
}

test('v5: HTTP /status reports semver version + health; bad rules/lastError raise warnings', async (t) => {
  const env = await makeEnv(t);
  const { host, services } = trackingHost({});
  services.workingDirectory = { ensure: async () => env.workspaceDir };
  const runtime = new env.mods.runtime.MemoryRuntime(host, env.config);
  const pctx = await runtime.storeFor(env.workspaceDir);

  // Overlong rules override (>8000 chars) => rules truncated warning.
  const longRules = `${Array.from({ length: 900 }, (_, index) => `- v5 rule line ${index}`).join('\n')}\n`;
  await writeFile(pctx.paths.projectRulesFile, longRules, 'utf8');
  await pctx.state.markDreamFailed('v5 simulated dream failure');

  const token = 'v5-token';
  const handler = env.mods.http.createHttpHandler({ runtime, token });
  const handle = typeof handler === 'function' ? handler : handler.handle.bind(handler);
  const res = await callHttp(handle, { token, path: '/status' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.match(body.version, SEMVER, `status.version must be semver, got ${body.version}`);
  assert.equal(body.version, env.mods.meta.VERSION, 'HTTP status version must match meta.VERSION');

  assert.equal(typeof body.health, 'object');
  assert.equal(body.health.ok, false, 'health must be not-ok with warnings present');
  assert.ok(Array.isArray(body.health.warnings) && body.health.warnings.length > 0);
  assert.ok(
    body.health.warnings.some((warning) => /rules/i.test(warning)),
    `health must warn about truncated rules: ${JSON.stringify(body.health.warnings)}`,
  );
  assert.ok(
    body.health.warnings.some((warning) => /dream|error/i.test(warning)),
    `health must warn about the last dream error: ${JSON.stringify(body.health.warnings)}`,
  );
  assert.equal(typeof body.health.services, 'object');
  for (const name of ['commands', 'agents', 'workingDirectory', 'webServer']) {
    assert.equal(typeof body.health.services[name], 'boolean', `health.services.${name} must be a boolean`);
  }
  assert.equal(body.health.services.workingDirectory, true, 'the fake host exposes workingDirectory here');
  assert.equal(body.health.services.commands, false, 'the fake host has no commands service');
  assert.equal(body.health.version, env.mods.meta.VERSION);
  assert.equal(body.health.dataSchema, env.mods.meta.DATA_SCHEMA);

  assert.equal(body.rules.source, 'project');
  assert.equal(body.rules.truncated, true, 'overlong project rules are reported as truncated');
});

test('v5: the status service returns version/health/rules and previews the editable rules', async (t) => {
  const env = await makeEnv(t);
  const { host, records, services } = trackingHost({});
  services.workingDirectory = { ensure: async () => env.workspaceDir };
  const runtime = new env.mods.runtime.MemoryRuntime(host, env.config);
  const pctx = await runtime.storeFor(env.workspaceDir);
  const customRule = '- V5 CUSTOM RULE: verify memory before relying on it';
  await writeFile(pctx.paths.projectRulesFile, `${customRule}\n`, 'utf8');
  await pctx.state.markDreamFailed('v5 memory_status failure');

  services.tools = toolsService(records);
  const dispose = env.mods.tools.registerTools(host, runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  // v11: memory_status is no longer a model tool; the same payload is served
  // by the status service (and the /status HTTP endpoint).
  assert.equal(records.tools.some((definition) => definition.name === 'memory_status'), false);
  const statusMod = await loadModule('../src/status.js', { requireExports: ['createStatusService'] });
  const service = statusMod.createStatusService(runtime);
  const result = await service.status(pctx);
  assert.equal(result.ok, true, `status failed: ${JSON.stringify(result).slice(0, 300)}`);
  assert.match(result.version, SEMVER);
  assert.equal(result.version, env.mods.meta.VERSION);
  assert.equal(typeof result.health, 'object');
  assert.ok(Array.isArray(result.health.warnings));
  assert.equal(result.health.ok, false, 'overlong-corrupt state => health warnings');
  assert.equal(result.rules.source, 'project');
  const rulesPreview = JSON.stringify(result.rules) + JSON.stringify(result.injection ?? {});
  assert.match(rulesPreview, /V5 CUSTOM RULE/, 'the status payload previews the editable rules');
  assert.doesNotThrow(() => JSON.stringify(result), 'the status payload must be lossless JSON');
});

// ---------------------------------------------------------------------------
// 4. Update compatibility: unknown config keys, corrupt data files
// ---------------------------------------------------------------------------

test('v5: unknown config keys are ignored; DATA_SCHEMA exists', async (t) => {
  const env = await makeEnv(t);
  const withUnknown = env.mods.config.resolveConfig({
    memoryRoot: env.memoryRoot,
    unknownFutureKey: 'ignored',
    anotherOne: 42,
    minHours: 7,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(withUnknown, 'unknownFutureKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(withUnknown, 'anotherOne'), false);
  assert.equal(withUnknown.minHours, 7, 'known keys still apply next to unknown ones');
  assert.deepEqual(
    env.mods.config.resolveConfig({ memoryRoot: env.memoryRoot, unknownFutureKey: 'ignored' }),
    env.mods.config.resolveConfig({ memoryRoot: env.memoryRoot }),
    'unknown keys must not shift any default',
  );
  assert.equal(env.mods.meta.DATA_SCHEMA, 1, 'DATA_SCHEMA constant must exist');
});

test('v5: corrupt state / override / rules data degrade to defaults without throwing', async (t) => {
  const env = await makeEnv(t);
  const paths = env.mods.paths.buildPaths({ memoryRoot: env.memoryRoot, workspaceDir: env.workspaceDir });
  await mkdir(path.dirname(paths.stateFile), { recursive: true });

  // Corrupt state file -> default snapshot.
  await writeFile(paths.stateFile, '{ this is not json', 'utf8');
  const state = new env.mods.state.ProjectState(paths);
  await assert.doesNotReject(() => state.load());
  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.sessionsSince, []);
  assert.equal(snapshot.lastDreamAt, 0);
  assert.equal(snapshot.lastError, '');

  // Corrupt override file -> empty overrides, base config still applies.
  await writeFile(paths.pluginStateFile, 'not-json-at-all', 'utf8');
  const runtime = new env.mods.runtime.MemoryRuntime({ get: () => undefined }, env.config);
  assert.deepEqual(runtime.overrides(), {}, 'corrupt overrides must degrade to {}');
  assert.equal(runtime.config.enabled, true);

  // Unreadable rules path (a directory) -> falls back to the default rules.
  const pctx = await runtime.storeFor(env.workspaceDir);
  await mkdir(paths.projectRulesFile, { recursive: true });
  let rules;
  assert.doesNotThrow(() => {
    rules = runtime.rulesFor(pctx);
  });
  assert.equal(rules.source, 'default', 'unreadable project rules fall back to no rules at all');
  assert.equal(rules.text, '', 'the built-in behaviour manual is gone');
});

// ---------------------------------------------------------------------------
// 5. Package version + CHANGELOG
// ---------------------------------------------------------------------------

test('v5: package version is semver and CHANGELOG documents it', async () => {
  const { meta } = await modules();
  const pkg = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.version, SEMVER, `package.json version must be semver, got ${pkg.version}`);
  assert.equal(meta.VERSION, pkg.version, 'meta.VERSION must come from package.json');

  const changelogPath = path.join(PLUGIN_ROOT, 'CHANGELOG.md');
  assert.equal(await exists(changelogPath), true, 'CHANGELOG.md must exist');
  const changelog = await readFile(changelogPath, 'utf8');
  assert.ok(
    changelog.includes(pkg.version),
    `CHANGELOG.md must document the current release ${pkg.version}`,
  );
});
