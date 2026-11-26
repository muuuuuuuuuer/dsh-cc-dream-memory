import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { mountDreamFixture, playDreamTasks, toolsEnv } from './v10-helpers.mjs';
import { readRunCheckpoint, readRunManifest, runDirOf } from '../src/dream-run.js';
import { buildFocus } from '../src/dream-focus.js';

const message = (seq, role, text) => ({
  seq, type: role + '/message',
  data: { message: { role, content: [{ type: 'text', text }] } },
});
const QUOTE = '默认用 pnpm release，staging 仍用 npm release';
const NOTE = { file: 'project_release.md', op: 'write', name: 'Release command', type: 'project', body: QUOTE + '。' };
const sessionOf = (spec) => (spec.prompt[0].text.match(/session_id=(\S+?),/u) ?? spec.prompt[0].text.match(/^- (\S+) \| /mu))[1];
const offeredIn = (spec) => [...spec.prompt[0].text.matchAll(/^- (\S+) \| (?:\d{4}-\d{2}-\d{2}|unknown date) \| /gmu)].map((match) => match[1]);

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
        if (name === 'dream_read_session') sourceReads.push(args);
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

test('dreamMaxTasks caps the sessions offered to the one child; the remainder waits for the next run', async (t) => {
  const env = await setup(t, { dreamMaxTasks: 2 }, ['s1', 's2', 's3']);
  const result = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  assert.equal(env.starts.length, 1);
  assert.equal(result.ready, true);
  const records = env.pctx.state.snapshot().shadowPending.reviewRecords;
  assert.deepEqual(records.map(({ id }) => id), ['s1', 's2']);
  assert.deepEqual(offeredIn(env.starts[0]), ['s1', 's2']);
  assert.match(env.starts[0].prompt[0].text, /\bdream_read_session\b/u);
  assert.doesNotMatch(env.starts[0].prompt[0].text, /^- s3 \|/mu);
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

test('Dream note lookup returns bounded candidates and can widen to note bodies or the catalog', async (t) => {
  const env = await setup(t);
  const files = [
    ['project_piano.md', 'Piano lessons', 'Lesson schedule', 'A piano lesson runs on Tuesday.'],
    ['project_hidden.md', 'Workshop checklist', 'Equipment', 'Calibrate the theremin after setup.'],
    ...Array.from({ length: 15 }, (_, i) => ['project_other_' + i + '.md', 'Other ' + i, 'Other note', 'Other detail.']),
  ];
  for (const [file, name, description, body] of files) {
    await env.pctx.store.writeRawEntry(file, { name, description, body, type: 'project' });
  }
  // On-disk notes written outside the plugin still go through output redaction.
  await writeFile(path.join(env.pctx.paths.memoryDir, 'project_private.md'),
    '---\nname: Private\ntype: project\ndescription: AKIAIOSFODNN7EXAMPLE\n---\nOther detail.\n');
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      const list = async (args) => JSON.parse(await invoke('dream_list_notes', args));
      const piano = await list({ query: 'piano lessons' });
      assert.deepEqual(piano.items.map(({ file }) => file), ['project_piano.md']);
      assert.equal(piano.next_offset, null);
      assert.doesNotMatch(JSON.stringify(piano), /runs on Tuesday/u);
      assert.deepEqual(await list({ query: 'theremin' }), { items: [], next_offset: null, empty_catalog: false });
      const widened = await list({ query: 'theremin', include_body: true });
      assert.deepEqual(widened.items.map(({ file }) => file), ['project_hidden.md']);
      assert.doesNotMatch(JSON.stringify(widened), /Calibrate the theremin/u);
      const first = await list({});
      const next = await list({ offset: first.next_offset });
      assert.equal(first.items.length, 12);
      assert.equal(next.next_offset, null);
      assert.equal(new Set([...first.items, ...next.items].map(({ file }) => file)).size, files.length + 1);
      assert.doesNotMatch(JSON.stringify([...first.items, ...next.items]), /AKIA/u);
      assert.match(await invoke('dream_submit', { done: true, changes: [] }), /structured_output/u);
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, noSessions: true });
  assert.equal(run.skipReason, 'nothing-new');
});

test('Dream tells the child an empty catalog needs no lookup and reports it as empty', async (t) => {
  const env = await setup(t);
  env.setChild(async (spec, invoke) => {
    assert.match(spec.prompt[0].text, /The project note catalog is empty\./u);
    const list = async (args) => JSON.parse(await invoke('dream_list_notes', args));
    assert.deepEqual(await list({ query: 'release' }), { items: [], next_offset: null, empty_catalog: true });
    assert.deepEqual(await list({ query: 'release', include_body: true }), { items: [], next_offset: null, empty_catalog: true });
    return { stopReason: 'completed', structured: { done: true, summary: 'Checked.', changes: [] } };
  });
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.sessionsReviewed, 1, run.error);
});

test('a note written by one submission is visible to the next in the same run', async (t) => {
  const env = await setup(t);
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      assert.match(spec.prompt[0].text, /The project note catalog is empty/u);
      await invoke('dream_read_session', { session_id: 's1' });
      const change = { ...NOTE, citations: [{ session_id: 's1', seq: 2, quote: QUOTE }] };
      assert.match(await invoke('dream_submit', { done: false, changes: [change] }), /WROTE project_release\.md/u);
      const listed = JSON.parse(await invoke('dream_list_notes', { query: NOTE.name }));
      assert.equal(listed.empty_catalog, false);
      assert.deepEqual(listed.items.map(({ file }) => file), [NOTE.file]);
      await invoke('dream_submit', { done: true, changes: [] });
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.sessionsReviewed, 1, run.error);
  assert.deepEqual(env.pctx.state.snapshot().shadowPending.files.map(({ file }) => file), [NOTE.file]);
});

for (const [label, name, quote, old, replacement, allowed, cited = quote, timing = ''] of [
  ['Chinese production command', 'Atlas release', '纠正 Atlas 生产发布命令，以后生产环境使用 pnpm run atlas-release，预发环境继续用 npm run atlas-stage。', 'Use npm run atlas-release for production.', 'Use pnpm run atlas-release for production.', true],
  ['English production command', 'Atlas release', 'Correction to the existing Atlas release note: for production, use pnpm run atlas-release. Staging still uses npm run atlas-stage.', 'Use npm run atlas-release for production.', 'Use pnpm run atlas-release for production.', true],
  ['the cited correction preserves its release timing', 'Atlas release', '纠正一下：Atlas 生产环境固定改用 pnpm run atlas-release。预发仍用 npm run atlas-stage。这条规则适用于后续发布。', 'Use npm run atlas-release for production.', 'Use pnpm run atlas-release for production.', true, undefined, 'This applies to subsequent releases.'],
  ['a shorter quote of the same event', 'Atlas release', '纠正一下：Atlas 生产环境固定改用 pnpm run atlas-release。预发仍用 npm run atlas-stage。这条规则适用于后续发布。', 'Use npm run atlas-release for production.', 'Use pnpm run atlas-release for production.', false, 'Atlas 生产环境固定改用 pnpm run atlas-release。', 'This applies to subsequent releases.'],
  ['a named frequency correction', 'Room guide', 'Correction for the existing Workshop Kestrel record: tune the theremin to 443 Hz every rehearsal, replacing the 440 Hz setting.', 'In Workshop Kestrel, tune the theremin to 440 Hz every rehearsal.', 'In Workshop Kestrel, tune the theremin to 443 Hz every rehearsal.', true],
  ['wrong production scope', 'Atlas release', 'Correction to the existing Atlas release note: for staging, use pnpm run atlas-release.', 'Use npm run atlas-release for production.', 'Use pnpm run atlas-release for production.', false],
  ['unrelated project scope', 'Atlas release', '纠正 Orion 生产发布命令，以后生产环境使用 pnpm run atlas-release。', 'Use npm run atlas-release for production.', 'Use pnpm run atlas-release for production.', false],
  ['becomes unconditional', 'Atlas release', 'Correction to the existing Atlas release note: for production, use pnpm run atlas-release only when the canary passes.', 'Use npm run atlas-release for production.', 'Use pnpm run atlas-release for production.', false],
  ['drops a following condition', 'Atlas release', 'Correction to the existing Atlas release note: for production, use pnpm run atlas-release. Exception: only after sign-off.', 'Use npm run atlas-release for production.', 'Use pnpm run atlas-release for production.', false, 'Correction to the existing Atlas release note: for production, use pnpm run atlas-release.'],
  ['the cited old frequency was different', 'Room guide', 'Correction for the existing Workshop Kestrel record: tune the theremin to 443 Hz every rehearsal, replacing the 442 Hz setting.', 'In Workshop Kestrel, tune the theremin to 440 Hz every rehearsal.', 'In Workshop Kestrel, tune the theremin to 443 Hz every rehearsal.', false],
]) {
  test('a targeted edit with an existing quote applies: ' + label, async (t) => {
    const env = await setup(t);
    const { file } = NOTE;
    const other = 'Keep the staging command npm run atlas-stage.';
    const before = old + ' ' + other;
    const after = replacement + ' ' + other + (timing ? ' ' + timing : '');
    await env.pctx.store.writeRawEntry(file, { name, type: 'project', body: before });
    env.events.splice(0, env.events.length, message(2, 'user', quote));
    env.setChild(async (_spec, invoke) => {
      const header = JSON.parse((await invoke('dream_read_note', { file })).split('\n')[0]);
      return { stopReason: 'completed', structured: { done: true, summary: 'Checked the correction.', changes: [{
        file, op: 'edit', old_text: timing ? before : old, body: timing ? after : replacement, version: header.version,
        citations: [{ session_id: 's1', seq: 2, quote: cited }],
      }] } };
    });
    const result = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
    assert.equal(result.ready, true, result.error);
    const switched = await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId });
    assert.equal(switched.ok, true, switched.error);
    assert.equal((await env.pctx.store.readEntry(file)).body, after + '\n\n- Superseded: ' + (timing ? before : old));
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
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      const submit = async (session_id, change, done) => {
        await invoke('dream_read_session', { session_id });
        const { version } = JSON.parse((await invoke('dream_read_note', { file })).split('\n')[0]);
        return invoke('dream_submit', { done, changes: [{ file, version, ...change }] });
      };
      await submit('s1', { op: 'add', body: 'User prefers tagged releases.', citations: [{ session_id: 's1', seq: 3, quote: rule }] }, false);
      await submit('s2', { op: 'edit', old_text: old, body: 'Use pnpm release.', citations: [{ session_id: 's2', seq: 4, quote: correction }] }, true);
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.ready, true);
  const pending = env.pctx.state.snapshot().shadowPending;
  assert.deepEqual(pending.proofs.map(({ kind }) => kind), ['citation']);
  assert.deepEqual(new Set(pending.evidence.filter((e) => e.verified).map((e) => e.sessionId)), new Set(['s1', 's2']));
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
        old_text: invalid === 'ambiguous' ? 'build' : body, body: 'Use pnpm.', citations: [{ session_id: 's1', seq: 2, quote: QUOTE }],
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
    assert.equal(offeredIn(env.starts.at(-1))[0], expected);
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

test('a change without a valid citation comes back as an error and nothing is applied', async (t) => {
  const env = await setup(t);
  const replies = [];
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      await invoke('dream_read_session', { session_id: 's1' });
      replies.push(await invoke('dream_submit', { done: false, changes: [{ ...NOTE, citations: [] }] }));
      replies.push(await invoke('dream_submit', { done: true, changes: [], skipped_sessions: [] }));
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.match(replies[0], /^ERROR: no change in this call was applied\.\n- project_release\.md: no valid citation/u);
  assert.equal(run.skipReason, 'nothing-new');
  assert.equal(run.sessionsReviewed, 1);
  assert.equal(env.pctx.state.snapshot().shadowPending, null);
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

test('switch settles only the correction versions the original Dream observed', async (t) => {
  const env = await setup(t);
  const corrected = 'project_other.md';
  const observed = 'project_done.md';
  for (const file of [corrected, observed]) {
    await env.pctx.store.writeRawEntry(file, { type: 'project', body: 'An existing fact.' });
    await env.pctx.state.noteCorrected(file);
  }
  const result = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(result.ready, true, result.error);
  await env.pctx.store.writeRawEntry(corrected, { type: 'project', body: 'A newer fact corrected after Dream.' });
  await env.pctx.state.noteCorrected(corrected);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: 'stale-run' })).ok, false);
  assert.deepEqual(env.pctx.state.snapshot().correctedFiles, [observed, corrected]);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId })).ok, true);
  assert.deepEqual(env.pctx.state.snapshot().correctedFiles, [corrected]);
});

test('automatic note focus names the note as a suspect', async (t) => {
  const env = await setup(t, { autoDreamEnabled: true });
  await env.pctx.store.writeRawEntry('project_probe.md', { type: 'project', body: 'Use pnpm.' });
  await env.pctx.state.noteCorrected('project_probe.md');
  const focus = await buildFocus(env.pctx, env.runtime.config);
  env.setChild(async () => ({ stopReason: 'completed', structured: { done: true, summary: 'Checked.', changes: [] } }));
  const result = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, trigger: 'auto', focus: focus.text });
  assert.equal(result.sessionsReviewed, 1);
  assert.match(env.starts[0].prompt[0].text, /Suspect notes[\s\S]*- project_probe\.md: the user corrected it since the last Dream/u);
});

test('automatic focus does not spend a session slot on an already reviewed conversation', async (t) => {
  const env = await setup(t, { dreamMaxTasks: 2 }, ['s1']);
  env.setChild(async () => ({ stopReason: 'completed', structured: { done: true, summary: 'Checked.', changes: [] } }));
  assert.equal((await env.runtime.dream({ pctx: env.pctx, agent: env.parent })).sessionsReviewed, 1);
  const query = env.host.services.sessionQuery;
  const old = (await query.filterSessions())[0];
  query.filterSessions = async () => [old, { header: { id: 's2', cwd: env.workspaceDir, createdAt: 2 } }];
  const lookedUp = [];
  const readSession = query.readSession;
  query.readSession = (id) => {
    if (id === 's1' || id === 's2') lookedUp.push(id);
    return readSession(id);
  };
  await env.pctx.store.writeRawEntry('project_port.md', { type: 'project', body: 'Port 4000.' });
  await env.pctx.state.noteCorrected('project_port.md');
  const focus = await buildFocus(env.pctx, env.runtime.config);
  const result = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, trigger: 'auto', focus: focus.text });
  assert.equal(result.sessionsReviewed, 1);
  assert.match(env.prompts.at(-1), /session_id=s2,/u);
  assert.deepEqual(lookedUp, ['s2']);
});

test('completed automatic no-op remembers only fully read notes and reopens changed inputs', async (t) => {
  const env = await setup(t);
  const checked = 'project_checked.md';
  const unread = 'project_unread.md';
  const source = path.join(env.workspaceDir, 'release.js');
  await writeFile(source, 'export const replaced = true;');
  await env.pctx.store.saveEntry({ name: 'checked', type: 'project', content: 'Old release convention.',
    sources: ['release.js#oldName'] });
  await env.pctx.store.writeRawEntry(unread, { type: 'project', body: 'An edited convention.\n'.repeat(450) });
  await env.pctx.state.noteCorrected(unread);
  const focus = await buildFocus(env.pctx, env.runtime.config);
  env.setChild(async (_task, invoke) => {
    const read = await invoke('dream_read_note', { file: checked });
    assert.match(read, /Old release convention/u);
    const partial = await invoke('dream_read_note', { file: unread });
    assert.ok(partial.length <= 8_000, 'the response budget includes its header');
    assert.ok(JSON.parse(partial.split('\n', 1)[0]).next > 0, 'the second note was only partly read');
    return { stopReason: 'completed', structured: { done: true, summary: 'Checked.', changes: [] } };
  });
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, trigger: 'auto', noSessions: true,
    focus: focus.text, maintenance: focus.maintenance });
  assert.equal(run.skipReason, 'nothing-new');

  const state = new env.pctx.state.constructor(env.pctx.paths);
  await state.load();
  const refreshed = { ...env.pctx, state };
  const targets = async () => (await buildFocus(refreshed, env.runtime.config)).files.map(({ file }) => file);
  assert.deepEqual(await targets(), [unread]);
  await state.noteCorrected(checked);
  assert.ok((await targets()).includes(checked), 'a new explicit correction makes it eligible again');
  await state.clearCorrected([checked]);
  assert.deepEqual(await targets(), [unread]);
  await writeFile(source, 'export const changedAgain = true;');
  assert.deepEqual(await targets(), [unread, checked], 'a cited source changing makes it eligible again');
});

test('a clipped note tool result does not settle an unchanged maintenance target', async (t) => {
  const env = await setup(t);
  const file = 'project_port.md';
  await env.pctx.store.writeRawEntry(file, { type: 'project', body: 'Use port 4000 for development.' });
  await env.pctx.state.noteCorrected(file);
  const { text: focus, maintenance } = await buildFocus(env.pctx);
  env.setChild(async (_task, invoke) => {
    await invoke('dream_read_note', { file }, (content) => [{ ...content[0], text: content[0].text.slice(0, -10) }]);
    return { stopReason: 'completed', structured: { done: true, summary: 'Checked.', changes: [] } };
  });
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, trigger: 'auto', noSessions: true, focus, maintenance });
  assert.equal(run.skipReason, 'nothing-new');
  assert.deepEqual((await buildFocus(env.pctx)).files.map((item) => item.file), [file]);
});

test('adopting an automatic dialogue proposal does not drop corrections the child never reviewed', async (t) => {
  const env = await setup(t);
  const file = 'project_port.md';
  await env.pctx.store.writeRawEntry(file, { type: 'project', body: 'Use port 4000 for development.' });
  await env.pctx.state.noteCorrected(file);
  const { text: focus, maintenance } = await buildFocus(env.pctx);
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, trigger: 'auto', focus, maintenance });
  assert.equal(run.ready, true, run.error);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: run.runId })).ok, true);
  assert.deepEqual((await buildFocus(env.pctx)).files.map((item) => item.file), [file]);
});

test('a completed review remembers an unchanged target even when it also proposes a dialogue edit', async (t) => {
  const env = await setup(t);
  const file = 'project_port.md';
  await env.pctx.store.writeRawEntry(file, { type: 'project', body: 'Use port 4000 for development.' });
  await env.pctx.state.noteCorrected(file);
  const { text: focus, maintenance } = await buildFocus(env.pctx);
  env.setChild(async (spec, invoke) => {
    await invoke('dream_read_note', { file });
    return { stopReason: 'completed', structured: { done: true, summary: 'Reviewed port and release facts.',
      changes: [{ ...NOTE, citations: [{ session_id: sessionOf(spec), seq: 2, quote: QUOTE }] }] } };
  });
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent, trigger: 'auto', focus, maintenance });
  assert.equal(run.ready, true, run.error);
  assert.deepEqual((await buildFocus(env.pctx)).files, []);
  assert.deepEqual(env.pctx.state.snapshot().correctedFiles, [file]);
});

test('a citation to a session that was not offered or a quote that is not there rejects the whole call', async (t) => {
  const env = await setup(t, { dreamMaxTasks: 1 }, ['s1', 's2']);
  env.host.services.subagents.startActivation = async (spec) => {
    const invoke = mountDreamFixture(env.host, spec);
    const result = (async () => {
      await invoke('dream_read_session', { session_id: 's1' });
      const change = { ...NOTE, citations: [{ session_id: 's1', seq: 2, quote: QUOTE }] };
      const foreign = { ...NOTE, file: 'project_foreign.md', citations: [{ session_id: 's2', seq: 2, quote: QUOTE }] };
      const missing = { ...NOTE, file: 'project_missing.md', citations: [{ session_id: 's1', seq: 2, quote: 'Never said in this session.' }] };
      const refused = await invoke('dream_submit', { done: false, changes: [change, foreign, missing] });
      assert.match(refused, /session s2 was not offered/u);
      assert.match(refused, /the quote is not in event 2 of s1/u);
      assert.deepEqual(JSON.parse(await invoke('dream_list_notes', {})).items, []);
      assert.match(await invoke('dream_submit', { done: true, changes: [change] }), /WROTE project_release\.md/u);
      return { stopReason: 'completed', structured: { finished: true } };
    })();
    return { result, dispose: async () => {} };
  };
  const run = await env.runtime.dream({ pctx: env.pctx, agent: env.parent });
  assert.equal(run.ready, true, run.error);
  assert.deepEqual(env.pctx.state.snapshot().shadowPending.origins, { 'project_release.md': ['s1'] });
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

test('session pages carry seq numbers and labels, omit credentials and leave no source file', async (t) => {
  const env = await setup(t);
  const secret = 'sk-proj-' + 'SyntheticFixture1234567890'.repeat(3);
  env.events.push(message(3, 'user', 'Synthetic credential ' + secret));
  await env.runtime.dream({ pctx: env.pctx, agent: env.parent, force: true });
  const text = env.host.dreamSourcePages.join('\n');
  assert.match(text, /\[seq 2\] \[user\] 纠正一下/u);
  assert.match(text, /\[seq 3\] \[sensitive passage omitted\]/u);
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
  const reviewed = offeredIn(env.starts[0])[0];
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
    const session = sessionOf(spec);
    if (session === 's1') {
      return { stopReason: 'completed', output: [], structured: { done: true, summary: 'release', changes: [
        { ...NOTE, citations: [{ session_id: 's1', seq: 2, quote: QUOTE }] },
      ] } };
    }
    const style = { op: 'write', file: 'feedback_style.md', name: 'Style', type: 'feedback', body: 'Answer directly.',
      citations: [{ session_id: 's2', seq: 2, quote: QUOTE }] };
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
