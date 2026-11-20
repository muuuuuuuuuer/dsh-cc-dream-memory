import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { mountDreamFixture, playDreamTasks, toolsEnv } from './v10-helpers.mjs';
import { readRunManifest, runDirOf } from '../src/dream-run.js';

const message = (seq, role, text) => ({
  seq, type: role + '/message',
  data: { message: { role, content: [{ type: 'text', text }] } },
});
const QUOTE = '默认用 pnpm release，staging 仍用 npm release';
const NOTE = { file: 'project_release.md', op: 'write', name: 'Release command', type: 'project', body: QUOTE + '。' };
const sessionOf = (spec) => spec.prompt[0].text.match(/session_id=(\S+?),/u)[1];

async function setup(t, config = {}, sessionIds = ['s1']) {
  const env = await toolsEnv(t, { autoDreamEnabled: false, ...config });
  const events = [
    message(0, 'user', 'The staging deploy uses npm release.'),
    message(1, 'assistant', 'The build and staging deploy completed.'),
    message(2, 'user', '纠正一下，' + QUOTE + '。'),
  ];
  env.host.services.sessionQuery = {
    filterSessions: async () => sessionIds.map((id, index) => ({ header: { id, cwd: env.workspaceDir, createdAt: index + 1 } })),
    readSession: async () => ({ events: structuredClone(events) }),
    listEvents: async () => events.map(({ seq, type }) => ({ seq, type })),
    readEvent: async ({ seq, before, after }) => ({ events: events.filter((event) => event.seq >= seq - before && event.seq <= seq + after) }),
  };
  const parent = { id: 'lead-1', session: { header: { id: 'lead-1', cwd: env.workspaceDir } } };
  env.host.services.agents = { get: (id) => (id === parent.id ? parent : undefined), list: () => [parent] };
  const starts = [];
  const appended = [];
  const restrictions = [];
  const prompts = [];
  const sourceReads = [];
  let child = async (spec) => {
    return { stopReason: 'completed', output: [], structured: {
      done: true, summary: 'Recorded the release command.',
      changes: [{ ...NOTE, citations: [{ session_id: sessionOf(spec), seq: 2, quote: QUOTE }] }],
    } };
  };
  env.host.services.subagents = {
    async startActivation(spec) {
      starts.push(spec);
      const invoke = mountDreamFixture(env.host, spec, {
        append: (type, data) => appended.push([type, data]),
        restrict: (filter) => restrictions.push(filter),
      });
      const result = playDreamTasks(env.host, spec, (name, args) => {
        if (name === 'dream_read_source') sourceReads.push(args);
        return invoke(name, args);
      }, (task) => {
        prompts.push(task.prompt[0].text);
        return child(task, invoke);
      });
      return { childId: spec.childId, name: spec.name, result, dispose: async () => {} };
    },
  };
  return { ...env, parent, starts, appended, restrictions, prompts, sourceReads, events, setChild: (fn) => { child = fn; } };
}

test('Dream runs a scoped standard-preset child and checks its proposed shadow draft', async (t) => {
  const env = await setup(t);
  const result = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  assert.equal(env.starts.length, 1);
  const [spec] = env.starts;
  assert.equal(spec.agentPreset, 'standard');
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.delivery, 'caller');
  assert.equal(spec.parent, env.parent);
  assert.equal(spec.cwd, path.join(env.pctx.paths.dreamsDir, 'shadow'));
  assert.deepEqual(env.appended, [['sandbox/mode', { mode: 'workspace-write' }]]);
  assert.deepEqual(env.restrictions, [{ allow: [] }]);
  assert.equal(result.ready, true);
  const pending = env.pctx.state.snapshot().shadowPending;
  assert.deepEqual(pending.files.map(({ file }) => file), ['project_release.md']);
  assert.ok(pending.evidence.some((item) => item.verified && item.quote === QUOTE));
  assert.deepEqual(pending.reviewRecords.map(({ id, seq, complete }) => [id, seq, complete]), [['s1', 2, true]]);
  // The live store is untouched until the human switches.
  await assert.rejects(env.pctx.store.readEntry('project_release.md'));
});

test('one child handles up to dreamMaxTasks sessions; the remainder waits for the next run', async (t) => {
  const env = await setup(t, { dreamMaxTasks: 2 }, ['s1', 's2', 's3']);
  const result = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  assert.equal(env.starts.length, 1);
  assert.equal(result.ready, true);
  const records = env.pctx.state.snapshot().shadowPending.reviewRecords;
  assert.deepEqual(records.map(({ id }) => id), ['s1', 's2']);
  const fixedRules = (prompt) => prompt.slice(prompt.indexOf('You are Dream'), prompt.indexOf('\n\nTask '));
  assert.match(fixedRules(env.prompts[0]), /Use dream_list_notes/u);
  assert.equal(fixedRules(env.prompts[1]), fixedRules(env.prompts[0]));
  assert.match(env.prompts[1], /session_id=s2,/u);
});

test('four short sessions need only the first page fetch, with no shadow listing before launch', async (t) => {
  const env = await setup(t, { dreamMaxTasks: 4 }, ['s1', 's2', 's3', 's4']);
  const proto = Object.getPrototypeOf(env.pctx.store);
  const listEntries = proto.listEntries;
  const shadowDir = path.join(env.pctx.paths.dreamsDir, 'shadow');
  let startupListings = 0;
  t.mock.method(proto, 'listEntries', function (...args) {
    if (this.paths.memoryDir === shadowDir && env.starts.length === 0) startupListings++;
    return listEntries.apply(this, args);
  });
  env.setChild(async () => ({ stopReason: 'completed', structured: { done: true, summary: 'Checked.', changes: [] } }));
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.sessionsReviewed, 4);
  assert.deepEqual(env.sourceReads, [{ task: 1, page: 0 }]);
  assert.equal(startupListings, 0);
  for (const prompt of env.prompts.slice(1)) {
    const page = JSON.parse(prompt.split('\n').at(-1));
    assert.match(page.source, /\[seq 2\] user\/message/u);
    assert.ok(page.source.includes(QUOTE));
    assert.ok(prompt.length <= 8000);
  }
});

test('a changed handoff must recover its source through an explicit page read', async (t) => {
  const env = await setup(t, {}, ['s1', 's2']);
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      const submit = { done: true, summary: 'Checked.', changes: [] };
      await invoke('dream_read_source', { task: 1, page: 0 });
      await invoke('dream_submit_task', { ...submit, task: 1 }, ([block]) => {
        assert.match(block.text, /Complete source page/u);
        return [{ ...block, text: block.text.replace(QUOTE, '[removed]') }];
      });
      assert.match(await invoke('dream_submit_task', { ...submit, task: 2 }), /dream_read_source with task 2 and page 0/u);
      assert.ok((await invoke('dream_read_source', { task: 2, page: 0 })).includes(QUOTE));
      assert.match(await invoke('dream_submit_task', { ...submit, task: 2 }), /Batch finished/u);
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.sessionsReviewed, 2);
});

test('a purely social session settles locally and later substantive activity is still reviewed', async (t) => {
  const env = await setup(t);
  env.events.splice(0, env.events.length, message(0, 'user', '你好！'), message(1, 'assistant', '您好。'));
  const social = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(social.sessionsReviewed, 1);
  assert.equal(social.sessionsRead, 0);
  assert.equal(env.starts.length, 0);
  assert.equal(env.pctx.state.snapshot().dreamProcessedSessions[0].seq, 1);
  const repeated = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(repeated.sessionsOffered, 0);
  assert.equal(env.starts.length, 0);
  env.events.push(message(2, 'user', '谢谢，' + QUOTE));
  await env.pctx.state.ensureSession('s1');
  const next = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(next.ready, true);
  assert.equal(env.starts.length, 1);
  assert.match(env.prompts[0], /after seq 1/u);
});

test('a tool-only session with no model-visible result body settles without a child', async (t) => {
  const env = await setup(t);
  env.events.splice(0, env.events.length, { seq: 3, type: 'tool/result', data: { snippet: 'A raw tool result.' } });
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.sessionsReviewed, 1);
  assert.equal(run.sessionsRead, 0);
  assert.equal(env.starts.length, 0);
  assert.equal(env.pctx.state.snapshot().dreamProcessedSessions[0].seq, 3);
});

test('overview screens disposable pages once and requires raw evidence for a new fact', async (t) => {
  const env = await setup(t, { userMemory: 'project' });
  // Five long replies to a one-off request, then a plain statement with no preference keyword.
  const fact = 'My piano lessons start on October 12.';
  env.events.splice(0, env.events.length, message(0, 'user', 'Give me examples of rhymes.'),
    ...Array.from({ length: 5 }, (_, i) => message(i + 1, 'assistant', ('Example rhyme number ' + i + '. ').repeat(140))),
    message(6, 'user', fact));
  env.events.at(-1).time = Date.UTC(2026, 8, 20);
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      assert.match(spec.prompt[0].text, /view=overview/u);
      const submit = { task: 1, done: true, summary: 'Lessons start in October.', changes: [] };
      const view = { task: 1, view: 'overview', page: 0 };
      const first = JSON.parse(await invoke('dream_read_source', view));
      const last = JSON.parse(await invoke('dream_read_source', { ...view, page: first.next_page }));
      assert.equal(last.next_page, null);
      const entries = [...first.entries, ...last.entries];
      const { page, excerpts } = entries.find((e) => e.excerpts.some((s) => s.text === fact));
      assert.equal(excerpts.find((s) => s.seq === 6).time, '2026-09-20T00:00:00.000Z');
      const all = entries.map((e) => e.page);
      const change = { ...NOTE, type: 'user', file: 'user_lessons.md', body: fact, citations: [{ session_id: 's1', seq: 6, quote: fact }] };
      assert.match(await invoke('dream_submit_task', { ...submit, skip_pages: all, changes: [change] }), /open the raw page/u);
      await invoke('dream_read_source', { task: 1, page });
      assert.match(await invoke('dream_submit_task', { ...submit, skip_pages: all.filter((p) => p !== page), changes: [change] }), /Batch finished/u);
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.ready, true);
  assert.ok(env.pctx.state.snapshot().shadowPending.evidence.some((item) => item.verified && item.quote === fact));
  const { tasks: [task] } = await readRunManifest(runDirOf(env.pctx.paths, run.runId));
  assert.deepEqual([task.totalPages, task.rawPagesRead, task.pagesScreened], [5, 1, 4]);
});

test('a clipped overview and an abbreviated user message cannot be used to skip pages', async (t) => {
  const env = await setup(t);
  env.events.splice(0, env.events.length, message(0, 'user', 'Many details. '.repeat(240)),
    message(1, 'assistant', 'An illustration. '.repeat(200)), message(2, 'assistant', 'Another illustration. '.repeat(160)));
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      const view = { task: 1, page: 0, view: 'overview' };
      const submit = { task: 1, done: true, summary: 'One-off discussion.', changes: [], skip_pages: [0, 1, 2] };
      await invoke('dream_read_source', view, () => [{ type: 'text', text: 'clipped' }]);
      assert.match(await invoke('dream_submit_task', { ...submit, skip_pages: [1, 2] }), /requires a delivered overview/u);
      const { entries } = JSON.parse(await invoke('dream_read_source', view));
      assert.deepEqual(entries.map((entry) => entry.requiresDetail), [true, false, false]);
      assert.match(await invoke('dream_submit_task', submit), /Open requiresDetail/u);
      await invoke('dream_read_source', { task: 1, page: 0 });
      assert.match(await invoke('dream_submit_task', { ...submit, skip_pages: [1, 2] }), /Batch finished/u);
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.sessionsReviewed, 1);
  assert.equal(run.skipReason, 'nothing-new');
  assert.equal(env.pctx.state.snapshot().dreamProcessedSessions[0].seq, 2);
});

test('a disposable long exchange settles with one overview and no raw read or note lookup', async (t) => {
  const env = await setup(t);
  env.events.splice(0, env.events.length, message(0, 'user', 'Give me a list of sample rhymes.'),
    ...Array.from({ length: 3 }, (_, i) => message(i + 1, 'assistant', 'A sample rhyme. '.repeat(215))),
    message(4, 'user', 'Internal label before credential: AKIAIOSFODNN7EXAMPLE'));
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      const overview = await invoke('dream_read_source', { task: 1, view: 'overview', page: 0 });
      const { entries, next_page } = JSON.parse(overview);
      assert.equal(next_page, null);
      assert.doesNotMatch(overview, /AKIA|Internal label/u);
      assert.match(overview, /sensitive passage omitted/u);
      assert.match(await invoke('dream_submit_task', { task: 1, done: true, changes: [],
        summary: 'One-time examples.', skip_pages: entries.map(({ page }) => page) }), /Batch finished/u);
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.skipReason, 'nothing-new');
  assert.equal(run.sessionsRead, 0);
  assert.equal(run.sessionsReviewed, 1);
  const manifest = await readRunManifest(runDirOf(env.pctx.paths, run.runId));
  assert.deepEqual(manifest.tasks.map(({ totalPages, pagesScreened, rawPagesRead }) => [totalPages, pagesScreened, rawPagesRead]), [[3, 3, 0]]);
});

test('overview protects a buried result and bypasses triage when it could not save a fetch', async () => {
  const { taskSourceOverview } = await import('../src/dream-transcript.js');
  const pages = Array.from({ length: 3 }, (_, seq) => {
    const text = 'Example '.repeat(110) + (seq === 1 ? 'The migration failed. ' : '') + 'More examples. '.repeat(90);
    return { text, fragments: [{ seq, type: 'assistant/message', text }] };
  });
  assert.deepEqual(taskSourceOverview(pages).map(({ requiresDetail }) => requiresDetail), [false, true, false]);
  pages[2].fragments[0].type = 'user/message';
  assert.deepEqual(taskSourceOverview(pages), []);
});

for (const reason of ['multiple pages', 'large project rules']) {
  test('handoff keeps explicit paging for ' + reason, async (t) => {
    const env = await setup(t, {}, ['s1', 's2']);
    if (reason === 'multiple pages') env.events.push(message(3, 'user', 'Long dialogue '.repeat(400)));
    else env.runtime.rulesFor = () => ({ text: 'Preserve scoped conditions. '.repeat(260) });
    const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
    assert.equal(run.sessionsReviewed, 2);
    assert.deepEqual(env.sourceReads.filter(({ task }) => task === 2).map(({ page }) => page),
      env.sourceReads.filter(({ task }) => task === 1).map(({ page }) => page));
    assert.ok(env.sourceReads.some(({ task }) => task === 2));
    assert.doesNotMatch(env.prompts[1], /Complete source page/u);
  });
}

test('targeted additions and corrections keep other sections and their independently bound facts', async (t) => {
  const env = await setup(t, {}, ['s1', 's2']);
  const file = 'project_release.md';
  const old = 'Use make release.';
  const history = '## History\n\n- Superseded: Older rollout.';
  await env.pctx.store.writeRawEntry(file, { type: 'project', description: 'Release notes', body: old + '\n\n' + history });
  const rule = 'I prefer tagged releases.';
  const correction = 'Replace use make release with use pnpm release.';
  env.events.push(message(3, 'user', rule), message(4, 'user', correction));
  env.setChild(async (spec, invoke) => {
    const session_id = sessionOf(spec);
    const { version } = JSON.parse((await invoke('dream_read_note', { file })).split('\n')[0]);
    const change = session_id === 's1'
      ? { op: 'add', body: 'User prefers tagged releases.', citations: [{ session_id, seq: 3, quote: rule }] }
      : { op: 'edit', old_text: old, body: 'Use pnpm release.',
        citations: [{ session_id, seq: 4, quote: correction }] };
    return { stopReason: 'completed', structured: { done: true, summary: 'Checked release guidance.', changes: [{ file, version, ...change }] } };
  });
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.ready, true);
  const pending = env.pctx.state.snapshot().shadowPending;
  assert.deepEqual(pending.proofs[0].unsupportedClaims, []);
  assert.deepEqual(new Set(pending.evidence.filter((e) => e.claims.length).map((e) => e.sessionId)), new Set(['s1', 's2']));
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: run.runId })).ok, true);
  const note = await env.pctx.store.readEntry(file);
  assert.equal(note.frontmatter.description, 'Release notes');
  assert.equal(note.body, 'User prefers tagged releases.\n\nUse pnpm release.\n\n' + history + '\n\n- Superseded: Use make release.');
});

for (const invalid of ['ambiguous', 'stale']) {
  test('targeted edit rejects ' + invalid + ' input', async (t) => {
    const env = await setup(t);
    const file = 'project_release.md';
    const body = 'Production: build. Staging: build.';
    await env.pctx.store.writeRawEntry(file, { body });
    env.setChild(async (_spec, invoke) => {
      const { version } = JSON.parse((await invoke('dream_read_note', { file })).split('\n')[0]);
      return { stopReason: 'completed', structured: { done: true, summary: 'Edit release.', changes: [{
        op: 'edit', file, version: invalid === 'stale' ? 'old-version' : version,
        old_text: invalid === 'ambiguous' ? 'build' : body, body: 'Use pnpm.', citations: [],
      }] } };
    });
    const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
    assert.equal(run.error, 'unfinished-writes');
    assert.equal((await env.pctx.store.readEntry(file)).body, body);
  });
}

test('deferred work rotates behind unseen sessions and stays eligible without advancing its cursor', async (t) => {
  const env = await setup(t, { dreamMaxTasks: 1 }, ['s1', 's2']);
  const run = () => env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  for (const expected of ['s1', 's2', 's1']) {
    assert.equal((await run()).ready, true);
    assert.equal(sessionOf(env.starts.at(-1)), expected);
    assert.equal((await env.runtime.switchDream({ pctx: env.pctx, defer: [NOTE.file] })).ok, true);
    await env.pctx.state.read();
    assert.equal((await env.runtime.dreamCoverage(env.pctx)).counts.todo, 2);
  }
});

test('auto Dream waits for new activity on a deferred session', async (t) => {
  const env = await setup(t);
  const run = (trigger) => env.runtime.dream({ pctx: env.pctx, agent: env.parent, trigger });
  assert.equal((await run('manual')).ready, true);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, defer: [NOTE.file] })).ok, true);
  await run('auto');
  assert.equal(env.starts.length, 1);
  assert.equal((await env.runtime.dreamCoverage(env.pctx)).counts.todo, 1);
  env.events.push(message(3, 'user', 'The release rule still applies.'));
  await env.pctx.state.ensureSession('s1');
  assert.equal((await run('auto')).ready, true);
  assert.equal(env.starts.length, 2);
});

test('the last unseen session does not share a batch with already deferred work', async (t) => {
  const env = await setup(t, { dreamMaxTasks: 2 }, ['s1', 's2', 's3']);
  await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, defer: [NOTE.file] })).ok, true);
  await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.deepEqual(env.prompts.map((text) => sessionOf({ prompt: [{ text }] })), ['s1', 's2', 's3']);
});

test('one short fact supplies the recall description without importing extra claims', async (t) => {
  const env = await setup(t);
  const quote = '我默认使用书面交接。';
  env.events.push(message(3, 'user', quote));
  env.setChild(async () => ({ stopReason: 'completed', structured: { done: true, summary: 'Checked handoff.', changes: [{
    file: 'feedback_handoff.md', op: 'write', type: 'feedback', body: '用户默认使用书面交接。',
    description: 'Mandatory for every team.', citations: [{ session_id: 's1', seq: 3, quote }],
  }] } }));
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: run.runId })).ok, true);
  const note = await env.pctx.store.readEntry('feedback_handoff.md');
  assert.equal(note.frontmatter.description, note.body);
});

test('a worker can refine a broad correction citation once before writing', async (t) => {
  const env = await setup(t);
  const file = 'project_format.md';
  const old = 'Use text reports.';
  const instruction = 'Replace use text reports with use PDF reports.';
  const broad = 'Report format update. ' + instruction;
  env.events.push(message(3, 'user', broad));
  await env.pctx.store.writeRawEntry(file, { type: 'project', body: old });
  let submissions = 0;
  env.setChild(async (_spec, invoke) => {
    const { version } = JSON.parse((await invoke('dream_read_note', { file })).split('\n')[0]);
    const quote = ++submissions === 1 ? broad : instruction;
    return { stopReason: 'completed', structured: { done: true, summary: 'Report format corrected.', changes: [{
      op: 'edit', file, version, old_text: old, body: 'Use PDF reports.', citations: [{ session_id: 's1', seq: 3, quote }],
    }] } };
  });
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(submissions, 2);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: run.runId })).ok, true);
  assert.equal((await env.pctx.store.readEntry(file)).body, 'Use PDF reports.\n\n- Superseded: ' + old);
});

test('a historical source date binds only to its own event; a dropped sibling never reaches shadow or settlement', async (t) => {
  const env = await setup(t);
  env.events[2].time = Date.UTC(2026, 8, 30, 1, 20);
  const cite = [{ session_id: 's1', seq: 2, quote: QUOTE }];
  const submit = { task: 1, done: true, summary: 'Keep the release decision.' };
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      const page = await invoke('dream_read_source', { task: '1', page: '0' });
      assert.match(page, /Source date 2026-09-30 UTC/u);
      const note = { ...NOTE, body: 'Recorded 2026-09-30 UTC: ' + QUOTE, citations: cite };
      const transient = { ...note, file: 'project_transient.md', body: 'Recorded 2026-11-20 UTC: ' + QUOTE };
      const retry = await invoke('dream_submit_task', { ...submit, changes: [note, transient] });
      assert.match(retry, /Review before writing: project_transient\.md/u);
      assert.deepEqual(JSON.parse(await invoke('dream_list_notes', {})), []);
      assert.match(await invoke('dream_submit_task', { ...submit, changes: [note] }), /Batch finished/u);
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.ready, true, run.error);
  const pending = env.pctx.state.snapshot().shadowPending;
  assert.deepEqual(pending.files.map(({ file }) => file), [NOTE.file]);
  assert.deepEqual(pending.proofs[0].unsupportedClaims, []);
  assert.equal(pending.evidence.length, 1);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: run.runId })).ok, true);
});

test('dropping all unsupported facts settles without a pending draft', async (t) => {
  const env = await setup(t);
  let calls = 0;
  env.setChild(async () => ({ stopReason: 'completed', structured: { done: true, summary: 'Reviewed.',
    changes: ++calls === 1 ? [{ ...NOTE, body: 'The build is currently blocked.', citations: [] }] : [] } }));
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(calls, 2);
  assert.equal(run.skipReason, 'nothing-new');
  assert.equal(run.sessionsReviewed, 1);
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
});

test('card overview indexes requests and latest receipts and retains intervening user rulings', async () => {
  const { taskSourceOverview } = await import('../src/dream-transcript.js');
  const rows = [
    ['user', '只执行 T01，不执行 T02。'], ['assistant', 'T01 BLOCKED. ' + 'passed '.repeat(150)],
    ['user', '继续补修 T01，授权使用 schema 56。'], ['assistant', 'T01 completed. ' + 'passed '.repeat(150)],
    ['user', '只执行 T02。'], ['assistant', 'T02 pending review. ' + 'passed '.repeat(150)],
    ['user', 'My piano lessons start tomorrow. ' + 'My instructions. '.repeat(120)],
  ];
  const pages = rows.map(([role, text], seq) => ({ text, fragments: [{ type: role + '/message', seq, text }] }));
  const overview = taskSourceOverview(pages);
  assert.deepEqual(overview.slice(0, 6).map(({ excerpts }) => [excerpts[0].card, excerpts[0].role]), [
    ['T01', 'first request'], ['T01', 'earlier reply'], ['T01', 'follow-up'], ['T01', 'latest reply'],
    ['T02', 'first request'], ['T02', 'latest reply'],
  ]);
  assert.match(overview[2].excerpts[0].text, /授权使用 schema 56/u);
  assert.equal(overview[6].requiresDetail, true);
});

test('a child that fails leaves no edit in the copy and pauses the run', async (t) => {
  const env = await setup(t);
  env.setChild(async () => {
    return { stopReason: 'error', output: [] };
  });
  const result = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  assert.equal(result.status, 'paused');
  assert.equal(result.resumable, true);
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
});

test('a reused worker must correct a previous task citation before any change in the submission is applied', async (t) => {
  const env = await setup(t, {}, ['s1', 's2']);
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      const submit = { done: true, summary: 'checked', changes: [] };
      await invoke('dream_read_source', { task: 1, page: 0 });
      await invoke('dream_submit_task', { task: 1, ...submit });
      await invoke('dream_read_source', { task: 2, page: 0 });
      const change = { ...NOTE, citations: [{ session_id: 's2', seq: 2, quote: QUOTE }] };
      const foreign = { ...NOTE, file: 'project_foreign.md', citations: [{ session_id: 's1', seq: 2, quote: QUOTE }] };
      const refused = await invoke('dream_submit_task', { task: 2, ...submit, changes: [change, foreign] });
      assert.match(refused, /ERROR:.*current task/u);
      assert.deepEqual(JSON.parse(await invoke('dream_list_notes', {})), []);
      assert.match(await invoke('dream_submit_task', { task: 2, ...submit, changes: [change] }), /Batch finished/u);
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.ready, true, run.error);
  assert.deepEqual(env.pctx.state.snapshot().shadowPending.origins, { 'project_release.md': ['s2'] });
});

test('resume publishes the last checkpoint without starting a notes-only child', async (t) => {
  const env = await setup(t);
  const start = env.host.services.subagents.startActivation;
  env.host.services.subagents.startActivation = async (spec) => {
    const activation = await start(spec);
    return { ...activation, result: activation.result.then(() => ({ stopReason: 'error' })) };
  };
  const paused = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(paused.status, 'paused');
  delete env.host.services.subagents;
  const resumed = await env.runtime.dream({ pctx: env.pctx, resume: true, runId: paused.runId });
  assert.equal(env.starts.length, 1);
  assert.equal(resumed.ready, true, resumed.error);
  assert.deepEqual(env.pctx.state.snapshot().shadowPending.reviewRecords.map(({ id }) => id), ['s1']);
});

test('lowering the next batch limit does not drop frozen tasks on resume', async (t) => {
  const env = await setup(t, { dreamMaxTasks: 3 }, ['s1', 's2', 's3']);
  env.setChild(async (spec) => sessionOf(spec) === 's1'
    ? { stopReason: 'completed', structured: { done: true, summary: 'checked', changes: [] } }
    : { stopReason: 'error' });
  const paused = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(paused.status, 'paused');
  env.runtime.baseConfig = { ...env.config, dreamMaxTasks: 1 };
  env.setChild(async () => ({ stopReason: 'completed', structured: { done: true, summary: 'checked', changes: [] } }));
  const resumed = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, resume: true, runId: paused.runId });
  assert.equal(resumed.sessionsReviewed, 3, resumed.error);
  assert.equal(env.starts.length, 2);
});

test('an edit without a matching quote is shown as unsupported, not applied silently', async (t) => {
  const env = await setup(t);
  env.setChild(async () => {
    return { stopReason: 'completed', output: [], structured: { done: true, summary: 'x', changes: [
      { ...NOTE, body: NOTE.body.replace('pnpm', 'yarn'), citations: [{ session_id: 's1', seq: 2, quote: 'yarn release everywhere' }] },
    ] } };
  });
  await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  const pending = env.pctx.state.snapshot().shadowPending;
  assert.ok(pending, 'the change still reaches review');
  assert.ok(!pending.evidence.some((item) => item.verified));
  const proof = pending.proofs.find((item) => item.file === 'project_release.md');
  assert.equal(proof.kind, 'missing');
});

test('without a live conversation to parent the children, Dream skips and says why', async (t) => {
  const env = await setup(t);
  env.pctx.agent = undefined;
  const result = await env.runtime.dream({ pctx: env.pctx, force: true });
  assert.equal(env.starts.length, 0);
  assert.equal(result.skipReason, 'subagent-unavailable');
});

test('without the host subagent service, Dream skips and says why', async (t) => {
  const env = await setup(t);
  delete env.host.services.subagents;
  const result = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  assert.equal(result.skipReason, 'subagent-unavailable');
});

test('dreamYieldToSubagents waits for the user subagents, then runs to the end', async (t) => {
  const env = await setup(t, { dreamYieldToSubagents: true });
  env.host.emit('subagent/start', { runId: 'u1', id: 'user-child' });
  const run = await env.runtime.startDream(env.pctx, { agent: env.parent, force: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(env.starts.length, 0);
  env.host.emit('subagent/end', { runId: 'u1', id: 'user-child' });
  const result = await run.done;
  assert.equal(env.starts.length, 1);
  assert.equal(result.ready, true);
});

test('without the yield option Dream starts at once and retries when the host is at capacity', async (t) => {
  const env = await setup(t);
  env.host.emit('subagent/start', { runId: 'u1', id: 'user-child' });
  const start = env.host.services.subagents.startActivation;
  let refused = 0;
  env.host.services.subagents.startActivation = async (spec) => {
    if (refused++ === 0) throw Object.assign(new Error('at capacity'), { code: 'ACTIVATION_LIMIT_REACHED' });
    return start(spec);
  };
  const run = await env.runtime.startDream(env.pctx, { agent: env.parent, force: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(refused, 1);
  env.host.emit('subagent/end', { runId: 'u1', id: 'user-child' });
  const result = await run.done;
  assert.equal(refused, 2);
  assert.equal(result.ready, true);
});

test('cancelling a slot wait rejects without starting a Dream child', async () => {
  const { SubagentTracker } = await import('../src/dream-subagent.js');
  const tracker = new SubagentTracker();
  const controller = new AbortController();
  const waiting = tracker.next(controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/u);
});

test('a Dream child cannot use the memory tools even when subagents share memory', async (t) => {
  const env = await setup(t, { subagentMemory: 'shared' });
  let allowed;
  env.setChild(async (spec) => {
    allowed = env.runtime.canWriteMemory({ id: spec.childId, session: { header: { parentSession: 'lead-1', origin: 'subagent' } } });
    return { stopReason: 'completed', output: [], structured: { done: true, summary: 'nothing', changes: [] } };
  });
  await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  assert.equal(allowed, false);
  assert.equal(env.runtime.canWriteMemory({ id: 'other-child', session: { header: { parentSession: 'lead-1', origin: 'subagent' } } }), true);
});

test('session pages retain sequence markers, omit credentials and leave no source file', async (t) => {
  const env = await setup(t);
  const secret = 'sk-proj-' + 'SyntheticFixture1234567890'.repeat(3);
  env.events.push(message(3, 'user', 'Synthetic credential ' + secret));
  await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  const text = env.host.dreamSourcePages.join('\n');
  assert.match(text, /\[seq 2\] user\/message\n纠正一下/u);
  assert.match(text, /\[seq 3\] user\/message\n\[sensitive passage omitted\]/u);
  assert.ok(!text.includes(secret));
  const runId = env.pctx.state.snapshot().shadowPending.runId;
  await assert.rejects(access(path.join(env.pctx.paths.dreamsDir, runId, 'tasks')), { code: 'ENOENT' });
});

test('the task list shows, per workspace, which conversations Dream reviewed and which not yet', async (t) => {
  const env = await setup(t, { dreamMaxTasks: 1 }, ['s1', 's2', 's3']);
  const before = await env.runtime.dreamCoverage(env.pctx);
  assert.deepEqual(before.sessions.map(({ status }) => status), ['todo', 'todo', 'todo']);
  await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  const pending = await env.runtime.dreamCoverage(env.pctx);
  const reviewed = env.starts[0].prompt[0].text.match(/session_id=(\S+?),/u)[1];
  assert.equal(pending.sessions.find(({ id }) => id === reviewed).status, 'review');
  assert.equal(pending.counts.todo, 2);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx })).ok, true);
  const after = await env.runtime.dreamCoverage(env.pctx);
  assert.equal(after.sessions.find(({ id }) => id === reviewed).status, 'done');
  assert.equal(after.counts.done, 1);
  // A conversation of another workspace is not listed.
  env.host.services.sessionQuery.filterSessions = async () => [
    { header: { id: 's1', cwd: env.workspaceDir } },
    { header: { id: 'elsewhere', cwd: path.join(env.tmp, 'other-workspace') } },
  ];
  assert.deepEqual((await env.runtime.dreamCoverage(env.pctx)).sessions.map(({ id }) => id), ['s1']);
  const status = await env.mods.status.createStatusService(env.runtime).status(env.pctx);
  assert.equal(status.dreamTasks.total, 1);
});

test('task rows carry the host session title when it has one', async (t) => {
  const env = await setup(t, {}, ['s1', 's2']);
  env.host.services.sessionQuery.readTitleSnapshots = async (ids) => ids.map((id) => (id === 's1'
    ? { status: 'fulfilled', value: { session: { id }, title: { title: 'Release command question' } } }
    : { status: 'fulfilled', value: { session: { id } } }));
  const { sessions } = await env.runtime.dreamCoverage(env.pctx);
  assert.equal(sessions.find(({ id }) => id === 's1').title, 'Release command question');
  assert.equal(sessions.find(({ id }) => id === 's2').title, '');
});

test('a partial switch settles the session whose changes went live and holds the one deferred', async (t) => {
  const env = await setup(t, {}, ['s1', 's2']);
  env.setChild(async (spec) => {
    const session = spec.prompt[0].text.match(/session_id=(\S+?),/u)[1];
    if (session === 's1') {
      return { stopReason: 'completed', output: [], structured: { done: true, summary: 'release', changes: [
        { ...NOTE, citations: [{ session_id: 's1', seq: 2, quote: QUOTE }] },
      ] } };
    }
    // An unsourced paraphrase: review cannot bind it to a quote.
    const style = { op: 'write', file: 'feedback_style.md', name: 'Style', type: 'feedback', body: 'Answer directly.', citations: [] };
    return { stopReason: 'completed', output: [], structured: { done: true, summary: 'style', changes: [style] } };
  });
  const result = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  assert.equal(result.ready, true);
  assert.deepEqual(env.pctx.state.snapshot().shadowPending.origins, { 'project_release.md': ['s1'], 'feedback_style.md': ['s2'] });
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, defer: ['feedback_style.md'] })).ok, true);
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions.map(({ id }) => id), ['s1']);
  const { sessions } = await env.runtime.dreamCoverage(env.pctx);
  assert.deepEqual(sessions.map(({ id, status }) => [id, status]).sort(), [['s1', 'done'], ['s2', 'todo']]);
});

test('skipped or replaced source pages cannot advance the review cursor', async (t) => {
  const env = await setup(t);
  env.events.push(message(3, 'user', 'Long dialogue '.repeat(400)));
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      const submit = { task: 1, done: true, summary: 'checked', changes: [] };
      assert.match(await invoke('dream_submit_task', submit), /read all source pages/u);
      const first = await invoke('dream_read_source', { task: 1, page: 0 });
      const next = JSON.parse(first.split('\n')[0]).next_page;
      assert.equal(next, 1);
      await invoke('dream_read_source', { task: 1, page: next }, () => [{ type: 'text', text: 'redacted by host' }]);
      assert.match(await invoke('dream_submit_task', submit), /read all source pages/u);
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.error, 'subagent-incomplete-tasks');
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);
});

for (const userMemory of ['global', 'project']) {
  test(`Dream respects the ${userMemory} user memory policy for new notes`, async (t) => {
    const env = await setup(t, { userMemory });
    env.setChild(async () => ({ stopReason: 'completed', structured: { done: true, summary: 'checked', changes: [
      { ...NOTE, file: 'user_release.md', type: 'user', citations: [{ session_id: 's1', seq: 2, quote: QUOTE }] },
    ] } }));
    const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
    if (userMemory === 'global') {
      assert.equal(run.error, 'unfinished-writes');
      assert.equal(env.pctx.state.snapshot().shadowPending, null);
    } else {
      assert.equal(run.ready, true);
      assert.equal(env.pctx.state.snapshot().shadowPending.files[0].file, 'user_release.md');
    }
  });
}

test('a child whose turn ends without a result stops the wait instead of hanging', async (t) => {
  // Dream's own waits use unref'd timers; with a dispose that never settles,
  // Node 22's runner would otherwise see an empty event loop and cancel the file.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const { SubagentTracker, runDreamChild } = await import('../src/dream-subagent.js');
  const tracker = new SubagentTracker();
  let childId;
  const subagents = {
    async startActivation(spec) {
      childId = spec.childId;
      // Paused from the host: the turn ends, the result never settles.
      setTimeout(() => tracker.endedTurn({ id: childId }, { type: 'turn/end' }), 10);
      return { childId, result: new Promise(() => {}), dispose: () => new Promise(() => {}) };
    },
  };
  const { result } = await runDreamChild({ subagents, tracker, parent: {}, cwd: '.', label: 'x', prompt: 'x',
    signal: new AbortController().signal, graceMs: 20 });
  assert.equal(result.stopReason, 'aborted');
  assert.equal(tracker.isOwn(childId), false);
});

test('sessions in the memory root, such as Dream children, get no memory project', async (t) => {
  const env = await setup(t);
  const shadow = path.join(env.pctx.paths.dreamsDir, 'shadow');
  const child = { id: 'old-child', session: { header: { id: 'old-child', cwd: shadow, parentSession: 'lead-1', origin: 'subagent' } } };
  assert.equal(await env.runtime.forAgent(child), undefined);
  assert.equal(await env.runtime.forSessionId('old-child', shadow), undefined);
  env.host.services.agents.get = (id) => (id === 'old-child' ? child : id === env.parent.id ? env.parent : undefined);
  assert.equal(await env.runtime.isDreamSession('old-child'), true);
  assert.equal(await env.runtime.isDreamSession(env.parent.id), false);
});

test('conversations started in a git-ignored folder of the project are not Dream tasks', async (t) => {
  const env = await setup(t, {}, []);
  const { execFileSync } = await import('node:child_process');
  const { mkdir: makeDir } = await import('node:fs/promises');
  execFileSync('git', ['init', '-q'], { cwd: env.workspaceDir });
  await writeFile(path.join(env.workspaceDir, '.gitignore'), 'runs/\n');
  const scratch = path.join(env.workspaceDir, 'runs', 'eval-1');
  const docs = path.join(env.workspaceDir, 'docs');
  await makeDir(scratch, { recursive: true });
  await makeDir(docs, { recursive: true });
  env.host.services.sessionQuery.filterSessions = async () => [
    { header: { id: 'root', cwd: env.workspaceDir } },
    { header: { id: 'docs', cwd: docs } },
    { header: { id: 'eval', cwd: scratch } },
  ];
  const { sessions } = await env.runtime.dreamCoverage(env.pctx);
  assert.deepEqual(sessions.map(({ id }) => id).sort(), ['docs', 'root']);
});

test('a note named with its type prefix keeps one prefix', async (t) => {
  const env = await setup(t);
  const saved = await env.pctx.store.saveEntry({ name: 'feedback_handover_doc_format', type: 'feedback', description: '', content: 'Handover: conclusions and to-dos.', source: { via: 'test' } });
  assert.equal(saved.file, 'feedback_handover_doc_format.md');
});

const unfinishedIn = (env, unfinished) => env.setChild(async (spec) => {
  const session = sessionOf(spec);
  return { stopReason: 'completed', output: [], structured: {
    done: session !== unfinished, summary: 'task ' + session,
    changes: session === unfinished ? [{ ...NOTE, file: 'project_unfinished.md', citations: [{ session_id: session, seq: 2, quote: QUOTE }] }] : [],
  } };
});

test('an unfinished task with a draft ends the batch, so no later task is handed out or reviewed', async (t) => {
  const env = await setup(t, {}, ['s1', 's2']);
  unfinishedIn(env, 's1');
  const result = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  assert.equal(env.prompts.length, 1);
  assert.match(env.prompts[0], /session_id=s1,/u);
  // Its draft reaches review only as an incomplete review; no session is marked reviewed.
  assert.equal(result.ready, true, result.error);
  assert.equal(env.pctx.state.snapshot().dreamRunOutcomes.at(-1).skipReason, 'incomplete-review');
  assert.deepEqual(env.pctx.state.snapshot().shadowPending.reviewRecords, []);
});

test('an unfinished task after a finished one pauses, and its draft stays out of the checkpoint', async (t) => {
  const env = await setup(t, {}, ['s1', 's2']);
  unfinishedIn(env, 's2');
  const paused = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.error, 'unchecked-draft');
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
  const { readFile: read } = await import('node:fs/promises');
  const checkpoint = JSON.parse(await read(path.join(env.pctx.paths.dreamsDir, paused.runId, 'checkpoint.json'), 'utf8'));
  assert.deepEqual(checkpoint.work.map(({ id }) => id), ['s1']);
  assert.ok(!checkpoint.draft.pages.some(({ file }) => file === 'project_unfinished.md'));
});
