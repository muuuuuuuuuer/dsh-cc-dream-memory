/**
 * Cross-project user memory layer: type user notes live in one store shared by
 * every project on the machine; the project store is looked at first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveConfig } from '../src/config.js';
import { buildInjectionText, MEMORY_INSTRUCTIONS } from '../src/inject.js';
import { attachRecall } from '../src/recall.js';
import { runtimeEnv, streamOf, toolsEnv } from './v10-helpers.mjs';

const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };

test('config: userMemory defaults to global and accepts project only', () => {
  assert.equal(resolveConfig({}).userMemory, 'global');
  assert.equal(resolveConfig({ userMemory: 'project' }).userMemory, 'project');
  assert.equal(resolveConfig({ userMemory: 'elsewhere' }).userMemory, 'global');
});

test('a type user save goes to the shared user store, other types stay in the project', async (t) => {
  const env = await toolsEnv(t);
  const save = env.definitions.get('memory_save');
  const person = await save.execute({ name: 'role', type: 'user', description: 'who I am', content: 'Backend engineer.' }, exec);
  const fact = await save.execute({ name: 'deploy', type: 'project', description: 'how we deploy', content: 'Deploys use make release.' }, exec);
  assert.equal(person.scope, 'user');
  assert.equal(fact.scope, 'project');
  const user = await env.runtime.userContext(env.pctx);
  assert.equal(user.paths.memoryDir, path.join(env.memoryRoot, 'user', 'memory'));
  assert.deepEqual((await user.store.listEntries()).map((entry) => entry.file), [person.file]);
  assert.deepEqual((await env.pctx.store.listEntries()).map((entry) => entry.file), [fact.file]);
  assert.match(await user.store.indexText(), /role/);
  // One shared instance serves every project.
  assert.equal(await env.runtime.userContext(env.pctx), user);
});

test('userMemory project keeps type user notes in the project; a subagent own store has no user layer', async (t) => {
  const env = await toolsEnv(t, { userMemory: 'project' });
  const saved = await env.definitions.get('memory_save').execute({ name: 'role', type: 'user', description: 'd', content: 'Backend engineer.' }, exec);
  assert.equal(saved.scope, 'project');
  assert.equal((await env.pctx.store.listEntries()).length, 1);
  assert.equal(await env.runtime.userContext(env.pctx), undefined);
  const own = await toolsEnv(t);
  assert.equal(await own.runtime.userContext({ ...own.pctx, agentMemory: true }), undefined);
});

test('memory_read, memory_update and memory_search look in the project store, then the user store', async (t) => {
  const env = await toolsEnv(t);
  const { store } = await env.runtime.userContext(env.pctx);
  const person = await store.saveEntry({ name: 'role', type: 'user', description: 'who I am', content: 'Backend engineer, prefers Go.' });
  await env.pctx.store.saveEntry({ name: 'goroutines', type: 'project', description: 'Go concurrency notes', content: 'Use errgroup for Go fan-out.' });

  const read = await env.definitions.get('memory_read').execute({ file: person.file }, exec);
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.scope, 'user');

  const updated = await env.definitions.get('memory_update').execute({ file: person.file, content: 'Backend engineer, prefers Rust.', expectedHash: read.hash }, exec);
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.scope, 'user');
  assert.match((await store.readEntry(person.file)).body, /Rust/);
  assert.equal((await env.pctx.store.listEntries()).length, 1, 'nothing was copied into the project');

  const found = await env.definitions.get('memory_search').execute({ query: 'Go' }, exec);
  assert.equal(found.ok, true);
  assert.deepEqual(new Set(found.items.map((item) => item.scope)), new Set(['project']));
  const rust = await env.definitions.get('memory_search').execute({ query: 'Rust engineer' }, exec);
  assert.deepEqual(rust.items.map((item) => [item.scope, item.file]), [['user', person.file]]);

  const missing = await env.definitions.get('memory_read').execute({ file: 'user_nope.md' }, exec);
  assert.equal(missing.error, 'NOT_FOUND');
});

test('the injected snapshot carries a separate user index and the privacy line', () => {
  const text = buildInjectionText({ index: { text: '- [Deploy](project_deploy.md) — x\n' }, userIndex: { text: '- [Role](user_role.md) — who I am\n' } });
  assert.match(text, /<index>\n- \[Deploy\]/);
  assert.match(text, /<user-index scope="all projects on this machine">\n- \[Role\]\(user_role\.md\)/);
  assert.doesNotMatch(buildInjectionText({ index: { text: '' }, userIndex: { text: '' } }), /user-index/);
  assert.match(MEMORY_INSTRUCTIONS, /user notes are shared across all projects on this machine/);
  assert.doesNotMatch(MEMORY_INSTRUCTIONS, /Private to this project\.$/m);
});

test('recall offers user notes as scope user and reads them from the user store', async (t) => {
  const env = await runtimeEnv(t, { recallMode: 'model' });
  const { store } = await env.runtime.userContext(env.pctx);
  // The same file name exists in both layers: the selector must be able to tell them apart.
  const person = await store.saveEntry({ name: 'role', type: 'user', description: 'who I am', content: 'STATUS: current\nUser is a Rust engineer.' });
  await env.pctx.store.saveEntry({ name: 'role', type: 'user', description: 'project-local role', content: 'STATUS: current\nProject-local role note.' });
  const prompts = [];
  env.host.services.llm = {
    stream(options) {
      prompts.push(options.messages.flatMap((message) => message.content).map((block) => block.text).join('\n'));
      return streamOf([{ type: 'text-delta', text: JSON.stringify({ selected_memories: [`user/${person.file}`] }) }, { type: 'finish', reason: { kind: 'stop' } }]);
    },
  };
  const handlers = [];
  const agentCtx = { on: (_event, handler) => { handlers.push(handler); return () => {}; } };
  env.runtime.forAgent = async () => env.pctx;
  attachRecall({ agent: { id: 's1', ctx: agentCtx }, agentCtx, runtime: env.runtime, config: () => env.runtime.config });
  const messages = [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'what do I do for a living' }], source: { kind: 'user' } }];
  const decision = await handlers[0]({ messages, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [...messages] }));
  assert.match(prompts[0], new RegExp(`user/${person.file.replace('.', '\\.')}`));
  const text = decision.messages.at(-1).content[0].text;
  assert.match(text, /## user\/user_role\.md/);
  assert.match(text, /Rust engineer/);
  assert.doesNotMatch(text, /Project-local role note/);
});

test('the status payload lists the user layer', async (t) => {
  const env = await toolsEnv(t);
  await env.definitions.get('memory_save').execute({ name: 'role', type: 'user', description: 'who I am', content: 'Backend engineer.' }, exec);
  const { createStatusService } = await import('../src/status.js');
  const payload = await createStatusService(env.runtime).status(env.pctx, { sessionId: 'sess-1' });
  assert.equal(payload.userMemory.mode, 'global');
  assert.deepEqual(payload.userMemory.entries.map((entry) => entry.name), ['role']);
  assert.equal(payload.entries.length, 0);
});
