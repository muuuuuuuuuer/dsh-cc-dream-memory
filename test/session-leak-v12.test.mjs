/**
 * v12 Bug 5: runtime.bySession must not leak disposed agent sessions.
 * Contract `docs/superpowers/specs/2026-11-08-v12-review-fixes.md` Bug 5.
 */
import { withCordis } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import { loadModule } from './helpers.mjs';
import { sleep, waitFor } from './v10-helpers.mjs';

let modsPromise;

function mods() {
  if (!modsPromise) {
    modsPromise = (async () => ({
      config: await loadModule('../src/config.js', { requireExports: ['resolveConfig'] }),
      runtime: await loadModule('../src/runtime.js', { requireExports: ['MemoryRuntime'] }),
      inject: await loadModule('../src/inject.js', { requireExports: ['registerInjection'] }),
    }))();
  }
  return modsPromise;
}

function fakeHost({ workspaceDir }) {
  const listeners = new Map();
  const agents = [];
  const services = {
    workingDirectory: { ensure: async () => workspaceDir },
    agents: {
      list: () => agents.slice(),
      get: (id) => agents.find((agent) => agent.id === id),
    },
    systemPrompt: {},
  };
  return {
    services,
    agents,
    addAgent(agent) {
      agents.push(agent);
      return agent;
    },
    get: (name) => services[name],
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
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
  return { id, ctx: withCordis({ systemPrompt: { context: () => () => {} } }) };
}

async function leakEnv(t) {
  const m = await mods();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc-memory-v12-leak-'));
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = m.config.resolveConfig({ memoryRoot: path.join(tmp, 'root') });
  const host = fakeHost({ workspaceDir });
  const runtime = new m.runtime.MemoryRuntime(host, config);
  const disposeInjection = m.inject.registerInjection(host, runtime);
  t.after(async () => {
    try {
      disposeInjection?.();
    } catch {
      /* ignore */
    }
    try {
      await runtime.drain();
    } catch {
      /* ignore */
    }
    await sleep(50);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  return { m, tmp, workspaceDir, config, host, runtime };
}

test('v12 session-leak: 50 disposed agents leave runtime.bySession empty', async (t) => {
  const env = await leakEnv(t);
  assert.equal(typeof env.runtime.bySession, 'object');
  assert.equal(typeof env.runtime.forgetSession, 'function', 'runtime.forgetSession is added in v12');

  for (let index = 0; index < 50; index += 1) {
    const agent = env.host.addAgent(makeAgent(`leak-agent-${index}`));
    await env.runtime.forAgent(agent);
  }
  assert.ok(env.runtime.bySession.size >= 50, `bySession tracks the agents: ${env.runtime.bySession.size}`);

  for (const agent of env.host.agents) {
    env.host.emit('agent/disposed', { agent });
  }
  await waitFor(() => env.runtime.bySession.size === 0, { timeout: 5000 });
  assert.equal(env.runtime.bySession.size, 0, 'inject agent/disposed listens call forgetSession');
});

test('v12 session-leak: bySession has an LRU cap and forgetSession removes all maps', async (t) => {
  const env = await leakEnv(t);
  const cap = typeof env.runtime.bySessionCap === 'number' ? env.runtime.bySessionCap : 500;
  assert.ok(cap >= 100 && cap <= 2000, `bySession cap looks sane: ${cap}`);
  for (let index = 0; index < cap + 40; index += 1) {
    const agent = env.host.addAgent(makeAgent(`cap-agent-${index}`));
    await env.runtime.forAgent(agent);
  }
  assert.ok(env.runtime.bySession.size <= cap, `bySession is capped at ${cap}: ${env.runtime.bySession.size}`);

  const victim = `cap-agent-${cap + 39}`;
  env.runtime.forgetSession(victim);
  assert.equal(env.runtime.bySession.has(victim), false, 'forgetSession removes the session entry');
});
