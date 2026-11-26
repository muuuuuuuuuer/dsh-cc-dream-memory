/**
 * Dream merges what subagents learned in their private stores (subagentMemory
 * 'own'): the notes are read-only material, quoted as the subagent's claim,
 * and settled by content hash like sessions. The private stores are never written.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { mountDreamFixture, toolsEnv } from './v10-helpers.mjs';

const CLAIM = 'The canary job must finish before the staging deploy starts.';
const note = (over = {}) => ({ file: 'project_staging.md', op: 'write', name: 'Staging', type: 'project', body: CLAIM, ...over });
const fromAgent = (quote, file = 'agent:reviewer/project_canary.md') => ({ memory_file: file, quote });

async function setup(t, config = { subagentMemory: 'own', agentMemoryPresets: ['reviewer'] }) {
  const env = await toolsEnv(t, { autoDreamEnabled: false, ...config });
  env.host.services.sessionQuery = { filterSessions: async () => [], readSession: async () => ({ events: [] }) };
  const parent = { id: 'lead-1', session: { header: { id: 'lead-1', cwd: env.workspaceDir } } };
  env.host.services.agents = { get: (id) => (id === parent.id ? parent : undefined), list: () => [parent] };
  const starts = [];
  let play = async () => {};
  env.host.services.subagents = {
    async startActivation(spec) {
      starts.push(spec);
      const invoke = mountDreamFixture(env.host, spec);
      const result = (async () => {
        await play(invoke, spec);
        return { stopReason: 'completed', output: [], structured: { finished: true } };
      })();
      return { childId: spec.childId, name: spec.name, result, dispose: async () => {} };
    },
  };
  const privateStore = async (preset = 'reviewer') => (await env.runtime._agentContextFor(env.pctx, undefined, preset)).store;
  const remember = async (file, body, preset = 'reviewer') => (await privateStore(preset))
    .writeRawEntry(file, { type: 'project', description: 'canary rule', body });
  return {
    ...env, starts, remember,
    run: () => env.runtime.dream({ pctx: env.pctx, agent: parent }),
    pending: () => env.pctx.state.snapshot().shadowPending,
    prompt: () => starts.at(-1).prompt[0].text,
    child: (fn) => { play = fn; },
    // Every byte under agents/, to prove Dream wrote nothing there.
    agentsTree: async () => {
      const root = path.join(env.pctx.paths.projectDir, 'agents');
      const out = [];
      const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(file);
          else out.push([path.relative(root, file), createHash('sha256').update(await readFile(file)).digest('hex')]);
        }
      };
      await walk(root);
      return out.sort();
    },
  };
}

const finish = (invoke, changes = [], extra = {}) => invoke('dream_submit', { changes, done: true, ...extra });

test('a cited private note changes the project note after the switch; the private store stays byte-identical and nothing is verified', async (t) => {
  const env = await setup(t);
  await env.remember('project_canary.md', CLAIM);
  const before = await env.agentsTree();
  env.child(async (invoke) => {
    const page = await invoke('dream_read_note', { file: 'agent:reviewer/project_canary.md' });
    assert.match(page, /canary job must finish/u);
    const reply = await finish(invoke, [note({ citations: [fromAgent('canary job must finish before the staging deploy')] })]);
    assert.match(reply, /^WROTE project_staging\.md/u);
    assert.match(reply, /Reviewed: agent:reviewer\/project_canary\.md/u);
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  assert.match(env.prompt(), /Notes from subagent stores \(read-only material; propose project changes if they hold up\)/u);
  assert.match(env.prompt(), /- agent:reviewer\/project_canary\.md \(project\): canary rule/u);
  const [item] = env.pending().evidence;
  assert.deepEqual([item.memoryFile, item.source, item.role, item.verified], ['agent:reviewer/project_canary.md', 'agent-memory', 'subagent', true]);
  assert.deepEqual(env.pending().origins, { 'project_staging.md': ['agent:reviewer/project_canary.md'] });

  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId })).ok, true);
  assert.match((await env.pctx.store.readEntry('project_staging.md')).body, /canary job must finish/u);
  assert.deepEqual(await env.agentsTree(), before);
  const { readLedger } = await import('../src/verification-ledger.js');
  assert.deepEqual(Object.keys((await readLedger(env.pctx.store)).entries), []);
  assert.doesNotMatch((await env.pctx.store.readEntry('project_staging.md')).body, /STATUS: current/u);
  assert.deepEqual(Object.keys(env.pctx.state.snapshot().dreamAgentNotes), ['agent:reviewer/project_canary.md']);
});

test('a settled private note is offered again only when its content changes', async (t) => {
  const env = await setup(t);
  await env.remember('project_canary.md', CLAIM);
  env.child(async (invoke) => {
    await invoke('dream_read_note', { file: 'agent:reviewer/project_canary.md' });
    await finish(invoke, [note({ citations: [fromAgent(CLAIM)] })]);
  });
  const first = await env.run();
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: first.runId })).ok, true);

  env.child(async (invoke) => { await finish(invoke); });
  await env.run();
  assert.doesNotMatch(env.prompt(), /subagent stores/u);

  await env.remember('project_canary.md', CLAIM + ' Then the smoke test runs.');
  await env.run();
  assert.match(env.prompt(), /agent:reviewer\/project_canary\.md/u);
});

test('undoing the switch makes the private notes it settled eligible again', async (t) => {
  const env = await setup(t);
  await env.remember('project_canary.md', CLAIM);
  env.child(async (invoke) => {
    await invoke('dream_read_note', { file: 'agent:reviewer/project_canary.md' });
    await finish(invoke, [note({ citations: [fromAgent(CLAIM)] })]);
  });
  const first = await env.run();
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: first.runId })).ok, true);
  assert.equal((await env.runtime.undoLastDream(env.pctx)).ok, true);
  assert.deepEqual(env.pctx.state.snapshot().dreamAgentNotes, {});
});

test('a note settles when read completely or skipped; a half-read note stays', async (t) => {
  const env = await setup(t);
  await env.remember('project_long.md', 'A long private note. '.repeat(600));
  await env.remember('project_skip.md', 'Something that needs no project change.');
  await env.remember('project_unread.md', 'Nobody opens this one.');
  env.child(async (invoke) => {
    const page = JSON.parse((await invoke('dream_read_note', { file: 'agent:reviewer/project_long.md' })).split('\n')[0]);
    assert.notEqual(page.next, null);
    const reply = await finish(invoke, [], { skipped_sessions: ['agent:reviewer/project_skip.md', 'agent:reviewer/project_missing.md'] });
    assert.match(reply, /Reviewed: agent:reviewer\/project_skip\.md/u);
    assert.match(reply, /Left for the next run: .*project_long\.md.*project_unread\.md/u);
    assert.match(reply, /Not in the offered sessions, ignored: agent:reviewer\/project_missing\.md/u);
  });
  await env.run();
  assert.deepEqual(Object.keys(env.pctx.state.snapshot().dreamAgentNotes), ['agent:reviewer/project_skip.md']);
});

test('only subagentMemory own shows the block; off and shared leave the prompt without it', async (t) => {
  for (const subagentMemory of ['off', 'shared']) {
    const env = await setup(t, { subagentMemory });
    await env.remember('project_canary.md', CLAIM);
    env.child(async (invoke) => {
      assert.match(await invoke('dream_read_note', { file: 'agent:reviewer/project_canary.md' }), /^ERROR/u);
      await finish(invoke);
    });
    await env.run();
    assert.doesNotMatch(env.prompt(), /subagent|agent:/u, subagentMemory);
  }
});

test('a quote that is not in the private note, an unknown preset and a path escape are rejected', async (t) => {
  const env = await setup(t, { subagentMemory: 'own', agentMemoryPresets: ['reviewer', 'other'] });
  await env.remember('project_canary.md', CLAIM);
  await env.remember('project_theirs.md', 'The other agent keeps its own habits.', 'other');
  const replies = [];
  env.child(async (invoke) => {
    const bad = (citation) => finish(invoke, [note({ citations: [citation] })]).then((reply) => replies.push(reply));
    await invoke('dream_read_note', { file: 'agent:reviewer/project_canary.md' });
    // Never said: the quote is checked against the private note's own text.
    await bad(fromAgent('the canary job is optional for staging'));
    await bad(fromAgent(CLAIM, 'agent:ghost/project_canary.md'));
    await bad(fromAgent(CLAIM, 'agent:../x'));
    await bad(fromAgent(CLAIM, 'agent:reviewer/../../.state.json'));
    await bad(fromAgent(CLAIM, 'agent:reviewer/project_missing.md'));
    for (const file of ['agent:../x', 'agent:ghost/project_canary.md', 'agent:reviewer/../../.state.json']) {
      assert.match(await invoke('dream_read_note', { file }), /^ERROR/u);
    }
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  assert.match(replies[0], /agent:reviewer\/project_canary\.md does not contain the quote/u);
  for (const reply of replies.slice(1)) assert.match(reply, /^ERROR: no change in this call was applied/u);
  assert.equal(env.pending(), null);
});
