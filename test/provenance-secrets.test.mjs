/**
 * v7 provenance + secret scan.
 *
 * FIXES-v7 搂2/搂3:
 *   - frontmatter provenance (created / source_session / via) written by store
 *     writes, preserved on update, tolerated on legacy four-field files;
 *   - via attribution: tools (`tool:memory_save|update`), `/remember`
 *     (`command:/remember`), dream writes (`dream`);
 *   - secrets: scanSecrets rules/excerpts, config modes warn/deny/off, store and
 *     tool and rules enforcement, dream write drop (deny) / warnings (warn).
 *
 * Real store/state/runtime in os.tmpdir(); no LLM is called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
      tools: await loadModule('../src/tools.js', { requireExports: ['registerTools'] }),
      commands: await loadModule('../src/commands.js', { requireExports: ['registerCommands'] }),
      secrets: await loadModule('../src/secrets.js', {
        requireExports: ['scanSecrets', 'secretScanMode', 'secretWarnings', 'SECRET_DETECTED', 'EXCERPT_CHARS'],
      }),
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
  return { mods, tmp, memoryRoot, workspaceDir, config, paths, store };
}

async function runtimeEnv(t, configOverrides = {}) {
  const env = await makeEnv(t, configOverrides);
  const host = fakeHost({ workspaceDir: env.workspaceDir });
  const runtime = new env.mods.runtime.MemoryRuntime(host, env.config);
  const pctx = await runtime.storeFor(env.workspaceDir);
  return { ...env, host, runtime, pctx };
}

/** One plan file wired as the current dry-run plan. */
async function writePlan(env, plan) {
  const planPath = path.join(env.tmp, `plan-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
  await env.pctx.state.setLastPlan(planPath, 'dry-run');
  return planPath;
}

const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';
// v11 severity model: format-specific keys (AWS, sk-ant, ...) are deny-level;
// generic assignment / high-entropy matches stay warn-level.
const WARN_SECRET = 'api_key = abcdefghijklmnopqrstuvwxyz1234567890';

function planWithWrite({ file, body, name = 'secret note' }) {
  return {
    summary: 'secret scan plan',
    operations: [
      {
        op: 'write',
        scope: 'project',
        type: 'user',
        name,
        description: 'secret scan note',
        body,
        ...(file ? { file } : {}),
      },
    ],
    sessions: [],
    truncatedFiles: [],
  };
}

// ---------------------------------------------------------------------------
// Provenance: store layer
// ---------------------------------------------------------------------------

test('v7 provenance: store writes created/source_session/via, update keeps created', async (t) => {
  const env = await makeEnv(t);
  const saved = await env.store.saveEntry({
    name: 'prov note',
    type: 'user',
    description: 'provenance note',
    content: 'first body',
    source: { sessionId: 'sess-abc', via: 'tool:memory_save' },
  });
  assert.equal(saved.ok, true);
  const first = await env.store.readEntry(saved.file);
  assert.equal(first.frontmatter.via, 'tool:memory_save');
  assert.equal(first.frontmatter.source_session, 'sess-abc');
  assert.match(first.frontmatter.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  const createdBefore = first.frontmatter.created;

  const meta = (await env.store.listEntries()).find((entry) => entry.file === saved.file);
  assert.equal(meta.via, 'tool:memory_save');
  assert.equal(meta.sourceSession, 'sess-abc');
  assert.equal(meta.created, createdBefore);

  await env.store.updateEntry(saved.file, {
    content: 'second body',
    source: { sessionId: 'sess-def', via: 'tool:memory_update' },
  });
  const updated = await env.store.readEntry(saved.file);
  assert.equal(updated.frontmatter.created, createdBefore, 'created must be the first-write timestamp');
  assert.equal(updated.frontmatter.via, 'tool:memory_update');
  assert.equal(updated.frontmatter.source_session, 'sess-def', 'the latest session wins');

  // A raw legacy four-field file stays readable and still gains created on update.
  await writeFile(
    path.join(env.paths.memoryDir, 'user_legacy.md'),
    [
      '---',
      'name: legacy',
      'description: old file',
      'type: user',
      'modified: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      'legacy body',
      '',
    ].join('\n'),
    'utf8',
  );
  const legacy = await env.store.readEntry('user_legacy.md');
  assert.equal(legacy.frontmatter.via, '');
  assert.equal(legacy.frontmatter.created, '');
  await env.store.updateEntry('user_legacy.md', {
    content: 'legacy body v2',
    source: { via: 'tool:memory_update' },
  });
  const legacyUpdated = await env.store.readEntry('user_legacy.md');
  assert.match(legacyUpdated.frontmatter.created, /^\d{4}-\d{2}-\d{2}T/, 'created is set on first attributed update');
  assert.equal(legacyUpdated.frontmatter.via, 'tool:memory_update');
});

// ---------------------------------------------------------------------------
// Provenance: tools / remember / dream
// ---------------------------------------------------------------------------

test('v7 provenance: memory_save/memory_update tools attribute via tool:memory_*', async (t) => {
  const env = await runtimeEnv(t);
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

  const save = definitions.get('memory_save');
  assert.ok(save);
  // v9 write policy queues short/low-confidence bodies; force a real write so
  // the provenance attribution is what this test exercises.
  const saved = await save.execute(
    { name: 'tool note', type: 'user', description: 'tool note', content: 'tool body', force: true },
    { agent: { id: 'agent-1' }, sessionId: 'sess-tool' },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const entry = (await env.pctx.store.listEntries()).find((item) => item.name === 'tool note');
  assert.ok(entry);
  assert.equal(entry.via, 'tool:memory_save');
  assert.equal(entry.sourceSession, 'sess-tool');

  const update = definitions.get('memory_update');
  assert.ok(update);
  const updated = await update.execute(
    { file: entry.file, content: 'tool body v2', force: true },
    { agent: { id: 'agent-1' }, sessionId: 'sess-tool-2' },
  );
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const afterUpdate = await env.pctx.store.readEntry(entry.file);
  assert.equal(afterUpdate.frontmatter.via, 'tool:memory_update');
  assert.equal(afterUpdate.frontmatter.source_session, 'sess-tool-2');

  // v11: memory_delete is no longer a model tool; the human path (status
  // service / UI / HTTP) still soft-deletes through the trash.
  const deleteEnv = await runtimeEnv(t);
  assert.equal(deleteEnv.config.dreamAllowDelete, true, 'v11 enables delete by default');
  const statusMod = await loadModule('../src/status.js', { requireExports: ['createStatusService'] });
  const deleteService = statusMod.createStatusService(deleteEnv.runtime);
  const seed = await deleteEnv.pctx.store.saveEntry({
    name: 'delete me',
    type: 'user',
    description: 'to trash',
    content: 'trash body',
  });
  const deleteResult = await deleteService.deleteFile(deleteEnv.pctx, seed.file, 'project');
  assert.equal(deleteResult.trashed, true, JSON.stringify(deleteResult));
  assert.equal(typeof deleteResult.trashPath, 'string');
  assert.equal(await exists(path.join(deleteEnv.pctx.paths.memoryDir, seed.file)), false);
});

test('v7 provenance: /remember attributes command:/remember', async (t) => {
  const env = await runtimeEnv(t);
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
  const remember = definitions.get('remember');
  assert.ok(remember);
  const result = await remember.handler({
    rawInput: '鎴戠殑鍋忓ソ鏄敤涓枃鍥炲',
    agent: { id: 'agent-remember' },
    sessionId: 'session-remember',
  });
  assert.equal(result.kind, 'success', result.text);
  const pctx = await env.runtime.forAgent({ id: 'agent-remember' });
  const entry = (await pctx.store.listEntries())[0];
  assert.ok(entry, 'the remember command must save one entry');
  assert.equal(entry.via, 'command:/remember');
  assert.equal(entry.sourceSession, 'agent-remember');
});

test('v7 provenance: dream-applied writes are attributed via:dream', async (t) => {
  const env = await runtimeEnv(t);
  await writePlan(env, planWithWrite({ file: 'user_dream_prov.md', body: 'dream attributed body' }));
  const result = await env.runtime.applyPlanOperations(env.pctx, { indexes: [0] });
  assert.equal(result.applied, true, JSON.stringify(result));
  const read = await env.pctx.store.readEntry('user_dream_prov.md');
  assert.equal(read.frontmatter.via, 'dream');
  assert.equal(read.frontmatter.source_session, '', 'dream writes carry no session attribution');
});

// ---------------------------------------------------------------------------
// Secret scanning: pure module
// ---------------------------------------------------------------------------

test('v7 secrets: scanSecrets detects the documented shapes with <=12 char excerpts', async (t) => {
  await makeEnv(t); // ensure the module cache is warm / temp dir cleanup registered
  const { scanSecrets, secretScanMode, secretWarnings, EXCERPT_CHARS, SECRET_DETECTED } = (await modules()).secrets;
  assert.equal(EXCERPT_CHARS, 12);
  assert.equal(SECRET_DETECTED, 'SECRET_DETECTED');

  const cases = [
    [`AKIA${'ABCDEFGHIJKLMNOP'}`, 'aws-access-key'],
    ['sk-' + 'a'.repeat(24), 'openai-key'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private-key-block'],
    ['ghp_' + 'a'.repeat(36), 'github-token'],
    ['xoxb-123456789012345', 'slack-token'],
    ['Bearer abcdefghijklmnop', 'bearer-token'],
    ['password: supersecret123', 'secret-assignment'],
    ['AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/ab', 'high-entropy-base64'],
  ];
  for (const [text, rule] of cases) {
    const { matches } = scanSecrets(`prefix ${text} suffix`);
    assert.ok(matches.length >= 1, `expected a match for ${rule}`);
    const match = matches.find((item) => item.rule === rule);
    assert.ok(match, `expected rule ${rule} in ${JSON.stringify(matches.map((m) => m.rule))}`);
    assert.ok(match.excerpt.length <= 12, `excerpt must be <= 12 chars, got ${match.excerpt.length}`);
    assert.equal(text.includes(match.excerpt), true);
    const warnings = secretWarnings([match]);
    assert.match(warnings[0], /^secret-scan: rule /);
    assert.match(warnings[0], /鈥??$/);
  }
  assert.deepEqual(scanSecrets('just normal prose about gardening').matches, []);
  assert.equal(secretScanMode(undefined), 'warn');
  assert.equal(secretScanMode({ secretScan: 'deny' }), 'deny');
  assert.equal(secretScanMode({ secretScan: 'off' }), 'off');
  assert.equal(secretScanMode({ secretScan: 'bogus' }), 'warn');
});

test('v7 secrets: config defaults to warn and validates the mode', async (t) => {
  const env = await makeEnv(t);
  assert.equal(env.config.secretScan, 'warn');
  assert.equal(env.mods.config.resolveConfig({ secretScan: 'deny' }).secretScan, 'deny');
  assert.equal(env.mods.config.resolveConfig({ secretScan: 'off' }).secretScan, 'off');
  assert.equal(env.mods.config.resolveConfig({ secretScan: 'nope' }).secretScan, 'warn');
});

// ---------------------------------------------------------------------------
// Secret scanning: store / tools / dream enforcement
// ---------------------------------------------------------------------------

test('v7 secrets: warn mode writes warn-level matches, deny-level keys always refuse', async (t) => {
  // v11: the format-specific AWS key is deny-level even when secretScan is warn.
  const denyContent = `leaked credential: ${AWS_KEY} end`;
  const warnContent = `config file: ${WARN_SECRET} end`;

  const warnEnv = await makeEnv(t, { secretScan: 'warn' });
  const warned = await warnEnv.store.saveEntry({ name: 'warn note', type: 'user', description: 'd', content: warnContent });
  assert.equal(warned.ok, true);
  assert.ok(Array.isArray(warned.warnings) && warned.warnings.length > 0);
  assert.match(warned.warnings.join(' '), /secret-scan: rule secret-assignment/);
  assert.equal(await exists(path.join(warnEnv.paths.memoryDir, warned.file)), true, 'warn-level matches still write');
  await assert.rejects(
    warnEnv.store.saveEntry({ name: 'warn deny note', type: 'user', description: 'd', content: denyContent }),
    (error) => {
      assert.equal(error.code, 'SECRET_DETECTED');
      return true;
    },
    'a deny-level key is refused even in warn mode',
  );

  const denyEnv = await makeEnv(t, { secretScan: 'deny' });
  await assert.rejects(denyEnv.store.saveEntry({ name: 'deny note', type: 'user', description: 'd', content: denyContent }), (error) => {
    assert.equal(error.code, 'SECRET_DETECTED');
    return true;
  });
  assert.deepEqual(await denyEnv.store.listEntries(), [], 'deny mode must not create the file');

  const benign = await denyEnv.store.saveEntry({ name: 'benign note', type: 'user', description: 'd', content: 'plain body' });
  await assert.rejects(denyEnv.store.updateEntry(benign.file, { content: denyContent }), (error) => {
    assert.equal(error.code, 'SECRET_DETECTED');
    return true;
  });
  await assert.rejects(
    denyEnv.store.writeRawEntry('user_deny_raw.md', {
      type: 'user',
      name: 'deny raw',
      description: 'd',
      body: denyContent,
    }),
    (error) => {
      assert.equal(error.code, 'SECRET_DETECTED');
      return true;
    },
  );
  assert.equal(await exists(path.join(denyEnv.paths.memoryDir, 'user_deny_raw.md')), false);

  const offEnv = await makeEnv(t, { secretScan: 'off' });
  const skipped = await offEnv.store.saveEntry({ name: 'off note', type: 'user', description: 'd', content: denyContent });
  assert.equal(skipped.ok, true, 'off mode skips even deny-level matches');
  assert.equal(skipped.warnings, undefined, 'off mode adds no warnings');
});

test('v7 secrets: memory tools surface deny/warn results without leaking the secret', async (t) => {
  const denyEnv = await runtimeEnv(t, { secretScan: 'deny' });
  const denyDefs = new Map();
  const denyDispose = denyEnv.mods.tools.registerTools(
    { tools: { register: (definition) => (denyDefs.set(definition.name, definition), () => {}) } },
    denyEnv.runtime,
  );
  t.after(() => denyDispose?.());
  const denied = await denyDefs.get('memory_save').execute(
    { name: 'secret tool note', type: 'user', description: 'd', content: `key ${AWS_KEY}` },
    { agent: { id: 'agent-1' }, sessionId: 'sess-1' },
  );
  assert.equal(denied.ok, false);
  assert.match(String(denied.error), /secret/i);
  assert.equal(JSON.stringify(denied).includes(AWS_KEY), false, 'the full secret must never be echoed');
  assert.deepEqual(await denyEnv.pctx.store.listEntries(), []);

  const warnEnv = await runtimeEnv(t, { secretScan: 'warn' });
  const warnDefs = new Map();
  const warnDispose = warnEnv.mods.tools.registerTools(
    { tools: { register: (definition) => (warnDefs.set(definition.name, definition), () => {}) } },
    warnEnv.runtime,
  );
  t.after(() => warnDispose?.());
  const warned = await warnDefs.get('memory_save').execute(
    { name: 'warn tool note', type: 'user', description: 'd', content: `config: ${WARN_SECRET}` },
    { agent: { id: 'agent-1' }, sessionId: 'sess-1' },
  );
  assert.equal(warned.ok, true, JSON.stringify(warned));
  assert.ok(Array.isArray(warned.warnings) && warned.warnings.length > 0);
  assert.match(warned.warnings.join(' '), /secret-assignment|secret-scan/);
  assert.equal(JSON.stringify(warned).includes(WARN_SECRET), false, 'warnings only expose the 12-char excerpt');

  // A deny-level key is refused even in warn mode (v11 severity model).
  const refused = await warnDefs.get('memory_save').execute(
    { name: 'warn deny tool note', type: 'user', description: 'd', content: `key ${AWS_KEY}` },
    { agent: { id: 'agent-1' }, sessionId: 'sess-1' },
  );
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.match(String(refused.error), /secret/i);
  assert.equal(JSON.stringify(refused).includes(AWS_KEY), false);
});

test('v7 secrets: dream writes are dropped on deny and warned on warn', async (t) => {
  const denied = await runtimeEnv(t, { secretScan: 'deny' });
  await writePlan(denied, planWithWrite({ file: 'user_dream_secret.md', body: `dream key ${AWS_KEY}` }));
  const deniedResult = await denied.runtime.applyPlanOperations(denied.pctx, { indexes: [0] });
  assert.equal(deniedResult.applied, false, JSON.stringify(deniedResult));
  assert.ok(Array.isArray(deniedResult.dropped));
  assert.match(deniedResult.dropped.join(' '), /secret/i);
  assert.equal(await exists(path.join(denied.pctx.paths.memoryDir, 'user_dream_secret.md')), false);

  const warned = await runtimeEnv(t, { secretScan: 'warn' });
  await writePlan(warned, planWithWrite({ file: 'user_dream_secret.md', body: `dream config ${WARN_SECRET}` }));
  const warnedResult = await warned.runtime.applyPlanOperations(warned.pctx, { indexes: [0] });
  assert.equal(warnedResult.applied, true, JSON.stringify(warnedResult));
  assert.ok(Array.isArray(warnedResult.warnings) && warnedResult.warnings.length > 0);
  assert.match(warnedResult.warnings.join(' '), /secret-scan/);
  assert.equal(await exists(path.join(warned.pctx.paths.memoryDir, 'user_dream_secret.md')), true);

  // A deny-level key is dropped even in warn mode.
  const warnedDeny = await runtimeEnv(t, { secretScan: 'warn' });
  await writePlan(warnedDeny, planWithWrite({ file: 'user_dream_deny.md', body: `dream key ${AWS_KEY}` }));
  const warnedDenyResult = await warnedDeny.runtime.applyPlanOperations(warnedDeny.pctx, { indexes: [0] });
  assert.equal(warnedDenyResult.applied, false, JSON.stringify(warnedDenyResult));
  assert.match(warnedDenyResult.dropped.join(' '), /secret/i);
  assert.equal(await exists(path.join(warnedDeny.pctx.paths.memoryDir, 'user_dream_deny.md')), false);

  const off = await runtimeEnv(t, { secretScan: 'off' });
  await writePlan(off, planWithWrite({ file: 'user_dream_secret.md', body: `dream key ${AWS_KEY}` }));
  const offResult = await off.runtime.applyPlanOperations(off.pctx, { indexes: [0] });
  assert.equal(offResult.applied, true, JSON.stringify(offResult));
  assert.equal(offResult.warnings, undefined);
});
