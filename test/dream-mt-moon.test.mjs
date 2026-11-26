/**
 * "Mt. Moon": memory already holds a wrong note, and the session it came from
 * shows what really happened. Each case in eval/mt-moon/cases.json runs through
 * a real Dream pass with a scripted child that behaves like a competent model
 * (reads what it is offered, cites the user's words, leaves the rest alone).
 * This proves the plumbing lets a correct model fix the note: the source
 * session is offered, readable and citable with the right role, the old value
 * lands in History and nothing else changes. Whether a real model does it is
 * measured by eval/mt-moon/run.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCases, eventText, scoreCase } from '../eval/mt-moon/lib.mjs';
import { mountDreamFixture, toolsEnv } from './v10-helpers.mjs';

const cases = await loadCases();

const toEvent = (event, seq) => ({
  seq, type: `${event.role}/message`, time: Date.UTC(2026, 10, 20, 9, seq),
  data: { message: { role: event.role, content: [{ type: 'text', text: eventText(event) }], ...(event.injected ? { source: { kind: event.injected } } : {}) } },
});

async function setup(t, testCase) {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  const events = Object.fromEntries(testCase.sessions.map(({ id, events: list }) => [id, list.map(toEvent)]));
  env.host.services.sessionQuery = {
    filterSessions: async () => testCase.sessions.map(({ id }, index) => ({ header: { id, cwd: env.workspaceDir, createdAt: Date.UTC(2026, 10, 1 + index) } })),
    readSession: async (id) => ({ events: structuredClone(events[id] ?? []) }),
  };
  const parent = { id: 'lead-1', session: { header: { id: 'lead-1', cwd: env.workspaceDir } } };
  env.host.services.agents = { get: (id) => (id === parent.id ? parent : undefined), list: () => [parent] };
  let play = async () => {};
  env.host.services.subagents = {
    async startActivation(spec) {
      const invoke = mountDreamFixture(env.host, spec);
      const result = (async () => {
        await play(invoke, spec);
        return { stopReason: 'completed', output: [], structured: { finished: true } };
      })();
      return { childId: spec.childId, name: spec.name, result, dispose: async () => {} };
    },
  };
  return { ...env, parent, child: (fn) => { play = fn; } };
}

const readAll = async (store) => Object.fromEntries(await Promise.all(
  (await store.listEntries('project')).map(async ({ file }) => [file, (await store.readEntry(file)).raw])));

for (const testCase of cases) {
  test(`mt-moon ${testCase.id}: ${testCase.title}`, async (t) => {
    const env = await setup(t, testCase);
    const run = () => env.runtime.dream({ pctx: env.pctx, agent: env.parent, noSessions: false });
    const reviewed = testCase.sessions.filter((session) => session.reviewed).map(({ id }) => id);

    // Sessions an earlier Dream run already settled: the fix has to come from the lookback.
    if (reviewed.length) {
      env.child(async (invoke) => {
        for (const id of reviewed) await invoke('dream_read_session', { session_id: id });
        await invoke('dream_submit', { changes: [], done: true, skipped_sessions: reviewed });
      });
      assert.notEqual((await run()).ready, true); // settles the reviewed sessions only; unreviewed ones wait
      assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions.map(({ id }) => id), reviewed);
    }

    for (const note of testCase.notes) {
      await env.pctx.store.writeRawEntry(note.file, { name: note.name, type: note.type, description: note.description, body: note.body,
        source: { via: 'test', sessionId: note.sourceSession } });
    }
    if (testCase.suspect?.kind === 'corrected') await env.pctx.state.noteCorrected(testCase.suspect.file);
    if (testCase.suspect?.kind === 'dismissed') await env.pctx.state.dismissRecall('lead-1', `project/${testCase.suspect.file}`);
    const before = await readAll(env.pctx.store);
    assert.deepEqual(Object.keys(before).sort(), testCase.notes.map(({ file }) => file).sort(), 'seeded under the fixture file names');

    const { fix } = testCase;
    const prompts = [];
    const replies = [];
    env.child(async (invoke, spec) => {
      const prompt = spec.prompt[0].text;
      prompts.push(prompt);
      const offered = [...prompt.matchAll(/^- (\S+) \| (?:\d{4}-\d{2}-\d{2}|unknown date) \| ([^\n]*)/gmu)].map((match) => ({ id: match[1], lookback: /already reviewed/u.test(match[2]) }));
      const pages = {};
      for (const { id } of offered) pages[id] = await invoke('dream_read_session', { session_id: id });
      const cited = new Set((fix?.citations ?? []).map(({ session }) => session));
      // What the child reads is what the fixture says happened: the cited quotes are on those pages.
      for (const { session, seq, quote } of fix?.citations ?? []) assert.ok(pages[session]?.includes(quote), `${session} seq ${seq} is readable`);
      const skipped = offered.filter(({ id, lookback }) => !cited.has(id) && !lookback && !fix).map(({ id }) => id);
      const changes = [];
      if (fix) {
        const { version } = JSON.parse((await invoke('dream_read_note', { file: fix.file })).split('\n')[0]);
        changes.push({ file: fix.file, op: 'edit', version, old_text: fix.old_text, body: fix.body,
          citations: fix.citations.map(({ session, seq, quote }) => ({ session_id: session, seq, quote })) });
      }
      // Unrelated offered sessions are named as screened, never left silently open.
      const screened = offered.filter(({ id, lookback }) => !lookback && !cited.has(id) && fix).map(({ id }) => id);
      replies.push(await invoke('dream_submit', { changes, done: true, skipped_sessions: fix ? screened : skipped }));
    });
    const result = await run();
    assert.equal(result.error, undefined);

    // What the child was told.
    const [prompt] = prompts;
    assert.ok(prompt, 'the child ran');
    // A session is offered when it is unreviewed or a suspect note came from it.
    const isOffered = ({ id, reviewed: wasReviewed }) => !wasReviewed || (testCase.suspect && testCase.notes.some((note) => note.file === testCase.suspect.file && note.sourceSession === id));
    const offeredIds = testCase.sessions.filter(isOffered).map(({ id }) => id);
    for (const note of testCase.notes.filter(({ sourceSession }) => offeredIds.includes(sourceSession))) {
      assert.match(prompt, new RegExp(`^- ${note.file} \\(${note.type}\\)[^\\n]*\\(from offered session ${note.sourceSession}\\)`, 'mu'), 'the note list says which offered session a note came from');
    }
    for (const { id, reviewed: wasReviewed } of testCase.sessions.filter(isOffered)) {
      const line = new RegExp(`^- ${id} \\| [^\\n]*${wasReviewed ? 'already reviewed; offered because ' + testCase.suspect.file + ' came from it' : ''}`, 'mu');
      assert.match(prompt, line, `session ${id} is offered`);
    }
    if (testCase.suspect) {
      const reason = testCase.suspect.kind === 'corrected' ? 'the user corrected it since the last Dream' : 'the user dismissed it in recall as not relevant';
      assert.match(prompt, new RegExp(`^- ${testCase.suspect.file}: ${reason}; came from session ${testCase.notes[0].sourceSession}$`, 'mu'));
    }
    const unreviewed = testCase.sessions.filter((session) => !session.reviewed).length;
    assert.equal(result.sessionsOffered, unreviewed, 'a lookback session is not part of the review');

    if (!fix) {
      assert.match(replies[0], /^Reviewed: s1\n/u);
      assert.equal(result.ready, false);
      assert.deepEqual(await readAll(env.pctx.store), before);
      return;
    }
    assert.match(replies[0], new RegExp(`^WROTE ${fix.file}`, 'u'));
    assert.equal(result.ready, true, result.error);
    // Who said what: the fix rests on the roles the fixture names.
    const { evidence } = env.pctx.state.snapshot().shadowPending;
    assert.deepEqual(evidence.map(({ sessionId, seq, role, verified }) => [sessionId, seq, role, verified]).sort(),
      fix.citations.map(({ session, seq, role }) => [session, seq, role, true]).sort());
    assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId })).ok, true);
    const after = await readAll(env.pctx.store);
    const score = scoreCase(testCase, { before, after });
    assert.deepEqual(score.checks.filter(({ ok }) => !ok), [], JSON.stringify(after));
    assert.equal(score.pass, true);
  });
}
