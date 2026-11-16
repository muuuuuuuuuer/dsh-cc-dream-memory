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
  const a = await save(env, 'A', 'Fact A.');
  const b = await save(env, 'B', 'Fact B.');
  const c = await save(env, 'C', 'Fact C.');
  model(env, [[
    ['memory_write', { file: b.file, body: 'Facts A and B.', merges: [a.file] }],
    ['memory_delete', { file: a.file, moved_to: b.file }],
    ['memory_write', { file: c.file, body: 'Facts A, B and C.', merges: [b.file] }],
    ['memory_delete', { file: b.file, moved_to: c.file }],
  ]]);
  assert.equal((await dream(env)).ready, true);
  await env.runtime.switchDream({ pctx: env.pctx, reject: [c.file] });
  assert.equal(await body(env, a.file), 'Fact A.');
  assert.equal(await body(env, b.file), 'Fact B.');
  assert.equal(await body(env, c.file), 'Fact C.');
});

test('undo can retry after an added page has already been removed', async (t) => {
  const env = await toolsEnv(t);
  const a = await save(env, 'A', 'Original.');
  const [citeA, citeB] = cite(env, "Rename A to the new strategy.", "Create B to track the new decision.");
  model(env, [[
    ['memory_write', { file: a.file, body: 'New A.', citations: citeA }],
    ['memory_write', { file: 'project_b.md', body: 'New B.', type: 'project', citations: citeB }],
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
  assert.equal(await body(env, a.file), 'Original.');
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

test('search does not expose injected text or accept runtime context as a citation', async (t) => {
  const env = await toolsEnv(t);
  const quote = 'Old injected memory says to always use French.';
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir } }],
    listEvents: async () => [{ seq: 1 }, { seq: 2 }],
    searchEvents: async () => ({ items: [{ seq: 1, snippet: quote }, { seq: 2, snippet: quote }] }),
    readEvent: async ({ seq }) => ({ events: [{ seq, type: 'user/message',
      data: { role: 'user', source: { kind: seq === 1 ? 'plugin:cc-memory-recall' : 'runtime-context' },
        content: [{ type: 'text', text: quote }] } }] }),
  };
  const requests = model(env, [[['session_search', { session_id: 's1', query: 'French' }],
    ['memory_write', { file: 'user_language.md', body: quote, type: 'user', citations: [{ session_id: 's1', seq: 2, quote }] }]]]);
  assert.equal((await dream(env)).ready, true);
  const result = requests[1].messages.find((message) => message.role === 'tool');
  assert.doesNotMatch(result.content[0].text, /French/);
  assert.equal(env.pctx.state.snapshot().shadowPending.evidence[0].verified, false);
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
  const [citations] = cite(env, 'Keep this new durable draft on file.');
  model(env, [[['memory_write', { file: 'project_draft.md', type: 'project', body: 'Unreviewed batch.', citations }]]]);
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

test('Dream estimate loads no logs and ending a search does not cover unread events', async (t) => {
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
  model(env, [[['session_search', { session_id: 's0', query: 'Message 20' }],
    ['session_done', { session_id: 's0' }]]]);
  await dream(env);
  assert.equal(loads, 8);
  assert.ok(!env.pctx.state.snapshot().dreamProcessedSessions.some(x => x.id === 's0' && !x.partial));
});

test('Dream cannot complete a session whose log could not be loaded', async (t) => {
  const env = await toolsEnv(t);
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir } }],
    listEvents: async () => { throw new Error('temporary read failure'); },
  };
  model(env, [[['session_done', { session_id: 's1' }]]]);
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

test('Dream completes a long event only after it sees every page', async (t) => {
  const env = await toolsEnv(t);
  const text = 'a'.repeat(8050) + ' Actual durable detail at the end.';
  const event = { seq: 7, type: 'user/message', data: { content: [{ type: 'text', text }] } };
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir } }],
    listEvents: async () => [event],
    readEvent: async () => ({ events: [event] }),
  };
  const requests = model(env, [
    [['session_read', { session_id: 's1', seq: 7, offset: 8000 }], ['session_done', { session_id: 's1' }]],
    [['session_read', { session_id: 's1', seq: 7, offset: 0 }], ['session_done', { session_id: 's1' }]],
    [['session_read', { session_id: 's1', seq: 7, offset: 8000 }], ['session_done', { session_id: 's1' }]],
  ]);
  const result = await dream(env);
  const outputs = requests.at(-1).messages.filter(m => m.role === 'tool').map(m => m.content[0].text);
  assert.deepEqual(outputs.filter(s => s.startsWith('INCOMPLETE')), [
    'INCOMPLETE s1: next unread seqs 7', 'INCOMPLETE s1: next unread seqs 7',
  ]);
  assert.equal(outputs.at(-1), 'DONE s1');
  assert.equal(result.ran, true);
  assert.equal(result.sessionsRead, 1);
  assert.equal(result.sessionsReviewed, 1);
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

test('Dream refuses to apply a fact change without a checked source', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'Release', 'Thursday.');
  model(env, [[['memory_write', { file, body: 'Friday.' }]]]);
  const pending = await dream(env);
  assert.equal(pending.ready, true);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: pending.runId })).error, 'evidence-required');
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
    ['session_done', { session_id: 's1' }],
    ['memory_write', { file: 'project_release.md', body: quote, citations: [{ session_id: 's1', seq: 4, quote }] }],
  ]]);
  const first = await dream(env);
  assert.equal(first.ready, true);
  assert.equal(first.sessionsReviewed, 1);
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);
  await env.runtime.discardDream({ pctx: env.pctx, runId: first.runId });
  assert.deepEqual(env.pctx.state.snapshot().dreamRejected, []);
  const requests = model(env, [[]]);
  await dream(env);
  assert.match(requests[0].messages[0].content[0].text, /s1 created/);
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

test('Dream needs the full long page and its read version before replacement', async (t) => {
  const env = await toolsEnv(t);
  const original = 'a'.repeat(8050) + '\nKeep this tail.';
  const { file } = await save(env, 'Long', original);
  const { memoryHash } = await import('../src/write-review.js');
  const version = memoryHash((await env.pctx.store.readEntry(file)).raw);
  const [citations] = cite(env, 'Add an explicit review step.');
  const requests = model(env, [
    [['memory_read', { file }]],
    [['memory_write', { file, version, body: 'Truncated rewrite.', citations }]],
    [['memory_read', { file, offset: 8000, version: 'stale' }]],
    [['memory_read', { file, offset: 8000, version }]],
    [['memory_write', { file, version, body: original + '\nAdd an explicit review step.', citations }]],
  ]);
  const pending = await dream(env);
  assert.equal(pending.ready, true);
  const outputs = requests.at(-1).messages.filter(item => item.role === 'tool').map(item => item.content[0].text);
  assert.match(outputs[1], /read all pages/);
  assert.match(outputs[2], /version changed/);
  assert.match(outputs[3], /Keep this tail/);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).ok, true);
  assert.match(await body(env, file), /Keep this tail/);
});

test('a checked source for an older rewrite does not approve the final rewrite', async (t) => {
  const env = await toolsEnv(t);
  const { file } = await save(env, 'Release', 'Thursday release.');
  const [citations] = cite(env, 'We now release on Monday.');
  model(env, [
    [['memory_write', { file, body: 'We now release on Monday.', citations }]],
    [['memory_write', { file, body: 'We now release on Friday.' }]],
  ]);
  assert.equal((await dream(env)).ready, true);
  const pending = env.pctx.state.snapshot().shadowPending;
  assert.deepEqual(pending.evidence, []);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).error, 'evidence-required');
});

test('a deduplication can remove a source without a quote only while the destination preserves it', async (t) => {
  const env = await toolsEnv(t);
  const a = await save(env, 'Duplicate', 'Retain this fact.');
  const dest = await save(env, 'Canonical', 'Retain this fact.');
  const duplicate = () => model(env, [[['memory_delete', { file: a.file, moved_to: dest.file }]]]);
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
