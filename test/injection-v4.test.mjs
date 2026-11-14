/**
 * v4 regression tests: session-frozen injection, live mode, config/rules forced
 * refreshes, compaction refresh, subagent injection switch and the tightened
 * index budget (100 lines / 8KB).
 *
 * The host is a fake ctx that exposes `agents`, `workingDirectory.ensure`, an
 * event bus (`on`/`emit`) and nothing else; the runtime and store are the real
 * modules, pointed at an os.tmpdir() memory root. `workingDirectory.ensure` is
 * mandatory: without it the runtime would fall back to process.cwd().
 */
import { withCordis } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadModule, makeTempDir } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Module loading / fake host
// ---------------------------------------------------------------------------

let modulesPromise;

function mods() {
  if (!modulesPromise) {
    modulesPromise = (async () => ({
      config: await loadModule('../src/config.js', { requireExports: ['resolveConfig'] }),
      runtime: await loadModule('../src/runtime.js', { requireExports: ['MemoryRuntime'] }),
      inject: await loadModule('../src/inject.js', { requireExports: ['registerInjection'] }),
    }))();
  }
  return modulesPromise;
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

/** One fake agent with a capturing systemPrompt.context registration. */
function makeAgent(id, { header } = {}) {
  const calls = [];
  const agent = {
    id,
    ctx: withCordis({
      systemPrompt: {
        context(options) {
          calls.push(options);
          return () => {};
        },
      },
    }),
    contextCalls: calls,
  };
  if (header !== undefined) agent.session = { header };
  return agent;
}

/** Current injected text of one fake agent ('' before the first registration). */
function agentText(agent) {
  const options = agent.contextCalls.at(-1);
  return options && typeof options.text === 'function' ? String(options.text()) : '';
}

/**
 * Fake plugin context: services via get(), a tiny event bus via on()/emit(),
 * and a mutable agent list. `workingDirectory.ensure` pins the project dir.
 */
function fakeHost({ workspaceDir }) {
  const listeners = new Map();
  const agents = [];
  const services = {
    agents: {
      list: () => [...agents],
      get: (id) => agents.find((agent) => agent.id === id),
    },
    workingDirectory: {
      ensure: async () => workspaceDir,
    },
  };
  return {
    get: (name) => services[name],
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
    },
    agents,
    addAgent(agent) {
      agents.push(agent);
      this.emit('agent/created', { agent });
      return agent;
    },
  };
}

/** Real runtime + real store over a temp memory root and a fake host. */
async function harness(t, { configOverrides = {} } = {}) {
  const modules = await mods();
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = modules.config.resolveConfig({ memoryRoot, ...configOverrides });
  const host = fakeHost({ workspaceDir });
  const runtime = new modules.runtime.MemoryRuntime(host, config);
  const pctx = await runtime.storeFor(workspaceDir);
  const dispose = modules.inject.registerInjection(host, runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  return { modules, tmp, memoryRoot, workspaceDir, config, host, runtime, pctx };
}

function seed(store, name, description, content) {
  return store.saveEntry({ name, type: 'user', description, content });
}

/** Register an agent and wait until its first snapshot is built. */
async function addReadyAgent(host, agent) {
  host.addAgent(agent);
  await waitFor(() => agent.contextCalls.length > 0, { timeout: 4000 });
  return agent;
}

// ---------------------------------------------------------------------------
// 1. session mode: one frozen snapshot per session
// ---------------------------------------------------------------------------

test('session mode freezes the first snapshot; memory writes do not change it', async (t) => {
  const h = await harness(t);
  await seed(h.pctx.store, 'alpha', 'first note', 'alpha body');
  const agent = await addReadyAgent(h.host, makeAgent('session-agent'));
  await waitFor(() => /alpha/.test(agentText(agent)));

  const frozen = agentText(agent);
  assert.match(frozen, /<system-reminder>/, 'the first snapshot is injected');
  assert.match(frozen, /Auto memory is enabled for this project/);
  assert.doesNotMatch(frozen, /beta/, 'beta must not be present before it is saved');

  // Simulate a memory_save + runtime.invalidateInjection(sessionId) write flow.
  await seed(h.pctx.store, 'beta', 'second note', 'beta body');
  h.runtime.invalidateInjection('session-agent');
  await sleep(300);

  assert.equal(agentText(agent), frozen, 'session mode must keep the frozen snapshot after ordinary memory writes');
  assert.doesNotMatch(agentText(agent), /beta/);
});

test('session mode: a configuration override (reason=config) forces a rebuild', async (t) => {
  const h = await harness(t);
  await seed(h.pctx.store, 'alpha', 'first note', 'alpha body');
  const agent = await addReadyAgent(h.host, makeAgent('config-agent'));
  await waitFor(() => /alpha/.test(agentText(agent)));
  await seed(h.pctx.store, 'gamma', 'config-triggered note', 'gamma body');

  const before = agentText(agent);
  assert.doesNotMatch(before, /gamma/);
  await h.runtime.setOverrides({ autoDreamEnabled: true });
  await waitFor(() => /gamma/.test(agentText(agent)));
  assert.match(agentText(agent), /gamma/, 'setOverrides must force a refresh even in session mode');
});

test('session mode: saving rules (reason=rules) forces a rebuild with the new rules', async (t) => {
  const h = await harness(t);
  await seed(h.pctx.store, 'alpha', 'first note', 'alpha body');
  const agent = await addReadyAgent(h.host, makeAgent('rules-agent'));
  await waitFor(() => /alpha/.test(agentText(agent)));
  await seed(h.pctx.store, 'gamma', 'rules-triggered note', 'gamma body');

  await h.runtime.saveRules(h.pctx, 'project', '- V4 PROJECT RULE: verify before relying');
  await waitFor(() => /V4 PROJECT RULE/.test(agentText(agent)));
  const text = agentText(agent);
  assert.match(text, /V4 PROJECT RULE/, 'the new rules must be injected after saveRules');
  assert.match(text, /gamma/, 'the refreshed snapshot must include memory written before the rules change');
});

// ---------------------------------------------------------------------------
// 3. compaction refreshes the frozen snapshot once
// ---------------------------------------------------------------------------

test('a compaction session event refreshes the frozen snapshot', async (t) => {
  const h = await harness(t);
  await seed(h.pctx.store, 'alpha', 'first note', 'alpha body');
  const agent = await addReadyAgent(h.host, makeAgent('compact-agent'));
  await waitFor(() => /alpha/.test(agentText(agent)));
  await seed(h.pctx.store, 'epsilon', 'compaction note', 'epsilon body');
  assert.doesNotMatch(agentText(agent), /epsilon/);

  h.host.emit('session/event', { id: 'compact-agent' }, { type: 'compaction/end' });
  await waitFor(() => /epsilon/.test(agentText(agent)));
  assert.match(agentText(agent), /epsilon/, 'compaction must refresh the frozen snapshot');
});

// ---------------------------------------------------------------------------
// 4. subagentMemory policy
// ---------------------------------------------------------------------------

test('subagentMemory:off skips delegated sessions; shared injects them', async (t) => {
  const parentSessionHeader = { parentSession: 'main-agent' };
  const subagentOriginHeader = { origin: 'subagent' };

  const skipped = await harness(t, { configOverrides: { subagentMemory: 'off' } });
  const main = await addReadyAgent(skipped.host, makeAgent('main-agent'));
  const child = skipped.host.addAgent(makeAgent('child-agent', { header: parentSessionHeader }));
  const origin = skipped.host.addAgent(makeAgent('origin-agent', { header: subagentOriginHeader }));
  await sleep(350);
  assert.ok(main.contextCalls.length > 0, 'the mainline agent must be injected');
  assert.equal(child.contextCalls.length, 0, 'a parentSession child must not register an injection context');
  assert.equal(origin.contextCalls.length, 0, 'an origin:"subagent" session must not register an injection context');

  const included = await harness(t, { configOverrides: { subagentMemory: 'shared' } });
  const childIncluded = included.host.addAgent(makeAgent('child-included', { header: parentSessionHeader }));
  const originIncluded = included.host.addAgent(makeAgent('origin-included', { header: subagentOriginHeader }));
  await waitFor(() => /<system-reminder>/.test(agentText(childIncluded)) && /<system-reminder>/.test(agentText(originIncluded)));
  assert.match(agentText(childIncluded), /<system-reminder>/, 'shared injects child sessions');
  assert.match(agentText(originIncluded), /<system-reminder>/, 'shared injects origin:subagent sessions');
});

test('a delegated session gets no auto recall when subagentMemory is off', async (t) => {
  const h = await harness(t, { configOverrides: { subagentMemory: 'off' } });
  const hooked = (id, header) => {
    const agent = makeAgent(id, { header });
    agent.hooks = [];
    agent.ctx.on = (event) => {
      agent.hooks.push(event);
      return () => {};
    };
    return agent;
  };
  const main = await addReadyAgent(h.host, hooked('main-agent'));
  const child = h.host.addAgent(hooked('child-agent', { parentSession: 'main-agent' }));
  await sleep(350);
  assert.ok(main.hooks.includes('agent/pre-step'), 'the mainline session is hooked');
  assert.deepEqual(child.hooks, [], 'the delegated session is not');
});

// ---------------------------------------------------------------------------
// 5. default budget: 200 lines / 25KB with a budget notice
// ---------------------------------------------------------------------------

test('default budget injects at most 200 lines / 25KB and adds a budget-notice', async (t) => {
  const h = await harness(t);
  const lines = Array.from({ length: 201 }, (_, index) => `- [memory ${index}](memory_${index}.md) — note ${index}`);
  await h.pctx.store.writeIndex(`${lines.join('\n')}\n`);

  const index = await h.pctx.store.injectedIndex();
  assert.equal(index.maxLines, 200, 'default indexMaxLines is 200');
  assert.equal(index.maxBytes, 25 * 1024, 'default indexMaxBytes is 25600');
  assert.equal(index.truncated, true, 'a 201-line index must be truncated for injection');
  assert.equal(index.overflow, true);
  assert.ok(index.lines <= 200, `injected lines (${index.lines}) must be within budget`);

  const agent = await addReadyAgent(h.host, makeAgent('budget-agent'));
  await waitFor(() => /<budget-notice>/.test(agentText(agent)));
  const text = agentText(agent);
  assert.match(text, /<budget-notice>/, 'the injected prompt must warn about the over-budget index');
  assert.match(text, /MEMORY\.md is over its read limit \(201 lines \//, 'budget notice must show the real index size');
  assert.match(text, /<index>/, 'the index block is still injected (truncated)');
  assert.doesNotMatch(text, /memory_200\.md/, 'content past the read limit is not injected');
  assert.match(text, /memory_0\.md/, 'the head of the index stays visible');
  assert.match(text, /index truncated at the read limit/, 'the truncation marker is injected');
  assert.match(text, /memory_0\.md/, 'the oldest head line stays visible');
});


test('the first turn states that memory exists', async (t) => {
  const h = await harness(t);
  const agent = await addReadyAgent(h.host, makeAgent('instructions-agent'));
  await waitFor(() => /<instructions>/.test(agentText(agent)));
  const text = agentText(agent);
  assert.match(text, /You have a persistent memory directory for this project\./, 'the model is told memory exists');
  assert.match(text, /Do not save secrets, one-off tasks/, 'the save/skip rule travels with it');
});

test('v20: a subagent with private memory is injected with its own index', async (t) => {
  const h = await harness(t, {
    configOverrides: { subagentMemory: 'own', agentMemoryPresets: ['reviewer'] },
  });
  const child = makeAgent('child-agent', {
    header: { id: 'child-agent', parentSession: 'main-session', origin: 'subagent', agentPreset: 'reviewer' },
  });
  const childContext = await h.runtime.forAgent(child);
  await childContext.store.saveEntry({
    name: 'reviewer checklist',
    type: 'feedback',
    description: 'private child note',
    content: 'Check the patch carefully before approving it.',
  });

  h.host.addAgent(child);
  await waitFor(() => /reviewer checklist/.test(agentText(child)));
  assert.match(agentText(child), /reviewer checklist/, 'the subagent sees its own note');
  assert.match(agentText(child), /private child note/, 'its description is in the private index');

  const main = await addReadyAgent(h.host, makeAgent('main-session'));
  assert.doesNotMatch(agentText(main), /reviewer checklist/, 'the main session never sees a private agent note');
});
