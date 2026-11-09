/**
 * v3 regression tests (FIXES-v3.md): editable rules, runtime overrides,
 * silent HTTP status API, plugin toggle semantics and the new commands.
 *
 * The HTTP handler is exercised directly through `createHttpHandler` with fake
 * req/res objects, so no real web server or host service is needed. Every
 * runtime/store instance points at an os.tmpdir() memory root (the real
 * `~/.dsh` is never touched).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadModule, makeTempDir } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Module loading / fixtures
// ---------------------------------------------------------------------------

let modulesPromise;

function v3() {
  if (!modulesPromise) {
    modulesPromise = (async () => ({
      config: await loadModule('../src/config.js', { requireExports: ['resolveConfig'] }),
      paths: await loadModule('../src/paths.js', { requireExports: ['buildPaths'] }),
      store: await loadModule('../src/store.js', { requireExports: ['MemoryStore'] }),
      state: await loadModule('../src/state.js', { requireExports: ['ProjectState'] }),
      runtime: await loadModule('../src/runtime.js', { requireExports: ['MemoryRuntime'] }),
      rules: await loadModule('../src/rules.js', { requireExports: ['DEFAULT_RULES'] }),
      inject: await loadModule('../src/inject.js', { requireExports: ['buildInjectionText', 'registerInjection'] }),
      http: await loadModule('../src/http.js', { requireExports: ['createHttpHandler'] }),
      tools: await loadModule('../src/tools.js', { requireExports: ['registerTools'] }),
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

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real MemoryRuntime over a throwaway memory root with a no-service fake ctx
 * (`get()` returns undefined), plus the matching paths and one project context.
 */
async function runtimeSetup(t, { configOverrides = {}, withProject = true } = {}) {
  const mods = await v3();
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'memory-root');
  const homeDir = path.join(tmp, 'home');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const baseConfig = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const ctx = { get: (name) => (name === 'workingDirectory' ? { ensure: async () => workspaceDir } : undefined) };
  const runtime = new mods.runtime.MemoryRuntime(ctx, baseConfig);
  const paths = mods.paths.buildPaths({ memoryRoot: baseConfig.memoryRoot, homeDir, workspaceDir });
  const pctx = withProject ? await runtime.storeFor(workspaceDir) : undefined;
  return { mods, tmp, memoryRoot, homeDir, workspaceDir, baseConfig, ctx, runtime, paths, pctx };
}

// ---------------------------------------------------------------------------
// 1. Editable rules: priority, injection replacement, truncation, saveRules
// ---------------------------------------------------------------------------

test('rules: default block is injected when neither override file exists', async (t) => {
  const { runtime, pctx, paths, mods } = await runtimeSetup(t);
  const rules = runtime.rulesFor(pctx);
  assert.equal(rules.source, 'default');
  assert.equal(rules.text.trim(), mods.rules.DEFAULT_RULES.trim(), 'default rules must come from src/rules.js');
  assert.equal(rules.projectPath, paths.projectRulesFile);
  assert.equal(rules.globalPath, paths.globalRulesFile);
  assert.equal(typeof rules.maxChars, 'number');
  assert.ok(rules.maxChars > 0);
});

test('rules: global file overrides the default and project file wins over global', async (t) => {
  const { runtime, pctx, paths } = await runtimeSetup(t);
  await writeFile(paths.globalRulesFile, '- GLOBAL RULE: save durable facts only\n', 'utf8');
  const globalRules = runtime.rulesFor(pctx);
  assert.equal(globalRules.source, 'global');
  assert.match(globalRules.text, /GLOBAL RULE/);

  await writeFile(paths.projectRulesFile, '- PROJECT RULE: this repo only\n', 'utf8');
  const projectRules = runtime.rulesFor(pctx);
  assert.equal(projectRules.source, 'project');
  assert.match(projectRules.text, /PROJECT RULE/);
  assert.doesNotMatch(projectRules.text, /GLOBAL RULE/);

  // A blank project file must fall back to global instead of injecting an empty Rules section.
  await writeFile(paths.projectRulesFile, '   \n\n', 'utf8');
  const fallback = runtime.rulesFor(pctx);
  assert.equal(fallback.source, 'global');
  assert.match(fallback.text, /GLOBAL RULE/);
});

test('rules: over-long rules text is truncated to maxChars', async (t) => {
  const { runtime, pctx, paths } = await runtimeSetup(t);
  const long = Array.from({ length: 900 }, (_, index) => `- rule ${index}: keep this line`).join('\n');
  await writeFile(paths.projectRulesFile, long, 'utf8');
  const rules = runtime.rulesFor(pctx);
  assert.equal(rules.source, 'project');
  assert.ok(rules.text.length <= rules.maxChars, `rules text (${rules.text.length}) must be <= maxChars (${rules.maxChars})`);
  assert.equal(rules.truncated, true, 'truncated flag must be set when the file exceeds maxChars');
  assert.ok(rules.maxChars <= 8000, 'default rules cap is 8000 characters');
});

test('rules: saveRules writes the override file and rulesFor reads it back', async (t) => {
  const { runtime, pctx, paths } = await runtimeSetup(t);
  const projectRules = await runtime.saveRules(pctx, 'project', '- custom project rule A\n- custom project rule B');
  assert.equal(projectRules.source, 'project');
  assert.match(projectRules.text, /custom project rule A/);
  assert.match(projectRules.text, /custom project rule B/);
  assert.equal(await exists(paths.projectRulesFile), true, 'project rules file must be written');
  const onDisk = await readFile(paths.projectRulesFile, 'utf8');
  assert.match(onDisk, /custom project rule A/);
  assert.equal(runtime.rulesFor(pctx).source, 'project');

  const globalRules = await runtime.saveRules(pctx, 'global', '- custom global rule');
  assert.equal(globalRules.source, 'project', 'the project override still wins after saving global rules');
  assert.match(await readFile(paths.globalRulesFile, 'utf8'), /custom global rule/);
});

test('rules: buildInjectionText replaces the built-in Rules section with input.rules', async (t) => {
  await runtimeSetup(t);
  const { buildInjectionText } = (await v3()).inject;
  const custom = '- CUSTOM RULE A: only durable knowledge\n- CUSTOM RULE B: verify before relying';
  const text = buildInjectionText({
    memoryDir: 'C:/tmp/memory',
    config: { injectIndex: false },
    rules: custom,
  });
  assert.match(text, /Rules:/);
  assert.match(text, /CUSTOM RULE A/);
  assert.match(text, /CUSTOM RULE B/);
  assert.doesNotMatch(
    text,
    /Save only durable knowledge that is NOT derivable/,
    'built-in default rules must be replaced by the custom rules',
  );

  // Without input.rules the built-in block stays exactly as before.
  const builtin = buildInjectionText({ memoryDir: 'C:/tmp/memory', config: { injectIndex: false } });
  assert.match(builtin, /Save only durable knowledge that is NOT derivable/);
});

// ---------------------------------------------------------------------------
// 2. Runtime overrides: atomic persistence, merge getter, corruption fallback
// ---------------------------------------------------------------------------

test('overrides: setOverrides persists atomically and runtime.config merges them', async (t) => {
  const { runtime, paths, baseConfig, mods } = await runtimeSetup(t);
  assert.deepEqual(runtime.overrides(), {}, 'no overrides before the file exists');
  assert.equal(runtime.config.enabled, baseConfig.enabled);

  const first = await runtime.setOverrides({ enabled: false });
  assert.equal(first.enabled, false);
  assert.deepEqual(runtime.overrides(), { enabled: false });
  assert.equal(runtime.config.enabled, false, 'runtime.config must reflect the enabled override');
  assert.equal(baseConfig.enabled, true, 'the base config object must not be mutated');
  assert.equal(Object.isFrozen(runtime.config), true, 'runtime.config must be frozen');

  const stateFile = paths.pluginStateFile;
  assert.equal(await exists(stateFile), true, 'plugin state file must be written');
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { enabled: false });
  const leftovers = (await readdir(path.dirname(stateFile))).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'atomic write must not leave temporary files behind');

  const merged = await runtime.setOverrides({ autoMemoryEnabled: false, autoDreamEnabled: true });
  assert.deepEqual(merged, { enabled: false, autoMemoryEnabled: false, autoDreamEnabled: true });
  assert.equal(runtime.config.autoMemoryEnabled, false);
  assert.equal(runtime.config.autoDreamEnabled, true);
  assert.equal(runtime.effectiveEnabled(), false, 'effectiveEnabled follows the enabled override');
  await runtime.setOverrides({ enabled: true });
  assert.equal(runtime.effectiveEnabled(), true);

  // A new runtime instance sees the persisted overrides.
  const { MemoryRuntime } = mods.runtime;
  const second = new MemoryRuntime({ get: () => undefined }, baseConfig);
  assert.equal(second.overrides().autoMemoryEnabled, false);
  assert.equal(second.config.autoMemoryEnabled, false);
});

test('overrides: a corrupt plugin state file falls back to an empty override set', async (t) => {
  const { runtime, paths, mods, baseConfig } = await runtimeSetup(t);
  await runtime.setOverrides({ enabled: false });
  await writeFile(paths.pluginStateFile, '{ this is not json', 'utf8');

  const { MemoryRuntime } = mods.runtime;
  const fresh = new MemoryRuntime({ get: () => undefined }, baseConfig);
  assert.deepEqual(fresh.overrides(), {}, 'corrupt state must degrade to no overrides');
  assert.equal(fresh.config.enabled, baseConfig.enabled, 'base config applies when overrides are unreadable');
});

test('overrides: setOverrides invalidates every known injection cache', async (t) => {
  const { runtime } = await runtimeSetup(t, { withProject: false });
  const seen = [];
  runtime.onInvalidate((info) => seen.push(info));
  await runtime.forAgent({ id: 'agent-known' });
  await runtime.setOverrides({ enabled: false });
  assert.ok(
    seen.some((info) => info.sessionId === 'agent-known'),
    `invalidateAllInjections must notify known sessions, saw ${JSON.stringify(seen)}`,
  );
});

// ---------------------------------------------------------------------------
// 3. enabled:false semantics: no injection context, write tools disabled
// ---------------------------------------------------------------------------

test('enabled:false: no memory text is injected, enabled:true injects the index block', async (t) => {
  const mods = await v3();
  const { runtime, baseConfig, workspaceDir } = await runtimeSetup(t, { configOverrides: { enabled: false }, withProject: false });

  function fakeAgent(record) {
    return {
      id: 'agent-injection',
      ctx: {
        systemPrompt: {
          context(options) {
            record.push(options);
            return () => {};
          },
        },
      },
    };
  }

  // The agents service is resolved through ctx.get('agents') or ctx.agents; keep
  // the fake ctx minimal but service-shaped.
  const disabledCalls = [];
  const disabledCtx = {
    agents: { list: () => [fakeAgent(disabledCalls)] },
    on: () => () => {},
  };
  const disposeDisabled = mods.inject.registerInjection(disabledCtx, runtime);
  await tick(150);
  const disabledTexts = disabledCalls.map((options) => String(options?.text?.() ?? '').trim()).filter((text) => text !== '');
  assert.deepEqual(disabledTexts, [], `enabled:false must not inject any memory text, got: ${disabledTexts.join(' | ')}`);
  for (const options of disabledCalls) assert.equal(options.name, 'cc-memory');
  if (typeof disposeDisabled === 'function') disposeDisabled();

  const enabledRuntime = new mods.runtime.MemoryRuntime(
    { get: (name) => (name === 'workingDirectory' ? { ensure: async () => workspaceDir } : undefined) },
    mods.config.resolveConfig({ memoryRoot: baseConfig.memoryRoot, enabled: true }),
  );
  const enabledCalls = [];
  const enabledCtx = {
    agents: { list: () => [fakeAgent(enabledCalls)] },
    on: () => () => {},
  };
  const disposeEnabled = mods.inject.registerInjection(enabledCtx, enabledRuntime);
  await tick(250);
  assert.equal(enabledCalls.length, 1, 'enabled:true must register the cc-memory prompt context');
  assert.equal(enabledCalls[0].name, 'cc-memory');
  assert.equal(enabledCalls[0].required, false);
  const injected = String(enabledCalls[0].text?.() ?? '');
  assert.match(injected, /<system-reminder>/, 'enabled:true must inject the system reminder block');
  assert.match(injected, /Rules:/, 'enabled:true must inject the rules block');
  if (typeof disposeEnabled === 'function') disposeEnabled();
});

test('enabled:false: write tools refuse, read tools still work', async (t) => {
  const mods = await v3();
  const { runtime } = await runtimeSetup(t, { configOverrides: { enabled: false }, withProject: false });
  const definitions = new Map();
  const toolCtx = {
    tools: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => {};
      },
    },
  };
  const dispose = mods.tools.registerTools(toolCtx, runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  const exec = { agent: { id: 'agent-tools' } };
  const save = definitions.get('memory_save');
  assert.ok(save, 'registerTools must register memory_save');
  const result = await save.execute(
    { name: 'disabled note', type: 'user', description: 'd', content: 'c' },
    exec,
  );
  assert.equal(result.ok, false, `write tool must be refused while disabled: ${JSON.stringify(result)}`);
  assert.match(String(result.error), /disabled/, `unexpected error ${JSON.stringify(result.error)}`);

  // v11: the read tools that remain are memory_read/memory_search.
  const read = definitions.get('memory_read');
  assert.ok(read, 'registerTools must register memory_read');
  const listed = await read.execute({ file: 'user_missing.md' }, exec);
  assert.match(String(listed.error ?? ''), /not.found|disabled/i, `read tool must keep working while disabled: ${JSON.stringify(listed)}`);
});

// ---------------------------------------------------------------------------
// 4. HTTP API through createHttpHandler
// ---------------------------------------------------------------------------

async function httpSetup(t, { configOverrides = {} } = {}) {
  const mods = await v3();
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const runtime = new mods.runtime.MemoryRuntime({ get: (name) => (name === 'workingDirectory' ? { ensure: async () => workspaceDir } : undefined) }, config);
  const pctx = await runtime.storeFor(workspaceDir);
  await pctx.store.saveEntry({ name: 'alpha', type: 'user', description: 'alpha note', content: 'alpha body' });
  await pctx.store.writeChangelog('## 2026-11-07T00:00:00.000Z\n- trigger: manual, rollback: false\n');
  const token = 'test-token-abc123';
  const handler = mods.http.createHttpHandler({ runtime, token });
  const handle = typeof handler === 'function' ? handler : handler.handle.bind(handler);
  return { mods, tmp, memoryRoot, workspaceDir, config, runtime, pctx, token, handle };
}

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    finished: false,
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
      this.finished = true;
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
  res.json = () => {
    const text = res.bodyText();
    return text === '' ? undefined : JSON.parse(text);
  };
  return res;
}

async function callHttp(handle, { method = 'GET', path: urlPath = '/status', token, body, rawBody, headers = {} } = {}) {
  // The handler serves the `/api/cc-memory` prefix it exports; tests use routes.
  const { http } = await v3();
  const prefix = typeof http.API_PREFIX === 'string' ? http.API_PREFIX : '/api/cc-memory';
  const fullPath = String(urlPath).startsWith(`${prefix}/`) ? String(urlPath) : `${prefix}${urlPath}`;
  const requestHeaders = { host: '127.0.0.1:61784', ...headers };
  if (token !== undefined) requestHeaders['x-cc-memory-token'] = token;
  let payload;
  if (rawBody !== undefined) payload = [Buffer.from(rawBody)];
  else if (body !== undefined) payload = [Buffer.from(JSON.stringify(body))];
  else payload = [];
  const req = Readable.from(payload);
  req.method = method;
  req.url = fullPath;
  req.headers = requestHeaders;
  req.httpVersion = '1.1';
  req.socket = { remoteAddress: '127.0.0.1', remotePort: 50000 };
  const res = fakeRes();
  await handle(req, res);
  return res;
}

function assertJsonHeaders(res) {
  assert.match(String(res.getHeader('content-type') ?? ''), /application\/json/, 'responses must be JSON');
  assert.equal(res.getHeader('cache-control'), 'no-store', 'responses must not be cached');
}

test('http: requests without a valid token get 401', async (t) => {
  const { handle } = await httpSetup(t);
  const missing = await callHttp(handle, { path: '/status' });
  assert.equal(missing.statusCode, 401);
  assert.deepEqual(missing.json(), { ok: false, error: 'unauthorized' });
  assertJsonHeaders(missing);

  const wrong = await callHttp(handle, { path: '/status', token: 'wrong-token' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error, 'unauthorized');
});

test('http: GET /status returns the documented status shape', async (t) => {
  const { handle, token, pctx } = await httpSetup(t);
  const res = await callHttp(handle, { token, path: '/status' });
  assert.equal(res.statusCode, 200);
  assertJsonHeaders(res);
  const body = res.json();
  assert.equal(body.ok, true);

  assert.equal(typeof body.project.memoryDir, 'string');
  assert.equal(body.project.memoryDir, pctx.paths.memoryDir);
  assert.equal(typeof body.project.projectRoot, 'string');

  for (const key of [
    'enabled',
    'autoMemoryEnabled',
    'autoDreamEnabled',
    'dreamMode',
    'indexMaxLines',
    'indexMaxBytes',
    'dreamAllowDelete',
    'userMemoryEnabled',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(body.config, key), `status.config.${key} is missing`);
  }
  assert.equal(body.config.enabled, true);
  assert.equal(typeof body.overrides, 'object');
  for (const key of ['text', 'lines', 'bytes', 'truncated', 'overflow']) {
    assert.ok(Object.prototype.hasOwnProperty.call(body.index, key), `status.index.${key} is missing`);
  }
  assert.ok(Array.isArray(body.entries));
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].file, 'user_alpha.md');
  assert.equal(body.entries[0].name, 'alpha');
  assert.equal(typeof body.userScope, 'object');
  assert.equal(body.userScope.enabled, false);
  assert.ok(Array.isArray(body.userScope.entries));

  for (const key of [
    'lastDreamAt',
    'lastDreamAttemptAt',
    'lastDreamSummary',
    'lastDreamSessions',
    'lastDreamOps',
    'lastDreamMode',
    'lastPlanPath',
    'pendingProposal',
    'lastError',
    'consecutiveFailures',
    'counters',
    'sessionsSince',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(body.state, key), `status.state.${key} is missing`);
  }
  assert.equal(typeof body.changelogTail, 'string');
  assert.match(body.changelogTail, /trigger: manual/);
  assert.equal(typeof body.trashCount, 'number');
  assert.equal(body.trashCount, 0);

  assert.equal(typeof body.rules, 'object');
  for (const key of ['text', 'source', 'projectPath', 'globalPath', 'maxChars']) {
    assert.ok(Object.prototype.hasOwnProperty.call(body.rules, key), `status.rules.${key} is missing`);
  }
  assert.equal(body.rules.source, 'default');
  assert.equal(body.rules.projectPath, pctx.paths.projectRulesFile);
  assert.equal(body.rules.globalPath, pctx.paths.globalRulesFile);
});

test('http: GET /file, /rules and /log return the expected payloads', async (t) => {
  const { handle, token } = await httpSetup(t);

  const file = await callHttp(handle, { token, path: '/file?file=user_alpha.md' });
  assert.equal(file.statusCode, 200);
  const fileBody = file.json();
  assert.equal(fileBody.ok, true);
  assert.equal(fileBody.file, 'user_alpha.md');
  assert.equal(fileBody.scope, 'project');
  assert.equal(fileBody.frontmatter.name, 'alpha');
  assert.match(fileBody.body, /alpha body/);

  const rules = await callHttp(handle, { token, path: '/rules' });
  assert.equal(rules.statusCode, 200);
  const rulesBody = rules.json();
  assert.equal(rulesBody.ok, true);
  assert.equal(rulesBody.rules.source, 'default');
  assert.ok(String(rulesBody.rules.text).length > 0);

  const log = await callHttp(handle, { token, path: '/log?lines=5' });
  assert.equal(log.statusCode, 200);
  const logBody = log.json();
  assert.equal(logBody.ok, true);
  assert.equal(typeof logBody.tail, 'string');
  assert.match(logBody.tail, /trigger: manual/);
});

test('http: POST /toggle updates overrides and /status reflects the new config', async (t) => {
  const { handle, token, runtime } = await httpSetup(t);
  const toggled = await callHttp(handle, {
    method: 'POST',
    path: '/toggle',
    token,
    body: { autoMemoryEnabled: false, autoDreamEnabled: true },
  });
  assert.equal(toggled.statusCode, 200);
  const toggledBody = toggled.json();
  assert.equal(toggledBody.ok, true);
  assert.equal(toggledBody.overrides.autoMemoryEnabled, false);
  assert.equal(toggledBody.overrides.autoDreamEnabled, true);
  assert.equal(toggledBody.config.autoMemoryEnabled, false);
  assert.equal(toggledBody.config.autoDreamEnabled, true);
  assert.equal(runtime.overrides().autoMemoryEnabled, false, 'toggle must persist into runtime overrides');

  const status = (await callHttp(handle, { token, path: '/status' })).json();
  assert.equal(status.config.autoMemoryEnabled, false);
  assert.equal(status.config.autoDreamEnabled, true);
  assert.equal(status.overrides.autoMemoryEnabled, false);

  // Plugin-level toggle: /status must stay available when the plugin is off.
  const pluginOff = await callHttp(handle, { method: 'POST', path: '/toggle', token, body: { enabled: false } });
  assert.equal(pluginOff.statusCode, 200);
  assert.equal(pluginOff.json().config.enabled, false);
  const statusDisabled = await callHttp(handle, { token, path: '/status' });
  assert.equal(statusDisabled.statusCode, 200);
  assert.equal(statusDisabled.json().ok, true);
  assert.equal(statusDisabled.json().config.enabled, false);
});

test('http: plugin-disabled rejects every endpoint except /status and /toggle', async (t) => {
  const { handle, token } = await httpSetup(t);
  await callHttp(handle, { method: 'POST', path: '/toggle', token, body: { enabled: false } });

  const status = await callHttp(handle, { token, path: '/status' });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().config.enabled, false);

  const dream = await callHttp(handle, { method: 'POST', path: '/dream', token, body: { action: 'dry-run' } });
  assert.equal(dream.json().ok, false);
  assert.equal(dream.json().error, 'plugin-disabled');

  const file = await callHttp(handle, { token, path: '/file?file=user_alpha.md' });
  assert.equal(file.json().ok, false);
  assert.equal(file.json().error, 'plugin-disabled');

  const reenable = await callHttp(handle, { method: 'POST', path: '/toggle', token, body: { enabled: true } });
  assert.equal(reenable.statusCode, 200);
  assert.equal(reenable.json().config.enabled, true);
});

test('http: POST /rules writes the rules file and changes the reported source', async (t) => {
  const { handle, token, pctx } = await httpSetup(t);
  const text = '- PROJECT RULE from HTTP: save durable facts\n- second line';
  const saved = await callHttp(handle, { method: 'POST', path: '/rules', token, body: { scope: 'project', text } });
  assert.equal(saved.statusCode, 200);
  const savedBody = saved.json();
  assert.equal(savedBody.ok, true);
  assert.equal(savedBody.rules.source, 'project');
  assert.match(savedBody.rules.text, /PROJECT RULE from HTTP/);
  assert.equal(await exists(pctx.paths.projectRulesFile), true);
  assert.match(await readFile(pctx.paths.projectRulesFile, 'utf8'), /PROJECT RULE from HTTP/);

  const rules = (await callHttp(handle, { token, path: '/rules' })).json();
  assert.equal(rules.rules.source, 'project');
  const status = (await callHttp(handle, { token, path: '/status' })).json();
  assert.equal(status.rules.source, 'project');

  const globalSaved = await callHttp(handle, {
    method: 'POST',
    path: '/rules',
    token,
    body: { scope: 'global', text: '- GLOBAL RULE from HTTP' },
  });
  assert.equal(globalSaved.json().ok, true);
  assert.match(await readFile(pctx.paths.globalRulesFile, 'utf8'), /GLOBAL RULE from HTTP/);
  assert.equal((await callHttp(handle, { token, path: '/rules' })).json().rules.source, 'project');
});

test('http: POST /dream rejects unknown actions with 400', async (t) => {
  const { handle, token } = await httpSetup(t);
  const res = await callHttp(handle, { method: 'POST', path: '/dream', token, body: { action: 'bogus-action' } });
  assert.equal(res.statusCode, 400, 'unknown dream action must be a 400');
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(typeof body.error, 'string');
});

test('http: POST /delete respects dreamAllowDelete and trashes when enabled', async (t) => {
  const disabled = await httpSetup(t, { configOverrides: { dreamAllowDelete: false } });
  const refused = await callHttp(disabled.handle, {
    method: 'POST',
    path: '/delete',
    token: disabled.token,
    body: { file: 'user_alpha.md' },
  });
  assert.equal(refused.json().ok, false);
  assert.equal(refused.json().error, 'delete-disabled');
  assert.equal(await exists(path.join(disabled.pctx.paths.memoryDir, 'user_alpha.md')), true);

  // v11: dreamAllowDelete defaults to true, so the default setup deletes.
  const enabled = await httpSetup(t);
  assert.equal(enabled.config.dreamAllowDelete, true);
  const deleted = await callHttp(enabled.handle, {
    method: 'POST',
    path: '/delete',
    token: enabled.token,
    body: { file: 'user_alpha.md' },
  });
  const body = deleted.json();
  assert.equal(body.ok, true);
  assert.equal(body.trashed, true);
  assert.equal(typeof body.trashPath, 'string');
  assert.equal(await exists(body.trashPath), true);
  assert.equal(await exists(path.join(enabled.pctx.paths.memoryDir, 'user_alpha.md')), false);
  const status = (await callHttp(enabled.handle, { token: enabled.token, path: '/status' })).json();
  assert.ok(status.trashCount >= 1, `trashCount should count the trashed entry, got ${status.trashCount}`);
});

test('http: malformed JSON bodies are rejected with 400', async (t) => {
  const { handle, token, pctx } = await httpSetup(t);
  const res = await callHttp(handle, {
    method: 'POST',
    path: '/toggle',
    token,
    rawBody: '{ not valid json ',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().ok, false);
});

// ---------------------------------------------------------------------------
// 5. Commands: /memory plugin on|off and /memory rules
// ---------------------------------------------------------------------------

/** Register the real commands module against a real runtime and fake ctx. */
async function commandHarness(t) {
  const { runtime, pctx, config, mods } = await runtimeSetup(t);
  const definitions = new Map();
  const commandCtx = {
    commands: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name);
      },
    },
    get: () => undefined,
    on: () => () => {},
    effect: (factory) => (typeof factory === 'function' ? factory() : undefined),
  };
  const dispose = mods.commands.registerCommands(commandCtx, runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  const memory = definitions.get('memory');
  assert.ok(memory, 'registerCommands must register /memory');
  return { runtime, pctx, config, definitions, memory };
}

test('commands: /memory plugin on|off writes the enabled override', async (t) => {
  const { runtime, memory } = await commandHarness(t);
  const invocation = { rawInput: 'plugin off', agent: { id: 'agent-cmd' }, sessionId: 'session-cmd' };

  const off = await memory.handler(invocation);
  assert.equal(off.kind, 'success', `plugin off failed: ${off.text}`);
  assert.equal(runtime.overrides().enabled, false, '/memory plugin off must persist enabled:false');

  const on = await memory.handler({ ...invocation, rawInput: 'plugin on' });
  assert.equal(on.kind, 'success', `plugin on failed: ${on.text}`);
  assert.equal(runtime.overrides().enabled, true, '/memory plugin on must persist enabled:true');
});

test('commands: /memory rules reports the active source and paths', async (t) => {
  const { runtime, memory } = await commandHarness(t);
  // The command handler resolves its own project context through forAgent; save
  // the rules into that same context so the command sees the project override.
  const commandPctx = await runtime.forAgent({ id: 'agent-cmd' });
  assert.ok(commandPctx, 'forAgent must resolve the command project context');
  await runtime.saveRules(commandPctx, 'project', '- COMMAND RULE: project specific');
  const result = await memory.handler({ rawInput: 'rules', agent: { id: 'agent-cmd' }, sessionId: 'session-cmd' });
  assert.equal(result.kind, 'success', `/memory rules failed: ${result.text}`);
  assert.match(result.text, /project/i, 'output must name the active source');
  assert.match(result.text, /COMMAND RULE/, 'output must show the active rules text');
  assert.match(result.text, /memory-rules\.md/, 'output must show the rule file paths');
});
