/**
 * Automatic recall: when the user's message clearly matches a memory's name and
 * description, the memory's body is attached to that step as background context.
 * The hook follows the host's `agent/pre-step` waterfall contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRecall, buildRecallText, attachRecall, RECALL_SOURCE_KIND } from '../src/recall.js';
import { runtimeEnv } from './v10-helpers.mjs';
import { buildSessionTranscript } from '../src/dream-session-text.js';

const entry = (file, name, description, type = 'project') => ({ file, name, description, type, modified: '2026-11-08T10:00:00.000Z' });
const ENTRIES = [
  entry('project_billing_routes.md', 'billing_routes', 'billing 项目 API 路由一律用 kebab-case，测试统一 vitest'),
  entry('project_web_console.md', 'web_console_conventions', 'web-console 项目路由用 camelCase，测试用 jest'),
  entry('project_deploy.md', 'deployment', '项目部署平台：GCP Cloud Run，AWS 已不再使用'),
  entry('feedback_handoff.md', 'handoff_format', '交接文档固定写结论和待办，涉及数据库变更附回滚步骤', 'feedback'),
  entry('user_language.md', 'user_language', '用户以中文沟通，希望中文回复', 'user'),
];
const files = (result) => result.map((item) => item.file);

test('a request about a remembered topic selects that memory', () => {
  assert.deepEqual(files(selectRecall({ query: '帮我给 billing 项目加一个新的 API 路由', entries: ENTRIES })), ['project_billing_routes.md']);
  assert.deepEqual(files(selectRecall({ query: '写一份这周的交接文档', entries: ENTRIES })), ['feedback_handoff.md']);
  assert.deepEqual(files(selectRecall({ query: '把服务部署到 cloud run 要注意什么', entries: ENTRIES })), ['project_deploy.md']);
});

test('small talk and unrelated requests select nothing', () => {
  for (const query of ['你好', '帮我算一下 17 乘 23', 'hello', '今天天气怎么样', 'ok', '写个 hello world']) {
    assert.deepEqual(selectRecall({ query, entries: ENTRIES }), [], query);
  }
});

test('a long message does not match by accident', () => {
  const entries = [entry('feedback_style.md', 'reply_style_concise', '回复风格：用户要求回答简短', 'feedback')];
  const unrelated = `You are a careful linear-algebraist. Solve the following problem and reply with the steps. ${'矩阵的特征值回答需要给出推导过程。'.repeat(40)}`;
  assert.deepEqual(selectRecall({ query: unrelated, entries }), []);
});

test('a long message that really is about a memory still finds it', () => {
  const related = `我们来讨论部署。${'这次部署到 GCP Cloud Run 平台，AWS 不再使用，'.repeat(12)}${'其他无关的说明文字写在这里。'.repeat(30)}`;
  assert.deepEqual(files(selectRecall({ query: related, entries: ENTRIES })), ['project_deploy.md']);
});

test('a single common word is not enough', () => {
  assert.deepEqual(selectRecall({ query: '这个项目怎么样', entries: ENTRIES }), [], '"项目" appears everywhere');
});

test('one specific English word in a memory name can recall a short request', () => {
  for (const [name, query] of [
    ['Deploy process', 'how do I deploy this?'],
    ['Handoff notes format', 'write handoff notes'],
  ]) {
    const entries = [entry('topic.md', name, 'Follow the saved procedure.')];
    assert.deepEqual(files(selectRecall({ query, entries })), ['topic.md'], query);
  }
});

test('one name keyword still requires a whole specific word', () => {
  for (const [name, description, query] of [
    ['Deploy process', 'Follow the saved procedure.', 'redeploy this'],
    ['Handoff notes format', 'Follow the saved procedure.', 'change the format'],
    ['Project guide', 'deploy using the release procedure', 'how do I deploy this?'],
    ['Database settings', 'Follow the saved procedure.', 'database unavailable'],
  ]) {
    assert.deepEqual(selectRecall({ query, entries: [entry('topic.md', name, description)] }), [], query);
  }
});

test('overlapping Chinese bigrams do not turn a shared database topic into a migration request', () => {
  const entries = [entry('migration.md', '数据库迁移', '迁移前做好备份并准备回滚')];
  assert.deepEqual(selectRecall({ query: '数据库连不上了', entries }), []);
  assert.deepEqual(selectRecall({ query: '数据库，数据库，数据库', entries }), []);
});

test('a meaningful Chinese word in the name can recall a short request', () => {
  const entries = [entry('migration.md', '数据库迁移', '迁移前做好备份并准备回滚')];
  assert.deepEqual(files(selectRecall({ query: '怎么做迁移', entries })), ['migration.md']);
});

test('Chinese strong matches require a word or a genuinely contiguous long phrase', () => {
  const entries = [entry('topic.md', '交接格式', '在数据库中保存交接文档')];
  assert.deepEqual(selectRecall({ query: '接格', entries }), [], 'cross-word substring is not a name keyword');
  assert.deepEqual(selectRecall({ query: '数据和据库', entries }), [], 'separate fragments are not a four-character phrase');
  assert.deepEqual(files(selectRecall({ query: '整理交接文档', entries })), ['topic.md']);
});

test('a long shared Chinese phrase still needs a non-generic word', () => {
  for (const query of ['我们可以', '在数据库中']) {
    const entries = [entry('migration.md', '数据库迁移', '我们可以在数据库中执行迁移')];
    assert.deepEqual(selectRecall({ query, entries }), [], query);
  }
});

test('one continuous Chinese segment does not outrank two independent topic words', () => {
  const entries = [
    entry('migration.md', '数据库迁移', ''),
    entry('rollback.md', 'cloud rollback', ''),
  ];
  assert.deepEqual(files(selectRecall({ query: '数据库迁移 cloud rollback', entries, maxFiles: 1 })), ['rollback.md']);
});

test('a strong name match does not bypass long-query coverage', () => {
  const entries = [entry('deploy.md', 'Deploy process', 'cloud release rollback staging monitoring approval traffic')];
  assert.deepEqual(selectRecall({ query: `deploy ${'unrelated mathematics explanation '.repeat(30)}`, entries }), []);
});

test('profile memories need a request actually about them', () => {
  assert.deepEqual(selectRecall({ query: '中文注释要不要加', entries: ENTRIES }), [], 'one shared word does not pull in the user profile');
});

test('profile memories keep three independent matches even for a strong name or Chinese phrase', () => {
  const profiles = [
    entry('profile.md', 'Deployment preference', 'cloud region language', 'user'),
    entry('zh_profile.md', '中文回复风格', '希望用中文回答', 'user'),
  ];
  assert.deepEqual(selectRecall({ query: 'deployment cloud', entries: profiles }), []);
  assert.deepEqual(selectRecall({ query: '中文回复风格', entries: profiles }), []);
  assert.deepEqual(files(selectRecall({ query: 'deployment cloud region', entries: profiles })), ['profile.md']);
});

test('a memory already shown in this session is not attached again', () => {
  const shown = new Set(['project_deploy.md']);
  assert.deepEqual(selectRecall({ query: '把服务部署到 cloud run', entries: ENTRIES, shown }), []);
});

test('at most the requested number of memories, best match first', () => {
  const many = Array.from({ length: 8 }, (_, i) => entry(`project_n${i}.md`, `deploy_note_${i}`, `cloud run deploy note number ${i}`));
  const result = selectRecall({ query: 'cloud run deploy', entries: [...many, entry('project_best.md', 'cloud_run_deploy', 'cloud run deploy guide')], maxFiles: 3 });
  assert.equal(result.length, 3);
  assert.equal(result[0].file, 'project_best.md');
});

test('recall text is bounded and marks the content as background', () => {
  const text = buildRecallText([{ file: 'a.md', modified: '2026-11-08T10:00:00.000Z', body: '甲'.repeat(5000) }, { file: 'b.md', modified: '', body: '乙'.repeat(5000) }], { maxChars: 2000 });
  assert.ok(text.length <= 2500, `bodies are capped at 2000 plus framing, got ${text.length}`);
  assert.match(text, /background/i);
  assert.match(text, /a\.md/);
  assert.match(text, /2026-11-08/);
});

// --- the host contract ------------------------------------------------------

/** A scoped context with the host's waterfall shape: handler(payload, next). */
function fakeAgentCtx() {
  const handlers = [];
  return {
    on(event, handler) {
      assert.equal(event, 'agent/pre-step');
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    /** Run the waterfall the way the agent loop does. */
    async preStep(messages, base = { kind: 'enter', messages: [...messages] }) {
      const run = (index) => (index < handlers.length ? handlers[index]({ messages, signal: new AbortController().signal }, () => run(index + 1)) : Promise.resolve(base));
      return run(0);
    },
    count: () => handlers.length,
  };
}
const userMessage = (text) => ({ role: 'user', id: 'u1', content: [{ type: 'text', text }], source: { kind: 'user' } });

async function recallEnv(t, config = {}) {
  const env = await runtimeEnv(t, config);
  await env.pctx.store.saveEntry({ name: 'deployment', type: 'project', description: '项目部署平台：GCP Cloud Run，AWS 已不再使用', content: '部署走 GCP Cloud Run。' });
  const agentCtx = fakeAgentCtx();
  const agent = { id: 'session-1', ctx: agentCtx };
  env.runtime.forAgent = async () => env.pctx;
  const dispose = attachRecall({ agent, agentCtx, runtime: env.runtime, config: () => env.runtime.config });
  return { env, agentCtx, dispose };
}

test('the hook appends one identified background message and keeps what the loop decided', async (t) => {
  const { agentCtx } = await recallEnv(t);
  const decision = await agentCtx.preStep([userMessage('把服务部署到 cloud run 要注意什么')]);
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 2);
  const [, recalled] = decision.messages;
  assert.equal(recalled.role, 'user');
  assert.equal(recalled.source.kind, RECALL_SOURCE_KIND);
  assert.equal(typeof recalled.id, 'string');
  assert.ok(recalled.content[0].text.includes('部署走 GCP Cloud Run'));
});

test('a recalled message never reaches a later dream as user speech', async (t) => {
  const { agentCtx } = await recallEnv(t);
  const decision = await agentCtx.preStep([userMessage('把服务部署到 cloud run 要注意什么')]);
  const transcript = buildSessionTranscript(decision.messages.map((message, i) => ({ type: 'user/message', seq: i + 1, data: message })));
  assert.deepEqual(transcript.userMessages, ['把服务部署到 cloud run 要注意什么']);
});

test('the same memory is attached once per session', async (t) => {
  const { agentCtx } = await recallEnv(t);
  const message = userMessage('把服务部署到 cloud run 要注意什么');
  assert.equal((await agentCtx.preStep([message])).messages.length, 2);
  assert.equal((await agentCtx.preStep([message])).messages.length, 1);
});

test('enabled user-scope memories are read from their scope and filename collisions recall once each', async (t) => {
  const { env, agentCtx } = await recallEnv(t, { userMemoryEnabled: true, autoRecallMaxFiles: 1 });
  const project = await env.pctx.store.saveEntry({ name: 'Shared handoff', type: 'feedback', description: 'handoff zebra', content: 'Project handoff marker.' });
  const user = await env.pctx.store.saveEntry({ scope: 'user', name: 'Shared handoff', type: 'feedback', description: 'handoff zebra', content: 'User handoff marker.' });
  assert.equal(project.file, user.file, 'the fixture has the same filename in each scope');
  const message = userMessage('handoff zebra');
  const first = (await agentCtx.preStep([message])).messages;
  const second = (await agentCtx.preStep([message])).messages;
  assert.equal(first.length, 2);
  assert.equal(second.length, 2, 'showing the project file must not suppress the user file');
  const text = [first[1].content[0].text, second[1].content[0].text].join('\n');
  assert.match(text, /Project handoff marker/);
  assert.match(text, /User handoff marker/);
  assert.match(text, /user\/feedback_shared_handoff\.md/);
  assert.equal((await agentCtx.preStep([message])).messages.length, 1);
});

test('disabled user scope is never enumerated by recall', async (t) => {
  const { env, agentCtx } = await recallEnv(t);
  const list = env.pctx.store.listEntries.bind(env.pctx.store);
  env.pctx.store.listEntries = (scope) => {
    assert.equal(scope, 'project', 'disabled user memory must remain untouched');
    return list(scope);
  };
  const decision = await agentCtx.preStep([userMessage('把服务部署到 cloud run')]);
  assert.equal(decision.messages.length, 2, 'project recall still works while user scope is off');
});

test('steps without a typed user message add nothing', async (t) => {
  const { agentCtx } = await recallEnv(t);
  assert.equal((await agentCtx.preStep([])).messages.length, 0, 'a tool-loop step claims no message');
  const injected = { role: 'user', id: 'x', content: [{ type: 'text', text: '把服务部署到 cloud run' }], source: { kind: 'runtime-context' } };
  assert.equal((await agentCtx.preStep([injected])).messages.length, 1, 'injected context is not a query');
});

test('recall can be turned off and never breaks a step', async (t) => {
  const off = await recallEnv(t, { autoRecall: false });
  assert.equal((await off.agentCtx.preStep([userMessage('把服务部署到 cloud run')])).messages.length, 1);

  const broken = await recallEnv(t);
  broken.env.runtime.forAgent = async () => { throw new Error('store is gone'); };
  const decision = await broken.agentCtx.preStep([userMessage('把服务部署到 cloud run')]);
  assert.equal(decision.messages.length, 1, 'the step goes on without recall');
});

test('a rejected step stays rejected', async (t) => {
  const { agentCtx } = await recallEnv(t);
  const rejected = { kind: 'reject', reason: 'blocked by policy' };
  const decision = await agentCtx.preStep([userMessage('把服务部署到 cloud run')], rejected);
  assert.deepEqual(decision, rejected);
});

test('disposing removes the hook', async (t) => {
  const { agentCtx, dispose } = await recallEnv(t);
  assert.equal(agentCtx.count(), 1);
  dispose();
  assert.equal(agentCtx.count(), 0);
});
