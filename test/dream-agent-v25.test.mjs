/**
 * Dream as an agent (v25).
 *
 * The model gets session search/read and memory tools, not pre-sliced
 * transcripts. It writes a shadow copy; switch/undo still decides what becomes
 * live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsEnv, streamOf } from './v10-helpers.mjs';

const now = Date.parse('2026-11-15T10:00:00Z');
const TRANSITION = 'Replace npm for installs with pnpm for installs.';

function toolCall(id, name, args) {
  return { type: 'block-end', block: { type: 'tool-call', id, name, arguments: args } };
}

function script(env, steps) {
  let call = 0;
  const prompts = [];
  env.host.services.llm.stream = (options) => {
    call += 1;
    prompts.push(options.messages?.map((message) => message.content?.map((block) => block.text ?? '').join('')).join('\n') ?? '');
    const step = steps[call - 1];
    if (!step) return streamOf([{ type: 'finish', reason: { kind: 'stop' } }]);
    return streamOf([
      ...step.tools.map((item, index) => toolCall(`c-${call}-${index}`, item.name, item.arguments)),
      { type: 'text-delta', text: step.text ?? '' },
      { type: 'finish', reason: { kind: step.tools.length > 0 ? 'tool-calls' : 'stop' } },
    ]);
  };
  return { prompts, calls: () => call };
}

async function dreamEnv(t) {
  const env = await toolsEnv(t, { autoDreamEnabled: false, sessionLookback: 8 });
  await env.pctx.store.saveEntry({
    name: 'Deploy',
    type: 'project',
    description: 'Release process',
    content: 'Use npm for installs.',
    source: { via: 'test' },
  });
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir, createdAt: now - 1000 } }],
    searchEvents: async () => ({ items: [{ seq: 7, snippet: TRANSITION }] }),
    readEvent: async () => ({
      events: [{ seq: 7, type: 'user/message', data: { content: [{ type: 'text', text: TRANSITION }] } }],
    }),
    readSession: async () => ({
      events: [{ seq: 7, type: 'user/message', data: { content: [{ type: 'text', text: TRANSITION }] } }],
    }),
  };
  return env;
}

test('agent searches sessions, reads memory on demand, and writes only the shadow', async (t) => {
  const env = await dreamEnv(t);
  const { prompts } = script(env, [
    {
      tools: [
        { name: 'session_search', arguments: { session_id: 's1', query: 'pnpm' } },
        { name: 'memory_read', arguments: { file: 'project_deploy.md' } },
      ],
    },
    {
      tools: [
        {
          name: 'memory_write',
          arguments: {
            file: 'project_deploy.md',
            name: 'Deploy',
            type: 'project',
            description: 'Use pnpm for installs.',
            body: 'Use pnpm for installs. ^[s1#7, 2026-11-15]',
            citations: [{ session_id: 's1', seq: 7, quote: TRANSITION }],
          },
        },
      ],
    },
    { tools: [], text: 'DONE' },
  ]);

  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-agent-1' });
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.runId, 'run-agent-1');

  // The brief names the session; the child reads note bodies from its working directory.
  assert.ok(prompts[0].includes('session_id=s1'));
  assert.ok(!prompts[0].includes('Use npm for installs.'));

  const live = await env.pctx.store.readEntry('project_deploy.md');
  assert.equal(live.body.includes('Use npm for installs.'), true);

  const snap = env.pctx.state.snapshot();
  assert.equal(snap.shadowPending?.runId, 'run-agent-1');
  // Read through the shadow store directly.
  const shadowStore = new (env.mods.store.MemoryStore)({
    paths: { ...env.pctx.paths, memoryDir: `${env.pctx.paths.dreamsDir}/shadow`, indexFile: `${env.pctx.paths.dreamsDir}/shadow/MEMORY.md` },
    getConfig: () => env.runtime.config,
  });
  const pending = await shadowStore.readEntry('project_deploy.md');
  assert.ok(pending.body.includes('Use pnpm for installs.'));

  const switched = await env.runtime.switchDream({ pctx: env.pctx });
  assert.equal(switched.ok, true);
  const applied = await env.pctx.store.readEntry('project_deploy.md');
  assert.ok(applied.body.includes('Use pnpm for installs.'));

  const undone = await env.runtime.undoLastDream(env.pctx);
  assert.equal(undone.ok, true);
  const restored = await env.pctx.store.readEntry('project_deploy.md');
  assert.ok(restored.body.includes('Use npm for installs.'));
});

test('Dream records human-readable evidence for a shadow write', async (t) => {
  const env = await dreamEnv(t);
  script(env, [
    {
      tools: [
        { name: 'session_read', arguments: { session_id: 's1', seq: 7 } },
        {
          name: 'memory_write',
          arguments: {
            file: 'project_deploy.md',
            name: 'Deploy',
            type: 'project',
            description: 'Release process uses pnpm',
            body: 'Use pnpm for installs. ^[s1#7, 2026-11-15]',
            citations: [{ session_id: 's1', seq: 7, quote: TRANSITION }],
          },
        },
      ],
    },
    { tools: [], text: 'DONE' },
  ]);
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-evidence-1' });
  assert.equal(result.ready, true);
  const pending = env.pctx.state.snapshot().shadowPending;
  assert.ok(Array.isArray(pending.evidence));
  const citation = pending.evidence.find((item) => item.file === 'project_deploy.md' && item.sessionId === 's1' && item.seq === 7);
  assert.ok(citation, 'the citation is stored for human review');
  assert.match(citation.quote, /pnpm/);

  const service = env.mods.status.createStatusService(env.runtime);
  const diff = await service.dreamDiff(env.pctx, 'run-evidence-1', 'project_deploy.md');
  assert.ok(diff.evidence.some((item) => item.sessionId === 's1' && item.seq === 7 && /pnpm/.test(item.quote)));
});

test('agent with nothing to change leaves no pending shadow', async (t) => {
  const env = await dreamEnv(t);
  script(env, [{ tools: [], text: 'DONE' }]);
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', noSessions: true, runId: 'run-agent-2' });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'nothing-new');
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
});

test('estimate returns a finite input limit for the UI', async (t) => {
  const env = await dreamEnv(t);
  const estimate = await env.runtime.estimateDream(env.pctx);
  assert.equal(estimate.rough, true);
  assert.equal(typeof estimate.limit, 'number');
  assert.ok(Number.isFinite(estimate.limit));
  assert.ok(estimate.limit >= 0);
});
