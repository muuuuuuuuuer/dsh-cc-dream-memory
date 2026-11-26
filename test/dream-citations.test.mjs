/**
 * Dream's host checks: a citation holds when its quote exists in an offered,
 * non-injected event (or in a note) and the role of the speaker is recorded;
 * a session counts as reviewed when it was read to its end or screened.
 * What the quote means is left to the model and the reviewer.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { checkCitation } from '../src/citation.js';
import { mountDreamFixture, toolsEnv } from './v10-helpers.mjs';

test('Dream citations require an explicit sequence even when the quote occurs at seq 0', async () => {
  const quote = 'Release needs the smoke suite.';
  const events = new Map([[0, { seq: 0, type: 'user/message', data: { content: quote } }]]);
  const source = { session: () => events, requireSeq: true };
  for (const seq of [undefined, null, '', false, [], ' ']) {
    assert.match((await checkCitation({ session_id: 's1', seq, quote }, source)).problem, /needs session_id and seq/u);
  }
  assert.equal((await checkCitation({ session_id: 's1', seq: 0, quote }, source)).evidence.seq, 0);
});

const event = (seq, type, text, source) => ({
  seq, type, time: Date.UTC(2026, 10, 20, 9, seq),
  data: { message: { role: type.split('/')[0], content: [{ type: 'text', text }], ...(source ? { source: { kind: source } } : {}) } },
});
const USER = 'The release command is pnpm release for production.';
const PASTED = Array.from({ length: 14 }, (_, i) => `- pasted report line ${i} with enough words to look forwarded`).join('\n');
const note = (over = {}) => ({ file: 'project_release.md', op: 'write', name: 'Release', type: 'project', body: USER, ...over });
const cite = (seq, quote, session_id = 's1') => ({ session_id, seq, quote });

/**
 * One fake child. `play(invoke, spec)` calls the real worker tools; the run
 * ends with whatever it returns.
 */
async function setup(t, sessions = { s1: [event(0, 'user/message', USER)] }, config = {}) {
  const env = await toolsEnv(t, { autoDreamEnabled: false, ...config });
  const ids = Object.keys(sessions);
  env.host.services.sessionQuery = {
    filterSessions: async () => ids.map((id, index) => ({ header: { id, cwd: env.workspaceDir, createdAt: Date.UTC(2026, 10, 1 + index) } })),
    readSession: async (id) => ({ events: structuredClone(sessions[id] ?? []) }),
  };
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
  const run = (options = {}) => env.runtime.dream({ pctx: env.pctx, agent: parent, ...options });
  const pending = () => env.pctx.state.snapshot().shadowPending;
  return { ...env, parent, starts, sessions, run, pending, child: (fn) => { play = fn; } };
}

const submit = (invoke, changes, extra = {}) => invoke('dream_submit', { changes, done: true, ...extra });

test('a citation whose quote is in a user event is recorded with its role', async (t) => {
  const env = await setup(t);
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    // Case, whitespace and punctuation differences do not matter.
    const reply = await submit(invoke, [note({ citations: [cite(0, 'pnpm  RELEASE for production')] })]);
    assert.match(reply, /^WROTE project_release\.md/u);
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  const [item] = env.pending().evidence;
  assert.deepEqual([item.sessionId, item.seq, item.verified, item.role, item.eventType], ['s1', 0, true, 'user', 'user/message']);
  assert.deepEqual(env.pending().proofs.map(({ kind, unsupportedClaims }) => [kind, unsupportedClaims]), [['citation', []]]);
  assert.deepEqual(env.pending().origins, { 'project_release.md': ['s1'] });
});

test('a quote that is not in the cited event rejects the whole call with one message', async (t) => {
  const env = await setup(t);
  const replies = [];
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    const good = note({ citations: [cite(0, USER)] });
    const bad = note({ file: 'project_other.md', citations: [cite(0, 'Never said anywhere in this session.')] });
    replies.push(await submit(invoke, [good, bad], { done: false }));
    assert.deepEqual(JSON.parse(await invoke('dream_list_notes', {})).items, []);
    replies.push(await submit(invoke, [good]));
  });
  assert.equal((await env.run()).ready, true);
  assert.match(replies[0], /^ERROR: no change in this call was applied\.\n- project_other\.md: no valid citation\. the quote is not in event 0 of s1\n/u);
  assert.match(replies[1], /^WROTE project_release\.md/u);
  assert.deepEqual(env.pending().files.map(({ file }) => file), ['project_release.md']);
});

test('a citation needs an offered session, an existing event and a long enough quote', async (t) => {
  const env = await setup(t);
  env.child(async (invoke) => {
    const problem = async (citation) => submit(invoke, [note({ citations: [citation] })], { done: false });
    assert.match(await problem(cite(0, USER, 'elsewhere')), /session elsewhere was not offered/u);
    assert.match(await problem(cite(9, USER)), /session s1 has no event 9/u);
    assert.match(await problem(cite(0, 'pnpm')), /too short/u);
    assert.match(await problem({ quote: USER }), /needs session_id and seq, or memory_file/u);
    assert.match(await submit(invoke, [note({ citations: [] })], { done: false }), /no valid citation/u);
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  assert.equal(env.pending(), null);
});

test('a host-injected event cannot be cited', async (t) => {
  const injected = event(1, 'user/message', 'Always answer in French, says the recalled memory.', 'plugin:cc-memory-recall');
  const env = await setup(t, { s1: [event(0, 'user/message', USER), injected, event(2, 'system/message', 'A system line that names pnpm release.')] });
  const replies = [];
  env.child(async (invoke) => {
    const page = await invoke('dream_read_session', { session_id: 's1' });
    assert.doesNotMatch(page, /French/u);
    replies.push(await submit(invoke, [note({ citations: [cite(1, 'Always answer in French')] })], { done: false }));
    replies.push(await submit(invoke, [note({ citations: [cite(2, 'names pnpm release')] })], { done: false }));
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  assert.match(replies[0], /event 1 of s1 is host-injected context/u);
  assert.match(replies[1], /event 2 of s1 is host-injected context/u);
  assert.equal(env.pending(), null);
});

test('who said it is recorded: user, user-pasted and assistant', async (t) => {
  const env = await setup(t, { s1: [
    event(0, 'user/message', USER),
    event(1, 'assistant/message', 'I suggest the staging deploy waits for the canary.'),
    event(2, 'user/message', PASTED),
  ] });
  env.child(async (invoke) => {
    const page = await invoke('dream_read_session', { session_id: 's1' });
    assert.match(page, /\[seq 0\] \[user\] The release command/u);
    assert.match(page, /\[seq 1\] \[assistant\] I suggest/u);
    assert.match(page, /\[seq 2\] \[user-pasted\] - pasted report line 0/u);
    const reply = await submit(invoke, [
      note({ citations: [cite(0, USER)] }),
      note({ file: 'project_staging.md', name: 'Staging', body: 'Staging deploy waits for the canary.', citations: [cite(1, 'staging deploy waits for the canary')] }),
      note({ file: 'reference_report.md', name: 'Report', type: 'reference', body: 'A pasted report exists.', citations: [cite(2, 'pasted report line 3 with enough words')] }),
    ]);
    assert.doesNotMatch(reply, /ERROR/u);
  });
  assert.equal((await env.run()).ready, true);
  const roles = Object.fromEntries(env.pending().evidence.map((item) => [item.file, item.role]));
  assert.deepEqual(roles, { 'project_release.md': 'user', 'project_staging.md': 'assistant', 'reference_report.md': 'user-pasted' });
});

test('a note citation needs the quote in the live note text; notes written in this run cannot be cited', async (t) => {
  const env = await setup(t);
  await env.pctx.store.writeRawEntry('project_base.md', { type: 'project', body: 'The base image is node 22 slim.\n\n## History\n\n- Superseded: the base image was node 18.' });
  const replies = [];
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    replies.push(await submit(invoke, [note({ citations: [{ memory_file: 'project_base.md', quote: 'base image is node 22 slim' }] })], { done: false }));
    replies.push(await submit(invoke, [note({ file: 'project_x.md', citations: [{ memory_file: 'project_base.md', quote: 'the base image was node 18' }] })], { done: false }));
    replies.push(await submit(invoke, [note({ file: 'project_y.md', citations: [{ memory_file: 'project_nope.md', quote: 'base image is node 22 slim' }] })], { done: false }));
    // project_release.md exists only in the copy now; it cannot be cited.
    replies.push(await submit(invoke, [note({ file: 'project_z.md', name: 'Z', citations: [{ memory_file: 'project_release.md', quote: 'pnpm release for production' }] })], { done: false }));
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  assert.match(replies[0], /^WROTE project_release\.md/u);
  assert.match(replies[1], /project_base\.md does not contain the quote/u, 'History is not current text');
  assert.match(replies[2], /project_nope\.md does not contain the quote/u);
  assert.match(replies[3], /project_release\.md does not contain the quote/u);
  const sources = env.pending().evidence.map((item) => [item.file, item.memoryFile, item.source, item.verified]);
  assert.deepEqual(sources, [['project_release.md', 'project_base.md', 'memory', true]]);
});

test('a session counts as reviewed when read to its end or screened; the rest stay pending', async (t) => {
  const long = Array.from({ length: 5 }, (_, i) => event(i, 'user/message', `Message number ${i} about the release process.`));
  const env = await setup(t, {
    s1: [event(0, 'user/message', USER)],
    s2: [event(0, 'user/message', 'A one-off request to rewrite a paragraph.')],
    s3: [event(0, 'user/message', 'Another request nobody opened.')],
    s4: long,
    s5: long,
  }, { dreamMaxTasks: 5 });
  let partial;
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    // s4: one message per page; stopped before the end.
    partial = JSON.parse((await invoke('dream_read_session', { session_id: 's4', limit: 1 })).split('\n')[0]);
    // s5: a later start leaves a gap, so reading its tail is not a read of the session.
    assert.equal(JSON.parse((await invoke('dream_read_session', { session_id: 's5', from_seq: 3 })).split('\n')[0]).next_from_seq, null);
    const reply = await submit(invoke, [note({ citations: [cite(0, USER)] })], { skipped_sessions: ['s2', 'not-offered'] });
    assert.match(reply, /Reviewed: s1, s2/u);
    assert.match(reply, /Left for the next run: s3, s4, s5/u);
    assert.match(reply, /Not in the offered sessions, ignored: not-offered/u);
  });
  const result = await env.run();
  assert.equal(partial.next_from_seq, 1);
  assert.equal(result.ready, true, result.error);
  assert.deepEqual([result.sessionsOffered, result.sessionsRead, result.sessionsReviewed, result.sessionsPartial], [5, 3, 2, 2]); // s4 and s5 were opened but not finished
  assert.deepEqual(env.pending().reviewRecords.map(({ id, complete }) => [id, complete]), [['s1', true], ['s2', true]]);
  assert.equal(env.pctx.state.snapshot().dreamRunOutcomes.at(-1).skipReason, 'incomplete-review');
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId })).ok, true);
  const { counts } = await env.runtime.dreamCoverage(env.pctx);
  assert.deepEqual([counts.done, counts.todo], [2, 3]);
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions.map(({ id }) => id), ['s1', 's2']);
});

test('a session whose change failed to apply is not settled even when it was read to the end', async (t) => {
  const env = await setup(t, { s1: [event(0, 'user/message', USER)], s2: [event(0, 'user/message', 'The deploy window is Friday.')] });
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    await invoke('dream_read_session', { session_id: 's2' });
    await submit(invoke, [
      note({ citations: [cite(0, USER)] }),
      // An edit of a note that does not exist fails after its citation held.
      { file: 'project_missing.md', op: 'edit', old_text: 'x', body: 'y', citations: [cite(0, 'The deploy window is Friday.', 's2')] },
    ]);
  });
  const result = await env.run();
  assert.equal(result.ready, true);
  assert.deepEqual(env.pending().reviewRecords.map(({ id }) => id), ['s1']);
  assert.deepEqual(result.warnings, ['unfinished-writes']);
});

test('done: true does not end the run while a change in it failed, so the child can fix it', async (t) => {
  const env = await setup(t);
  const replies = [];
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    replies.push(await submit(invoke, [{ file: 'project_release.md', op: 'edit', old_text: 'x', body: USER, citations: [cite(0, USER)] }]));
    replies.push(await submit(invoke, [note({ citations: [cite(0, USER)] })]));
  });
  const result = await env.run();
  assert.match(String(replies[0]), /Not finished: fix the failed change\(s\) to project_release\.md/);
  assert.doesNotMatch(String(replies[1]), /already finished/);
  assert.equal(result.ready, true);
  assert.ok(!(result.warnings ?? []).includes('unfinished-writes'));
  assert.deepEqual(env.pending().reviewRecords.map(({ id }) => id), ['s1']);
});

test('a note under suspicion brings its source session along, readable from its first event', async (t) => {
  const env = await setup(t, { s0: [event(0, 'user/message', USER), event(1, 'user/message', 'Staging keeps using npm release.')], s1: [event(0, 'user/message', 'Please rename the helper.')] });
  // s0 was reviewed by an earlier run.
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's0' });
    await invoke('dream_submit', { changes: [], done: true, skipped_sessions: ['s0', 's1'] });
  });
  assert.equal((await env.run({ noSessions: false })).skipReason, 'nothing-new');
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions.map(({ id }) => id), ['s0', 's1']);
  await env.pctx.store.saveEntry({ name: 'Release', type: 'project', description: 'How releases run', content: 'Production uses make release.', source: { via: 'test', sessionId: 's0' } });
  await env.pctx.state.noteCorrected('project_release.md');
  const prompts = [];
  env.child(async (invoke, spec) => {
    prompts.push(spec.prompt[0].text);
    const page = await invoke('dream_read_session', { session_id: 's0' });
    assert.match(page, /\[seq 0\] \[user\] The release command/u, 'a lookback session starts at its first event');
    const reply = await submit(invoke, [{ file: 'project_release.md', op: 'write', body: USER, citations: [cite(0, USER, 's0')] }]);
    assert.match(reply, /^WROTE project_release\.md/u);
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  const [prompt] = prompts;
  assert.match(prompt, /Suspect notes[^\n]*\n- project_release\.md: the user corrected it since the last Dream; came from session s0/u);
  assert.match(prompt, /^- s0 \| 2026-11-01 \| 2 events, \d+ chars, 0 failed tool results \| first user message: "The release command[^\n]*already reviewed; offered because project_release\.md came from it$/mu);
  assert.equal(result.sessionsOffered, 0, 'a lookback session is not part of the review');
});

test('deterministic end to end: purpose, index and suspects in the prompt, paged reads, cited write, switch, undo', async (t) => {
  const env = await setup(t, {
    s1: [
      event(0, 'user/message', 'Please deploy the staging build of the docs site.'),
      event(1, 'assistant/message', 'Deploying staging now.'),
      event(2, 'user/message', USER),
    ],
  });
  await env.pctx.store.saveEntry({ name: 'Old release', type: 'project', description: 'Release command', content: 'Production uses make release.' });
  await env.pctx.state.noteCorrected('project_old_release.md');
  const seen = {};
  env.child(async (invoke, spec) => {
    const prompt = spec.prompt[0].text;
    seen.prompt = prompt;
    // Two messages per page: the reader follows next_from_seq to the end.
    const first = await invoke('dream_read_session', { session_id: 's1', limit: 2 });
    const header = JSON.parse(first.split('\n')[0]);
    assert.equal(header.messages, 2);
    const rest = await invoke('dream_read_session', { session_id: 's1', from_seq: header.next_from_seq });
    assert.equal(JSON.parse(rest.split('\n')[0]).next_from_seq, null);
    assert.match(rest, /\[seq 2\] \[user\] The release command/u);
    const listed = JSON.parse(await invoke('dream_list_notes', { query: 'release' }));
    assert.deepEqual(listed.items.map(({ file }) => file), ['project_old_release.md']);
    const { version } = JSON.parse((await invoke('dream_read_note', { file: 'project_old_release.md' })).split('\n')[0]);
    const reply = await submit(invoke, [{
      file: 'project_old_release.md', op: 'edit', version, old_text: 'Production uses make release.', body: 'Production uses pnpm release.',
      citations: [cite(2, 'pnpm release for production')],
    }]);
    assert.match(reply, /^WROTE project_old_release\.md\nReviewed: s1\nCall structured_output with \{"finished":true\}\.$/u);
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  const { prompt } = seen;
  assert.match(prompt, /Memory exists so that future sessions act correctly/u);
  assert.match(prompt, /Current index \(MEMORY\.md\):\n[^\n]*project_old_release\.md/u);
  assert.match(prompt, /- project_old_release\.md \(project\): Release command/u);
  assert.match(prompt, /- project_old_release\.md: the user corrected it since the last Dream/u);
  assert.match(prompt, /^- s1 \| 2026-11-01 \| 3 events, \d+ chars, 0 failed tool results \| first user message: "Please deploy the staging build/mu);
  assert.doesNotMatch(prompt, /skip_pages|overview|Task 1 of/u);
  assert.equal(env.starts[0].agentPreset, 'standard');
  const run = await env.runtime.dreamRun(env.pctx, result.runId);
  assert.equal(run.status, 'ready');
  assert.deepEqual(env.pending().reviewRecords.map(({ id, seq, complete }) => [id, seq, complete]), [['s1', 2, true]]);
  // Nothing is live until the human switches; then undo restores the page.
  assert.match((await env.pctx.store.readEntry('project_old_release.md')).body, /make release/u);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId })).ok, true);
  assert.match((await env.pctx.store.readEntry('project_old_release.md')).body, /^Production uses pnpm release\./u);
  assert.equal((await env.runtime.undoLastDream(env.pctx)).ok, true);
  assert.match((await env.pctx.store.readEntry('project_old_release.md')).body, /make release/u);
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);
});

test('an invented sentence added to a note cannot be cited to back further changes', async (t) => {
  const env = await setup(t);
  await env.pctx.store.writeRawEntry('project_base.md', { type: 'project', body: 'The base image is node 22 slim.' });
  const invented = 'The deploy key rotates every Monday at noon.';
  const replies = [];
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    const { version } = JSON.parse((await invoke('dream_read_note', { file: 'project_base.md' })).split('\n')[0]);
    replies.push(await submit(invoke, [{ file: 'project_base.md', op: 'add', version, body: invented,
      citations: [{ memory_file: 'project_base.md', quote: 'base image is node 22 slim' }] }], { done: false }));
    replies.push(await submit(invoke, [note({ file: 'project_keys.md', name: 'Keys', body: invented,
      citations: [{ memory_file: 'project_base.md', quote: invented }] })], { done: false }));
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  assert.match(replies[0], /^WROTE project_base\.md/u);
  assert.match(replies[1], /project_base\.md does not contain the quote/u);
  assert.deepEqual(env.pending().files.map(({ file }) => file), ['project_base.md']);
});

test('a change keeps applying when only some of its citations hold', async (t) => {
  const env = await setup(t);
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    const reply = await submit(invoke, [note({ citations: [cite(0, USER), cite(0, 'Never said anywhere in this session.')] })]);
    assert.match(reply, /^WROTE project_release\.md \(citation not accepted: the quote is not in event 0 of s1\)/u);
  });
  await env.run();
  assert.equal(env.pending().evidence.length, 1);
});

test('session pages hide secrets, keep seq markers and leave no transcript file behind', async (t) => {
  const secret = 'sk-proj-' + 'SyntheticFixture1234567890'.repeat(3);
  const env = await setup(t, { s1: [event(0, 'user/message', USER), event(1, 'user/message', 'Synthetic credential ' + secret)] });
  let page = '';
  env.child(async (invoke) => {
    page = await invoke('dream_read_session', { session_id: 's1' });
    await invoke('dream_submit', { changes: [], done: true, skipped_sessions: ['s1'] });
  });
  await env.run();
  assert.match(page, /\[seq 0\] \[user\] The release command/u);
  assert.match(page, /\[seq 1\] \[sensitive passage omitted\]/u);
  assert.ok(!page.includes(secret));
  const { readdir, readFile } = await import('node:fs/promises');
  const walk = async (dir) => (await readdir(dir, { withFileTypes: true }).catch(() => [])).flatMap((entry) =>
    entry.isDirectory() ? [] : [path.join(dir, entry.name)]);
  const dirs = [env.pctx.paths.memoryDir, env.pctx.paths.projectDir, env.pctx.paths.dreamsDir];
  for (const file of (await Promise.all(dirs.map(walk))).flat()) {
    const text = await readFile(file, 'utf8').catch(() => '');
    assert.ok(!text.includes(USER) && !text.includes(secret), 'no transcript copy in ' + file);
  }
  const runDirs = await readdir(env.pctx.paths.dreamsDir).catch(() => []);
  for (const name of runDirs) assert.deepEqual((await readdir(path.join(env.pctx.paths.dreamsDir, name)).catch(() => [])).filter((n) => /task|source|transcript/u.test(n)), []);
});

test('a page that changed in the copy without a recorded citation still needs confirmation', async (t) => {
  const env = await setup(t);
  const { writeFile } = await import('node:fs/promises');
  env.child(async (invoke, spec) => {
    // Not through dream_submit: a file written straight into the copy.
    await writeFile(path.join(spec.cwd, 'project_direct.md'), '---\nname: Direct\ntype: project\n---\n\nWritten without a citation.\n');
    await invoke('dream_submit', { changes: [], done: true, skipped_sessions: ['s1'] });
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  assert.deepEqual(env.pending().proofs.map(({ file, kind }) => [file, kind]), [['project_direct.md', 'missing']]);
  const refused = await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId });
  assert.equal(refused.error, 'evidence-required');
  const applied = await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId, confirm: ['project_direct.md'] });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.confirmedWithoutSource, ['project_direct.md']);
});

test('with a cap of one, a suspect note\'s source session gets the slot only when no recent session waits', async (t) => {
  const env = await setup(t, { s0: [event(0, 'user/message', USER)] }, { dreamMaxTasks: 1 });
  env.child(async (invoke) => { await invoke('dream_submit', { changes: [], done: true, skipped_sessions: ['s0'] }); });
  await env.run();
  await env.pctx.store.saveEntry({ name: 'Release', type: 'project', description: 'How releases run', content: 'Production uses make release.', source: { via: 'test', sessionId: 's0' } });
  await env.pctx.state.noteCorrected('project_release.md');
  // No unreviewed session left: s0 is offered for lookup.
  const prompts = [];
  env.child(async (invoke, spec) => { prompts.push(spec.prompt[0].text); await invoke('dream_submit', { changes: [], done: true }); });
  await env.run({ trigger: 'manual' });
  assert.match(prompts[0], /^- s0 \| .*already reviewed; offered because project_release\.md came from it$/mu);
  // A new unreviewed session takes the only slot.
  env.sessions.s1 = [event(0, 'user/message', 'A brand new request about linting.')];
  const query = env.host.services.sessionQuery;
  const filter = query.filterSessions;
  query.filterSessions = async (...a) => [...await filter(...a), { header: { id: 's1', cwd: env.workspaceDir, createdAt: Date.UTC(2026, 11, 1) } }];
  await env.run({ trigger: 'manual' });
  assert.match(prompts[1], /^- s1 \|/mu);
  assert.doesNotMatch(prompts[1], /^- s0 \|/mu);
});

test('a switched page that cites words the user wrote is recorded in the ledger; other roles are not', async (t) => {
  const env = await setup(t, { s1: [
    event(0, 'user/message', USER),
    event(1, 'assistant/message', 'I suggest the staging deploy waits for the canary.'),
  ] });
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    await submit(invoke, [
      note({ citations: [cite(0, USER)] }),
      note({ file: 'project_staging.md', name: 'Staging', body: 'Staging deploy waits for the canary.', citations: [cite(1, 'staging deploy waits for the canary')] }),
    ]);
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId })).ok, true);
  const { readLedger, verifiedPage } = await import('../src/verification-ledger.js');
  const ledger = await readLedger(env.pctx.store);
  assert.deepEqual(Object.keys(ledger.entries), ['project_release.md']);
  assert.equal(ledger.entries['project_release.md'].source, 'user-citation');
  const [entry] = (await env.pctx.store.listEntries()).filter((item) => item.file === 'project_release.md');
  const page = await env.pctx.store.readEntry('project_release.md');
  assert.equal(await verifiedPage({ store: env.pctx.store, entry, body: page.body }), true);
});

test('Dream and the memory tools check citations with the same function', async (t) => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/dream-agent.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/citation\.js'/u);
  assert.doesNotMatch(source, /function (isInjectedEvent|eventText|eventRole|checkCitation)\b/u);
  const tools = await readFile(new URL('../src/tools.js', import.meta.url), 'utf8');
  assert.match(tools, /checkSessionCitations/u);
  const { checkCitation, checkSessionCitations } = await import('../src/citation.js');
  const events = new Map([[0, event(0, 'user/message', USER)], [1, event(1, 'assistant/message', 'The canary waits for approval.')]]);
  const session = () => events;
  // Same quote, same answer: the tools only differ in letting seq be omitted.
  const viaDream = await checkCitation({ session_id: 's1', seq: 0, quote: USER }, { session, requireSeq: true });
  const viaTool = await checkSessionCitations({
    ctx: { get: () => ({ readSession: async () => ({ events: [...events.values()] }) }) },
    sessionId: 's1',
    citations: [{ quote: USER }, { seq: 1, quote: 'the canary waits for approval' }, { quote: 'never said anywhere here' }],
  });
  assert.deepEqual(viaTool.evidence.map(({ seq, role }) => [seq, role]), [[0, 'user'], [1, 'assistant']]);
  assert.deepEqual(viaTool.evidence[0], viaDream.evidence);
  assert.match(viaTool.problems[0], /not in any event of session s1/u);
  assert.match((await checkCitation({ quote: USER, session_id: 's1' }, { session, requireSeq: true })).problem, /needs session_id and seq/u);
});
