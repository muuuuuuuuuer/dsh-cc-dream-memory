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
    async preStep(messages, base = { kind: 'enter', messages: [...messages] }, signal = new AbortController().signal) {
      const run = (index) => (index < handlers.length
        ? handlers[index]({ messages, signal }, () => run(index + 1))
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

test('recall uses the latest typed message even after a long earlier request', async (t) => {
  const { agentCtx, calls } = await modelRecallEnv(t);
  await agentCtx.preStep([
    userMessage('old request '.repeat(500)),
    { ...userMessage('How do I deploy to Cloud Run?'), id: 'u2' },
  ]);
  const prompt = calls[0].messages[0].content[0].text;
  assert.match(prompt, /^User message:\nHow do I deploy to Cloud Run\?\n/u);
  assert.doesNotMatch(prompt, /old request/u);
});

test('concurrent steps for the same user message share a selector attempt', async (t) => {
  const { agentCtx, calls } = await modelRecallEnv(t);
  const messages = [userMessage('Cloud Run')];
  const decisions = await Promise.all([agentCtx.preStep(messages), agentCtx.preStep(messages)]);
  assert.equal(calls.length, 1);
  assert.deepEqual(decisions.map(({ messages }) => messages.length).sort(), [1, 2]);
});

test('a truncated selector reply is discarded without retrying', async (t) => {
  const { env, agentCtx, file } = await modelRecallEnv(t);
  let calls = 0;
  env.host.services.llm.stream = () => {
    calls++;
    return streamOf([
      { type: 'text-delta', text: JSON.stringify({ selected_memories: [file] }) },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]);
  };
  assert.equal((await agentCtx.preStep([userMessage('Cloud Run')])).messages.length, 1);
  assert.equal(calls, 1);
});

test('the recall deadline releases the turn even when the stream ignores abort', { timeout: 2000 }, async (t) => {
  const { env, agentCtx } = await modelRecallEnv(t, { recallTimeoutMs: 100 });
  const { promise, resolve } = Promise.withResolvers();
  let signal;
  let timer;
  env.host.services.llm.stream = async function* (options) {
    signal = options.signal;
    await promise;
    yield* reply('{"selected_memories":[]}');
  };
  try {
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('recall blocked on an uncooperative stream')), 750);
    });
    const decision = await Promise.race([agentCtx.preStep([userMessage('Cloud Run')]), watchdog]);
    assert.equal(decision.messages.length, 1);
    assert.equal(signal?.aborted, true);
  } finally {
    clearTimeout(timer);
    resolve();
  }
});

test('cancelling a turn aborts its selector without waiting for the recall deadline', { timeout: 2000 }, async (t) => {
  const { env, agentCtx } = await modelRecallEnv(t);
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  env.host.services.llm.stream = async function* ({ signal }) {
    started.resolve(signal);
    await release.promise;
    yield* reply('{"selected_memories":[]}');
  };
  const pending = agentCtx.preStep([userMessage('Cloud Run')], undefined, controller.signal);
  try {
    const signal = await started.promise;
    controller.abort();
    assert.equal((await pending).messages.length, 1);
    assert.equal(signal.aborted, true);
  } finally {
    release.resolve();
  }
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

test('handwritten credentials in active bodies or descriptions stay out of automatic recall', async (t) => {
  const { env, agentCtx, file } = await modelRecallEnv(t);
  const bodyFile = 'project_private_body.md';
  const descriptionFile = 'project_private_description.md';
  const credential = 'password: synthetic-credential-123';
  const write = (name, description, body) => fs.writeFile(path.join(env.pctx.paths.memoryDir, name),
    stringifyFrontmatter({ name: 'Operations', type: 'project', description }, body));
  await write(bodyFile, 'Deployment instructions', 'Deploy the service.\n' + credential);
  await write(descriptionFile, credential, 'Deploy the service.');
  let prompt;
  env.host.services.llm.stream = (options) => {
    prompt = options.messages[0].content[0].text;
    return reply(JSON.stringify({ selected_memories: [bodyFile, descriptionFile, file] }));
  };
  const decision = await agentCtx.preStep([userMessage('Cloud Run deployment')]);
  assert.equal(decision.messages.length, 2);
  assert.doesNotMatch(prompt, /project_private_|synthetic-credential/u);
  assert.doesNotMatch(decision.messages[1].content[0].text, /project_private_|synthetic-credential/u);
});

test('a selected long note attaches the matched passage with its own conditions', async (t) => {
  const { env, agentCtx, file } = await modelRecallEnv(t, { autoRecallMaxChars: 620 });
  await env.pctx.store.updateEntry(file, { content: [
    '## Background', '', 'Administrative context. '.repeat(180), '',
    '## Windows staging', '', 'For EALIAS use resolver-fix-v7.', 'Applies when: corporate VPN is connected.',
    'Exception: leave production untouched.', '',
    '## Linux production', '', 'For a different symptom use reboot-v1.', 'Applies when: VPN is disconnected.',
    '', '## History', '', 'An earlier EALIAS fix used retired-v2.',
  ].join('\n') });
  const decision = await agentCtx.preStep([userMessage('EALIAS on Windows staging')]);
  const text = decision.messages[1]?.content[0].text ?? '';
  assert.match(text, /Windows staging[\s\S]*resolver-fix-v7\.[\s\S]*Applies when: corporate VPN is connected\.[\s\S]*Exception: leave production untouched\./);
  assert.match(text, /use memory_read for the rest/);
  assert.doesNotMatch(text, /reboot-v1|VPN is disconnected|retired-v2/);
  assert.ok(text.length <= 620);
});

test('recall keeps a localized exception with the matching paragraph', async (t) => {
  const { env, agentCtx, file } = await modelRecallEnv(t, { autoRecallMaxChars: 620 });
  await env.pctx.store.updateEntry(file, { content: [
    '## Background', '', 'Administrative context. '.repeat(180), '',
    '## Procedure', '', 'For EALIAS in shared mode run amber-bolt-76.', '',
    '**例外：**On shared resolvers use violet-fan-93 instead.',
  ].join('\n') });
  const decision = await agentCtx.preStep([userMessage('EALIAS in shared mode')]);
  assert.match(decision.messages[1]?.content[0].text ?? '', /amber-bolt-76[\s\S]*例外：[\s\S]*violet-fan-93/u);
});

test('recall can attach a different passage from a long note in the same session', async (t) => {
  const { env, agentCtx, calls, file } = await modelRecallEnv(t, { autoRecallMaxChars: 620 });
  await env.pctx.store.updateEntry(file, { content: [
    '## Routing', '', 'For EALIAS use resolver-fix-v7.', 'Confirm by checking healthcheck-v3.', '',
    'Administrative context. '.repeat(200), '',
    '## Releases', '', 'For manifest rotation run archive-v5.',
  ].join('\n') });
  const ask = (id, text) => agentCtx.preStep([{ ...userMessage(text), id }]);
  assert.match((await ask('u1', 'EALIAS')).messages[1]?.content[0].text ?? '', /resolver-fix-v7/u);
  assert.equal((await ask('u2', 'healthcheck-v3')).messages.length, 1);
  const later = (await ask('u3', 'manifest rotation')).messages[1]?.content[0].text ?? '';
  assert.match(later, /archive-v5/u);
  assert.doesNotMatch(later, /resolver-fix-v7/u);
  assert.equal(calls.length, 2);
});

test('recall keeps a short multi-section note in source order', async (t) => {
  const { env, agentCtx, file } = await modelRecallEnv(t);
  await env.pctx.store.updateEntry(file, { content: [
    '## Windows', 'Run win-fix.', 'Applies when: Windows node.', '',
    '## Linux', 'Run linux-fix.', 'Applies when: Linux node.',
  ].join('\n') });
  const decision = await agentCtx.preStep([userMessage('Compare the Windows and Linux commands')]);
  const text = decision.messages[1]?.content[0].text ?? '';
  assert.match(text, /## Windows\nRun win-fix\.\nApplies when: Windows node\.[\s\S]*## Linux\nRun linux-fix\.\nApplies when: Linux node\./);
});

test('a tight budget does not detach a recommendation from its long exception', async (t) => {
  const { env, agentCtx, file } = await modelRecallEnv(t, { autoRecallMaxChars: 430 });
  await env.pctx.store.updateEntry(file, { content: [
    'Use resolver-fix-v7 for EALIAS.',
    'Exception: ' + 'Do not use this if the host is acting as the shared resolver. '.repeat(8),
  ].join('\n') });
  const decision = await agentCtx.preStep([userMessage('EALIAS')]);
  const text = decision.messages[1]?.content[0].text ?? '';
  assert.match(text, /use memory_read for the rest/);
  assert.doesNotMatch(text, /resolver-fix-v7/);
  assert.ok(text.length <= 430);
});

test('a tight multi-file budget keeps a usable read pointer instead of bare file headers', async (t) => {
  const { env, agentCtx, file } = await modelRecallEnv(t, { autoRecallMaxChars: 430 });
  const store = env.pctx.store;
  await store.updateEntry(file, { content: 'Use resolver-fix-v7 for EALIAS.\nException: ' + 'Never use on shared resolvers. '.repeat(20) });
  const files = [file, 'project_maintenance_guidance.md', 'project_other_recovery_notes.md'];
  for (const name of files.slice(1)) {
    await store.writeRawEntry(name, { type: 'project', body: 'Unrelated maintenance information. '.repeat(30) });
  }
  env.host.services.llm.stream = () => reply(JSON.stringify({ selected_memories: files }));
  const decision = await agentCtx.preStep([userMessage('EALIAS')]);
  const text = decision.messages[1]?.content[0].text ?? '';
  assert.match(text, /project_deployment\.md[^\n]*\n…\(use memory_read for the rest\)/);
  assert.doesNotMatch(text, /resolver-fix-v7/);
  assert.ok(text.length <= 430);
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
