/**
 * Per-agent memory (v20): a subagent with an allowed preset gets its own
 * `agents/<preset>/memory` store, injected into that subagent only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { toolsEnv } from './v10-helpers.mjs';

function delegated(id, preset = 'reviewer') {
  return {
    id,
    session: {
      header: {
        id,
        parentSession: 'main-session',
        origin: 'subagent',
        ...(preset === undefined ? {} : { agentPreset: preset }),
      },
    },
  };
}

const mainAgent = { id: 'main-session', session: { header: { id: 'main-session' } } };

test('an allowed subagent resolves to its own agents/<preset>/memory store', async (t) => {
  const env = await toolsEnv(t, { subagentMemory: 'own', agentMemoryPresets: ['reviewer'] });
  const agent = delegated('child-1', 'reviewer');
  const child = await env.runtime.forAgent(agent);
  assert.equal(child.paths.memoryDir, path.join(env.pctx.paths.projectDir, 'agents', 'reviewer', 'memory'));
  assert.equal(child.agentMemory, true);
  assert.equal(child.agentMemoryName, 'reviewer');

  const main = await env.runtime.forAgent(mainAgent);
  assert.equal(main.paths.memoryDir, env.pctx.paths.memoryDir, 'the main session keeps the project store');
});

test('a preset outside the allowlist stays on the shared store and writes are blocked', async (t) => {
  const env = await toolsEnv(t, { subagentMemory: 'own', agentMemoryPresets: ['reviewer'] });
  const agent = delegated('child-2', 'implementer');
  const ctx = await env.runtime.forAgent(agent);
  assert.equal(ctx.paths.memoryDir, env.pctx.paths.memoryDir, 'not allowlisted, no private dir');
  const saved = await env.definitions.get('memory_save').execute(
    { name: 'child note', type: 'project', description: 'd', content: 'a child memory body long enough', force: true },
    { agent, sessionId: agent.id },
  );
  assert.equal(saved.ok, false, JSON.stringify(saved));
  assert.equal(saved.error, 'subagent-readonly');
});

test('an allowed subagent writes only into its own directory, never the project store', async (t) => {
  const env = await toolsEnv(t, { subagentMemory: 'own', agentMemoryPresets: ['reviewer'] });
  const agent = delegated('child-3', 'reviewer');
  const saved = await env.definitions.get('memory_save').execute(
    { name: 'review habit', type: 'feedback', description: 'child only', content: 'child body that is long enough to write', force: true },
    { agent, sessionId: agent.id },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const child = await env.runtime.forAgent(agent);
  const childEntries = await child.store.listEntries('project');
  assert.equal(childEntries.length, 1);
  assert.equal(childEntries[0].name, 'review habit');
  assert.equal((await env.pctx.store.listEntries('project')).length, 0, 'the project store is untouched');
  assert.equal(saved.scope, 'project');
  const raw = await child.store.readEntry(childEntries[0].file);
  assert.match(raw.raw, /child body/);
});

test('a delegated agent without an agentPreset has no private directory', async (t) => {
  const env = await toolsEnv(t, { subagentMemory: 'own', agentMemoryPresets: [] });
  const agent = delegated('child-4', null);
  const ctx = await env.runtime.forAgent(agent);
  assert.equal(ctx.paths.memoryDir, env.pctx.paths.memoryDir);
});

test('subagentMemory defaults to off', async (t) => {
  const env = await toolsEnv(t);
  const agent = delegated('child-5', 'reviewer');
  const ctx = await env.runtime.forAgent(agent);
  assert.equal(ctx.paths.memoryDir, env.pctx.paths.memoryDir);
  assert.equal(ctx.agentMemory, undefined);
});
