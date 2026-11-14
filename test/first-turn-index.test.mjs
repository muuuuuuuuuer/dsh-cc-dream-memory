/**
 * First-turn navigation: the injected index lists project notes only.
 * Real inject/runtime/store over os.tmpdir(); no LLM.
 */
import { withCordis } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modules, fakeHost, sleep, waitFor } from './v10-helpers.mjs';

const sleepLocal = sleep;

function makeAgent(id) {
  const calls = [];
  return {
    id,
    contextCalls: calls,
    ctx: withCordis({
      systemPrompt: {
        context(options) {
          calls.push(options);
          return () => {};
        },
      },
    }),
  };
}

function agentText(agent) {
  const options = agent.contextCalls.at(-1);
  return options && typeof options.text === 'function' ? String(options.text()) : '';
}

/** Injection env; cleans up after the async writes drain. */
async function indexEnv(t, configOverrides = {}) {
  const mods = await modules();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc-memory-first-turn-'));
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const host = fakeHost({ workspaceDir });
  const agent = makeAgent('index-agent');
  host.services.agents = { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) };
  host.services.systemPrompt = {};
  const runtime = new mods.runtime.MemoryRuntime(host, config);
  const pctx = await runtime.storeFor(workspaceDir);
  const dispose = mods.inject.registerInjection(host, runtime);
  t.after(async () => {
    try {
      dispose?.();
    } catch {
      /* ignore */
    }
    try {
      await runtime.drain();
    } catch {
      /* ignore */
    }
    await sleepLocal(60);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  await waitFor(() => agent.contextCalls.length > 0);
  return { mods, tmp, memoryRoot, workspaceDir, config, host, runtime, pctx, agent };
}

test('v23 navigation: the user index is gone; project summaries are the only first-turn entries', async (t) => {
  const env = await indexEnv(t, {});
  await env.pctx.store.saveEntry({
    name: 'tone',
    type: 'user',
    description: 'prefers short answers',
    content: 'Prefers short answers.',
  });
  env.runtime.refreshSession(env.agent.id);
  await waitFor(() => /prefers short answers/.test(agentText(env.agent)), { timeout: 6000 });
  const text = agentText(env.agent);
  assert.equal(/<user-index>/.test(text), false, 'no user index is injected');
  assert.match(text, /- \[tone\]\(user_tone\.md\) — prefers short answers/);
});
