/**
 * v11 step 2b: model-facing tool surface trimmed to four tools with a hard
 * description+schema budget (contract §2 tools.js, second phase).
 *
 * os.tmpdir(); no LLM.
 */
import { withCordis } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandEnv, runtimeEnv } from './v10-helpers.mjs';
import { loadModule } from './helpers.mjs';

const MODEL_TOOLS = ['memory_read', 'memory_save', 'memory_search', 'memory_update'];
const REMOVED_TOOLS = ['memory_delete', 'memory_dream', 'memory_list', 'memory_recall', 'memory_refresh', 'memory_status'];
const BUDGET_CHARS = 3000;

let toolsPromise;

function toolsModule() {
  if (!toolsPromise) {
    toolsPromise = loadModule('../src/tools.js', { requireExports: ['registerTools'] });
  }
  return toolsPromise;
}

async function registerCaptured(env) {
  const { registerTools } = await toolsModule();
  const definitions = new Map();
  const register = (definition) => {
    definitions.set(definition.name, definition);
    return () => {};
  };
  const dispose = registerTools(withCordis({ tools: { register } }), env.runtime);
  return { definitions, dispose };
}

function serializedSize(definitions) {
  const payload = [...definitions.values()].map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }));
  return JSON.stringify(payload).length;
}

test('v11 tools: only the four model-facing tools are registered', async (t) => {
  const env = await runtimeEnv(t);
  const { definitions, dispose } = await registerCaptured(env);
  t.after(() => dispose?.());
  assert.deepEqual([...definitions.keys()].sort(), [...MODEL_TOOLS].sort());
  for (const removed of REMOVED_TOOLS) {
    assert.equal(definitions.has(removed), false, `${removed} must not be registered for the model`);
  }
});

test('v11 tools: descriptions + JSON schemas stay within the 3000 character budget', async (t) => {
  const env = await runtimeEnv(t);
  const { definitions, dispose } = await registerCaptured(env);
  t.after(() => dispose?.());
  const size = serializedSize(definitions);
  assert.ok(size <= BUDGET_CHARS, `tool descriptions+schemas are ${size} chars, budget is ${BUDGET_CHARS}`);
  // Each remaining tool keeps a useful description.
  for (const name of MODEL_TOOLS) {
    const definition = definitions.get(name);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length >= 40, `${name} description is too terse`);
  }
  // The user scope is gone: no tool offers a scope parameter any more.
  for (const name of ['memory_save', 'memory_update', 'memory_search', 'memory_read']) {
    assert.equal(definitions.get(name).parameters.properties.scope, undefined, `${name} must not expose a scope`);
  }
});

test('v11 tools: memory_search absorbed the recall ranking (score/snippets)', async (t) => {
  const env = await runtimeEnv(t);
  const { definitions, dispose } = await registerCaptured(env);
  t.after(() => dispose?.());
  const tool = definitions.get('memory_search');
  assert.ok(tool);
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  await env.pctx.store.saveEntry({
    name: 'search target',
    type: 'user',
    description: 'search description',
    content: 'searchable body about zebra patterns',
  });
  const result = await tool.execute({ query: 'zebra' }, exec);
  assert.equal(result.ok, true, JSON.stringify(result));
  const items = result.items ?? result.hits ?? [];
  assert.ok(items.length >= 1);
  assert.equal(typeof items[0].score, 'number', 'search results rank with a numeric score');
  assert.ok(Array.isArray(items[0].snippets), 'search results carry matched snippets');
});

test('v11 tools: save/read/update semantics still work after the trim', async (t) => {
  const env = await runtimeEnv(t);
  const { definitions, dispose } = await registerCaptured(env);
  t.after(() => dispose?.());
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const saved = await definitions.get('memory_save').execute(
    { name: 'trim note', type: 'project', description: 'trim description', content: 'a plain note body kept across save and read' },
    exec,
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(typeof saved.file, 'string');
  const read = await definitions.get('memory_read').execute({ file: saved.file }, exec);
  assert.equal(read.ok, true, JSON.stringify(read));
  const updated = await definitions.get('memory_update').execute(
    { file: saved.file, content: 'updated body that is long enough' },
    exec,
  );
  assert.equal(updated.ok, true, JSON.stringify(updated));
});

test('v11 tools: a corrected note reads and searches as its current value only', async (t) => {
  const env = await runtimeEnv(t);
  const { definitions, dispose } = await registerCaptured(env);
  t.after(() => dispose?.());
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const saved = await env.pctx.store.saveEntry({
    name: 'release command',
    type: 'project',
    description: 'How releases are cut',
    content: [
      'STATUS: current',
      '',
      'Run `make ship` to cut a release.',
      '',
      '## History',
      '- Superseded: Run `make legacy-deploy` to cut a release. (until 2026-01-01) — (user)',
    ].join('\n'),
  });
  const read = await definitions.get('memory_read').execute({ file: saved.file }, exec);
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.match(read.body, /make ship/);
  assert.equal(read.body.includes('legacy-deploy'), false, 'the read answers with the current value only');
  assert.equal(read.status, 'current');

  const fresh = await definitions.get('memory_search').execute({ query: 'make ship' }, exec);
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.ok(fresh.items.some((item) => item.file === saved.file), 'the current value is searchable');

  const old = await definitions.get('memory_search').execute({ query: 'legacy-deploy' }, exec);
  assert.equal(old.ok, true, JSON.stringify(old));
  assert.equal(old.items.some((item) => item.file === saved.file), false, 'a replaced value is not returned as current');

  // Explicit history still locates the old text (file view / /memory history).
  const raw = await env.pctx.store.readEntry(saved.file);
  assert.match(raw.raw, /make legacy-deploy/);
});

test('v11 tools: human surfaces document the current operations (/memory usage)', async (t) => {
  const env = await commandEnv(t);
  const output = await env.invokeMemory('bogus');
  assert.equal(output.kind, 'error', output.text);
  for (const verb of ['status', 'list', 'delete', 'dream', 'refresh', 'metrics', 'merge', 'history', 'search', 'import', 'export']) {
    assert.match(output.text, new RegExp(`\\b${verb}\\b`), `the command surface still documents /memory ${verb}`);
  }
  assert.doesNotMatch(output.text, /\bwrites\b/, 'the pending-write queue is gone (Claude Code parity)');
});
