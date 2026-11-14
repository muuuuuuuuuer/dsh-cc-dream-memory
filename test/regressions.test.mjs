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
import { runtimeEnv as dreamRuntimeEnv, scriptDream, claimOf } from './v10-helpers.mjs';

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
  const store = new mods.store.MemoryStore({ paths, getConfig: () => config });
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
  assert.equal(resolved.dreamMaxFileChars, 100_000, 'dreamMaxFileChars defaults to 100000 (Claude cookbook 100KB)');
  assert.equal(resolved.dreamMaxToolChars, 4_000, 'dreamMaxToolChars defaults to 4000');
  assert.equal(resolved.enabled, true, 'plugin master switch default stays true');
  assert.equal(config.DEFAULTS.dreamMaxFileChars, 100_000);
  assert.equal(config.DEFAULTS.dreamMaxToolChars, 4_000);

  const overridden = config.resolveConfig({
    autoMemoryEnabled: false,
    dreamMaxFileChars: 12_000,
  });
  assert.equal(overridden.autoMemoryEnabled, false);
  assert.equal(overridden.dreamMaxFileChars, 12_000);
});

// ---------------------------------------------------------------------------
// P0-1: truncated input must never be written back
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
    get: (name) => (name === 'commands' ? commandCtx.commands : undefined),
  };
  const runtime = {
    config: proj.config,
    forAgent: async () => proj.pctx,
    forSessionId: async () => proj.pctx,
    storeFor: async () => proj.pctx,
    invalidateInjection() {},
    canWriteMemory: () => true,
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
