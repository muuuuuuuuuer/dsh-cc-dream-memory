/**
 * v7 status service + HTTP endpoints + new slash commands.
 *
 * Covers FIXES-v7 contract §1:
 *   - createStatusService: status/file/rules/saveRules/resetRules/toggle/
 *     deleteFile/backups/trash/restore (whole batch, single file, trash restore,
 *     path-escape rejection);
 *   - HTTP: GET /backups|/trash, POST /restore, POST /dream preview/apply-ops,
 *     with token/loopback/Origin/plugin-disabled and invalid-indexes => 400;
 *   - commands: /memory backups|trash|restore|dream preview|dream apply-ops.
 *
 * Real runtime/store/state in os.tmpdir(); no LLM is invoked (plan files are
 * written by the test).
 */
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
      status: await loadModule('../src/status.js', { requireExports: ['createStatusService'] }),
      http: await loadModule('../src/http.js', { requireExports: ['createHttpHandler', 'API_PREFIX'] }),
      commands: await loadModule('../src/commands.js', { requireExports: ['registerCommands'] }),
    }))();
  }
  return modulesPromise;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

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
  const services = {
    workingDirectory: { ensure: async () => workspaceDir },
  };
  return {
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
  const host = fakeHost({ workspaceDir });
  const runtime = new mods.runtime.MemoryRuntime(host, config);
  const pctx = await runtime.storeFor(workspaceDir);
  const service = mods.status.createStatusService(runtime);
  const paths = mods.paths.buildPaths({ memoryRoot: config.memoryRoot, workspaceDir });
  return { mods, tmp, memoryRoot, workspaceDir, config, host, runtime, pctx, service, paths };
}

async function seedStatusEnv(t, configOverrides = {}) {
  const env = await makeEnv(t, configOverrides);
  await env.pctx.store.saveEntry({
    name: 'one',
    type: 'user',
    description: 'first note',
    content: 'first body',
    source: { sessionId: 'sess-1', via: 'tool:memory_save' },
  });
  return env;
}

/** One valid plan file used by preview/apply-ops tests. */
async function writePlan(env, plan) {
  const planDir = path.join(env.tmp, 'plans');
  await mkdir(planDir, { recursive: true });
  const planPath = path.join(planDir, `plan-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
  return planPath;
}

function memoryFileText(name, body) {
  return [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    'type: user',
    'modified: 2026-11-07T00:00:00.000Z',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// createStatusService
// ---------------------------------------------------------------------------

test('v7 status: service payload mirrors the HTTP status shape with provenance', async (t) => {
  const env = await seedStatusEnv(t);
  const status = await env.service.status(env.pctx, { sessionId: 'sess-1' });
  assert.equal(status.ok, true);
  assert.match(status.version, SEMVER);
  assert.equal(status.project.memoryDir, env.pctx.paths.memoryDir);
  assert.equal(status.config.enabled, true);
  assert.equal(typeof status.overrides, 'object');
  assert.equal(status.index.lines, 1);
  assert.equal(status.index.text.includes('first note') || status.index.text.includes('user_one'), true);
  assert.equal(status.entries.length, 1);
  assert.equal(status.entries[0].via, 'tool:memory_save');
  assert.equal(status.entries[0].sourceSession, 'sess-1');
  assert.match(status.entries[0].created, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(status.userScope.enabled, false);
  assert.equal(typeof status.changelogTail, 'string');
  assert.equal(status.trashCount, 0);
  assert.equal(status.rules.source, 'default');
  assert.equal(typeof status.health, 'object');
  assert.ok(Array.isArray(status.health.warnings));
  assert.equal(status.state.lastDreamDurationMs, 0, 'state exposes the v7 duration field');
});

test('v7 status: file/rules/saveRules/resetRules/toggle round-trip', async (t) => {
  const env = await seedStatusEnv(t);
  const file = await env.service.file(env.pctx, 'user_one.md', 'project');
  assert.equal(file.file, 'user_one.md');
  assert.equal(file.frontmatter.via, 'tool:memory_save');
  await assert.rejects(env.service.file(env.pctx, '', 'project'), (error) => {
    assert.equal(error.code, 'invalid-file');
    return true;
  });

  assert.equal((await env.service.rules(env.pctx)).source, 'default');
  const saved = await env.service.saveRules(env.pctx, 'project', '- V7 PROJECT RULE: verify first');
  assert.equal(saved.source, 'project');
  assert.match(saved.text, /V7 PROJECT RULE/);
  assert.equal(await exists(env.paths.projectRulesFile), true);

  const reset = await env.service.resetRules(env.pctx, 'project');
  assert.equal(reset.source, 'default');
  assert.equal(await exists(env.paths.projectRulesFile), false);

  await assert.rejects(env.service.saveRules(env.pctx, 'bogus', 'x'), (error) => {
    assert.equal(error.code, 'invalid-scope');
    return true;
  });

  const toggled = await env.service.toggle(env.runtime, { autoMemoryEnabled: false });
  assert.equal(toggled.overrides.autoMemoryEnabled, false);
  assert.equal(toggled.config.autoMemoryEnabled, false);
  assert.equal(env.runtime.config.autoMemoryEnabled, false);
  await assert.rejects(env.service.toggle(env.runtime, {}), (error) => {
    assert.equal(error.code, 'no-toggle-field');
    return true;
  });
  await env.service.toggle(env.runtime, { autoMemoryEnabled: true });
});

test('v7 status: rules go through secret scanning (warn / deny)', async (t) => {
  // v11 severity: generic assignment text is warn-level; format-specific keys
  // (AWS) are deny-level even when secretScan is warn.
  const warnRules = '- hint: api_key = abcdefghijklmnopqrstuvwxyz1234567890';
  const secretRules = '- leaked token: AKIAABCDEFGHIJKLMNOP';
  const warnEnv = await makeEnv(t, { secretScan: 'warn' });
  const warned = await warnEnv.service.saveRules(warnEnv.pctx, 'project', warnRules);
  assert.equal(warned.source, 'project');
  assert.ok(Array.isArray(warned.warnings) && warned.warnings.length > 0);
  assert.match(warned.warnings.join(' '), /secret-scan: rule/);
  assert.equal(await exists(warnEnv.paths.projectRulesFile), true, 'warn mode still writes the warn-level rules');
  await assert.rejects(warnEnv.service.saveRules(warnEnv.pctx, 'project', secretRules), (error) => {
    assert.equal(error.code, 'SECRET_DETECTED');
    return true;
  });

  const denyEnv = await makeEnv(t, { secretScan: 'deny' });
  await assert.rejects(denyEnv.service.saveRules(denyEnv.pctx, 'project', secretRules), (error) => {
    assert.equal(error.code, 'SECRET_DETECTED');
    assert.match(String(error.message), /secret/i);
    return true;
  });
  assert.equal(await exists(denyEnv.paths.projectRulesFile), false, 'deny mode must not write the rules');
});

test('v7 status: deleteFile is gated by dreamAllowDelete, trash lists, and trash restore moves the file back', async (t) => {
  const disabled = await seedStatusEnv(t, { dreamAllowDelete: false });
  await assert.rejects(disabled.service.deleteFile(disabled.pctx, 'user_one.md'), (error) => {
    assert.equal(error.code, 'delete-disabled');
    return true;
  });

  // v11: dreamAllowDelete defaults to true.
  const env = await seedStatusEnv(t);
  assert.equal(env.config.dreamAllowDelete, true);
  const deleted = await env.service.deleteFile(env.pctx, 'user_one.md', 'project');
  assert.equal(deleted.trashed, true);
  assert.equal(await exists(deleted.trashPath), true);
  const trashListing = await env.service.trash(env.pctx);
  assert.equal(trashListing.items.length, 1);
  const batch = trashListing.items[0];
  assert.ok(batch.id);
  assert.ok(batch.files.includes('user_one.md'));

  const restored = await env.service.restore(env.pctx, { kind: 'trash', id: batch.id });
  assert.deepEqual(restored.restored, ['user_one.md']);
  assert.equal(await exists(path.join(env.paths.memoryDir, 'user_one.md')), true, 'trash restore moves the file back');
  const audit = await env.pctx.store.auditIndex();
  assert.equal(audit.missing.length, 0, 'trash restore repairs the index');
  const remaining = await env.service.trash(env.pctx);
  for (const item of remaining.items) {
    assert.equal(item.files.includes('user_one.md'), false, 'the restored file must no longer be in the trash');
  }
});

test('v7 status: restore supports a whole backup, a single backup file, and rejects escapes', async (t) => {
  const env = await seedStatusEnv(t);
  const backupId = '2026-11-07T10-00-00';
  const backupDir = path.join(env.paths.dreamsDir, backupId);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, 'user_backup_a.md'), memoryFileText('backup a', 'A body'), 'utf8');
  await writeFile(path.join(backupDir, 'user_backup_b.md'), memoryFileText('backup b', 'B body'), 'utf8');

  const backups = await env.service.backups(env.pctx);
  assert.equal(backups.items.length, 1);
  assert.equal(backups.items[0].id, backupId);
  assert.deepEqual(backups.items[0].files, ['user_backup_a.md', 'user_backup_b.md']);

  // Whole backup.
  const whole = await env.service.restore(env.pctx, { kind: 'backup', id: backupId });
  assert.deepEqual(whole.restored.sort(), ['user_backup_a.md', 'user_backup_b.md']);
  assert.equal(await exists(path.join(env.paths.memoryDir, 'user_backup_a.md')), true);
  assert.equal(await exists(path.join(env.paths.memoryDir, 'user_backup_b.md')), true);
  const audit = await env.pctx.store.auditIndex();
  assert.equal(audit.missing.length, 0);

  // Single file restore.
  const single = await env.service.restore(env.pctx, {
    kind: 'backup',
    id: backupId,
    file: 'user_backup_a.md',
  });
  assert.deepEqual(single.restored, ['user_backup_a.md']);

  // Rejections.
  await assert.rejects(env.service.restore(env.pctx, { kind: 'nope', id: backupId }), (error) => {
    assert.equal(error.code, 'invalid-kind');
    return true;
  });
  for (const id of ['../evil', '..\\evil', '/abs', 'a/b']) {
    await assert.rejects(env.service.restore(env.pctx, { kind: 'backup', id }), (error) => {
      assert.equal(error.code, 'invalid-id', `restore id ${JSON.stringify(id)} must be rejected`);
      return true;
    });
  }
  await assert.rejects(env.service.restore(env.pctx, { kind: 'backup', id: 'missing-batch' }), (error) => {
    assert.equal(error.code, 'not-found');
    return true;
  });
  await assert.rejects(
    env.service.restore(env.pctx, { kind: 'backup', id: backupId, file: '../escape.md' }),
    (error) => {
      assert.equal(error.code, 'invalid-id');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// HTTP endpoints
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
  const headers = { host };
  if (token !== undefined) headers['x-cc-memory-token'] = token;
  if (origin !== undefined) headers.origin = origin;
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.url = `${http.API_PREFIX}${route}`;
  req.headers = headers;
  req.httpVersion = '1.1';
  req.socket = remoteAddress === undefined ? {} : { remoteAddress, remotePort: 50000 };
  const res = fakeRes();
  await handle(req, res);
  return res;
}

async function httpEnv(t, configOverrides = {}) {
  const env = await seedStatusEnv(t, configOverrides);
  const token = 'v7-status-token-abcdef';
  const handler = env.mods.http.createHttpHandler({ runtime: env.runtime, token });
  const handle = typeof handler === 'function' ? handler : handler.handle.bind(handler);
  return { ...env, token, handle };
}

test('v7 http: new backup/trash/restore endpoints work and stay authenticated', async (t) => {
  const env = await httpEnv(t);
  const backupId = '2026-11-07T10-00-00';
  const backupDir = path.join(env.paths.dreamsDir, backupId);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, 'user_http_backup.md'), memoryFileText('http backup', 'body'), 'utf8');
  await mkdir(path.join(env.paths.trashRoot, backupId), { recursive: true });
  await writeFile(path.join(env.paths.trashRoot, backupId, 'user_http_trash.md'), memoryFileText('http trash', 'body'), 'utf8');

  const backups = await callHttp(env.handle, { token: env.token, path: '/backups' });
  assert.equal(backups.statusCode, 200);
  assert.equal(backups.json().ok, true);
  assert.equal(backups.json().items[0].id, backupId);

  const trash = await callHttp(env.handle, { token: env.token, path: '/trash' });
  assert.equal(trash.statusCode, 200);
  assert.equal(trash.json().ok, true);
  assert.equal(trash.json().items[0].id, backupId);

  const restored = await callHttp(env.handle, {
    method: 'POST',
    path: '/restore',
    token: env.token,
    body: { kind: 'backup', id: backupId },
    origin: 'http://127.0.0.1:61784',
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().ok, true);
  assert.deepEqual(restored.json().restored, ['user_http_backup.md']);
  assert.equal(await exists(path.join(env.paths.memoryDir, 'user_http_backup.md')), true);

  const trashRestore = await callHttp(env.handle, {
    method: 'POST',
    path: '/restore',
    token: env.token,
    body: { kind: 'trash', id: backupId },
  });
  assert.equal(trashRestore.json().ok, true);
  assert.deepEqual(trashRestore.json().restored, ['user_http_trash.md']);
  assert.equal(await exists(path.join(env.paths.memoryDir, 'user_http_trash.md')), true);

  // Caller mistakes map to 400.
  const badKind = await callHttp(env.handle, {
    method: 'POST',
    path: '/restore',
    token: env.token,
    body: { kind: 'nope', id: backupId },
  });
  assert.equal(badKind.statusCode, 400);
  assert.equal(badKind.json().error, 'invalid-kind');

  const escape = await callHttp(env.handle, {
    method: 'POST',
    path: '/restore',
    token: env.token,
    body: { kind: 'backup', id: '../evil' },
  });
  assert.equal(escape.statusCode, 400);
  assert.equal(escape.json().error, 'invalid-id');

  // Security keeps working on the new endpoints.
  assert.equal((await callHttp(env.handle, { path: '/backups' })).statusCode, 401);
  assert.equal(
    (await callHttp(env.handle, { token: env.token, path: '/backups', remoteAddress: '10.0.0.5' })).statusCode,
    403,
  );
  const evilOrigin = await callHttp(env.handle, {
    method: 'POST',
    path: '/restore',
    token: env.token,
    body: { kind: 'backup', id: backupId },
    origin: 'https://evil.example',
  });
  assert.equal(evilOrigin.statusCode, 403);
  assert.equal(evilOrigin.json().error, 'bad-origin');
});

test('v7 http: dream preview and apply-ops endpoints use plan files; invalid indexes => 400', async (t) => {
  const env = await httpEnv(t);
  const plan = {
    summary: 'v7 preview plan',
    operations: [
      {
        op: 'write',
        scope: 'project',
        type: 'user',
        name: 'http plan note',
        description: 'planned note',
        body: 'planned body',
        file: 'user_http_plan_note.md',
      },
    ],
    sessions: [],
    truncatedFiles: [],
  };
  const planPath = await writePlan(env, plan);
  await env.pctx.state.setLastPlan(planPath, 'dry-run');

  const preview = await callHttp(env.handle, {
    method: 'POST',
    path: '/dream',
    token: env.token,
    body: { action: 'preview' },
    origin: 'http://127.0.0.1:61784',
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().ok, true);
  assert.equal(preview.json().result.path, planPath);
  assert.equal(preview.json().result.ops.length, 1);
  assert.equal(preview.json().result.ops[0].file, 'user_http_plan_note.md');
  assert.equal(preview.json().result.ops[0].changed, true);
  assert.equal(await exists(path.join(env.paths.memoryDir, 'user_http_plan_note.md')), false, 'preview is read-only');

  const applied = await callHttp(env.handle, {
    method: 'POST',
    path: '/dream',
    token: env.token,
    body: { action: 'apply-ops', indexes: [0] },
  });
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.json().ok, true);
  assert.equal(applied.json().result.applied, true);
  assert.equal(await exists(path.join(env.paths.memoryDir, 'user_http_plan_note.md')), true);
  assert.equal(env.pctx.state.snapshot().lastPlanPath, '', 'applying the plan clears lastPlanPath');

  const invalid = await callHttp(env.handle, {
    method: 'POST',
    path: '/dream',
    token: env.token,
    body: { action: 'apply-ops', indexes: [] },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, 'invalid-indexes');
});

test('v7 http: plugin-disabled blocks the new endpoints but keeps toggle alive', async (t) => {
  const env = await httpEnv(t, {});
  const off = await callHttp(env.handle, {
    method: 'POST',
    path: '/toggle',
    token: env.token,
    body: { enabled: false },
  });
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().config.enabled, false);

  for (const [route, method] of [
    ['/backups', 'GET'],
    ['/trash', 'GET'],
    ['/restore', 'POST'],
  ]) {
    const res = await callHttp(env.handle, { token: env.token, method, path: route, body: method === 'POST' ? {} : undefined });
    assert.equal(res.json().ok, false, `${method} ${route} must be refused while disabled`);
    assert.equal(res.json().error, 'plugin-disabled');
  }
  const dream = await callHttp(env.handle, {
    method: 'POST',
    path: '/dream',
    token: env.token,
    body: { action: 'preview' },
  });
  assert.equal(dream.json().error, 'plugin-disabled');

  const on = await callHttp(env.handle, {
    method: 'POST',
    path: '/toggle',
    token: env.token,
    body: { enabled: true },
  });
  assert.equal(on.json().config.enabled, true);
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandHarness(t, configOverrides = {}) {
  const env = await seedStatusEnv(t, configOverrides);
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
  const dispose = env.mods.commands.registerCommands(commandCtx, env.runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  const memory = definitions.get('memory');
  assert.ok(memory, '/memory command must be registered');
  const invoke = (rawInput) => memory.handler({ rawInput, agent: { id: 'agent-1' }, sessionId: 'session-1' });
  return { ...env, invoke };
}

test('v7 commands: backups/trash/restore list and restore batches', async (t) => {
  const env = await commandHarness(t, { dreamAllowDelete: true });
  const batchId = '2026-11-07T11-00-00';
  const backupDir = path.join(env.paths.dreamsDir, batchId);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, 'user_cmd_backup.md'), memoryFileText('cmd backup', 'body'), 'utf8');
  const trashDir = path.join(env.paths.trashRoot, batchId);
  await mkdir(trashDir, { recursive: true });
  await writeFile(path.join(trashDir, 'user_cmd_trash.md'), memoryFileText('cmd trash', 'body'), 'utf8');

  const backups = await env.invoke('backups');
  assert.equal(backups.kind, 'success', backups.text);
  assert.match(backups.text, new RegExp(batchId.replace(/[-]/g, '\\-')));

  const trash = await env.invoke('trash');
  assert.equal(trash.kind, 'success', trash.text);
  assert.match(trash.text, new RegExp(batchId.replace(/[-]/g, '\\-')));

  const backupRestore = await env.invoke(`restore backup ${batchId}`);
  assert.equal(backupRestore.kind, 'success', backupRestore.text);
  assert.match(backupRestore.text, /restor/i);
  assert.equal(await exists(path.join(env.paths.memoryDir, 'user_cmd_backup.md')), true);

  const trashRestore = await env.invoke(`restore trash ${batchId}`);
  assert.equal(trashRestore.kind, 'success', trashRestore.text);
  assert.equal(await exists(path.join(env.paths.memoryDir, 'user_cmd_trash.md')), true);

  const usage = await env.invoke('restore');
  assert.equal(usage.kind, 'error', 'restore without arguments must fail with usage');
});

test('dream preview shows the quote behind each new statement', async (t) => {
  const env = await commandHarness(t);
  const planPath = await writePlan(env, {
    summary: 'quoted plan',
    operations: [
      {
        op: 'write',
        scope: 'project',
        type: 'feedback',
        name: 'handoff notes',
        description: 'conclusion first',
        body: 'Handoff notes lead with the conclusion.',
        file: 'feedback_handoff_notes.md',
        evidence: [{ statement: 'Handoff notes lead with the conclusion.', quote: 'I want the conclusion first' }],
      },
    ],
    sessions: [],
    truncatedFiles: [],
  });
  await env.pctx.state.setLastPlan(planPath, 'dry-run');

  const preview = await env.invoke('dream preview');
  assert.equal(preview.kind, 'success', preview.text);
  assert.match(preview.text, /quote: "I want the conclusion first"/);
});

test('v7 commands: dream preview and dream apply-ops execute plan subsets', async (t) => {
  const env = await commandHarness(t);
  const plan = {
    summary: 'v7 command plan',
    operations: [
      {
        op: 'write',
        scope: 'project',
        type: 'user',
        name: 'command plan note',
        description: 'planned',
        body: 'command planned body',
        file: 'user_command_plan_note.md',
      },
    ],
    sessions: [],
    truncatedFiles: [],
  };
  const planPath = await writePlan(env, plan);
  await env.pctx.state.setLastPlan(planPath, 'dry-run');

  const preview = await env.invoke('dream preview');
  assert.equal(preview.kind, 'success', preview.text);
  assert.match(preview.text, /user_command_plan_note\.md/);
  assert.match(preview.text, /preview/i);

  const apply = await env.invoke('dream apply-ops 0');
  assert.equal(apply.kind, 'success', apply.text);
  assert.equal(await exists(path.join(env.paths.memoryDir, 'user_command_plan_note.md')), true);
  assert.equal(env.pctx.state.snapshot().lastPlanPath, '');

  const badIndex = await env.invoke('dream apply-ops 99');
  assert.match(badIndex.text, /invalid-indexes|not applied/i, 'an out-of-range operation index must be reported');
});
