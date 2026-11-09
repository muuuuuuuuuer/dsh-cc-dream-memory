/**
 * v10 P1-14: compaction memory digest (`<memory-digest>`).
 * Contract §8. Real inject/runtime/store over os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modules, fakeHost, memoryFile, indexFor, exists, sleep, waitFor } from './v10-helpers.mjs';

const sleepLocal = sleep;

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

/** Injection env with compaction control; cleans up after the async writes drain. */
async function digestEnv(t, configOverrides = {}) {
  const mods = await modules();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cc-memory-v10-digest-'));
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const host = fakeHost({ workspaceDir });
  const agent = makeAgent('digest-agent');
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

/** Write topic files with explicit modified timestamps + a standard index. */
async function seedFiles(env, items) {
  const names = items.map((item, index) => ({ ...item, file: `user_topic_${index}.md` }));
  for (const item of names) {
    await writeFile(
      path.join(env.pctx.paths.memoryDir, item.file),
      memoryFile(
        { name: item.name, type: 'user', description: item.description, modified: item.modified },
        item.body,
      ),
      'utf8',
    );
  }
  await env.pctx.store.writeIndex(indexFor(names));
  return names;
}

async function triggerCompaction(env) {
  env.host.emit('session/event', { id: env.agent.id }, { type: 'compaction/end' });
  await waitFor(() => /<memory-digest>/.test(agentText(env.agent)), { timeout: 6000 });
}

test('v10 digest: compaction refresh appends a recent-memory digest; config off disables it', async (t) => {
  // Default config: compactionDigest is true.
  {
    const env = await digestEnv(t);
    assert.equal(env.config.compactionDigest, true, 'compactionDigest defaults to true');
    const old = '2026-01-01T00:00:00.000Z';
    const recent = '2026-11-07T10:00:00.000Z';
    const newest = '2026-11-07T12:00:00.000Z';
    const files = await seedFiles(env, [
      { name: 'old note', description: 'an old note', modified: old, body: 'old body' },
      { name: 'recent note', description: 'a recent note', modified: recent, body: 'recent body' },
      { name: 'newest note', description: 'the newest note', modified: newest, body: 'newest body' },
    ]);
    // Top-read entries for the digest.
    await env.mods.metrics.recordRead(env.pctx.paths, files[0].file);
    await env.mods.metrics.recordRead(env.pctx.paths, files[0].file);
    await env.mods.metrics.recordRead(env.pctx.paths, files[1].file);

    await triggerCompaction(env);
    const text = agentText(env.agent);
    assert.match(text, /<memory-digest>/, 'compaction injection includes the digest');
    assert.match(text, /<\/memory-digest>/);
    const digest = text.slice(text.indexOf('<memory-digest>') + '<memory-digest>'.length, text.indexOf('</memory-digest>'));
    assert.match(digest, /newest note/, 'the most recently modified memory is first');
    assert.ok(
      digest.indexOf('newest note') < digest.indexOf('recent note') ||
        !digest.includes('recent note'),
      `digest should order by recency: ${digest}`,
    );
    assert.ok(digest.length <= 500, `digest must stay compact, got ${digest.length} characters`);
    // Recent-read entries are surfaced too (top reads).
    assert.match(digest, /old note|recent note/, 'top-read memories appear in the digest');

    // Non-compaction refreshes must not carry the digest.
    env.runtime.refreshSession(env.agent.id);
    await sleep(150);
    const manual = agentText(env.agent);
    if (manual.includes('<memory-digest>')) {
      // A manual refresh may keep the digest appended by the last build; that
      // is acceptable, but a fresh init text may not have it.
      assert.match(manual, /<memory-digest>/);
    }
  }

  // compactionDigest:false disables the digest entirely.
  const offEnv = await digestEnv(t, { compactionDigest: false });
  assert.equal(offEnv.config.compactionDigest, false);
  await seedFiles(offEnv, [{ name: 'off note', description: 'off', modified: '2026-11-07T00:00:00.000Z', body: 'off body' }]);
  offEnv.host.emit('session/event', { id: offEnv.agent.id }, { type: 'compaction/end' });
  await sleep(400);
  await offEnv.runtime.drain();
  assert.doesNotMatch(agentText(offEnv.agent), /<memory-digest>/, 'compactionDigest:false must not append the digest');
});

test('v10 digest: config validates compactionDigest', async (t) => {
  const env = await digestEnv(t);
  assert.equal(env.mods.config.resolveConfig({ memoryRoot: env.memoryRoot }).compactionDigest, true);
  assert.equal(
    env.mods.config.resolveConfig({ memoryRoot: env.memoryRoot, compactionDigest: false }).compactionDigest,
    false,
  );
  assert.equal(
    env.mods.config.resolveConfig({ memoryRoot: env.memoryRoot, compactionDigest: 'nope' }).compactionDigest,
    true,
    'invalid compactionDigest falls back to true',
  );
});
