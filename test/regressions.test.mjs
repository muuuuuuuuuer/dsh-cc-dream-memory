/**
 * Regression tests for the second-round P0/P1 fixes (FIXES-v2.md).
 *
 * Covers the four P0 reproductions from the external review plus the P1 fixes:
 *   1. truncated dream input must never rewrite the source file  (P0-1)
 *   2. unicode memory names must not collapse into one file     (P0-2)
 *   3. subagent sessions filtered from dream input + prompt authority rules (P0-3)
 *   4. one git root -> one store/state, concurrent saves stay consistent (P0-4)
 *   5. delete-disabled dream merges leave no orphan files/index lines (P1)
 *   6. dry-run plan and applyLastPlan execute the same plan       (P1)
 *   7. mid-apply failure restores the backup and reports rolledBack (P1)
 *   8. review/pending proposal lifecycle                          (P2)
 *   9. new v2 config defaults
 *
 * All state lives in os.tmpdir(); the real ~/.dsh is never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadModule, makeTempDir } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Module loading / shared fixtures
// ---------------------------------------------------------------------------

let corePromise;

/** Load every module the regressions need; missing modules surface clearly. */
function core() {
  if (!corePromise) {
    corePromise = (async () => ({
      config: await loadModule('../src/config.js', { requireExports: ['resolveConfig', 'DEFAULTS'] }),
      paths: await loadModule('../src/paths.js', { requireExports: ['buildPaths'] }),
      store: await loadModule('../src/store.js', { requireExports: ['MemoryStore'] }),
      state: await loadModule('../src/state.js', { requireExports: ['ProjectState'] }),
      runtime: await loadModule('../src/runtime.js', { requireExports: ['MemoryRuntime'] }),
      dream: await loadModule('../src/dream.js', { requireExports: ['DreamEngine'] }),
      dreamInput: await loadModule('../src/dream-input.js', { requireExports: ['gatherDreamInput'] }),
      dreamPrompt: await loadModule('../src/dream-prompt.js', {
        requireExports: ['DREAM_SYSTEM_PROMPT', 'buildDreamPrompt'],
      }),
    }))();
  }
  return corePromise;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function indexLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Set up one isolated project context inside a temp dir. */
async function setupProject(t, { configOverrides = {}, git = false, workspaceName = 'workspace' } = {}) {
  const mods = await core();
  const tmp = await makeTempDir(t);
  const home = path.join(tmp, 'home');
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, workspaceName);
  await mkdir(workspaceDir, { recursive: true });
  let projectRoot = workspaceDir;
  if (git) {
    projectRoot = tmp;
    await mkdir(path.join(tmp, '.git'), { recursive: true });
  }
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const paths = mods.paths.buildPaths({ memoryRoot: config.memoryRoot, homeDir: home, workspaceDir });
  const store = new mods.store.MemoryStore({ paths, config });
  await store.ensure();
  const state = new mods.state.ProjectState(paths);
  await state.load();
  return {
    mods,
    tmp,
    home,
    memoryRoot,
    workspaceDir,
    projectRoot,
    config,
    paths,
    store,
    state,
    pctx: { workspaceDir, paths, store, state },
  };
}

function streamOf(chunks) {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  })();
}

/**
 * Fake host context: llm (plan returned by `planFor`), agentDefaultModel,
 * sessionQuery and optional workingDirectory.
 */
function fakeCtx({
  planFor = () => ({ summary: 'noop', operations: [] }),
  sessions = {},
  filterRecords = [],
  selection = { provider: 'fake', model: 'fake' },
  workspaceDir,
} = {}) {
  const llmCalls = [];
  const services = {
    llm: {
      stream(options) {
        llmCalls.push(options);
        const plan = planFor(options);
        const text = typeof plan === 'string' ? plan : JSON.stringify(plan);
        return streamOf([
          { type: 'text-delta', text },
          { type: 'finish', reason: { kind: 'stop' } },
        ]);
      },
    },
    agentDefaultModel: { currentSelection: () => selection },
    sessionQuery: {
      async filterSessions() {
        return filterRecords;
      },
      async readSession(id) {
        return sessions[id];
      },
      async readTitle(id) {
        return { title: sessions[id]?.title ?? '' };
      },
    },
  };
  if (workspaceDir) {
    services.workingDirectory = {
      async ensure() {
        return workspaceDir;
      },
    };
  }
  return { ctx: { get: (name) => services[name] }, llmCalls, services };
}

/** One session record shaped like `sessionQuery.readSession()` output. */
function sessionRecord({ id, createdAt = 0, parentSession, origin, title, user = [], assistant = [] }) {
  const header = { id, createdAt: Number(createdAt) };
  if (parentSession !== undefined) header.parentSession = parentSession;
  if (origin !== undefined) header.origin = origin;
  if (title !== undefined) header.title = title;
  const events = [
    ...user.map((text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })),
    ...assistant.map((text) => ({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    })),
  ];
  return { header, session: { createdAt: Number(createdAt) }, events };
}

/** Build a real MemoryRuntime sharing the fake host ctx. */
async function runtimeFor(proj, ctx) {
  const { MemoryRuntime } = proj.mods.runtime;
  return new MemoryRuntime(ctx.ctx, proj.config);
}

/** Tolerate the plan.json wrapper shape ({...plan, truncatedFiles, applied} vs {plan:{...}}). */
function planField(planJson, key) {
  if (planJson && typeof planJson === 'object' && Object.prototype.hasOwnProperty.call(planJson, key)) {
    return planJson[key];
  }
  if (planJson && planJson.plan && typeof planJson.plan === 'object') return planJson.plan[key];
  return undefined;
}

function planOperations(planJson) {
  const operations = planField(planJson, 'operations');
  return Array.isArray(operations) ? operations : [];
}

/** Wrap a real store so the Nth `writeRawEntry` call throws (rollback test). */
function failingWriteStore(store, { failOnFile } = {}) {
  const calls = [];
  const wrapped = new Proxy(store, {
    get(target, property) {
      if (property === 'writeRawEntry') {
        return async (file, payload) => {
          calls.push(file);
          if (failOnFile ? file === failOnFile : calls.length === 2) {
            throw new Error(`simulated disk failure while writing ${file}`);
          }
          return target.writeRawEntry(file, payload);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store: wrapped, calls };
}

// ---------------------------------------------------------------------------
// 9. Config v2 defaults (also covered in config.test.mjs)
// ---------------------------------------------------------------------------

test('v2 config exposes the new autoMemoryEnabled / dream budget defaults', async () => {
  const { config } = await core();
  const resolved = config.resolveConfig();
  assert.equal(resolved.autoMemoryEnabled, true, 'autoMemoryEnabled defaults to true');
  assert.equal(resolved.dreamMaxFileChars, 20_000, 'dreamMaxFileChars defaults to 20000');
  assert.equal(resolved.dreamMaxSessionChars, 12_000, 'dreamMaxSessionChars defaults to 12000 (v0.10.8)');
  assert.equal(resolved.dreamMaxToolChars, 4_000, 'dreamMaxToolChars defaults to 4000');
  assert.equal(resolved.enabled, true, 'plugin master switch default stays true');
  assert.equal(config.DEFAULTS.dreamMaxFileChars, 20_000);
  assert.equal(config.DEFAULTS.dreamMaxSessionChars, 12_000);
  assert.equal(config.DEFAULTS.dreamMaxToolChars, 4_000);

  const overridden = config.resolveConfig({
    autoMemoryEnabled: false,
    dreamMaxFileChars: 12_000,
    dreamMaxSessionChars: 3000,
  });
  assert.equal(overridden.autoMemoryEnabled, false);
  assert.equal(overridden.dreamMaxFileChars, 12_000);
  assert.equal(overridden.dreamMaxSessionChars, 3000);
});

// ---------------------------------------------------------------------------
// P0-1: truncated input must never be written back
// ---------------------------------------------------------------------------

test('P0-1: validateDreamPlan drops writes to files truncated in the dream input', async () => {
  const { dream, config } = await core();
  const cfg = config.resolveConfig();
  const plan = {
    summary: 'tidy',
    operations: [
      {
        op: 'write',
        type: 'reference',
        file: 'reference_api_notes.md',
        name: 'api notes',
        description: 'long reference',
        body: 'shrunk body',
      },
      { op: 'write', type: 'user', name: 'short note', description: 'ok', body: 'safe body' },
      { op: 'index', content: '- [api notes](reference_api_notes.md) — long reference\n' },
    ],
  };
  const result = dream.validateDreamPlan(plan, {
    config: cfg,
    existingFiles: ['reference_api_notes.md', 'user_short_note.md'],
    truncatedFiles: ['reference_api_notes.md'],
  });
  assert.equal(result.ok, true);
  const writes = (result.plan?.operations ?? []).filter((operation) => operation.op === 'write');
  assert.equal(
    writes.some((operation) => operation.file === 'reference_api_notes.md'),
    false,
    'write to a truncated source file must be dropped',
  );
  assert.equal(
    writes.some((operation) => operation.name === 'short note' || operation.file === 'user_short_note.md'),
    true,
    'writes to non-truncated files stay valid',
  );
  assert.match(result.dropped.join(' '), /truncat/i, 'the drop reason must mention truncation');
});

test('P0-1: dream apply never rewrites a long file that was truncated in the input', async (t) => {
  const proj = await setupProject(t);
  const content = Array.from({ length: 800 }, (_, index) => `- fact ${index}: ${'x'.repeat(30)}`).join('\n');
  const saved = await proj.store.saveEntry({
    name: 'api notes',
    type: 'reference',
    description: 'long reference',
    content,
  });
  const fileName = saved.file;
  const before = await proj.store.readEntry(fileName);
  assert.ok(
    before.body.length > proj.config.dreamMaxFileChars,
    `fixture body (${before.body.length}) must exceed dreamMaxFileChars (${proj.config.dreamMaxFileChars})`,
  );
  await proj.state.ensureSession('session-1', 1000);

  const ctx = fakeCtx({
    workspaceDir: proj.workspaceDir,
    sessions: {
      'session-1': sessionRecord({ id: 'session-1', createdAt: 1000, user: ['整理记忆'], assistant: ['好的'] }),
    },
    planFor: () => ({
      summary: 'tidy long reference',
      operations: [
        {
          op: 'write',
          type: 'reference',
          file: fileName,
          name: 'api notes',
          description: 'long reference',
          body: `${before.body.slice(0, 400)}\n- fact NEW`,
        },
        { op: 'index', content: `- [api notes](${fileName}) — long reference\n` },
      ],
    }),
  });

  const engine = new proj.mods.dream.DreamEngine({ ctx: ctx.ctx, runtime: { invalidateInjection() {} }, config: proj.config });
  const run = await engine.run({ pctx: proj.pctx, force: true, trigger: 'manual' });
  assert.equal(run.ran, true, 'forced dream must run');

  const after = await proj.store.readEntry(fileName);
  assert.equal(after.body, before.body, 'the truncated source file body must stay byte-identical');
  assert.equal(after.body.length, before.body.length);

  if (Array.isArray(run.dropped)) {
    assert.match(run.dropped.join(' '), /truncat/i, 'run result should report the truncated-file drop');
  }

  // The gathered input carries head+tail only and reports the truncated file.
  const input = await proj.mods.dreamInput.gatherDreamInput({
    ctx: ctx.ctx,
    store: proj.store,
    config: proj.config,
    workspaceDir: proj.workspaceDir,
    state: proj.state,
  });
  assert.ok(Array.isArray(input.truncatedFiles), 'gatherDreamInput must expose truncatedFiles');
  assert.equal(input.truncatedFiles.includes(fileName), true, `truncatedFiles must include ${fileName}`);
  const gathered = input.memory.files.find((file) => file.file === fileName);
  assert.ok(gathered, 'gathered memory must include the long file');
  assert.ok(gathered.body.length < before.body.length, 'truncated input must carry a bounded excerpt');
  assert.match(gathered.body, /fact 0/, 'head facts are kept');
  assert.match(gathered.body, /fact 799/, 'tail facts are kept (latest conclusions survive)');
});

// ---------------------------------------------------------------------------
// P0-2: unicode names and non-destructive collisions
// ---------------------------------------------------------------------------

test('P0-2: two Chinese memory names become two distinct, readable files', async (t) => {
  const proj = await setupProject(t);
  const first = await proj.store.saveEntry({
    name: '用户语言偏好',
    type: 'user',
    description: '中文回复',
    content: 'A: 用中文回复',
  });
  const second = await proj.store.saveEntry({
    name: '测试习惯',
    type: 'user',
    description: '先跑测试',
    content: 'B: 先跑测试',
  });
  assert.notEqual(first.file, second.file, 'distinct CJK names must map to distinct files');
  assert.match(first.file, /^user_.+\.md$/u);
  assert.match(second.file, /^user_.+\.md$/u);

  assert.match((await proj.store.readEntry(first.file)).body, /用中文回复/);
  assert.match((await proj.store.readEntry(second.file)).body, /先跑测试/);

  const entries = await proj.store.listEntries();
  assert.equal(entries.length, 2, 'both CJK entries must be listed');
  const index = await proj.store.indexText();
  assert.match(index, new RegExp(`\\]\\(${escapeRegExp(first.file)}\\)`), 'first file must be indexed');
  assert.match(index, new RegExp(`\\]\\(${escapeRegExp(second.file)}\\)`), 'second file must be indexed');

  const audit = await proj.store.auditIndex();
  assert.deepEqual(audit.missing, [], 'no disk file may be missing from the index');
  assert.deepEqual(audit.dangling, [], 'no index line may point at a missing file');
});

test('P0-2: same name updates in place, a different name with the same slug does not overwrite', async (t) => {
  const proj = await setupProject(t);
  const first = await proj.store.saveEntry({ name: '测试习惯', type: 'user', description: 'v1', content: '版本一' });
  const same = await proj.store.saveEntry({ name: '测试习惯', type: 'user', description: 'v2', content: '版本二' });
  assert.equal(same.file, first.file, 'same logical name updates the existing file');
  assert.equal(same.created, false);
  assert.match((await proj.store.readEntry(first.file)).body, /版本二/);

  // Different names that share one slug must not silently overwrite each other.
  const spaced = await proj.store.saveEntry({ name: 'note one', type: 'project', description: 'first', content: 'FIRST BODY' });
  const dashed = await proj.store.saveEntry({ name: 'note-one', type: 'project', description: 'second', content: 'SECOND BODY' });
  assert.notEqual(spaced.file, dashed.file, 'a slug collision must get a disambiguating suffix');
  assert.match((await proj.store.readEntry(spaced.file)).body, /FIRST BODY/, 'the old file content must survive');
  assert.match((await proj.store.readEntry(dashed.file)).body, /SECOND BODY/);
  const audit = await proj.store.auditIndex();
  assert.deepEqual(audit.missing, []);
});

test('P0-2: two /remember notes with Chinese first lines do not collide', async (t) => {
  const proj = await setupProject(t);
  const { registerCommands } = await loadModule('../src/commands.js', { requireExports: ['registerCommands'] });
  const definitions = new Map();
  const commandCtx = {
    commands: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name);
      },
    },
    get: () => undefined,
  };
  const runtime = {
    config: proj.config,
    forAgent: async () => proj.pctx,
    forSessionId: async () => proj.pctx,
    storeFor: async () => proj.pctx,
    invalidateInjection() {},
    dream: async () => ({ ran: false }),
    applyPendingDream: async () => ({ applied: false }),
    applyLastPlan: async () => ({ applied: false }),
  };
  const dispose = registerCommands(commandCtx, runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  const remember = definitions.get('remember');
  assert.ok(remember, 'registerCommands must register /remember');

  const invocation = { rawInput: '用户偏好用中文回复所有回答', agent: { id: 'agent-1' }, sessionId: 'session-1' };
  const firstResult = await remember.handler(invocation);
  const secondResult = await remember.handler({ ...invocation, rawInput: '测试前必须先跑回归测试' });
  assert.equal(firstResult.kind, 'success', `first /remember failed: ${firstResult.text}`);
  assert.equal(secondResult.kind, 'success', `second /remember failed: ${secondResult.text}`);

  const entries = await proj.store.listEntries();
  assert.equal(entries.length, 2, `/remember notes collapsed: ${JSON.stringify(entries.map((entry) => entry.file))}`);
  assert.equal(new Set(entries.map((entry) => entry.file)).size, 2);
});

// ---------------------------------------------------------------------------
// P0-3: subagent session filtering + prompt authority rules
// ---------------------------------------------------------------------------

test('P0-3: gatherDreamInput filters subagent sessions and keeps mainline sessions', async (t) => {
  const proj = await setupProject(t);
  await proj.state.ensureSession('main-1', 1000);
  await proj.state.ensureSession('sub-1', 2000);

  const ctx = fakeCtx({
    workspaceDir: proj.workspaceDir,
    sessions: {
      'main-1': sessionRecord({
        id: 'main-1',
        createdAt: 1000,
        user: ['主线会话：修复记忆插件'],
        assistant: ['已完成 P0 修复'],
      }),
      'main-2': sessionRecord({ id: 'main-2', createdAt: 3000, user: ['第二个主线会话内容'] }),
      'sub-1': sessionRecord({
        id: 'sub-1',
        createdAt: 2000,
        parentSession: 'main-1',
        user: ['SUBAGENT DISPATCH text must not leak'],
      }),
      'sub-2': sessionRecord({
        id: 'sub-2',
        createdAt: 4000,
        origin: 'subagent',
        user: ['SUBAGENT ORIGIN text must not leak'],
      }),
    },
    filterRecords: [
      { header: { id: 'sub-2', createdAt: 4000, origin: 'subagent' } },
      { header: { id: 'main-2', createdAt: 3000 } },
    ],
  });

  const input = await proj.mods.dreamInput.gatherDreamInput({
    ctx: ctx.ctx,
    store: proj.store,
    config: proj.config,
    workspaceDir: proj.workspaceDir,
    state: proj.state,
  });
  const ids = input.sessions.map((session) => session.id);
  assert.equal(ids.includes('sub-1'), false, 'a session with header.parentSession is a subagent session and must be skipped');
  assert.equal(ids.includes('sub-2'), false, 'a session with header.origin === "subagent" must be skipped');
  assert.equal(ids.includes('main-1'), true, 'mainline session from state must be included');
  assert.equal(ids.includes('main-2'), true, 'mainline candidate from filterSessions must be included');
  const serialized = JSON.stringify(input.sessions);
  assert.doesNotMatch(serialized, /SUBAGENT/, 'subagent text must not reach the dream prompt');
  assert.match(serialized, /主线会话|已完成 P0 修复|第二个主线会话内容/);
});

test('P0-3: dream prompt makes memory subordinate to instructions and refuses truncated rewrites', async (t) => {
  await setupProject(t); // just ensures the temp dir fixture machinery works
  const { DREAM_SYSTEM_PROMPT, buildDreamPrompt } = await core().then((mods) => mods.dreamPrompt);
  const input = {
    memory: {
      index: '- [api notes](reference_api_notes.md) — long reference',
      files: [
        {
          file: 'reference_api_notes.md',
          type: 'reference',
          description: 'long reference',
          modified: '2026-11-06T00:00:00.000Z',
          body: 'head\n...(truncated)\ntail',
          truncated: true,
        },
      ],
    },
    sessions: [],
    chars: 100,
    truncated: true,
    truncatedFiles: ['reference_api_notes.md'],
  };
  const prompt = `${DREAM_SYSTEM_PROMPT}\n${buildDreamPrompt(input)}`;
  assert.doesNotMatch(prompt, /prefer the newer/i, 'the old "prefer the newer memory" wording must be gone');
  assert.doesNotMatch(prompt, /newer memory/i, 'no "newer memory wins" guidance may remain');
  assert.match(prompt, /not instructions/i, 'prompt must say memory is context, not instructions');
  assert.match(prompt, /background context/i, 'prompt must describe memory as background context');
  assert.match(prompt, /never overrides/i, 'prompt must say memory never overrides instruction files');
  assert.match(prompt, /TRUNCATED IN INPUT/, 'prompt must mark truncated files');
  assert.match(prompt, /DO NOT REWRITE/, 'prompt must forbid rewriting truncated files');
  assert.match(prompt, /reference_api_notes\.md/, 'prompt must name the truncated file');
});

// ---------------------------------------------------------------------------
// P0-4: one git root -> one store/state; concurrent saves keep the index
// ---------------------------------------------------------------------------

test('P0-4: repo and its subdirectory share one store/state instance; concurrent saves keep index consistent', async (t) => {
  const { config, paths, store: storeMod, state: stateMod, runtime: runtimeMod } = await core();
  const tmp = await makeTempDir(t);
  const repo = path.join(tmp, 'repo');
  const pkg = path.join(repo, 'pkg');
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await mkdir(pkg, { recursive: true });
  const cfg = config.resolveConfig({ memoryRoot: path.join(tmp, 'memory-root') });

  const runtime = new runtimeMod.MemoryRuntime({ get: () => undefined }, cfg);
  const repoContext = await runtime.storeFor(repo);
  const pkgContext = await runtime.storeFor(pkg);

  assert.equal(pkgContext.store, repoContext.store, 'same git root must share one MemoryStore instance');
  assert.equal(pkgContext.state, repoContext.state, 'same git root must share one ProjectState instance');
  assert.equal(pkgContext.paths.memoryDir, repoContext.paths.memoryDir, 'same git root must share one memory dir');

  const saves = [];
  for (let index = 0; index < 10; index += 1) {
    const target = index % 2 === 0 ? repoContext : pkgContext;
    saves.push(
      target.store.saveEntry({
        name: `note ${index}`,
        type: 'project',
        description: `note number ${index}`,
        content: `content ${index}`,
      }),
    );
  }
  await Promise.all(saves);

  const entries = await repoContext.store.listEntries();
  const lines = indexLines(await repoContext.store.indexText());
  assert.equal(entries.length, 10, 'all 10 concurrent saves must produce files');
  assert.equal(lines.length, entries.length, `index lines (${lines.length}) must equal topic files (${entries.length})`);
  for (const entry of entries) {
    assert.ok(
      lines.some((line) => line.includes(`](${entry.file})`)),
      `missing index line for ${entry.file}`,
    );
  }
  const audit = await repoContext.store.auditIndex();
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.dangling, []);

  // State writes through both handles must not lose sessions.
  await Promise.all([repoContext.state.ensureSession('s-1'), pkgContext.state.ensureSession('s-2')]);
  const disk = await readJson(repoContext.paths.stateFile);
  const persisted = disk.sessionsSince.map((entry) => entry.id).sort();
  assert.deepEqual(persisted, ['s-1', 's-2'], 'concurrent session writes into the shared state must both persist');
});

// ---------------------------------------------------------------------------
// P1: delete-disabled dream merge leaves no orphans; trashEntry moves files
// ---------------------------------------------------------------------------

test('P1: delete-disabled dream merge keeps disk and index in sync (no orphan files)', async (t) => {
  const proj = await setupProject(t, { configOverrides: { dreamAllowDelete: false } });
  await proj.store.saveEntry({ name: 'testing a', type: 'feedback', description: 'run tests first', content: 'A body' });
  await proj.store.saveEntry({ name: 'testing b', type: 'feedback', description: 'run tests before commit', content: 'B body' });
  await proj.state.ensureSession('session-1', 1000);

  const ctx = fakeCtx({
    workspaceDir: proj.workspaceDir,
    sessions: {
      'session-1': sessionRecord({ id: 'session-1', createdAt: 1000, user: ['合并测试记忆'], assistant: ['好的'] }),
    },
    planFor: () => ({
      summary: 'merge testing notes',
      operations: [
        { op: 'write', type: 'feedback', name: 'testing', description: 'run tests before claiming done', body: 'A+B merged' },
        { op: 'delete', file: 'feedback_testing_a.md', reason: 'absorbed' },
        { op: 'delete', file: 'feedback_testing_b.md', reason: 'absorbed' },
        { op: 'index', content: '- [testing](feedback_testing.md) — run tests before claiming done\n' },
      ],
    }),
  });
  const engine = new proj.mods.dream.DreamEngine({ ctx: ctx.ctx, runtime: { invalidateInjection() {} }, config: proj.config });
  const run = await engine.run({ pctx: proj.pctx, force: true, trigger: 'manual' });
  assert.equal(run.applied, true, 'the merge should apply');

  const entries = await proj.store.listEntries();
  const audit = await proj.store.auditIndex();
  assert.equal(audit.missing.length, 0, `orphan files not covered by the index: ${JSON.stringify(audit.missing)}`);
  assert.equal(audit.dangling.length, 0, `index lines pointing at deleted files: ${JSON.stringify(audit.dangling)}`);

  const injected = await proj.store.injectedIndex();
  for (const entry of entries) {
    assert.ok(
      injected.text.includes(`](${entry.file})`),
      `file ${entry.file} is on disk but never injected (orphan)`,
    );
  }
});

test('P1: trashEntry soft-deletes into the project trash and removes the index line', async (t) => {
  const proj = await setupProject(t);
  const saved = await proj.store.saveEntry({ name: 'trash me', type: 'user', description: 'to be trashed', content: 'trash body' });
  const trashed = await proj.store.trashEntry(saved.file, { reason: 'regression test' });
  assert.equal(trashed.trashed, true);
  assert.equal(trashed.file, saved.file);
  assert.equal(typeof trashed.trashPath, 'string');
  assert.ok(await exists(trashed.trashPath), 'trashed file must exist at trashPath');
  assert.equal(
    await exists(path.join(proj.paths.memoryDir, saved.file)),
    false,
    'the memory file must be moved out of the memory dir',
  );
  const trashRoot = proj.paths.trashRoot;
  assert.equal(typeof trashRoot, 'string', 'paths.trashRoot must be exposed');
  assert.ok(
    path.resolve(trashed.trashPath).startsWith(path.resolve(trashRoot)),
    `trashPath ${trashed.trashPath} must live under trashRoot ${trashRoot}`,
  );
  assert.doesNotMatch(await proj.store.indexText(), new RegExp(escapeRegExp(saved.file)), 'index line must be removed');
  const audit = await proj.store.auditIndex();
  assert.equal(audit.dangling.length, 0);
});

// ---------------------------------------------------------------------------
// P1: dry-run -> applyLastPlan executes exactly the previewed plan
// ---------------------------------------------------------------------------

test('P1: dry-run previews a plan and applyLastPlan executes that same plan', async (t) => {
  const proj = await setupProject(t);
  const ctx = fakeCtx({
    workspaceDir: proj.workspaceDir,
    sessions: { 'session-1': sessionRecord({ id: 'session-1', createdAt: 1000, user: ['请整理一下记忆文件'], assistant: ['好的'] }) },
    planFor: () => ({
      summary: 'consolidate notes',
      operations: [
        {
          op: 'write',
          type: 'user',
          name: 'consolidated',
          description: 'consolidated note',
          body: 'consolidated body',
          evidence: ['请整理一下记忆文件'],
        },
        { op: 'index', content: '- [consolidated](user_consolidated.md) — consolidated note\n' },
      ],
    }),
  });
  const runtime = await runtimeFor(proj, ctx);
  const pctx = await runtime.storeFor(proj.workspaceDir);
  await pctx.store.saveEntry({ name: 'existing', type: 'user', description: 'existing note', content: 'existing body' });
  await pctx.state.ensureSession('session-1', 1000);
  const entriesBefore = await pctx.store.listEntries();

  const dry = await runtime.dream({ pctx, force: true, dryRun: true, trigger: 'manual' });
  assert.equal(dry.ran, true, 'forced dry-run must run');
  assert.equal(dry.applied, false, 'dry-run must not apply');
  assert.equal(dry.dryRun, true);

  const snapshot = pctx.state.snapshot();
  assert.equal(typeof snapshot.lastPlanPath, 'string');
  assert.ok(snapshot.lastPlanPath.length > 0, 'dry-run must record lastPlanPath in state');
  assert.equal(snapshot.lastDreamMode, 'dry-run', 'state must record the dry-run mode');
  assert.ok(await exists(snapshot.lastPlanPath), 'plan.json must exist on disk');

  const savedPlan = await readJson(snapshot.lastPlanPath);
  assert.equal(planField(savedPlan, 'applied'), false, 'plan.json must be marked applied:false');
  assert.ok(Array.isArray(planField(savedPlan, 'truncatedFiles')), 'plan.json must carry truncatedFiles');
  const savedOperations = planOperations(savedPlan);
  assert.ok(savedOperations.length >= 2, 'normalized plan must keep the write and index operations');
  const savedWrite = savedOperations.find((operation) => operation.op === 'write');
  assert.ok(savedWrite && typeof savedWrite.file === 'string', 'normalized write must carry the derived file name');

  // dry-run must not have touched memory
  const entriesAfterDry = await pctx.store.listEntries();
  assert.equal(entriesAfterDry.length, entriesBefore.length, 'dry-run must not write memory files');
  assert.equal(await exists(path.join(pctx.paths.memoryDir, savedWrite.file)), false);

  const applied = await runtime.applyLastPlan({ pctx });
  assert.equal(applied.applied, true, `applyLastPlan failed: ${JSON.stringify(applied.error ?? applied)}`);

  const after = await pctx.store.listEntries();
  assert.ok(
    after.some((entry) => entry.file === savedWrite.file),
    `file planned by dry-run (${savedWrite.file}) must be written by applyLastPlan`,
  );
  const written = await pctx.store.readEntry(savedWrite.file);
  assert.equal(written.body.trim(), String(savedWrite.body).trim());
  assert.match(await pctx.store.indexText(), new RegExp(escapeRegExp(savedWrite.file)));

  const afterSnapshot = pctx.state.snapshot();
  assert.equal(afterSnapshot.lastPlanPath, '', 'lastPlanPath must be cleared after a successful apply');
  const audit = await pctx.store.auditIndex();
  assert.equal(audit.missing.length, 0);
});

// ---------------------------------------------------------------------------
// P1: mid-apply failure rolls back the backup
// ---------------------------------------------------------------------------

test('P1: a failure in the middle of apply restores the backup and reports rolledBack', async (t) => {
  const proj = await setupProject(t);
  const original = await proj.store.saveEntry({
    name: 'old',
    type: 'feedback',
    description: 'original',
    content: 'ORIGINAL BODY',
  });
  await proj.state.ensureSession('session-1', 1000);

  const ctx = fakeCtx({
    workspaceDir: proj.workspaceDir,
    sessions: { 'session-1': sessionRecord({ id: 'session-1', createdAt: 1000, user: ['请整理一下记忆文件'], assistant: ['好的'] }) },
    planFor: () => ({
      summary: 'rewrite and add',
      operations: [
        { op: 'write', type: 'feedback', file: original.file, name: 'old', description: 'original', body: 'REWRITTEN BODY', evidence: ['请整理一下记忆文件'] },
        { op: 'write', type: 'feedback', name: 'brand new', description: 'new', body: 'NEW BODY', evidence: ['请整理一下记忆文件'] },
        { op: 'index', content: `- [old](${original.file}) — original\n- [brand new](feedback_brand_new.md) — new\n` },
      ],
    }),
  });

  const { store: wrappedStore, calls } = failingWriteStore(proj.store, { failOnFile: 'feedback_brand_new.md' });
  const pctx = { ...proj.pctx, store: wrappedStore };
  const engine = new proj.mods.dream.DreamEngine({
    ctx: ctx.ctx,
    runtime: { invalidateInjection() {} },
    config: proj.config,
  });
  const run = await engine.run({ pctx, force: true, trigger: 'manual' });

  assert.ok(calls.includes('feedback_brand_new.md'), `the failing write was never attempted; writes: ${JSON.stringify(calls)}`);
  assert.equal(run.applied, false, 'a failed apply must not report success');
  assert.equal(run.rolledBack, true, 'a failed apply must report rolledBack:true');
  assert.ok(run.error, 'a failed apply must report the error');

  const restored = await proj.store.readEntry(original.file);
  assert.equal(restored.body.trim(), 'ORIGINAL BODY', 'the pre-dream body must be restored from the backup');
  assert.equal(
    await exists(path.join(proj.paths.memoryDir, 'feedback_brand_new.md')),
    false,
    'files created by the failed apply must be rolled back out of the memory dir',
  );
  assert.doesNotMatch(await proj.store.indexText(), /brand new/, 'the index must be restored as well');
  const audit = await proj.store.auditIndex();
  assert.equal(audit.missing.length, 0);

  const snapshot = proj.state.snapshot();
  assert.match(String(snapshot.lastError), /simulated disk failure/i, 'state must record the failure');
  assert.equal(snapshot.consecutiveFailures, 1, 'failure counter must be incremented');
  const changelog = await readFile(proj.paths.changelogFile, 'utf8').catch(() => '');
  assert.match(changelog, /rollback/i, 'changelog must record the rollback');
});

// ---------------------------------------------------------------------------
// P2: review / pending proposal lifecycle
// ---------------------------------------------------------------------------

test('P2: review mode writes a pending proposal without clearing sessions; applyPending finalizes it', async (t) => {
  const proj = await setupProject(t, { configOverrides: { dreamMode: 'review' } });
  const ctx = fakeCtx({
    workspaceDir: proj.workspaceDir,
    sessions: { 's-1': sessionRecord({ id: 's-1', createdAt: 1000, user: ['请整理一下记忆文件'], assistant: ['好的'] }) },
    planFor: () => ({
      summary: 'review proposal',
      operations: [
        { op: 'write', type: 'user', name: 'review note', description: 'proposed note', body: 'proposed body', evidence: ['请整理一下记忆文件'] },
      ],
    }),
  });
  const runtime = await runtimeFor(proj, ctx);
  const pctx = await runtime.storeFor(proj.workspaceDir);
  await pctx.store.saveEntry({ name: 'base', type: 'user', description: 'base note', content: 'base body' });
  await pctx.state.ensureSession('s-1', 1000);
  await pctx.state.ensureSession('s-2', 2000);

  const run = await runtime.dream({ pctx, force: true, trigger: 'manual' });
  assert.equal(run.ran, true, 'review dream must run');
  assert.equal(run.applied, false, 'review mode must not apply');
  assert.equal(run.mode, 'review');

  const snapshot = pctx.state.snapshot();
  assert.equal(typeof snapshot.pendingProposal, 'string');
  assert.ok(snapshot.pendingProposal.length > 0, 'review must record pendingProposal');
  assert.ok(await exists(snapshot.pendingProposal), 'pending proposal file must exist');
  const proposal = await readJson(snapshot.pendingProposal);
  assert.equal(planField(proposal, 'applied'), false, 'proposal must be marked applied:false');
  assert.ok(planOperations(proposal).length >= 1, 'proposal must carry operations');

  assert.deepEqual(
    snapshot.sessionsSince.map((entry) => entry.id).sort(),
    ['s-1', 's-2'],
    'review mode must not clear sessionsSince',
  );
  assert.equal(snapshot.lastDreamAt, 0, 'review mode must not mark the dream as done');
  assert.equal(
    (await pctx.store.listEntries()).some((entry) => /review_note/.test(entry.file)),
    false,
    'review mode must not write memory files',
  );

  const second = await runtime.dream({ pctx, force: true, trigger: 'manual' });
  assert.equal(second.ran, false, 'a second review run must not start while a proposal is pending');
  assert.equal(second.skipped, true);
  assert.equal(second.skipReason, 'pending-proposal');

  const applied = await runtime.applyPendingDream({ pctx, agent: { id: 'agent-1' } });
  assert.equal(applied.applied, true, `applyPendingDream failed: ${JSON.stringify(applied.error ?? applied)}`);
  const afterSnapshot = pctx.state.snapshot();
  assert.equal(afterSnapshot.pendingProposal, '', 'pendingProposal must be cleared after applying');
  // s-2 has no readable transcript in this fixture, so it was never consulted
  // by the proposal; a real Host would read it. Only consulted sessions clear.
  assert.deepEqual(afterSnapshot.sessionsSince.map((entry) => entry.id), ['s-2'], 'only consulted sessions are cleared after apply');
  assert.ok(
    (await pctx.store.listEntries()).some((entry) => /review_note/.test(entry.file)),
    'the proposed note must be written by applyPending',
  );
  const audit = await pctx.store.auditIndex();
  assert.equal(audit.missing.length, 0);
});

// ---------------------------------------------------------------------------
// Third review round: stale plans, derived-name collisions, truncated deletes
// ---------------------------------------------------------------------------

test('R3: applyLastPlan refuses a plan once memory changed after the dry-run', async (t) => {
  const proj = await setupProject(t);
  const ctx = fakeCtx({
    workspaceDir: proj.workspaceDir,
    planFor: () => ({
      summary: 'refresh goal',
      operations: [{ op: 'write', type: 'project', file: 'project_goal.md', name: 'goal', body: 'v1 (tidied)' }],
    }),
  });
  const runtime = await runtimeFor(proj, ctx);
  const pctx = await runtime.storeFor(proj.workspaceDir);
  await pctx.store.saveEntry({ name: 'goal', type: 'project', content: 'v1' });

  const dry = await runtime.dream({ pctx, force: true, dryRun: true, trigger: 'manual' });
  assert.equal(dry.ran, true);
  const planPath = pctx.state.snapshot().lastPlanPath;
  assert.equal(typeof planField(await readJson(planPath), 'inputFingerprint'), 'object', 'plan.json must carry the input fingerprint');

  await pctx.store.updateEntry('project_goal.md', { content: 'v2 newer human edit' });
  const applied = await runtime.applyLastPlan({ pctx });
  assert.equal(applied.applied, false, 'a stale plan must not be applied');
  assert.match(String(applied.error), /stale-plan/);
  assert.match(String(applied.error), /project_goal\.md/, 'the error names the changed file');
  assert.equal((await pctx.store.readEntry('project_goal.md')).body, 'v2 newer human edit', 'the newer edit survives');
});

test('R3: a direct dream apply aborts when memory changes while the model is running', async (t) => {
  const proj = await setupProject(t);
  await proj.store.saveEntry({ name: 'goal', type: 'project', content: 'v1' });
  const ctx = fakeCtx({
    workspaceDir: proj.workspaceDir,
    planFor: () => ({
      summary: 'refresh goal',
      operations: [{ op: 'write', type: 'project', file: 'project_goal.md', name: 'goal', body: 'v1 (tidied)' }],
    }),
  });
  // Simulate an edit landing during the (slow) model call.
  const stream = ctx.services.llm.stream.bind(ctx.services.llm);
  ctx.services.llm.stream = (options) => {
    const chunks = stream(options);
    return (async function* edited() {
      await proj.store.updateEntry('project_goal.md', { content: 'v2 edit during dream' });
      yield* chunks;
    })();
  };
  const engine = new proj.mods.dream.DreamEngine({ ctx: ctx.ctx, runtime: { invalidateInjection() {} }, config: proj.config });
  const run = await engine.run({ pctx: proj.pctx, force: true, trigger: 'manual' });
  assert.equal(run.applied, false);
  assert.match(String(run.error), /memory changed while the dream was running/);
  assert.equal((await proj.store.readEntry('project_goal.md')).body, 'v2 edit during dream');
});

test('R3: a write without "file" never overwrites a different memory that shares the slug', async (t) => {
  const proj = await setupProject(t);
  const first = await proj.store.saveEntry({ name: 'API Notes', type: 'reference', content: 'first' });
  const second = await proj.store.saveEntry({ name: 'api-notes', type: 'reference', content: 'second' });
  assert.notEqual(first.file, second.file);
  const ctx = fakeCtx({
    workspaceDir: proj.workspaceDir,
    planFor: () => ({
      summary: 'update notes',
      operations: [
        { op: 'write', type: 'reference', name: 'api-notes', body: 'second (updated)' },
        { op: 'write', type: 'reference', name: 'API Notes', body: 'first (updated)' },
      ],
    }),
  });
  const engine = new proj.mods.dream.DreamEngine({ ctx: ctx.ctx, runtime: { invalidateInjection() {} }, config: proj.config });
  const run = await engine.run({ pctx: proj.pctx, force: true, trigger: 'manual' });
  assert.equal(run.applied, true);
  assert.match(run.dropped.join(' '), /already holds a different memory/);
  assert.equal((await proj.store.readEntry(first.file)).body, 'first (updated)', 'same-name derived write still updates');
  assert.equal((await proj.store.readEntry(second.file)).body, 'second', 'the suffixed memory is untouched');
});

test('R3: with deletes enabled, a file truncated in the input cannot be deleted', async () => {
  const { dream, config } = await core();
  const result = dream.validateDreamPlan(
    {
      summary: 'absorb big ref',
      operations: [
        { op: 'write', type: 'reference', file: 'reference_merged.md', name: 'merged', body: 'excerpt only' },
        { op: 'delete', file: 'reference_big.md', reason: 'absorbed' },
      ],
    },
    {
      config: config.resolveConfig({ dreamAllowDelete: true }),
      existingFiles: ['reference_big.md'],
      truncatedFiles: ['reference_big.md'],
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.plan.operations.some((operation) => operation.op === 'delete'), false);
  assert.match(result.dropped.join(' '), /truncated in the dream input; refusing to delete/);
});
