/**
 * Dream's cross-session input: the work view (tool calls and results), the
 * search tools over the project's other sessions, citations of events read
 * there, the session catalog, and the one shared recording standard.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MEMORY_SELECTION } from '../src/rules.js';
import { resolveConfig } from '../src/config.js';
import { createDreamSearch } from '../src/dream-search.js';
import { buildSessionTranscript, chunkTranscript, countFailedToolResults, renderTranscriptPage } from '../src/dream-session-text.js';
import { registerScheduler } from '../src/scheduler.js';
import { mountDreamFixture, streamOf, toolsEnv, waitFor } from './v10-helpers.mjs';

const text = (seq, role, body, source) => ({
  seq, type: `${role}/message`, time: Date.UTC(2026, 10, 20, 9, seq),
  data: { message: { role, content: [{ type: 'text', text: body }], ...(source ? { source: { kind: source } } : {}) } },
});
const call = (seq, id, name, args) => ({ seq, type: 'tool/call', time: Date.UTC(2026, 10, 20, 9, seq), data: { name, toolCallId: id, arguments: args } });
const result = (seq, id, body, extra = {}) => ({
  seq, type: 'tool/result', time: Date.UTC(2026, 10, 20, 9, seq), data: { message: { toolCallId: id, content: [{ type: 'text', text: body }], ...extra } },
});

const FAILED = 'build exploded\n[stderr]\nENOSPC: no space left\n[exit code: 1]';
const WORK = [
  text(0, 'user', 'Please run the release build for the docs site.'),
  text(1, 'assistant', 'Running the build now.'),
  call(2, 'c1', 'bash', { command: 'pnpm release' }),
  result(3, 'c1', FAILED),
  call(4, 'c2', 'bash', { command: 'pnpm release --clean' }),
  result(5, 'c2', 'released 1.2.3\n[exit code: 0]'),
  text(6, 'assistant', 'Fixed: the release works now.'),
];

test('the work view keeps tool calls and results with their exit markers; the extractor view does not', () => {
  const calls = buildSessionTranscript(WORK, { work: true });
  const page = renderTranscriptPage(calls, { limit: 100 }).text;
  assert.match(page, /\[seq 2\] \[tool-call\] bash \{"command":"pnpm release"\}/u);
  assert.match(page, /\[seq 3\] \[tool-error\]|\[seq 3\] \[tool-result\] bash: build exploded/u);
  assert.match(page, /\\\[exit code: 1\]/u, 'the marker line stays, escaped so it cannot pose as structure');
  assert.match(page, /\[seq 5\] \[tool-result\] bash: released 1\.2\.3/u);
  assert.match(page, /\[seq 6\] \[assistant\] Fixed/u, 'the assistant claim is kept beside the results');
  const today = chunkTranscript(buildSessionTranscript(WORK), { chunkChars: 10_000, toolCharsPerChunk: 4_000 })[0].text;
  assert.doesNotMatch(today, /pnpm release --clean|released 1\.2\.3|Running the build/u);
  assert.doesNotMatch(renderTranscriptPage(buildSessionTranscript(WORK)).text, /tool-call/u);
});

test('a long tool result keeps its head and its tail, and secrets are replaced', () => {
  const long = `start-of-output\n${'x'.repeat(3000)}\n[stderr]\nboom\n[exit code: 2]`;
  const secret = result(5, 'c2', 'token sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD leaked');
  const page = renderTranscriptPage(buildSessionTranscript([call(2, 'c1', 'bash', { command: 'x'.repeat(2000) }), result(3, 'c1', long), call(4, 'c2', 'bash', {}), secret], { work: true }), { limit: 100 }).text;
  assert.match(page, /start-of-output/u);
  assert.match(page, /characters omitted/u);
  assert.match(page, /\\\[exit code: 2\]/u);
  assert.ok(page.length < 2_500, 'one call and result stay near 1.2k characters');
  assert.match(page, /\[sensitive passage omitted\]/u);
  assert.doesNotMatch(page, /sk-abcdef/u);
});

test('failed tool results are counted from errors and non-zero exit codes only', () => {
  const events = [...WORK, call(7, 'c3', 'read', {}), result(8, 'c3', 'denied', { isError: true })];
  assert.equal(countFailedToolResults(events), 2);
  assert.equal(countFailedToolResults([result(1, 'a', 'ok\n[exit code: 0]')]), 0);
});

test('dreamMaxTasks offers ten sessions by default', () => {
  assert.equal(resolveConfig({}).dreamMaxTasks, 10);
  assert.equal(resolveConfig({ dreamMaxTasks: 3 }).dreamMaxTasks, 3);
});

test('Dream search falls back to session events when a hit has no best match', async () => {
  const hit = { seq: 2, type: 'user/message', snippet: 'release command' };
  const search = createDreamSearch({
    sessionQuery: {
      searchSessions: async () => ({ items: [{ header: { id: 's1' }, bestMatch: null }] }),
      searchEvents: async () => ({ items: [null, hit] }),
      readEvent: async () => ({ target: text(2, 'user', 'release command') }),
    },
    allowed: async () => new Set(['s1']), offered: new Set(), remember: () => {},
  });
  const { items } = JSON.parse(await search.searchSessions({ query: 'release' }));
  assert.deepEqual(items.map(({ session_id, seq }) => [session_id, seq]), [['s1', 2]]);
});

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const NEEDLE = 'The flaky deploy needs --retry 3 every time';

/**
 * One offered session (s1) and a set of other sessions the search could reach.
 * The fake search matches any event whose text holds the query; the best match
 * of a session is its first such event, injected ones included.
 */
async function setup(t, { search = true, config = {} } = {}) {
  const env = await toolsEnv(t, { autoDreamEnabled: false, dreamMaxTasks: 1, ...config });
  const other = path.join(os.tmpdir(), 'cc-memory-another-project');
  const scratch = path.join(env.workspaceDir, 'runs', 'eval-1');
  execFileSync('git', ['init', '-q'], { cwd: env.workspaceDir });
  await writeFile(path.join(env.workspaceDir, '.gitignore'), 'runs/\n');
  await mkdir(scratch, { recursive: true });
  const day = (n) => Date.UTC(2026, 10, n);
  const sessions = {
    s1: { cwd: env.workspaceDir, createdAt: day(1), events: WORK },
    s6: { cwd: env.workspaceDir, createdAt: day(2), events: [
      text(0, 'user', 'Earlier: recalled note says the flaky deploy needs --retry 3', 'plugin:cc-memory-recall'),
      text(1, 'assistant', 'Starting deploy.'),
      text(2, 'user', NEEDLE),
      call(3, 'd1', 'bash', { command: 'deploy --retry 3' }),
      result(4, 'd1', `retry worked\n${SECRET}\n[exit code: 0]`),
    ] },
    s2: { cwd: env.workspaceDir, createdAt: day(3), events: [text(0, 'user', NEEDLE + ' (learn off)')] },
    s3: { cwd: other, createdAt: day(4), events: [text(0, 'user', NEEDLE + ' (another project)')] },
    s4: { cwd: env.workspaceDir, createdAt: day(5), parentSession: 'lead-1', events: [text(0, 'user', NEEDLE + ' (delegated)')] },
    s5: { cwd: scratch, createdAt: day(6), events: [text(0, 'user', NEEDLE + ' (git-ignored)')] },
  };
  await env.pctx.state.setSessionFlag('s2', 'learn', false);
  const searches = [];
  const reads = [];
  const hitOf = (id, event) => ({ sessionId: id, seq: event.seq, type: event.type, time: event.time, surface: 'current',
    snippet: (event.data?.message?.content?.[0]?.text ?? '') });
  const query = {
    filterSessions: async () => Object.entries(sessions).map(([id, item]) => ({ header: { id, cwd: item.cwd, createdAt: item.createdAt, ...(item.parentSession ? { parentSession: item.parentSession } : {}) } })),
    readSession: async (id) => ({ events: structuredClone(sessions[id]?.events ?? []) }),
    readTitleSnapshots: async (ids) => ids.map((sessionId) => (sessionId === 's1'
      ? { sessionId, status: 'fulfilled', value: { title: { title: 'Release flow' } } }
      : { sessionId, status: 'fulfilled', value: {} })),
  };
  if (search) {
    Object.assign(query, {
      searchSessions: async (request) => {
        searches.push(request);
        const ids = request.sessionFilters.find((filter) => filter.kind === 'id')?.values ?? Object.keys(sessions);
        const range = request.sessionFilters.find((filter) => filter.kind === 'created-at');
        // A host search that ignored the id filter would still be cut down by the wrapper.
        const items = Object.entries(sessions)
          .filter(([id, item]) => (!range || ((range.from === undefined || item.createdAt >= range.from) && (range.to === undefined || item.createdAt <= range.to))) && (ids.includes(id) || request.leak))
          .flatMap(([id, item]) => {
            const match = item.events.find((event) => (event.data?.message?.content?.[0]?.text ?? '').includes(request.query));
            return match ? [{ header: { id, cwd: item.cwd, createdAt: item.createdAt }, live: true, persisted: true, bestMatch: hitOf(id, match) }] : [];
          });
        return { items };
      },
      searchEvents: async ({ sessionId, query: needle }) => ({
        items: (sessions[sessionId]?.events ?? []).filter((event) => (event.data?.message?.content?.[0]?.text ?? '').includes(needle)).map((event) => hitOf(sessionId, event)),
      }),
      readEvent: async ({ sessionId, seq, before = 0, after = 0 }) => {
        reads.push({ sessionId, seq, before, after });
        const events = sessions[sessionId]?.events ?? [];
        const target = events.find((event) => event.seq === seq);
        if (!target) throw new Error(`no event ${seq}`);
        const inside = events.filter((event) => event.seq >= seq - before && event.seq <= seq + after);
        return { target: structuredClone(target), events: structuredClone(inside), startSeq: inside[0].seq, endSeq: inside.at(-1).seq };
      },
    });
  }
  env.host.services.sessionQuery = query;
  const parent = { id: 'lead-1', session: { header: { id: 'lead-1', cwd: env.workspaceDir } } };
  env.host.services.agents = { get: (id) => (id === parent.id ? parent : undefined), list: () => [parent] };
  let play = async () => {};
  const prompts = [];
  const toolNames = [];
  env.host.services.subagents = {
    async startActivation(spec) {
      prompts.push(spec.prompt[0].text);
      const invoke = mountDreamFixture(env.host, spec);
      const names = new Set();
      const tracked = (name, args, ...rest) => (names.add(name), invoke(name, args, ...rest));
      const finished = (async () => {
        await play(tracked, spec);
        return { stopReason: 'completed', output: [], structured: { finished: true } };
      })();
      toolNames.push(names);
      return { childId: spec.childId, name: spec.name, result: finished, dispose: async () => {} };
    },
  };
  const run = () => env.runtime.dream({ pctx: env.pctx, agent: parent });
  return { ...env, sessions, searches, reads, prompts, toolNames, run, child: (fn) => { play = fn; }, pending: () => env.pctx.state.snapshot().shadowPending };
}

const readAll = async (invoke) => {
  for (let from; ;) {
    const page = await invoke('dream_read_session', { session_id: 's1', ...(from === undefined ? {} : { from_seq: from }) });
    from = JSON.parse(page.split('\n')[0]).next_from_seq;
    if (from === null) return;
  }
};

test('Dream reads the work of a session: calls, results with exit markers and the assistant claim', async (t) => {
  const env = await setup(t);
  let page = '';
  env.child(async (invoke) => {
    page = await invoke('dream_read_session', { session_id: 's1' });
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  assert.match(page, /\[tool-call\] bash \{"command":"pnpm release"\}/u);
  assert.match(page, /\[seq 3\] \[tool-error\] bash: build exploded|\[seq 3\] \[tool-result\] bash: build exploded/u);
  assert.match(page, /ENOSPC/u);
  assert.match(page, /\\\[exit code: 1\]/u);
});

test('search never reaches learn-off, other-project, delegated or git-ignored sessions, nor injected events', async (t) => {
  const env = await setup(t);
  const seen = {};
  env.child(async (invoke) => {
    seen.sessions = JSON.parse(await invoke('dream_search_sessions', { query: 'flaky deploy' }));
    for (const id of ['s2', 's3', 's4', 's5']) {
      seen[id] = [await invoke('dream_search_events', { session_id: id, query: 'flaky' }), await invoke('dream_read_event', { session_id: id, seq: 0 })];
    }
    seen.events = JSON.parse(await invoke('dream_search_events', { session_id: 's6', query: 'flaky deploy' }));
    seen.injected = await invoke('dream_read_event', { session_id: 's6', seq: 0 });
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  // The host search is asked for the allowed sessions only (s1 offered, s6 the other allowed one)...
  assert.deepEqual(env.searches[0].sessionFilters.find(({ kind }) => kind === 'id').values.sort(), ['s1', 's6']);
  // ...and the wrapper cuts again, so a host that ignores the filter changes nothing.
  assert.deepEqual(seen.sessions.items.map((item) => item.session_id), ['s6']);
  assert.equal(seen.sessions.items[0].seq, 2, 'the injected best match is skipped for the first real event');
  assert.equal(seen.sessions.items[0].offered, false);
  assert.equal(seen.sessions.items[0].date, '2026-11-02');
  for (const id of ['s2', 's3', 's4', 's5']) {
    for (const reply of seen[id]) assert.match(reply, /^ERROR: session_id is not a session of this project/u, id);
  }
  assert.deepEqual(seen.events.items.map((item) => item.seq), [2]);
  assert.match(seen.injected, /^ERROR: that event is host-injected context/u);
});

test('a search host that returns sessions outside the id filter is still cut down', async (t) => {
  const env = await setup(t);
  const original = env.host.services.sessionQuery.searchSessions;
  env.host.services.sessionQuery.searchSessions = (request) => original({ ...request, leak: true });
  let items;
  env.child(async (invoke) => {
    items = JSON.parse(await invoke('dream_search_sessions', { query: 'flaky deploy', since: '2026-11-01', until: '2026-11-30' })).items;
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  assert.deepEqual(items.map((item) => item.session_id), ['s6']);
  const range = env.searches[0].sessionFilters.find(({ kind }) => kind === 'created-at');
  assert.equal(range.from, Date.UTC(2026, 10, 1));
  assert.equal(range.to, Date.UTC(2026, 10, 30) + 86_400_000 - 1, 'a bare until date covers that day');
});

test('dream_read_event shows labelled work around an event and redacts secrets', async (t) => {
  const env = await setup(t);
  let page = '';
  env.child(async (invoke) => {
    page = await invoke('dream_read_event', { session_id: 's6', seq: 3, before: 1, after: 1 });
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  const [header, ...rest] = page.split('\n');
  assert.deepEqual(JSON.parse(header), { session_id: 's6', seq: 3, from_seq: 2, to_seq: 4, offered: false, shown_messages: 3, truncated: false });
  assert.match(rest.join('\n'), /\[seq 2\] \[user\] The flaky deploy/u);
  assert.match(rest.join('\n'), /\[seq 3\] \[tool-call\] bash \{"command":"deploy --retry 3"\}/u);
  assert.match(rest.join('\n'), /\[seq 4\] \[sensitive passage omitted\]/u);
  assert.doesNotMatch(page, /sk-abcdef/u);
  assert.deepEqual(env.reads, [{ sessionId: 's6', seq: 3, before: 1, after: 1 }]);
});

test('a quote from an event read with dream_read_event can be cited, and does not settle that session', async (t) => {
  const env = await setup(t);
  const replies = [];
  const note = (citations) => ({ file: 'project_deploy.md', op: 'write', name: 'Deploy', type: 'project', body: 'Retry the flaky deploy three times.', citations });
  env.child(async (invoke) => {
    // Not yet read: a session that was not offered is not citable.
    replies.push(await invoke('dream_submit', { changes: [note([{ session_id: 's6', seq: 2, quote: NEEDLE }])], done: false }));
    await invoke('dream_read_event', { session_id: 's6', seq: 2, before: 0, after: 0 });
    // Read, but only seq 2: seq 3 is outside what was shown.
    replies.push(await invoke('dream_submit', { changes: [note([{ session_id: 's6', seq: 3, quote: 'deploy --retry 3' }])], done: false }));
    replies.push(await invoke('dream_submit', { changes: [note([{ session_id: 's6', seq: 2, quote: NEEDLE }])], done: false }));
    await readAll(invoke);
    await invoke('dream_submit', { changes: [], skipped_sessions: [], done: true });
  });
  const outcome = await env.run();
  assert.match(replies[0], /session s6 was not offered/u);
  assert.match(replies[1], /session s6 has no event 3/u);
  assert.match(replies[2], /^WROTE project_deploy\.md/u);
  assert.equal(outcome.ready, true, outcome.error);
  const [item] = env.pending().evidence;
  assert.deepEqual([item.sessionId, item.seq, item.verified, item.role], ['s6', 2, true, 'user']);
  assert.equal(outcome.sessionsOffered, 1);
  assert.deepEqual(env.pending().reviewRecords.map(({ id }) => id), ['s1'], 's6 was read in part, never offered, so it is not reviewed');
});

test('a clipped cross-session result does not make its events citable', async (t) => {
  const env = await setup(t);
  const replies = [];
  const change = { file: 'project_deploy.md', op: 'write', body: 'Retry deployment three times.', citations: [{ session_id: 's6', seq: 2, quote: NEEDLE }] };
  env.child(async (invoke) => {
    await invoke('dream_read_event', { session_id: 's6', seq: 2 }, () => [{ type: 'text', text: '[truncated]' }]);
    replies.push(await invoke('dream_submit', { changes: [change], done: false }));
    await invoke('dream_read_event', { session_id: 's6', seq: 2 });
    replies.push(await invoke('dream_submit', { changes: [change], done: true }));
  });
  assert.equal((await env.run()).ready, true);
  assert.match(replies[0], /no valid citation/u);
  assert.match(replies[1], /^WROTE/u);
});

test('a cross-session tool result without its producer cannot establish provenance', async (t) => {
  const env = await setup(t);
  const query = env.host.services.sessionQuery;
  const readEvent = query.readEvent;
  query.readEvent = async (args) => {
    const { before } = args;
    if (args.sessionId !== 's6' || args.seq !== 6) return readEvent(args);
    const target = result(6, 'm1', 'The snapshot remembered an obsolete command.');
    const events = before > 0 ? [call(5, 'm1', 'memory_read', {}), target] : [target];
    return { target, events, startSeq: events[0].seq, endSeq: 6 };
  };
  const replies = [];
  const change = { file: 'project_deploy.md', op: 'write', body: 'Use the obsolete command.',
    citations: [{ session_id: 's6', seq: 6, quote: 'remembered an obsolete command' }] };
  env.child(async (invoke) => {
    for (const before of [0, 1]) {
      await invoke('dream_read_event', { session_id: 's6', seq: 6, before });
      replies.push(await invoke('dream_submit', { changes: [change], done: false }));
    }
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  assert.match(replies[0], /tool result.*could not identify its call/u);
  assert.match(replies[1], /memory tool call or result/u);
});

test('a tool call of a read event can be quoted; an event of a learn-off session cannot be read or cited', async (t) => {
  const env = await setup(t);
  const replies = [];
  env.child(async (invoke) => {
    await invoke('dream_read_event', { session_id: 's6', seq: 3, before: 0, after: 1 });
    const note = (citation) => ({ file: 'project_deploy.md', op: 'write', name: 'Deploy', type: 'project', body: 'Use the retry flag.', citations: [citation] });
    replies.push(await invoke('dream_submit', { changes: [note({ session_id: 's6', seq: 3, quote: 'deploy --retry 3' })], done: false }));
    replies.push(await invoke('dream_submit', { changes: [note({ session_id: 's2', seq: 0, quote: NEEDLE })], done: false }));
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  assert.match(replies[0], /^WROTE project_deploy\.md/u);
  assert.match(replies[1], /session s2 was not offered/u);
});

test('without a search backend the search tools are not offered and the prompt says so', async (t) => {
  const env = await setup(t, { search: false });
  env.child(async (invoke) => {
    for (const name of ['dream_search_sessions', 'dream_search_events', 'dream_read_event']) {
      await assert.rejects(() => invoke(name, { query: 'x', session_id: 's1', seq: 0 }), TypeError);
    }
    await readAll(invoke);
    await invoke('dream_submit', { changes: [], done: true });
  });
  const outcome = await env.run();
  assert.equal(outcome.ok, true, outcome.error);
  assert.match(env.prompts[0], /Searching other sessions is not available in this host/u);
});

test('the session catalog shows the title, date, event count and failed tool results', async (t) => {
  const env = await setup(t);
  env.child(async (invoke) => {
    await readAll(invoke);
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  assert.match(env.prompts[0], /^- s1 \| 2026-11-01 \| 7 events, \d+ chars, 1 failed tool results \| title: "Release flow"$/mu);
  assert.match(env.prompts[0], /dream_search_sessions/u);
  assert.doesNotMatch(env.prompts[0], /not available in this host/u);
});

test('the catalog falls back to the first user message when the host has no title', async (t) => {
  const env = await setup(t);
  delete env.host.services.sessionQuery.readTitleSnapshots;
  env.child(async (invoke) => {
    await readAll(invoke);
    await invoke('dream_submit', { changes: [], done: true });
  });
  await env.run();
  assert.match(env.prompts[0], /^- s1 \| 2026-11-01 \| 7 events, \d+ chars, 1 failed tool results \| first user message: "Please run the release build/mu);
});

test('auto-extract and Dream carry the same recording standard', async (t) => {
  const env = await toolsEnv(t, { autoExtract: true, autoExtractEveryTurns: 1, autoDreamEnabled: false });
  const requests = [];
  env.host.services.llm.stream = (request) => {
    requests.push(request);
    return streamOf([{ type: 'text-delta', text: 'DONE' }, { type: 'finish', reason: { kind: 'stop' } }]);
  };
  env.host.services.sessionQuery = {
    filterSessions: async () => [],
    readSession: async (id) => ({ session: { id, cwd: env.workspaceDir }, events: [text(1, 'user', 'We release with make release, always.')] }),
  };
  const dispose = registerScheduler(env.host, env.runtime);
  t.after(() => dispose?.());
  env.host.emit('session/event', { id: 's1', header: { cwd: env.workspaceDir } }, { type: 'turn/end', time: Date.now() });
  const request = await waitFor(() => requests[0]);
  assert.ok(request.system.includes(MEMORY_SELECTION), 'auto-extract states the shared standard');
  assert.doesNotMatch(request.system, /Save only knowledge a future session cannot recover/u, 'and no second copy of it');
  assert.match(MEMORY_SELECTION, /cannot recover from the repository, its history or its instruction files/u);
  assert.match(MEMORY_SELECTION, /`sources` field \(path or path#symbol\) instead of copying the value/u);

  const dream = await setup(t);
  dream.child(async (invoke) => invoke('dream_submit', { changes: [], done: true }));
  await dream.run();
  assert.ok(dream.prompts[0].includes(MEMORY_SELECTION), 'Dream states the same standard');
  assert.match(dream.prompts[0], /Lessons that span sessions/u);
});

test('a Dream change can point at repository files with sources; a bad path is refused', async (t) => {
  const env = await setup(t);
  const replies = [];
  const change = (sources) => ({ file: 'project_build.md', op: 'write', name: 'Build', type: 'project', body: 'The release build fails when the disk is full.',
    sources, citations: [{ session_id: 's1', seq: 0, quote: 'run the release build for the docs site' }] });
  env.child(async (invoke) => {
    await readAll(invoke);
    replies.push(await invoke('dream_submit', { changes: [change(['../outside.js'])], done: false }));
    replies.push(await invoke('dream_submit', { changes: [change(['scripts/release.mjs#publish'])], done: true }));
  });
  await env.run();
  assert.match(replies[0], /ERROR: source must be a repo-relative path/u);
  assert.match(replies[1], /^WROTE project_build\.md/u);
  assert.match(await readShadowNote(env, 'project_build.md'), /sources:[\s\S]*scripts\/release\.mjs#publish/u);
});

async function readShadowNote(env, file) {
  const { readFile } = await import('node:fs/promises');
  const { shadowDirOf } = await import('../src/dream-shadow.js');
  return readFile(path.join(shadowDirOf(env.pctx.paths), file), 'utf8');
}

test('tool roles: a bash result is a tool-result, a call is a tool-call, and memory tools cannot be cited', async (t) => {
  const env = await setup(t);
  const memory = [
    text(0, 'user', 'Please remember the release flow.'),
    call(1, 'm1', 'memory_save', { name: 'Release flow', content: 'Releases run through pnpm release only.' }),
    result(2, 'm1', 'saved: Release flow, releases run through pnpm release only'),
    call(3, 'm2', 'memory_read', { file: 'project_release.md' }),
    result(4, 'm2', 'note says: staging uses the old deploy script'),
    call(5, 'b1', 'bash', { command: 'pnpm release --dry-run' }),
    result(6, 'b1', 'dry run finished\n[exit code: 0]'),
  ];
  env.sessions.s1.events = memory;
  const replies = [];
  const note = (quote, seq) => ({ file: 'project_release.md', op: 'write', name: 'Release', type: 'project', body: 'Releases use pnpm release.', citations: [{ session_id: 's1', seq, quote }] });
  let page = '';
  env.child(async (invoke) => {
    page = await invoke('dream_read_session', { session_id: 's1' });
    replies.push(await invoke('dream_submit', { changes: [note('pnpm release only', 1)], done: false }));
    replies.push(await invoke('dream_submit', { changes: [note('releases run through pnpm release only', 2)], done: false }));
    replies.push(await invoke('dream_submit', { changes: [note('staging uses the old deploy script', 4)], done: false }));
    replies.push(await invoke('dream_submit', { changes: [note('pnpm release --dry-run', 5)], done: false }));
    replies.push(await invoke('dream_submit', { changes: [note('dry run finished', 6)], done: true }));
  });
  await env.run();
  assert.match(page, /\[tool-call\] memory_save \(memory operation, not citable\)/u);
  for (const reply of replies.slice(0, 3)) assert.match(reply, /memory tool call or result: memory text cannot be cited/u);
  assert.match(replies[3], /^WROTE/u);
  assert.match(replies[4], /^WROTE/u);
  const roles = env.pending().evidence.map(({ seq, role }) => [seq, role]);
  assert.deepEqual(roles, [[5, 'tool-call'], [6, 'tool-result']]);
});

test('the main-session citation check refuses a memory tool call and result too', async () => {
  const { checkSessionCitations } = await import('../src/citation.js');
  const events = [
    text(0, 'user', 'We deploy with make release every time.'),
    call(1, 'm1', 'memory_save', { content: 'Deploy with make release, every time, no exceptions.' }),
    result(2, 'm1', 'saved: Deploy with make release, every time, no exceptions.'),
    call(3, 'b1', 'bash', { command: 'make release' }),
    result(4, 'b1', 'released ok\n[exit code: 0]'),
  ];
  const ctx = { get: (name) => (name === 'sessionQuery' ? { readSession: async () => ({ events }) } : undefined) };
  const check = (quote, seq) => checkSessionCitations({ ctx, sessionId: 's1', citations: [{ quote, seq }] });
  for (const [quote, seq] of [['no exceptions', 1], ['no exceptions', 2]]) {
    const { evidence, problems } = await check(quote, seq);
    assert.equal(evidence.length, 0);
    assert.match(problems[0], /memory tool call or result/u);
  }
  assert.deepEqual((await check('released ok', 4)).evidence.map(({ role }) => role), ['tool-result']);
  assert.deepEqual((await check('make release', 3)).evidence.map(({ role }) => role), ['tool-call']);
  // Without a seq, the best-held event is never a memory operation.
  assert.deepEqual((await check('no exceptions')).problems.length, 1);
});
