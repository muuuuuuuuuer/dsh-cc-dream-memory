/**
 * The 2026-11-16 review found ten problems. These tests pin the ones that a
 * test can hold still: a fact behind the same title is not a duplicate, a
 * read→update round trip keeps what `memory_read` hides, the index does not
 * flip between refreshes, the `/memory` verbs answer instead of failing, and a
 * switch stops when a page the dream cited was edited.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandEnv, makeEnv, streamOf, toolsEnv } from './v10-helpers.mjs';
import { entrySimilarity } from '../src/policy.js';
import { memoryHash } from '../src/write-review.js';

const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
const dream = (env) => env.runtime.dream({ pctx: env.pctx, force: true });
const bodyOf = async (env, file) => (await env.pctx.store.readEntry(file)).body;

test('a different fact behind the same title is not a duplicate', () => {
  const title = { name: 'deploy-target', description: 'where releases go' };
  const same = entrySimilarity({ ...title, body: 'Frankfurt staging mirrors.' }, { ...title, body: 'Frankfurt staging mirrors.' });
  const other = entrySimilarity(
    { ...title, body: 'Frankfurt staging mirrors.' },
    { ...title, body: 'Osaka production rollout.' },
  );
  assert.equal(same, 1);
  // Name and description alone weigh 0.70; the body has to contribute the rest.
  assert.ok(Math.abs(other - 0.7) < 1e-9, `expected 0.70 with no shared body tokens, got ${other}`);
});

test('a read→update round trip keeps the History that memory_read hides', async (t) => {
  const env = await toolsEnv(t);
  const saved = await env.pctx.store.saveEntry({
    name: 'release day',
    type: 'project',
    description: 'when releases happen',
    content: 'Releases happen on Thursday.\n\n## History\n\n- Superseded: Releases happened on Monday.\n',
  });
  const read = await env.definitions.get('memory_read').execute({ file: saved.file }, exec);
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.match(read.body, /Thursday/u);
  assert.doesNotMatch(read.body, /## History/u, 'memory_read answers what holds now');
  const updated = await env.definitions.get('memory_update').execute(
    { file: saved.file, content: read.body.replace('Thursday', 'Friday') },
    exec,
  );
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const after = await bodyOf(env, saved.file);
  assert.match(after, /Friday/u);
  assert.match(after, /## History/u, 'the round trip keeps what the model cannot see');
  assert.match(after, /Monday/u);
});

test('the index stays put across refreshes after pruning a superseded page', async (t) => {
  const env = await makeEnv(t);
  const live = await env.pctx.store.saveEntry({
    name: 'stack', type: 'project', description: 'what we build with', content: 'We build with pnpm.\n',
  });
  const dead = await env.pctx.store.saveEntry({
    name: 'old stack', type: 'project', description: 'what we used to build with',
    content: 'STATUS: superseded\n\nWe built with npm.\n',
  });
  await env.pctx.store.reconcileIndex();
  const first = await env.pctx.store.indexText();
  assert.equal(first.includes(dead.file), false, 'a superseded page keeps no index slot');
  assert.equal(first.includes(live.file), true);
  await env.pctx.store.reconcileIndex();
  const second = await env.pctx.store.indexText();
  assert.equal(second.includes(dead.file), false, 'the pruned line does not come back');
  assert.equal(second, first, 'the index is stable between refreshes');
});

test('/memory edit saves the page it read', async (t) => {
  const env = await commandEnv(t);
  const saved = await env.pctx.store.saveEntry({
    name: 'deploy', type: 'project', description: 'how we deploy', content: 'Deploy with make release.\n',
  });
  const result = await env.invokeMemory(`edit ${saved.file} --content=Deploy-with-pnpm-release.`);
  assert.equal(result.kind, 'success', JSON.stringify(result));
  assert.match(await bodyOf(env, saved.file), /Deploy-with-pnpm-release\./u);
});

test('/memory export counts the files it wrote', async (t) => {
  const env = await commandEnv(t);
  await env.pctx.store.saveEntry({ name: 'deploy', type: 'project', description: 'how we deploy', content: 'Body.\n' });
  const target = `${env.workspaceDir}/export-target`;
  const result = await env.invokeMemory(`export ${target}`);
  assert.equal(result.kind, 'success', JSON.stringify(result));
  assert.match(result.text, /exported 1 file\(s\)/u);
});

test('an unknown dream subcommand answers instead of returning nothing', async (t) => {
  const env = await commandEnv(t);
  const unknown = await env.invokeMemory('dream bogus');
  assert.equal(unknown.kind, 'error');
  assert.match(unknown.text, /unknown dream subcommand "bogus"/u);
  assert.match(unknown.text, /usage: \/memory dream run\|cancel/u);
  const apply = await env.invokeMemory('dream apply');
  assert.equal(apply.kind, 'error');
  assert.match(apply.text, /replaced by switch/u);
});

test('editing a page the dream cited stops the switch', async (t) => {
  const env = await toolsEnv(t);
  const target = await env.pctx.store.saveEntry({
    name: 'release day', type: 'project', content: 'Releases happen on Thursday.\n',
  });
  const source = await env.pctx.store.saveEntry({
    name: 'release policy', type: 'project', content: 'Ask the release owner first.\n',
  });
  const version = memoryHash((await env.pctx.store.readEntry(target.file)).raw);
  let wrote = false;
  env.host.services.llm.stream = () => {
    if (wrote) return streamOf([{ type: 'finish', reason: { kind: 'stop' } }]);
    wrote = true;
    return streamOf([
      {
        type: 'block-end',
        block: {
          type: 'tool-call',
          id: 'c1',
          name: 'memory_write',
          arguments: {
            file: target.file,
            version,
            body: 'Releases happen on Thursday.\n\nAsk the release owner first.\n',
            citations: [{ memory_file: source.file, quote: 'Ask the release owner first.' }],
          },
        },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]);
  };
  assert.equal((await dream(env)).ready, true);
  const pending = env.pctx.state.snapshot().shadowPending;
  assert.ok(
    pending.evidence.some((item) => item.source === 'memory' && item.memoryFile === source.file),
    'the citation is recorded as evidence',
  );
  await env.pctx.store.updateEntry(source.file, { content: 'Releases happen on Friday.\n' });
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).error, 'conflict');
  await env.runtime.discardDream({ pctx: env.pctx });
});
