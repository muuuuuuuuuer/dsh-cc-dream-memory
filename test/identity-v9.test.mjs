/**
 * v9 P0: project identity / multiple memory spaces.
 *
 * Contract: docs/superpowers/specs/2026-11-07-v9-p0-contract.md §2.
 * Every fixture lives in os.tmpdir(); no LLM is invoked.
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
      identity: await loadModule('../src/identity.js', { requireExports: ['resolveIdentity'] }),
      store: await loadModule('../src/store.js', { requireExports: ['MemoryStore'] }),
      state: await loadModule('../src/state.js', { requireExports: ['ProjectState'] }),
      runtime: await loadModule('../src/runtime.js', { requireExports: ['MemoryRuntime'] }),
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

/** Temp tree: <tmp>/home, <tmp>/memory-root, <tmp>/<name>. */
async function makeTree(t, { name = 'workspace', git = false } = {}) {
  const mods = await modules();
  const tmp = await makeTempDir(t);
  const homeDir = path.join(tmp, 'home');
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, name);
  await mkdir(workspaceDir, { recursive: true });
  if (git) await mkdir(path.join(workspaceDir, '.git'), { recursive: true });
  return { mods, tmp, homeDir, memoryRoot, workspaceDir };
}

function configFor(tree, overrides = {}) {
  return tree.mods.config.resolveConfig({ memoryRoot: tree.memoryRoot, ...overrides });
}

function pathsFor(tree, overrides = {}) {
  return tree.mods.paths.buildPaths({
    memoryRoot: tree.memoryRoot,
    homeDir: tree.homeDir,
    workspaceDir: tree.workspaceDir,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// resolveIdentity priorities
// ---------------------------------------------------------------------------

test('v9 identity: config projectId wins over marker, git and workspace', async (t) => {
  const tree = await makeTree(t, { git: true });
  await writeFile(path.join(tree.workspaceDir, '.cc-memory.json'), JSON.stringify({ projectId: 'marker-id' }), 'utf8');
  const identity = tree.mods.identity.resolveIdentity({
    workspaceDir: tree.workspaceDir,
    config: configFor(tree, { projectId: 'explicit-id' }),
  });
  assert.equal(identity.source, 'config');
  assert.equal(identity.projectId, 'explicit-id');
  assert.equal(identity.projectRoot, tree.workspaceDir);
});

test('v9 identity: marker files (.cc-memory.json and .dsh-memory-project) win over git', async (t) => {
  const jsonTree = await makeTree(t, { name: 'json-marker', git: true });
  await writeFile(path.join(jsonTree.workspaceDir, '.cc-memory.json'), JSON.stringify({ projectId: 'json-project' }), 'utf8');
  const jsonIdentity = jsonTree.mods.identity.resolveIdentity({ workspaceDir: jsonTree.workspaceDir, config: configFor(jsonTree) });
  assert.equal(jsonIdentity.source, 'marker');
  assert.equal(jsonIdentity.projectId, 'json-project');
  assert.equal(typeof jsonIdentity.markerPath, 'string');
  assert.equal(jsonIdentity.markerPath, path.join(jsonTree.workspaceDir, '.cc-memory.json'));

  const plainTree = await makeTree(t, { name: 'plain-marker', git: true });
  await writeFile(path.join(plainTree.workspaceDir, '.dsh-memory-project'), '  plain-project  \n', 'utf8');
  const plainIdentity = plainTree.mods.identity.resolveIdentity({ workspaceDir: plainTree.workspaceDir, config: configFor(plainTree) });
  assert.equal(plainIdentity.source, 'marker');
  assert.equal(plainIdentity.projectId, 'plain-project', 'the marker text is trimmed');
});

test('v9 identity: git root beats the bare workspace, bare workspace is the fallback', async (t) => {
  const repo = await makeTree(t, { name: 'repo', git: true });
  const nested = path.join(repo.workspaceDir, 'packages', 'app');
  await mkdir(nested, { recursive: true });
  const gitIdentity = repo.mods.identity.resolveIdentity({ workspaceDir: nested, config: configFor(repo) });
  assert.equal(gitIdentity.source, 'git');
  assert.equal(gitIdentity.projectRoot, repo.workspaceDir);

  const plain = await makeTree(t, { name: 'plain' });
  const workspaceIdentity = plain.mods.identity.resolveIdentity({ workspaceDir: plain.workspaceDir, config: configFor(plain) });
  assert.equal(workspaceIdentity.source, 'workspace');
  assert.equal(workspaceIdentity.projectRoot, plain.workspaceDir);
  assert.equal(typeof workspaceIdentity.projectId, 'string');
  // Without an explicit id the path layer keeps using the git-root slug, so the
  // memory dir is still derived from the workspace.
  const plainPaths = pathsFor({ ...plain, workspaceDir: plain.workspaceDir });
  assert.ok(plainPaths.memoryDir.length > 0);
});

// ---------------------------------------------------------------------------
// projectId sanitizing + paths / runtime wiring
// ---------------------------------------------------------------------------

test('v9 identity: projectId is sanitized for the project directory', async (t) => {
  const tree = await makeTree(t);
  const buildPaths = tree.mods.paths.buildPaths;
  const base = { memoryRoot: tree.memoryRoot, homeDir: tree.homeDir, workspaceDir: tree.workspaceDir };

  const cn = buildPaths({ ...base, projectId: '我的 项目@A/B' });
  assert.equal(path.basename(cn.projectDir), '我的-项目-A-B');
  assert.equal(cn.root, path.resolve(tree.memoryRoot));

  const kept = buildPaths({ ...base, projectId: 'a.b_c-d' });
  assert.equal(path.basename(kept.projectDir), 'a.b_c-d', 'letters, digits, _ . - are preserved');

  const empty = buildPaths({ ...base, projectId: '///' });
  assert.equal(path.basename(empty.projectDir), 'project', 'a fully stripped id falls back to "project"');

  const other = buildPaths({ ...base, projectId: 'other-project' });
  assert.notEqual(other.projectDir, cn.projectDir, 'different projectIds map to different memory dirs');
  assert.equal(other.memoryDir, path.join(other.projectDir, 'memory'));
});

test('v9 identity: two marker directories map to separate memory spaces; the same id shares one', async (t) => {
  const mods = await modules();
  const tmp = await makeTempDir(t);
  const homeDir = path.join(tmp, 'home');
  const memoryRoot = path.join(tmp, 'memory-root');

  async function makeMarked(name, projectId) {
    const workspaceDir = path.join(tmp, name);
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, '.cc-memory.json'), JSON.stringify({ projectId }), 'utf8');
    return workspaceDir;
  }
  const workA = await makeMarked('a', 'alpha');
  const workB = await makeMarked('b', 'beta');
  const workA2 = await makeMarked('a2', 'alpha');

  const config = mods.config.resolveConfig({ memoryRoot });
  const runtime = new mods.runtime.MemoryRuntime({ get: () => undefined }, config);
  const ctxA = await runtime.storeFor(workA);
  const ctxB = await runtime.storeFor(workB);
  const ctxA2 = await runtime.storeFor(workA2);

  assert.notEqual(ctxA.paths.memoryDir, ctxB.paths.memoryDir, 'different markers must not share memory');
  assert.equal(ctxA.paths.memoryDir, ctxA2.paths.memoryDir, 'the same marker id shares one memory space');
  assert.equal(ctxA.identity?.source, 'marker', 'the project context carries the identity');
  assert.equal(ctxB.identity?.projectId, 'beta');

  await ctxA.store.saveEntry({ name: 'alpha note', type: 'user', description: 'd', content: 'alpha body' });
  assert.equal((await ctxB.store.listEntries()).length, 0, 'entries must not leak across memory spaces');
  assert.equal((await ctxA2.store.listEntries()).length, 1, 'the shared space sees the entry');
});

// ---------------------------------------------------------------------------
// user scope independent budget + status surface + health warning
// ---------------------------------------------------------------------------

test('v9 identity: the project index owns the only budget; the user scope is gone', async (t) => {
  const tree = await makeTree(t);
  const config = configFor(tree, {});
  assert.equal('userIndexMaxLines' in config, false, 'userIndexMaxLines no longer exists');
  assert.equal('userIndexMaxBytes' in config, false, 'userIndexMaxBytes no longer exists');

  const paths = pathsFor(tree);
  const store = new tree.mods.store.MemoryStore({ paths, getConfig: () => config });
  await store.ensure();
  const projectIndex = await store.injectedIndex('project');
  assert.equal(projectIndex.maxLines, 200);
  assert.equal(projectIndex.maxBytes, 25 * 1024);

  await assert.rejects(store.injectedIndex('user'), (error) => {
    assert.equal(error.code, 'INVALID_SCOPE', String(error.code));
    return true;
  });

  const runtime = new tree.mods.runtime.MemoryRuntime(fakeHost({ workspaceDir: tree.workspaceDir }), config);
  const pctx = await runtime.storeFor(tree.workspaceDir);
  const service = tree.mods.status.createStatusService(runtime);
  const status = await service.status(pctx);
  assert.equal('userScope' in status, false, 'status must not expose a user scope');
});

test('v9 identity: a non-git workspace without a marker raises a sharing warning', async (t) => {
  const tree = await makeTree(t, { name: 'no-git-ws' });
  const config = configFor(tree);
  const runtime = new tree.mods.runtime.MemoryRuntime(fakeHost({ workspaceDir: tree.workspaceDir }), config);
  const pctx = await runtime.storeFor(tree.workspaceDir);
  assert.equal(pctx.identity?.source, 'workspace');

  const service = tree.mods.status.createStatusService(runtime);
  const status = await service.status(pctx);
  const healthText = JSON.stringify(status.health ?? {});
  assert.match(
    healthText,
    /non-git|非 ?git|marker|共享|shared/i,
    `health must warn about the shared workspace identity: ${healthText.slice(0, 500)}`,
  );
});
