/**
 * Model-backed recall (v23): a cheap selector call chooses up to five topic
 * files from the manifest. There is no lexical fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachRecall, RECALL_SOURCE_KIND } from '../src/recall.js';
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

  // A genuinely new user message starts a new selector turn.
  const nextUser = { ...userMessage('上线前要检查什么'), id: 'u2' };
  await agentCtx.preStep([nextUser]);
  assert.equal(calls.length, 2);
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
