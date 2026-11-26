import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toolsEnv, streamOf } from './v10-helpers.mjs';
import { runAutoExtract } from '../src/auto-extract.js';
import { attachRecall } from '../src/recall.js';

const exec = { agent: { id: 's1' }, sessionId: 's1' };
const save = (env, name, content) => env.pctx.store.saveEntry({ name, content, type: 'project' });
const body = async (env, file) => (await env.pctx.store.readEntry(file)).body.trim();
const dream = (env) => env.runtime.dream({ pctx: env.pctx, force: true });
const update = (env, file, content, caller = exec) =>
  env.definitions.get('memory_update').execute({ file, content }, caller);
const read = (env, file) => env.definitions.get('memory_read').execute({ file }, exec);

function cite(env, ...quotes) {
  const events = quotes.map((text, index) => ({ seq: index + 1, type: 'user/message', data: { content: [{ type: 'text', text }] } }));
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 'fixture-source', cwd: env.workspaceDir } }],
    listEvents: async () => events,
    readEvent: async ({ seq }) => ({ events: events.filter((item) => item.seq === seq) }),
  };
  return events.map((entry) => [{ session_id: 'fixture-source', seq: entry.seq, quote: entry.data.content[0].text }]);
}


function model(env, steps) {
  const requests = [];
  env.host.services.llm.stream = (options) => {
    const calls = steps[requests.length] ?? [];
    requests.push(structuredClone(options));
    return streamOf([
      ...calls.map(([name, args], index) => ({
        type: 'block-end', block: { type: 'tool-call', id: 'c' + requests.length + '-' + index, name, arguments: args },
      })),
      ...(!calls.length ? [{ type: 'text-delta', text: 'DONE' }] : []),
      { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } },
    ]);
  };
  return requests;
}

test('background writing does not clear a foreground read baseline', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'Note', 'Original.');
  await read(env, file);
  const backgroundCaller = { ...exec, internal: true, memoryReadHashes: new Map() };
  await env.definitions.get('memory_read').execute({ file }, backgroundCaller);
  const background = await update(env, file, 'Added by background.', backgroundCaller);
  assert.equal(background.ok, true);
  assert.equal((await update(env, file, 'Stale foreground edit.')).error, 'STALE');
  assert.equal(await body(env, file), 'Added by background.');
});

test('rejecting the destination protects every source in a merge chain', async (t) => {
  const env = await toolsEnv(t);
  const a = await save(env, 'A', 'Fact A holds.');
  const b = await save(env, 'B', 'Fact B holds.');
  const c = await save(env, 'C', 'Fact C holds.');
  const from = (note, quote) => [{ memory_file: note.file, quote }];
  model(env, [[
    ['memory_write', { file: b.file, body: 'Facts A and B.', merges: [a.file], citations: from(a, 'Fact A holds.') }],
    ['memory_delete', { file: a.file, moved_to: b.file, citations: from(a, 'Fact A holds.') }],
    ['memory_write', { file: c.file, body: 'Facts A, B and C.', merges: [b.file], citations: from(b, 'Fact B holds.') }],
    ['memory_delete', { file: b.file, moved_to: c.file, citations: from(b, 'Fact B holds.') }],
  ]]);
  assert.equal((await dream(env)).ready, true);
  await env.runtime.switchDream({ pctx: env.pctx, reject: [c.file] });
  assert.equal(await body(env, a.file), 'Fact A holds.');
  assert.equal(await body(env, b.file), 'Fact B holds.');
  assert.equal(await body(env, c.file), 'Fact C holds.');
});

test('undo can retry after an added page has already been removed', async (t) => {
  const env = await toolsEnv(t);
  const oldA = 'Original release strategy.';
  const a = await save(env, 'A', oldA);
  const newA = 'Use the new release strategy.';
  const newB = 'Track the new testing decision.';
  const [citeA, citeB] = cite(env, 'Replace the original release strategy with the new release strategy.', newB);
  model(env, [[
    ['memory_write', { file: a.file, body: newA, citations: citeA }],
    ['memory_write', { file: 'project_b.md', body: newB, type: 'project', citations: citeB }],
  ]]);
  assert.equal((await dream(env)).ready, true);
  const switched = await env.runtime.switchDream({ pctx: env.pctx });
  assert.equal(switched.ok, true);
  const original = path.join(switched.backupDir, a.file);
  const held = original + '.held';
  await fs.rename(original, held);
  assert.equal((await env.runtime.undoLastDream(env.pctx)).error, 'undo-partial');
  await fs.rename(held, original);
  assert.equal((await env.runtime.undoLastDream(env.pctx)).ok, true);
  assert.equal(await body(env, a.file), oldA);
  await assert.rejects(env.pctx.store.readEntry('project_b.md'), { code: 'NOT_FOUND' });
});

test('a corrected memory can be recalled again in the same session', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'Release', 'Release Friday.');
  let hook;
  env.runtime.forAgent = async () => env.pctx;
  env.host.services.llm.stream = () => streamOf([
    { type: 'text-delta', text: JSON.stringify({ selected_memories: [file] }) },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  attachRecall({ agent: exec.agent, agentCtx: { on: (_, fn) => { hook = fn; } },
    runtime: env.runtime, config: () => env.runtime.config });
  const step = async (id) => {
    const messages = [{ id, role: 'user', content: [{ type: 'text', text: 'When to release?' }] }];
    return (await hook({ messages }, async () => ({ kind: 'enter', messages }))).messages;
  };
  assert.match((await step('one')).at(-1).content[0].text, /Friday/);
  await env.pctx.store.updateEntry(file, { content: 'Release Monday.' });
  assert.match((await step('two')).at(-1).content[0].text, /Monday/);
});

for (const cutoff of ['max-tokens', 'max-turns']) {
  test('extractor preserves unread work after ' + cutoff, async (t) => {
    const env = await toolsEnv(t, { autoExtract: true });
    env.host.services.sessionQuery.readSession = async () => ({ events: [
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Remember that we run a release review every Thursday before noon.' }] } },
      { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'Remember that my reports always start with next steps.' }] } },
    ] });
    if (cutoff === 'max-tokens') {
      env.host.services.llm.stream = () => streamOf([{ type: 'finish', reason: { kind: cutoff } }]);
    } else {
      model(env, [[['memory_save', { name: 'Release review', content: 'Review every Thursday before noon.' }]],
        ...Array.from({ length: 4 }, () => [['memory_search', { query: 'reports' }]])]);
    }
    const result = await runAutoExtract({ runtime: env.runtime, pctx: env.pctx, ...exec });
    assert.equal(result.reason, cutoff);
    assert.equal(env.pctx.state.snapshot().extractSeqs.s1, undefined);
  });
}

test('Dream source pages omit injected text and exclude it from citation checks', async (t) => {
  const env = await toolsEnv(t);
  const quote = 'Old injected memory says to always use French.';
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir } }],
    listEvents: async () => [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
    readEvent: async ({ seq }) => ({ events: [{ seq, type: 'user/message',
      data: { role: 'user', source: { kind: ['plugin:cc-memory-recall', 'runtime-context', 'user'][seq - 1] },
        content: [{ type: 'text', text: seq === 3 ? 'Check the release notes.' : quote }] } }] }),
  };
  model(env, [[['memory_write', { file: 'project_language.md', body: quote, type: 'project', citations: [{ session_id: 's1', seq: 2, quote }] }]]]);
  // The only citation points at host-injected context, so the change is refused.
  assert.notEqual((await dream(env)).ready, true);
  const source = env.host.dreamSourcePages.join('\n');
  assert.match(source, /Check the release notes/u);
  assert.doesNotMatch(source, /French/u);
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
});
test('switch holds the same lock as ordinary writes and rollback preserves other pages', async (t) => {
  const env = await toolsEnv(t);
  const a = await save(env, 'A', 'Original A.');
  const b = await save(env, 'B', 'Original B.');
  const { prepareShadow, switchShadow } = await import('../src/dream-shadow.js');
  const { shadowStore, base } = await prepareShadow({ ...env.pctx, config: env.runtime.config });
  await shadowStore.writeRawEntry(a.file, { body: 'Dream A.' });
  const readShadow = shadowStore.readEntry.bind(shadowStore);
  let sharedLockHeld = false;
  shadowStore.readEntry = async (...args) => {
    sharedLockHeld = await fs.stat(env.pctx.paths.writeLockFile).then(() => true, () => false);
    // Simulate an editor outside the plugin and a failure reading the copy.
    await fs.writeFile(path.join(env.pctx.paths.memoryDir, b.file), 'External edit B.\n');
    await readShadow(...args);
    throw new Error('simulated read failure');
  };
  const result = await switchShadow({ ...env.pctx, shadowStore, base, files: [a.file] });
  assert.equal(result.ok, false);
  assert.equal(sharedLockHeld, true);
  assert.equal(await body(env, a.file), 'Original A.');
  assert.equal(await body(env, b.file), 'External edit B.');
});
test('a blind replacement must read the page first and cannot use memory_save as an overwrite', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'Note', 'Original.');
  assert.equal((await update(env, file, 'Unbased replacement.')).error, 'READ_REQUIRED');
  const result = await env.definitions.get('memory_save').execute({
    name: 'Note', type: 'project', content: 'Another unbased replacement.', force: true,
  }, exec);
  assert.equal(result.error, 'ALREADY_EXISTS');
  assert.equal(await body(env, file), 'Original.');
});

test('HTTP Dream actions bind to the reviewed batch', async (t) => {
  const { httpEnv, callHttp } = await import('./v10-helpers.mjs');
  const env = await httpEnv(t);
  const statement = 'Keep this new durable draft on file.';
  const [citations] = cite(env, statement);
  model(env, [[['memory_write', { file: 'project_draft.md', type: 'project', body: statement, citations }]]]);
  const pending = await dream(env);
  assert.equal(pending.ready, true);
  const act = async (action, runId) => (await callHttp(env, {
    method: 'POST', path: '/dream', body: { action, sessionId: 's1', runId },
  })).json();
  assert.equal((await act('switch', 'old-batch')).result.error, 'stale-dream');
  assert.equal((await act('discard', 'old-batch')).result.error, 'stale-dream');
  assert.equal((await act('switch', pending.runId)).result.ok, true);
});

test('human creation and merge do not overwrite an unrelated destination', async (t) => {
  const env = await toolsEnv(t);
  const a = await save(env, 'A', 'First source.');
  const b = await save(env, 'B', 'Second source.');
  const c = await save(env, 'C', 'Unrelated note.');
  const service = env.mods.status.createStatusService(env.runtime);
  await assert.rejects(service.writeFile(env.pctx, { type: 'project', name: 'C', content: 'Replace.' }), { code: 'ALREADY_EXISTS' });
  await assert.rejects(service.mergeFiles(env.pctx, { type: 'project', name: 'C', files: [a.file,b.file] }), { code: 'ALREADY_EXISTS' });
  assert.equal(await body(env, c.file), 'Unrelated note.');
  assert.equal(await body(env, a.file), 'First source.');
});

test('manual merge detects a changed source and rolls back its other changes', async (t) => {
  const env = await toolsEnv(t);
  const a = await save(env, 'A', 'First source.');
  const b = await save(env, 'B', 'Second source.');
  const store = env.pctx.store;
  const trash = store.trashEntry.bind(store);
  store.trashEntry = async (file, options) => {
    if (file === b.file) await store.updateEntry(file, { content: 'Latest edit.' });
    return trash(file, options);
  };
  const service = env.mods.status.createStatusService(env.runtime);
  await assert.rejects(service.mergeFiles(env.pctx, {
    type: 'project', name: 'Merged', files: [a.file,b.file],
  }), { code: 'STALE_WRITE' });
  assert.equal(await body(env, a.file), 'First source.');
  assert.equal(await body(env, b.file), 'Latest edit.');
  await assert.rejects(store.readEntry('project_merged.md'), { code: 'NOT_FOUND' });
});

test('Dream estimate loads no logs', async (t) => {
  const env = await toolsEnv(t);
  const events = [1, 20].map(seq => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text: 'Message ' + seq }] } }));
  let loads = 0;
  env.host.services.sessionQuery = {
    filterSessions: async () => Array.from({ length: 24 }, (_, i) => ({ header: { id: 's' + i, createdAt: i, cwd: env.workspaceDir } })),
    listEvents: async () => { loads++; return events; },
    searchEvents: async () => ({ items: [{ seq: 20, snippet: 'Message 20' }] }),
    readEvent: async () => ({ events: [events[1]] }),
  };
  await env.runtime.estimateDream(env.pctx);
  assert.equal(loads, 0);
});

test('Dream cannot complete a session whose log could not be loaded', async (t) => {
  const env = await toolsEnv(t);
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir } }],
    listEvents: async () => { throw new Error('temporary read failure'); },
  };
  model(env, [[['work_done', { session_id: 's1', through_seq: 1, summary: 'Reviewed the session.' }]]]);
  await dream(env);
  assert.ok(!env.pctx.state.snapshot().dreamProcessedSessions.some(x => x.id === 's1' && !x.partial));
});

test('a rejected extraction update keeps the input eligible for retry', async (t) => {
  const env = await toolsEnv(t, { autoExtract: true });
  const { file } = await save(env, 'Release', 'Release Thursday.');
  env.host.services.sessionQuery.readSession = async () => ({ events: [
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Remember this correction: from now on the project releases only on Monday.' }] } },
  ] });
  model(env, [[['memory_update', { file, content: 'Release Monday.', expectedHash: 'stale-fixture-hash' }]]]);
  const run = () => runAutoExtract({ runtime: env.runtime, pctx: env.pctx, ...exec });
  assert.equal((await run()).reason, 'write-incomplete');
  assert.equal(env.pctx.state.snapshot().extractSeqs.s1, undefined);
});

test('merge preserves active sections after a source with history', async (t) => {
  const env = await toolsEnv(t);
  const a = await save(env, 'A', 'New fact A.\n\n## History\n\n- Superseded: Old fact A.');
  const b = await save(env, 'B', 'Current fact B.');
  const retired = await save(env, 'Retired', 'STATUS: retired\nHistorical fact C.');
  const service = env.mods.status.createStatusService(env.runtime);
  const merged = await service.mergeFiles(env.pctx, {
    files: [a.file, b.file, retired.file], type: 'project', name: 'Merged',
  });
  const current = await read(env, merged.file);
  assert.match(current.body, /New fact A/);
  assert.match(current.body, /Current fact B/);
  assert.doesNotMatch(current.body, /Old fact A|Historical fact C/);
  // History stays in the file; memory_read only returns the current text.
  assert.equal(current.raw, undefined);
  const { raw } = await env.pctx.store.readEntry(merged.file);
  assert.match(raw, /Old fact A/);
  assert.match(raw, /Historical fact C/);
});

test('Dream refuses a fact change that has no citation', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'Release', 'Thursday.');
  model(env, [[['memory_write', { file, body: 'Friday.' }]]]);
  const pending = await dream(env);
  assert.notEqual(pending.ready, true);
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
  assert.equal(await body(env, file), 'Thursday.');
});

test('deferring a sourced Dream keeps the reviewed session eligible without rejecting its proposal', async (t) => {
  const env = await toolsEnv(t);
  const quote = 'The project now releases on Monday.';
  const event = { seq: 4, type: 'user/message', data: { content: [{ type: 'text', text: quote }] } };
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir } }],
    listEvents: async () => [event],
    readEvent: async () => ({ events: [event] }),
  };
  model(env, [[
    ['session_read', { session_id: 's1', seq: 4 }],
    ['memory_write', { file: 'project_release.md', body: quote, citations: [{ session_id: 's1', seq: 4, quote }] }],
    ['work_done', { session_id: 's1', through_seq: 4, summary: 'Reviewed the release date.' }],
  ]]);
  const first = await dream(env);
  assert.equal(first.ready, true);
  assert.equal(first.sessionsReviewed, 1);
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);
  await env.runtime.discardDream({ pctx: env.pctx, runId: first.runId });
  assert.deepEqual(env.pctx.state.snapshot().dreamRejected, []);
  const requests = model(env, [[]]);
  await dream(env);
  assert.match(requests[0].messages[0].content[0].text, /session_id=s1/);
});

test('automatic extraction resumes within a long event and reaches the final short tail', async (t) => {
  const env = await toolsEnv(t, { autoExtract: true, autoExtractMaxChars: 2000 });
  const text = 'a'.repeat(3300) + ' Last clue: Friday.';
  env.host.services.sessionQuery.readSession = async () => ({ events: [
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text }] } },
  ] });
  const requests = model(env, []);
  const run = () => runAutoExtract({ runtime: env.runtime, pctx: env.pctx, ...exec });
  await run();
  assert.ok(env.pctx.state.snapshot().extractOffsets.s1.offset > 0);
  env.runtime.extractCursors.clear();
  for (let n = 0; n < 4 && !requests.some(r => r.messages[0].content[0].text.includes('Last clue')); n++) await run();
  assert.ok(requests.some(r => r.messages[0].content[0].text.includes('Last clue')));
  assert.equal(env.pctx.state.snapshot().extractSeqs.s1, 1);
  assert.equal(env.pctx.state.snapshot().extractOffsets.s1, undefined);
});

test('a cited rewrite reaches review with its evidence bound to the page revision', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'Release', 'Thursday release.');
  const [citations] = cite(env, 'We now release on Monday.');
  model(env, [[['memory_write', { file, body: 'We now release on Monday.', citations }]]]);
  assert.equal((await dream(env)).ready, true);
  const pending = env.pctx.state.snapshot().shadowPending;
  assert.equal(pending.evidence.length, 1);
  assert.equal(pending.evidence[0].revision, pending.proofs[0].revision);
  assert.equal(pending.evidence[0].role, 'user');
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).ok, true);
});

test('a deduplication can remove a source without a quote only while the destination preserves it', async (t) => {
  const env = await toolsEnv(t);
  const a = await save(env, 'Duplicate', 'Retain this fact.');
  const dest = await save(env, 'Canonical', 'Retain this fact.');
  const duplicate = () => model(env, [[['memory_delete', { file: a.file, moved_to: dest.file, citations: [{ memory_file: dest.file, quote: 'Retain this fact.' }] }]]]);
  duplicate();
  assert.equal((await dream(env)).ready, true);
  await env.pctx.store.updateEntry(dest.file, { content: 'The other note was corrected.' });
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).error, 'conflict');
  assert.equal(await body(env, a.file), 'Retain this fact.');
  await env.runtime.discardDream({ pctx: env.pctx });
  await env.pctx.store.updateEntry(dest.file, { content: 'Retain this fact.' });
  duplicate();
  assert.equal((await dream(env)).ready, true);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).ok, true);
  await assert.rejects(env.pctx.store.readEntry(a.file), { code: 'NOT_FOUND' });
});
