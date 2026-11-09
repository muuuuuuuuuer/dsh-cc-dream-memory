/**
 * v10 P1-12: subagent write semantics (`subagentWriteMode: 'shared' | 'off'`).
 * Contract §6. Uses os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { toolsEnv, exists } from './v10-helpers.mjs';

function subagent(id, { parentSession = 'main-session', origin } = {}) {
  const header = {};
  if (parentSession) header.parentSession = parentSession;
  if (origin) header.origin = origin;
  return { id, session: { header } };
}

function mainAgent(id = 'main-session') {
  return { id, session: { header: { id } } };
}

async function seed(env) {
  await env.pctx.store.saveEntry({
    name: 'shared base',
    type: 'user',
    description: 'base note',
    content: 'base body that is long enough to write',
  });
}

test('v10 subagent: config defaults to shared and validates the mode', async (t) => {
  const env = await toolsEnv(t);
  assert.equal(env.config.subagentWriteMode, 'off');
  const invalid = env.mods.config.resolveConfig({ memoryRoot: env.memoryRoot, subagentWriteMode: 'bogus' });
  assert.equal(invalid.subagentWriteMode, 'off', 'invalid mode falls back to off');
  const off = env.mods.config.resolveConfig({ memoryRoot: env.memoryRoot, subagentWriteMode: 'off' });
  assert.equal(off.subagentWriteMode, 'off');
});

test('v10 subagent: shared mode lets a subagent write with its own session provenance', async (t) => {
  const env = await toolsEnv(t, { subagentWriteMode: 'shared' });
  await seed(env);
  const agent = subagent('child-1');
  const saved = await env.definitions.get('memory_save').execute(
    {
      name: 'child memory',
      type: 'user',
      description: 'child description',
      content: 'a child session memory body that is long enough',
      force: true,
    },
    { agent, sessionId: agent.id },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const entry = (await env.pctx.store.listEntries()).find((item) => item.name === 'child memory');
  assert.ok(entry, 'shared mode writes into the current project');
  const read = await env.pctx.store.readEntry(entry.file);
  assert.equal(read.frontmatter.source_session, 'child-1', 'subagent session provenance is preserved');
});

test('v10 subagent: off mode makes write tools readonly but keeps read tools working', async (t) => {
  const env = await toolsEnv(t, { subagentWriteMode: 'off' });
  await seed(env);
  const agent = subagent('child-readonly');
  const exec = { agent, sessionId: agent.id };
  const entries = await env.pctx.store.listEntries();
  const baseFile = entries[0].file;

  const saved = await env.definitions.get('memory_save').execute(
    { name: 'blocked', type: 'user', description: 'd', content: 'blocked body long enough', force: true },
    exec,
  );
  assert.equal(saved.ok, false, JSON.stringify(saved));
  assert.equal(saved.error, 'subagent-readonly');

  const updated = await env.definitions.get('memory_update').execute(
    { file: baseFile, content: 'updated body long enough', force: true },
    exec,
  );
  assert.equal(updated.ok, false);
  assert.equal(updated.error, 'subagent-readonly');

  // v11: only save/update remain model-facing write tools; delete/dream are
  // human/HTTP operations now.
  for (const removed of ['memory_delete', 'memory_dream', 'memory_list', 'memory_refresh']) {
    assert.equal(env.definitions.has(removed), false, `${removed} is not a model tool anymore`);
  }

  // Read-only tools keep working.
  const read = await env.definitions.get('memory_read').execute({ file: baseFile }, exec);
  assert.equal(read.ok, true, JSON.stringify(read));
  const found = await env.definitions.get('memory_search').execute({ query: 'base' }, exec);
  assert.equal(found.ok, true, JSON.stringify(found));

  // Nothing was written.
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, 'user_blocked.md')), false);
});

test('v10 subagent: main agents are unaffected and status exposes subagentPolicy', async (t) => {
  const env = await toolsEnv(t, { subagentWriteMode: 'off' });
  const main = mainAgent();
  const saved = await env.definitions.get('memory_save').execute(
    { name: 'main memory', type: 'user', description: 'd', content: 'main body long enough to write', force: true },
    { agent: main, sessionId: main.id },
  );
  assert.equal(saved.ok, true, 'the main session keeps full write access');

  const service = env.mods.status.createStatusService(env.runtime);
  const status = await service.status(env.pctx, { sessionId: main.id });
  assert.ok(status.subagentPolicy, 'status must expose subagentPolicy');
  assert.equal(typeof status.subagentPolicy.injectSubagents, 'boolean');
  assert.equal(status.subagentPolicy.mode, 'off');
});
