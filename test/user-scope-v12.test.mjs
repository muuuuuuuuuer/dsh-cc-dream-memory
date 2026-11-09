/**
 * v12 design fix 2: the model can save/update memory in the user scope; the
 * tool budget still holds.
 * Contract §设计问题修复 2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { toolsEnv, exists } from './v10-helpers.mjs';

const BUDGET_CHARS = 3000;

function toolBudget(definitions) {
  const payload = [...definitions.values()].map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }));
  return JSON.stringify(payload).length;
}

test('v12 user-scope: memory_save can write into the user scope', async (t) => {
  const env = await toolsEnv(t, { userMemoryEnabled: true });
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const saved = await env.definitions.get('memory_save').execute(
    {
      scope: 'user',
      name: 'user scoped note',
      type: 'user',
      description: 'a user-level preference',
      content: '用户偏好：回答简短。',
    },
    exec,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(typeof saved.file, 'string');
  assert.equal(await exists(path.join(env.pctx.paths.userMemoryDir, saved.file)), true, 'the file lands in the user memory dir');
  const userIndex = await env.pctx.store.injectedIndex('user');
  assert.match(userIndex.text, /user scoped note/);
  const projectIndex = await env.pctx.store.injectedIndex('project');
  assert.doesNotMatch(projectIndex.text, /user scoped note/);

  const entries = await env.pctx.store.listEntries('user');
  assert.equal(entries.some((entry) => entry.name === 'user scoped note'), true);
});

test('v12 user-scope: memory_search scope user finds it; memory_update scope user edits it', async (t) => {
  const env = await toolsEnv(t, { userMemoryEnabled: true });
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const saved = await env.definitions.get('memory_save').execute(
    { scope: 'user', name: 'searchable user', type: 'user', description: 'd', content: 'user scope zebra marker' },
    exec,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const found = await env.definitions.get('memory_search').execute({ query: 'zebra', scope: 'user' }, exec);
  assert.equal(found.ok, true, JSON.stringify(found));
  const hits = found.items ?? found.hits ?? [];
  assert.equal(hits.some((hit) => hit.file === saved.file), true, JSON.stringify(hits));

  const projectSearch = await env.definitions.get('memory_search').execute({ query: 'zebra' }, exec);
  const projectHits = projectSearch.items ?? projectSearch.hits ?? [];
  assert.equal(projectHits.some((hit) => hit.file === saved.file), false, 'the default scope stays project');

  const updated = await env.definitions.get('memory_update').execute(
    { file: saved.file, scope: 'user', content: 'user scope zebra marker v2' },
    exec,
  );
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const entry = await env.pctx.store.readEntry(saved.file, 'user');
  assert.match(entry.body, /v2/);
});

test('v12 user-scope: tool schemas expose scope and the budget stays within 3000 chars', async (t) => {
  const env = await toolsEnv(t);
  for (const name of ['memory_save', 'memory_update', 'memory_search', 'memory_read']) {
    const definition = env.definitions.get(name);
    assert.ok(definition, `${name} is registered`);
    assert.ok(definition.parameters.properties.scope, `${name} accepts a scope parameter`);
  }
  const size = toolBudget(env.definitions);
  assert.ok(size <= BUDGET_CHARS, `tool descriptions+schemas are ${size} chars, budget is ${BUDGET_CHARS}`);
});
