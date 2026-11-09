/**
 * v9 P0: in-session instant refresh (live/auto session mode, manual refresh).
 *
 * Contract: docs/superpowers/specs/2026-11-07-v9-p0-contract.md §3.
 * Fake host + real runtime/store/inject in os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadModule } from './helpers.mjs';

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
      inject: await loadModule('../src/inject.js', { requireExports: ['registerInjection'] }),
      tools: await loadModule('../src/tools.js', { requireExports: ['registerTools'] }),
      commands: await loadModule('../src/commands.js', { requireExports: ['registerCommands'] }),
      status: await loadModule('../src/status.js', { requireExports: ['createStatusService'] }),
    }))();
  }
  return modulesPromise;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 5000, interval = 25 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const value = await check();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error('condition was not satisfied within the timeout');
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

function makeAgent(id) {
  const calls = [];
  return {
    id,
    contextCalls: calls,
    ctx: {
      systemPrompt: {
        context(options) {
          calls.push(options);
          return () => {};
        },
      },
    },
  };
}

function agentText(agent) {
  const options = agent.contextCalls.at(-1);
  return options && typeof options.text === 'function' ? String(options.text()) : '';
}

/**
 * Real runtime + store + injection attached to one fake agent. The temp dir is
 * removed only after the injection disposer ran and every tracked background
 * write drained, so cleanup never races the filesystem.
 */
async function injectionEnv(t, configOverrides = {}) {
  const mods = await modules();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc-memory-v9-refresh-'));
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const host = fakeHost({ workspaceDir });
  const agent = makeAgent('session-agent');
  host.services.agents = { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) };
  host.services.systemPrompt = {};
  const memoryRuntime = new mods.runtime.MemoryRuntime(host, config);
  const pctx = await memoryRuntime.storeFor(workspaceDir);
  const disposeInjection = mods.inject.registerInjection(host, memoryRuntime);
  t.after(async () => {
    try {
      if (typeof disposeInjection === 'function') disposeInjection();
    } catch {
      /* ignore */
    }
    try {
      await memoryRuntime.drain();
    } catch {
      /* ignore */
    }
    await sleep(80);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  await waitFor(() => agent.contextCalls.length > 0);
  return { mods, tmp, memoryRoot, workspaceDir, config, host, runtime: memoryRuntime, pctx, agent, disposeInjection };
}

/** Register the memory tools against the same fake host. */
async function withTools(env, t) {
  const definitions = new Map();
  env.host.services.tools = {
    register(definition) {
      definitions.set(definition.name, definition);
      return () => {};
    },
  };
  const dispose = env.mods.tools.registerTools(env.host, env.runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  return { definitions, dispose };
}

/** Seed a memory file, then force a manual refresh and wait for the text. */
async function seedWithRefresh(env, name, body, marker) {
  await env.pctx.store.saveEntry({ name, type: 'user', description: `${name} description`, content: body });
  env.runtime.refreshSession(env.agent.id);
  await waitFor(() => new RegExp(marker).test(agentText(env.agent)));
}

// ---------------------------------------------------------------------------
// Session mode API + manual refresh
// ---------------------------------------------------------------------------

test('v9 refresh: setSessionMode/sessionMode/refreshSession session API', async (t) => {
  const env = await injectionEnv(t);
  const runtime = env.runtime;

  assert.equal(typeof runtime.setSessionMode, 'function');
  assert.equal(typeof runtime.sessionMode, 'function');
  assert.equal(typeof runtime.refreshSession, 'function');
  assert.equal(runtime.sessionMode('session-agent'), 'auto', 'sessions start in auto mode');

  await runtime.setSessionMode('session-agent', 'live');
  assert.equal(runtime.sessionMode('session-agent'), 'live');
  await runtime.setSessionMode('session-agent', 'auto');
  assert.equal(runtime.sessionMode('session-agent'), 'auto');
  await runtime.setSessionMode('session-agent', 'bogus');
  assert.equal(runtime.sessionMode('session-agent'), 'auto', 'an invalid session mode does not stick');

  const invalidations = [];
  runtime.onInvalidate((info) => invalidations.push(info));
  runtime.refreshSession('session-agent');
  assert.ok(
    invalidations.some((info) => info.sessionId === 'session-agent' && info.reason === 'manual'),
    `refreshSession must invalidate with reason "manual", saw ${JSON.stringify(invalidations)}`,
  );
});

// ---------------------------------------------------------------------------
// live sessions refresh after memory_save
// ---------------------------------------------------------------------------

test('v9 refresh: a live session refreshes its injection after memory_save', async (t) => {
  const env = await injectionEnv(t);
  const { definitions } = await withTools(env, t);
  await seedWithRefresh(env, 'alpha', 'alpha body', 'alpha');

  await env.runtime.setSessionMode(env.agent.id, 'live');
  const saved = await definitions.get('memory_save').execute(
    { name: 'beta', type: 'user', description: 'live refresh note', content: 'beta body from a live session' },
    { agent: env.agent, sessionId: env.agent.id },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  await waitFor(() => /beta/.test(agentText(env.agent)));
  assert.match(agentText(env.agent), /beta/, 'live mode must pick up the write immediately');
});

// ---------------------------------------------------------------------------
// manual refresh overrides the frozen (session-mode) snapshot
// ---------------------------------------------------------------------------

test('v9 refresh: refreshSession (manual) rebuilds a frozen snapshot', async (t) => {
  const env = await injectionEnv(t); // config injectionMode defaults to session (frozen)
  await seedWithRefresh(env, 'alpha', 'alpha body', 'alpha');
  const frozen = agentText(env.agent);

  await env.pctx.store.saveEntry({ name: 'gamma', type: 'user', description: 'later note', content: 'gamma body' });
  await sleep(120);
  assert.equal(agentText(env.agent), frozen, 'the frozen snapshot ignores plain writes');
  assert.doesNotMatch(agentText(env.agent), /gamma/);

  env.runtime.refreshSession(env.agent.id);
  await waitFor(() => /gamma/.test(agentText(env.agent)));
  assert.match(agentText(env.agent), /gamma/, 'a manual refresh overrides the session freeze');
});

// ---------------------------------------------------------------------------
// memory_refresh tool + /memory refresh + /memory live commands
// ---------------------------------------------------------------------------

test('v9 refresh: memory_refresh is no longer a model tool; manual refresh still rebuilds', async (t) => {
  const env = await injectionEnv(t);
  const { definitions } = await withTools(env, t);
  await seedWithRefresh(env, 'alpha', 'alpha body', 'alpha');
  await env.pctx.store.saveEntry({ name: 'delta', type: 'user', description: 'manual refresh', content: 'delta body' });

  // v11 trims the model-facing tools to save/update/read/search.
  assert.equal(definitions.has('memory_refresh'), false, 'memory_refresh must not be registered for the model');
  env.runtime.refreshSession(env.agent.id);
  await waitFor(() => /delta/.test(agentText(env.agent)));
  assert.match(agentText(env.agent), /delta/, 'a manual refresh rebuilds the frozen snapshot');
});

test('v9 refresh: /memory refresh and /memory live on|off commands', async (t) => {
  const env = await injectionEnv(t);
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
  assert.ok(memory);
  const invoke = (rawInput) => memory.handler({ rawInput, agent: env.agent, sessionId: env.agent.id });

  await seedWithRefresh(env, 'alpha', 'alpha body', 'alpha');
  await env.pctx.store.saveEntry({ name: 'epsilon', type: 'user', description: 'command refresh', content: 'epsilon body' });

  const refresh = await invoke('refresh');
  assert.equal(refresh.kind, 'success', refresh.text);
  assert.match(refresh.text, /epsilon|refresh/i);
  await waitFor(() => /epsilon/.test(agentText(env.agent)));

  const liveOn = await invoke('live on');
  assert.equal(liveOn.kind, 'success', liveOn.text);
  assert.equal(env.runtime.sessionMode(env.agent.id), 'live');
  assert.match(liveOn.text, /live/i);

  const liveOff = await invoke('live off');
  assert.equal(liveOff.kind, 'success', liveOff.text);
  assert.equal(env.runtime.sessionMode(env.agent.id), 'auto');
});

test('v9 refresh: status exposes the per-session live flag', async (t) => {
  const env = await injectionEnv(t);
  const service = env.mods.status.createStatusService(env.runtime);
  let status = await service.status(env.pctx, { sessionId: env.agent.id });
  assert.ok(status.session, 'status must expose a session block');
  assert.equal(status.session.live, false);

  await env.runtime.setSessionMode(env.agent.id, 'live');
  status = await service.status(env.pctx, { sessionId: env.agent.id });
  assert.equal(status.session.live, true, 'status.session.live reflects the session mode');
});
