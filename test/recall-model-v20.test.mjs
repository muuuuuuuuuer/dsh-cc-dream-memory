/**
 * Model-backed recall (v23): a cheap selector call chooses up to five topic
 * files from the manifest. There is no lexical fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { attachRecall, RECALL_SOURCE_KIND } from '../src/recall.js';
import { stringifyFrontmatter } from '../src/frontmatter.js';
import { runtimeEnv, streamOf } from './v10-helpers.mjs';

const userMessage = (text) => ({ role: 'user', id: 'u1', content: [{ type: 'text', text }], source: { kind: 'user' } });

function fakeAgentCtx() {
  const handlers = [];
  return {
    on(event, handler) {
      assert.equal(event, 'agent/pre-step');
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    async preStep(messages, base = { kind: 'enter', messages: [...messages] }) {
      const run = (index) => (index < handlers.length
        ? handlers[index]({ messages, signal: new AbortController().signal }, () => run(index + 1))
        : Promise.resolve(base));
      return run(0);
    },
  };
}

function reply(text) {
  return streamOf([{ type: 'text-delta', text }, { type: 'finish', reason: { kind: 'stop' } }]);
}

async function modelRecallEnv(t, config = {}) {
  const env = await runtimeEnv(t, { recallMode: 'model', ...config });
  await env.pctx.store.saveEntry({
    name: 'deployment',
    type: 'project',
    description: '项目部署平台：GCP Cloud Run，AWS 已不再使用',
    content: '部署走 GCP Cloud Run，生产发布用 make release。',
  });
  const file = (await env.pctx.store.listEntries('project'))[0].file;
  const calls = [];
  env.host.services.llm = {
    stream(options) {
      calls.push(options);
      return reply(config.__reply ?? JSON.stringify({ selected_memories: [file] }));
    },
  };
  const agentCtx = fakeAgentCtx();
  const agent = { id: 'session-1', ctx: agentCtx };
  env.runtime.forAgent = async () => env.pctx;
  const dispose = attachRecall({ agent, agentCtx, runtime: env.runtime, config: () => env.runtime.config });
  return { env, agentCtx, dispose, calls, file };
}

test('model recall selects a memory the query does not lexically match', async (t) => {
  const { agentCtx, calls, file } = await modelRecallEnv(t);
  const decision = await agentCtx.preStep([userMessage('上线前要检查什么')]);
  assert.equal(decision.messages.length, 2);
  const text = decision.messages[1].content[0].text;
  assert.equal(decision.messages[1].source.kind, RECALL_SOURCE_KIND);
  assert.match(text, /部署走 GCP Cloud Run/);
  assert.equal(calls.length, 1, 'one selector call per user turn');
  const prompt = calls[0].messages.map((message) => message.content).flat().map((block) => block.text).join('\n');
  assert.match(prompt, /上线前要检查什么/);
  assert.match(prompt, new RegExp(file.replace(/\./g, '\\.')));
});

test('the selector sees recent tool use so tool docs do not crowd out the answer', async (t) => {
  const { agentCtx, calls } = await modelRecallEnv(t);
  await agentCtx.preStep([
    userMessage('上线前要检查什么'),
    { role: 'assistant', id: 'a1', content: [{ type: 'tool-call', id: 'c1', name: 'memory_read', arguments: '{}' }], source: { kind: 'model', provider: 'fake', model: 'fake' } },
  ]);
  const prompt = calls[0].messages.map((message) => message.content).flat().map((block) => block.text).join('\n');
  assert.match(prompt, /memory_read/);
});

test('an invalid selector reply attaches nothing (no second ranker)', async (t) => {
  const { agentCtx } = await modelRecallEnv(t, { __reply: 'not json at all' });
  const decision = await agentCtx.preStep([userMessage('把服务部署到 cloud run 要注意什么')]);
  assert.equal(decision.messages.length, 1);
});

test('a selector transport error attaches nothing', async (t) => {
  const env = await runtimeEnv(t, { recallMode: 'model' });
  await env.pctx.store.saveEntry({
    name: 'deployment',
    type: 'project',
    description: '项目部署平台：GCP Cloud Run',
    content: '部署走 GCP Cloud Run。',
  });
  env.host.services.llm = { stream() { throw new Error('transport failed'); } };
  const agentCtx = fakeAgentCtx();
  env.runtime.forAgent = async () => env.pctx;
  attachRecall({ agent: { id: 's1', ctx: agentCtx }, agentCtx, runtime: env.runtime, config: () => env.runtime.config });
  const decision = await agentCtx.preStep([userMessage('把服务部署到 cloud run 要注意什么')]);
  assert.equal(decision.messages.length, 1);
});

test('a selected file is attached once per session', async (t) => {
  const { agentCtx, calls } = await modelRecallEnv(t);
  assert.equal((await agentCtx.preStep([userMessage('上线前要检查什么')])).messages.length, 2);
  assert.equal((await agentCtx.preStep([userMessage('上线前要检查什么')])).messages.length, 1);
  assert.equal(calls.length, 1, 'the same user turn does not call the selector again');
});

test('the selector runs once per user turn, not once per model step', async (t) => {
  const { agentCtx, calls } = await modelRecallEnv(t);
  const assistant = {
    role: 'assistant',
    id: 'a1',
    content: [{ type: 'text', text: '先检查部署配置。' }],
    source: { kind: 'model', provider: 'fake', model: 'fake' },
  };
  const first = await agentCtx.preStep([userMessage('上线前要检查什么')]);
  assert.equal(first.messages.length, 2);
  assert.equal(calls.length, 1);

  // A second model step in the same user turn must not call the selector.
  const second = await agentCtx.preStep([userMessage('上线前要检查什么'), assistant]);
  assert.equal(second.messages.length, 2);
  assert.equal(calls.length, 1);

  // A new user message with every candidate already shown sends no new files
  // and does not spend another selector call.
  const nextUser = { ...userMessage('上线前要检查什么'), id: 'u2' };
  const third = await agentCtx.preStep([nextUser]);
  assert.equal(calls.length, 1);
  assert.equal(third.messages.length, 1);
});

test('recall reuses candidate status and notices a hand-edited retirement', async (t) => {
  const { env, agentCtx, calls, file } = await modelRecallEnv(t);
  const { store, paths } = env.pctx;
  const other = await store.saveEntry({ name: 'Recovery notes', type: 'project', content: 'Use a backup.' });
  const target = path.join(paths.memoryDir, other.file);
  const read = store.readEntry.bind(store);
  const reads = [];
  store.readEntry = async (file, ...args) => {
    reads.push(file);
    return read(file, ...args);
  };
  const turn = (id) => agentCtx.preStep([{ ...userMessage('上线前要检查什么'), id }]);
  await turn('u1');
  assert.ok(calls[0].messages[0].content[0].text.includes(other.file));

  await store.saveEntry({ name: 'Archived deployment', type: 'project', content: 'STATUS: retired\nOld approach.' });
  const priorContentReads = store.contentReads;
  reads.length = 0;
  await turn('u2');
  assert.deepEqual(reads, [], 'current candidates and the already shown page need no body read');
  assert.equal(store.contentReads - priorContentReads, 1, 'only the newly added page needs classification');
  assert.equal(calls.length, 2);

  await fs.appendFile(target, '\nSTATUS: retired\n');
  await turn('u3');
  assert.equal(calls.length, 2, 'the only unseen page was retired by the edit');
  assert.ok(!reads.includes(file));
});

test('the default selector budget includes an old note matched only by its current body', async (t) => {
  const { env, agentCtx } = await modelRecallEnv(t);
  const dir = env.pctx.paths.memoryDir;
  const file = 'project_recovery.md';
  await fs.writeFile(path.join(dir, file), stringifyFrontmatter({
    name: 'Recovery', description: 'Observations from maintenance', type: 'project', modified: '2001-01-01',
  }, '## Windows staging\n\nFlush the DNS cache after EALIAS.\nApplies when: corporate VPN is connected.\n\n## History\n\nEOLDALIAS used a reboot.'));
  for (let index = 0; index < 90; index++) {
    await fs.writeFile(path.join(dir, `project_noise_${index}.md`), stringifyFrontmatter({
      name: `Operations note ${index}`, type: 'project', modified: '2025-01-01',
      description: 'Review team handoff and approval procedures when preparing the monthly planning documents, interview feedback, and onboarding invitations.',
    }, 'Internal administrative tasks.'));
  }
  const prompts = [];
  env.host.services.llm.stream = (options) => {
    const prompt = options.messages[0].content[0].text;
    prompts.push(prompt);
    return reply(JSON.stringify({ selected_memories: prompt.includes(file) ? [file] : [] }));
  };
  const decision = await agentCtx.preStep([userMessage('EALIAS')]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /project_recovery\.md[^\n]*Windows staging[^\n]*Flush the DNS cache after EALIAS/);
  assert.match(prompts[0], /corporate VPN/);
  assert.doesNotMatch(prompts[0], /EOLDALIAS/);
  assert.equal(decision.messages.length, 2);
  assert.match(decision.messages[1].content[0].text, /Flush the DNS cache after EALIAS/);
  assert.doesNotMatch(decision.messages[1].content[0].text, /EOLDALIAS/);
});

test('body and description hits share the manifest and an unlisted filename cannot be selected', async (t) => {
  const { env, agentCtx, file: unlisted } = await modelRecallEnv(t, { recallMaxCandidates: 2 });
  const save = (name, description, content) => env.pctx.store.writeRawEntry(name, { type: 'project', description, body: content });
  const bodyHit = 'project_body_hit.md';
  const descriptionHit = 'project_description_hit.md';
  await save(bodyHit, 'Maintenance', 'Refresh the resolver for EALIAS.');
  await save(descriptionHit, 'EALIAS deployment guidance', 'Use the staging playbook.');
  let prompt;
  env.host.services.llm.stream = (options) => {
    prompt = options.messages[0].content[0].text;
    return reply(JSON.stringify({ selected_memories: [unlisted] }));
  };
  const decision = await agentCtx.preStep([userMessage('EALIAS')]);
  assert.ok(prompt.includes(bodyHit));
  assert.ok(prompt.includes(descriptionHit));
  assert.ok(!prompt.includes(unlisted));
  assert.equal(decision.messages.length, 1);
});

test('history and credential-bearing bodies are omitted from candidate matching', async (t) => {
  const { env, agentCtx, file } = await modelRecallEnv(t, { recallMaxCandidates: 1 });
  const dir = env.pctx.paths.memoryDir;
  const write = (name, body) => fs.writeFile(path.join(dir, name), stringifyFrontmatter({
    name: 'Operations', type: 'project', modified: '2000-01-01',
  }, body));
  await write('project_history.md', 'Use the current approach.\n\n## History\n\nEOLDALIAS once required a reboot.');
  await write('project_credential.md', 'EOLDALIAS diagnostics.\n\npassword: synthetic-credential-123');
  let prompt;
  env.host.services.llm.stream = (options) => {
    prompt = options.messages[0].content[0].text;
    return reply('{"selected_memories":[]}');
  };
  const decision = await agentCtx.preStep([userMessage('EOLDALIAS')]);
  assert.ok(prompt.includes(file));
  assert.doesNotMatch(prompt, /project_history|project_credential|synthetic-credential/);
  assert.equal(decision.messages.length, 1);
});

test('recall does not attach bytes edited after the selector saw a candidate', async (t) => {
  const { env, agentCtx, file } = await modelRecallEnv(t);
  const target = path.join(env.pctx.paths.memoryDir, file);
  env.host.services.llm.stream = async function* () {
    await fs.appendFile(target, '\nThis now describes a different procedure.');
    yield* reply(JSON.stringify({ selected_memories: [file] }));
  };
  const decision = await agentCtx.preStep([userMessage('Cloud Run')]);
  assert.equal(decision.messages.length, 1);
});

test('recallMode off disables the selector', async (t) => {
  const env = await runtimeEnv(t, { recallMode: 'off' });
  await env.pctx.store.saveEntry({ name: 'deployment', type: 'project', description: 'cloud run', content: '部署走 GCP Cloud Run。' });
  const calls = [];
  env.host.services.llm = { stream() { calls.push(true); return reply('{}'); } };
  const agentCtx = fakeAgentCtx();
  env.runtime.forAgent = async () => env.pctx;
  attachRecall({ agent: { id: 's1', ctx: agentCtx }, agentCtx, runtime: env.runtime, config: () => env.runtime.config });
  const decision = await agentCtx.preStep([userMessage('把服务部署到 cloud run')]);
  assert.equal(decision.messages.length, 1);
  assert.equal(calls.length, 0);
});
