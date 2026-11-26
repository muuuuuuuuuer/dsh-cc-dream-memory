/**
 * Wiki pages: the layer only Dream writes. Flat `wiki_<slug>.md` files with
 * `type: wiki`; the host guards links, sizes and the page status, and the
 * main session may read them but never write them.
 * os.tmpdir(); no LLM.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachRecall, buildRecallText, recallManifest } from '../src/recall.js';
import { statusHidingPage } from '../src/memory-body.js';
import { resolveConfig } from '../src/config.js';
import { wikiLinks, resolveWikiLink } from '../src/wiki.js';
import { mountDreamFixture, runtimeEnv, streamOf, toolsEnv } from './v10-helpers.mjs';

const event = (seq, type, text) => ({
  seq, type, time: Date.UTC(2026, 10, 20, 9, seq),
  data: { message: { role: type.split('/')[0], content: [{ type: 'text', text }] } },
});
const USER = 'The release command is pnpm release for production.';
const TESTING = 'Integration tests always hit the real database.';
const cite = (seq, quote, session_id = 's1') => ({ session_id, seq, quote });
const noteCite = (memory_file, quote) => ({ memory_file, quote });
const page = (over = {}) => ({
  file: 'wiki_release.md', op: 'write', name: 'Release workflow', description: 'How releases are cut and verified',
  body: 'Run pnpm release on the ops box; verify with the smoke suite. See [[project_release]] and [[feedback_testing]].',
  citations: [cite(0, USER)], ...over,
});

async function setup(t, config = {}) {
  const env = await toolsEnv(t, { autoDreamEnabled: false, ...config });
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir, createdAt: Date.UTC(2026, 10, 1) } }],
    readSession: async () => ({ events: [event(0, 'user/message', USER)] }),
  };
  const parent = { id: 'lead-1', session: { header: { id: 'lead-1', cwd: env.workspaceDir } } };
  env.host.services.agents = { get: (id) => (id === parent.id ? parent : undefined), list: () => [parent] };
  let play = async () => {};
  const prompts = [];
  env.host.services.subagents = {
    async startActivation(spec) {
      prompts.push(spec.prompt[0].text);
      const invoke = mountDreamFixture(env.host, spec);
      const result = (async () => {
        await play(invoke, spec);
        return { stopReason: 'completed', output: [], structured: { finished: true } };
      })();
      return { childId: spec.childId, name: spec.name, result, dispose: async () => {} };
    },
  };
  await env.pctx.store.writeRawEntry('project_release.md', { type: 'project', description: 'Release command', body: USER });
  await env.pctx.store.writeRawEntry('feedback_testing.md', { type: 'feedback', description: 'Test policy', body: TESTING });
  return {
    ...env, parent, prompts,
    child: (fn) => { play = fn; },
    run: (options = {}) => env.runtime.dream({ pctx: env.pctx, agent: parent, ...options }),
    pending: () => env.pctx.state.snapshot().shadowPending,
    live: (file) => env.pctx.store.readEntry(file),
  };
}

const submit = (invoke, changes, extra = {}) => invoke('dream_submit', { changes, done: true, ...extra });

test('Dream writes a cited wiki page; the index leads with it; switch and undo carry it', async (t) => {
  const env = await setup(t);
  const replies = [];
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    replies.push(await submit(invoke, [page()]));
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  assert.match(replies[0], /^WROTE wiki_release\.md\n.*Wiki: 1 page\(s\), \d+ of 40000 chars used; one page holds at most 8000 chars\./su);
  assert.match(env.prompts[0], /^Wiki: 0 page\(s\), 0 of 40000 chars used/mu);
  const pending = env.pending();
  assert.deepEqual(pending.files, [{ file: 'wiki_release.md', action: 'added' }]);
  assert.deepEqual(pending.wiki.pages, [0, 1]);
  assert.equal(pending.wiki.chars[0], 0);
  assert.ok(pending.wiki.chars[1] > 50);
  assert.ok(pending.evidence.some((item) => item.file === 'wiki_release.md' && item.verified), 'the page carries its citation');

  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId })).ok, true);
  const written = await env.live('wiki_release.md');
  assert.equal(written.frontmatter.type, 'wiki');
  assert.equal(written.frontmatter.description, 'How releases are cut and verified');
  const lines = (await env.pctx.store.indexText()).trim().split('\n');
  assert.match(lines[0], /^- \[Release workflow\]\(wiki_release\.md\) — How releases/u, 'the wiki section comes first');
  assert.equal(lines.length, 3);
  assert.equal((await env.pctx.store.listEntries('project', { currentOnly: true })).some((entry) => entry.file === 'wiki_release.md'), true);

  assert.equal((await env.runtime.undoLastDream(env.pctx)).ok, true);
  await assert.rejects(env.live('wiki_release.md'), { code: 'NOT_FOUND' });
  assert.doesNotMatch(await env.pctx.store.indexText(), /wiki_release/u);
});

test('a broken [[link]] rejects the whole call with the list; links to files written in the same call hold', async (t) => {
  const env = await setup(t);
  const replies = [];
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    replies.push(await submit(invoke, [page({ body: 'See [[project_nope]], [[feedback_testing.md]] and [[nowhere]].' })], { done: false }));
    replies.push(await submit(invoke, [
      page({ body: 'Next: [[wiki_deploy]]; also [[release]] and [[project_release]].' }),
      page({ file: 'wiki_deploy.md', name: 'Deploy', description: 'Deploys', body: 'Back to [[wiki_release]].' }),
    ]));
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  assert.match(replies[0], /^ERROR: no change in this call was applied\./u);
  assert.match(replies[0], /wiki_release\.md: broken link\(s\) \[\[project_nope\]\], \[\[nowhere\]\]/u);
  assert.doesNotMatch(replies[0], /\[\[feedback_testing\.md/u, 'a link with .md resolves');
  assert.match(replies[0], /Wiki: 0 page\(s\)/u);
  assert.match(replies[1], /^WROTE wiki_release\.md\nWROTE wiki_deploy\.md/u);
});

test('the file a call deletes may not leave a page with a dead link; a page rewritten in the call is checked on its new text', async (t) => {
  const env = await setup(t);
  await env.pctx.store.writeRawEntry('wiki_ops.md', { description: 'Ops', body: 'Release facts live in [[project_release]].' });
  const replies = [];
  const del = { file: 'project_release.md', op: 'delete', moved_to: 'wiki_release.md', citations: [noteCite('project_release.md', 'pnpm release for production')] };
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    replies.push(await submit(invoke, [del], { done: false }));
    replies.push(await submit(invoke, [page({ body: 'Rule: [[project_release]] says it all.' }), del], { done: false }));
    const { version } = JSON.parse((await invoke('dream_read_note', { file: 'wiki_ops.md' })).split('\n')[0]);
    replies.push(await submit(invoke, [
      { file: 'wiki_ops.md', op: 'write', version, body: 'Release facts live in [[wiki_release]].', citations: [cite(0, USER)] },
      page({ body: 'Run pnpm release; verify on the ops box.' }),
      del,
    ]));
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  assert.match(replies[0], /project_release\.md: cannot be deleted while wiki_ops\.md link\(s\) to it/u);
  assert.match(replies[1], /wiki_release\.md: broken link\(s\) \[\[project_release\]\]/u);
  assert.match(replies[2], /^WROTE wiki_ops\.md\nWROTE wiki_release\.md\nDELETED project_release\.md/u);
  assert.deepEqual(env.pending().links, { 'project_release.md': 'wiki_release.md' });
});

test('an edit that drops a link unblocks deleting the note in a later call', async (t) => {
  const env = await setup(t);
  await env.pctx.store.writeRawEntry('wiki_ops.md', { description: 'Ops', body: 'Release facts live in [[project_release]].' });
  const replies = [];
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    const { version } = JSON.parse((await invoke('dream_read_note', { file: 'wiki_ops.md' })).split('\n')[0]);
    replies.push(await submit(invoke, [{
      file: 'wiki_ops.md', op: 'edit', version,
      old_text: 'Release facts live in [[project_release]].',
      body: 'Release facts live in the ops runbook.',
      citations: [noteCite('wiki_ops.md', 'Release facts live in [[project_release]].')],
    }], { done: false }));
    replies.push(await submit(invoke, [
      { file: 'project_release.md', op: 'delete', citations: [noteCite('project_release.md', 'pnpm release for production')] },
    ]));
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  assert.match(replies[0], /^WROTE wiki_ops\.md/u);
  assert.match(replies[1], /^DELETED project_release\.md/u);
  assert.ok(env.pending().files.some(({ file, action }) => file === 'project_release.md' && action === 'removed'));
});

test('an edit that drops a link and the delete it unblocks apply in one call', async (t) => {
  const env = await setup(t);
  await env.pctx.store.writeRawEntry('wiki_ops.md', { description: 'Ops', body: 'Release facts live in [[project_release]].' });
  const replies = [];
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    const { version } = JSON.parse((await invoke('dream_read_note', { file: 'wiki_ops.md' })).split('\n')[0]);
    replies.push(await submit(invoke, [
      {
        file: 'wiki_ops.md', op: 'edit', version,
        old_text: 'Release facts live in [[project_release]].',
        body: 'Release facts live in the ops runbook.',
        citations: [noteCite('wiki_ops.md', 'Release facts live in [[project_release]].')],
      },
      { file: 'project_release.md', op: 'delete', citations: [noteCite('project_release.md', 'pnpm release for production')] },
    ]));
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  assert.match(replies[0], /^WROTE wiki_ops\.md\nDELETED project_release\.md/u);
  assert.ok(env.pending().files.some(({ file, action }) => file === 'project_release.md' && action === 'removed'));
});

test('a failed wiki edit cannot unblock deleting the note it still links', async (t) => {
  const env = await setup(t);
  await env.pctx.store.writeRawEntry('wiki_ops.md', { description: 'Ops', body: 'See [[project_release]].' });
  let reply;
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    reply = await submit(invoke, [
      { file: 'project_release.md', op: 'delete', citations: [cite(0, USER)] },
      { file: 'wiki_ops.md', op: 'edit', old_text: 'See [[project_release]].', body: 'See the runbook.', citations: [cite(0, USER)] },
    ]);
  });
  const result = await env.run();
  assert.match(reply, /no change in this call was applied/iu);
  assert.equal(result.error, 'unfinished-writes');
  assert.equal(env.pending(), null);
});

test('a partial switch cannot keep a wiki link while deferring the page it needs', async (t) => {
  const env = await setup(t);
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    await submit(invoke, [page({ body: 'See [[wiki_deploy]].' }), page({ file: 'wiki_deploy.md', body: 'Use pnpm release.' })]);
  });
  const result = await env.run();
  assert.equal(result.ready, true);
  const rejected = await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId, defer: ['wiki_deploy.md'] });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /wiki_release\.md.*\[\[wiki_deploy\]\]/u);
  await assert.rejects(env.live('wiki_release.md'), { code: 'NOT_FOUND' });
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId })).ok, true);
});

test('selecting suspect lookups reads just the final batch, without reading a session twice', async (t) => {
  const env = await setup(t, { dreamMaxTasks: 2 });
  const query = env.host.services.sessionQuery;
  const ids = ['s1', 's2', 's3'];
  query.filterSessions = async (filters) => ids.filter((id) => !filters.length || filters[0].values.includes(id))
    .map((id, i) => ({ header: { id, cwd: env.workspaceDir, createdAt: i + 1 } }));
  const reads = [];
  const readSession = query.readSession;
  query.readSession = async (id) => {
    if (ids.includes(id)) reads.push(id);
    return readSession(id);
  };
  await env.pctx.store.writeRawEntry('project_release.md', { body: USER, source: { sessionId: 's1' } });
  await env.pctx.state.noteCorrected('project_release.md');
  env.child(async (invoke) => {
    await submit(invoke, [], { skipped_sessions: ['s1', 's2'] });
  });
  await env.run();
  assert.deepEqual(reads.sort(), ['s1', 's2']);
});

async function movedNote(t) {
  const env = await setup(t);
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    await submit(invoke, [
      page({ body: 'Run pnpm release; verify on the ops box.' }),
      { file: 'project_release.md', op: 'delete', moved_to: 'wiki_release.md', citations: [noteCite('project_release.md', 'pnpm release for production')] },
    ]);
  });
  const result = await env.run();
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.deepEqual(env.pending().files.map(({ file, action }) => `${action} ${file}`).sort(), ['added wiki_release.md', 'removed project_release.md']);
  return { env, result };
}

test('rejecting the page keeps the note it absorbed: they are one decision', async (t) => {
  const { env, result } = await movedNote(t);
  await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId, reject: ['wiki_release.md'] });
  assert.equal((await env.live('project_release.md')).body, USER);
  await assert.rejects(env.live('wiki_release.md'), { code: 'NOT_FOUND' });
});

test('a note moved into a page leaves the index on switch and comes back on undo', async (t) => {
  const { env, result } = await movedNote(t);
  assert.equal((await env.runtime.switchDream({ pctx: env.pctx, runId: result.runId })).ok, true);
  await assert.rejects(env.live('project_release.md'), { code: 'NOT_FOUND' });
  assert.equal((await env.live('wiki_release.md')).frontmatter.type, 'wiki');
  const index = await env.pctx.store.indexText();
  assert.match(index, /wiki_release\.md/u);
  assert.doesNotMatch(index, /\(project_release\.md\)/u, 'the moved note leaves the index');
  assert.equal((await env.runtime.undoLastDream(env.pctx)).ok, true);
  assert.equal((await env.live('project_release.md')).body, USER);
  await assert.rejects(env.live('wiki_release.md'), { code: 'NOT_FOUND' });
});

test('wiki page and total sizes are capped and the usage comes back with every submit', async (t) => {
  const env = await setup(t, { wikiPageMaxChars: 500, wikiTotalMaxChars: 700 });
  const replies = [];
  const body = (n) => `Release rule. ${'x'.repeat(n)}`;
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    replies.push(await submit(invoke, [page({ body: body(600) })], { done: false }));
    replies.push(await submit(invoke, [page({ body: body(400) })], { done: false }));
    replies.push(await submit(invoke, [page({ file: 'wiki_deploy.md', name: 'Deploy', description: 'Deploys', body: body(400) })], { done: false }));
    // A page may shrink, and a smaller page fits the budget.
    replies.push(await submit(invoke, [page({ file: 'wiki_deploy.md', name: 'Deploy', description: 'Deploys', body: body(200) })]));
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  assert.match(replies[0], /ERROR: wiki_release\.md: this page is 6\d\d chars; a page holds at most 500\./u);
  assert.match(replies[0], /Wiki: 0 page\(s\), 0 of 700 chars used; one page holds at most 500 chars\./u);
  assert.match(replies[1], /^WROTE wiki_release\.md\nWiki: 1 page\(s\), 414 of 700 chars used/u);
  assert.match(replies[2], /ERROR: wiki_deploy\.md: the wiki would hold 828 chars; the budget is 700 \(now 414\)/u);
  assert.match(replies[3], /^WROTE wiki_deploy\.md\nWiki: 2 page\(s\), 628 of 700 chars used/u);
  assert.deepEqual(env.pending().wiki.pages, [0, 2]);
});

test('a wiki page needs a description, a wiki name and a wiki type', async (t) => {
  const env = await setup(t);
  const replies = [];
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    replies.push(await submit(invoke, [page({ description: '' })], { done: false }));
    replies.push(await submit(invoke, [page({ file: 'project_page.md', type: 'wiki', body: 'A page by another name.' })], { done: false }));
    replies.push(await submit(invoke, [page({ type: 'project', body: 'Typed project, named wiki.' })]));
  });
  await env.run();
  assert.match(replies[0], /a wiki page needs a description/u);
  assert.match(replies[1], /a wiki page must be named wiki_<slug>\.md/u);
  assert.match(replies[2], /^WROTE wiki_release\.md/u, 'the file name decides the type');
  assert.equal(env.pending().files[0].file, 'wiki_release.md');
});

test('a change that would hide the whole page needs retire: true, for notes and pages', async (t) => {
  const env = await setup(t);
  const replies = [];
  const plan = 'STATUS: superseded\nThe batched rollout plan was cancelled; push all at once.';
  env.child(async (invoke) => {
    await invoke('dream_read_session', { session_id: 's1' });
    replies.push(await submit(invoke, [{ file: 'project_rollout.md', op: 'write', name: 'Rollout', type: 'project', body: plan, citations: [cite(0, USER)] }], { done: false }));
    replies.push(await submit(invoke, [page({ body: 'STATUS: stale\nSome page text.' })], { done: false }));
    replies.push(await submit(invoke, [{ file: 'project_rollout.md', op: 'write', name: 'Rollout', type: 'project', body: plan, citations: [cite(0, USER)], retire: true }]));
  });
  const result = await env.run();
  assert.equal(result.ready, true, result.error);
  assert.match(replies[0], /ERROR: project_rollout\.md: STATUS: superseded would hide this whole page from the index and recall/u);
  assert.match(replies[0], /delete it with moved_to or merges; to record an old value, put it under ## History\. Set retire: true/u);
  assert.match(replies[1], /ERROR: wiki_release\.md: STATUS: stale would hide/u);
  assert.match(replies[2], /^WROTE project_rollout\.md/u);
});

test('statusHidingPage flags only a page that becomes hidden', () => {
  assert.equal(statusHidingPage(undefined, 'STATUS: superseded\nx'), 'superseded');
  assert.equal(statusHidingPage('x', 'STATUS: retired\nx'), 'retired');
  assert.equal(statusHidingPage('STATUS: stale\nx', 'STATUS: stale\ny'), '', 'a page that was already hidden stays as it is');
  assert.equal(statusHidingPage('STATUS: stale\nx', 'STATUS: current\nx'), '');
  assert.equal(statusHidingPage('x', 'x\n\n```\nSTATUS: stale\n```'), '', 'a fenced line is an example');
  assert.equal(statusHidingPage('x', '## History\n- STATUS before: superseded'), '');
});

test('the main session cannot write a wiki page, hide a page, or rename one; it can read pages', async (t) => {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const tool = (name, args) => env.definitions.get(name).execute(args, exec);
  await env.pctx.store.writeRawEntry('wiki_release.md', { description: 'How releases go', body: 'Run pnpm release. See [[project_release]].' });
  await env.pctx.store.writeRawEntry('project_plan.md', { type: 'project', description: 'Plan', body: 'Push all at once.' });

  const saved = await tool('memory_save', { name: 'release', type: 'wiki', content: 'x' });
  assert.equal(saved.ok, false);
  assert.equal(saved.error, 'WIKI_READONLY');
  assert.match(saved.message, /written by Dream only/u);

  const read = await tool('memory_read', { file: 'wiki_release.md' });
  assert.match(JSON.stringify(read), /Run pnpm release/u);
  const hash = (await env.pctx.store.readEntry('wiki_release.md')).raw;
  const edited = await tool('memory_update', { file: 'wiki_release.md', content: 'changed', expectedHash: 'x' });
  assert.equal(edited.error, 'WIKI_READONLY');
  const deleted = await tool('memory_update', { file: 'wiki_release.md', delete: true });
  assert.equal(deleted.error, 'WIKI_READONLY');
  assert.equal((await env.pctx.store.readEntry('wiki_release.md')).raw, hash);

  const hidden = await tool('memory_save', { name: 'old rollout', type: 'project', content: 'STATUS: superseded\nThe rollout was batched.' });
  assert.equal(hidden.error, 'STATUS_HIDES_PAGE');
  assert.doesNotMatch(hidden.message, /retire: true/u);
  await tool('memory_read', { file: 'project_plan.md' });
  const hiding = await tool('memory_update', { file: 'project_plan.md', content: 'STATUS: stale\nPush all at once.' });
  assert.equal(hiding.error, 'STATUS_HIDES_PAGE', JSON.stringify(hiding));
  assert.match(hiding.message, /delete it with moved_to or merges/u);
  assert.equal((await env.pctx.store.readEntry('project_plan.md')).body, 'Push all at once.');
  const fine = await tool('memory_update', { file: 'project_plan.md', content: 'Push all at once, after the freeze.' });
  assert.equal(fine.written, true, JSON.stringify(fine));

  // Every other write path refuses too.
  await assert.rejects(env.pctx.store.saveEntry({ name: 'x', type: 'wiki', content: 'x' }), { code: 'WIKI_READONLY' });
  await assert.rejects(env.pctx.store.updateEntry('wiki_release.md', { content: 'x' }), { code: 'WIKI_READONLY' });
  await assert.rejects(env.pctx.store.renameEntry('wiki_release.md', 'Other'), { code: 'WIKI_READONLY' });
  const service = env.mods.status.createStatusService(env.runtime);
  const entry = await env.pctx.store.readEntry('wiki_release.md');
  await assert.rejects(
    service.writeFile(env.pctx, { file: 'wiki_release.md', content: 'by hand', expectedHash: (await import('../src/write-review.js')).memoryHash(entry.raw) }),
    { code: 'wiki-readonly' },
  );
  await assert.rejects(service.mergeFiles(env.pctx, { files: ['wiki_release.md', 'project_plan.md'] }), { code: 'wiki-readonly' });
});

test('the index lists wiki lines first and keeps them first on reconcile and when over budget', async (t) => {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  const { store } = env.pctx;
  await store.saveEntry({ name: 'alpha', type: 'project', description: 'Alpha note', content: 'alpha' });
  await store.writeRawEntry('wiki_one.md', { description: 'Page one', body: 'one' });
  await store.saveEntry({ name: 'beta', type: 'project', description: 'Beta note', content: 'beta' });
  await store.writeRawEntry('wiki_two.md', { description: 'Page two', body: 'two' });
  const files = async () => (await store.indexText()).trim().split('\n').map((line) => /\(([^)]+)\)/u.exec(line)[1]);
  assert.deepEqual(await files(), ['wiki_one.md', 'wiki_two.md', 'project_alpha.md', 'project_beta.md']);
  // A hand-written index with the pages last is put right by a refresh.
  await store.writeIndex('- [Alpha](project_alpha.md) — a\n- [Page two](wiki_two.md) — b\n- [Beta](project_beta.md) — c\n- [Page one](wiki_one.md) — d\n');
  await store.refreshIndex();
  assert.deepEqual(await files(), ['wiki_two.md', 'wiki_one.md', 'project_alpha.md', 'project_beta.md']);
  // Over budget, the most used note cannot push a page out of the head.
  const head = await store.injectedIndex('project', { maxLines: 3, usage: { 'project_beta.md': 9, 'wiki_one.md': 0 } });
  assert.equal(head.overflow, true);
  assert.deepEqual(head.text.trim().split('\n').slice(0, 2).map((line) => /\(([^)]+)\)/u.exec(line)[1]), ['wiki_two.md', 'wiki_one.md']);
  // A byte cap drops notes before pages.
  const small = await store.injectedIndex('project', { maxLines: 200, maxBytes: Buffer.byteLength(await store.indexText()) - 1 });
  assert.match(small.text, /wiki_two\.md/u);
  assert.doesNotMatch(small.text, /project_beta/u);
});

test('the injected text tells the model about wiki pages only when the index has them', async (t) => {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  const { buildInjectionText } = await import('../src/inject.js');
  const plain = buildInjectionText({ index: { text: '- [A](project_a.md) — a\n' } });
  assert.doesNotMatch(plain, /wiki/iu);
  const withWiki = buildInjectionText({ index: { text: '- [W](wiki_w.md) — w\n- [A](project_a.md) — a\n' } });
  assert.match(withWiki, /Entries named wiki_\* lead the index/u);
  assert.ok(env);
});

test('recall can select a wiki page and attaches its body within autoRecallMaxChars', async (t) => {
  const env = await runtimeEnv(t, { recallMode: 'model', autoRecallMaxChars: 1500 });
  const body = `Release rule: run pnpm release. ${'Trap: check the ops box first.\n\n'.repeat(120)}`;
  await env.pctx.store.writeRawEntry('wiki_release.md', { description: 'How releases are cut', body });
  await env.pctx.store.writeRawEntry('project_other.md', { type: 'project', description: 'Other', body: 'Something else.' });
  const prompts = [];
  const systems = [];
  env.host.services.llm = {
    stream(options) {
      systems.push(JSON.stringify(options));
      prompts.push(options.messages.flatMap((message) => message.content).map((block) => block.text).join('\n'));
      return streamOf([{ type: 'text-delta', text: JSON.stringify({ selected_memories: ['wiki_release.md'] }) }, { type: 'finish', reason: { kind: 'stop' } }]);
    },
  };
  const handlers = [];
  const agentCtx = { on: (_event, handler) => { handlers.push(handler); return () => {}; } };
  env.runtime.forAgent = async () => env.pctx;
  attachRecall({ agent: { id: 's', ctx: agentCtx }, agentCtx, runtime: env.runtime, config: () => env.runtime.config });
  const messages = [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'How do I cut a release?' }], source: { kind: 'user' } }];
  const decision = await handlers[0]({ messages, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [...messages] }));
  assert.match(prompts[0], /- \[wiki\] wiki_release\.md \(updated [^)]*\): How releases are cut/u);
  assert.match(systems[0], /A \[wiki\] page synthesizes several notes/u);
  const text = decision.messages[1].content[0].text;
  assert.match(text, /## project\/wiki_release\.md|## wiki_release\.md/u);
  assert.match(text, /Release rule: run pnpm release\./u);
  assert.ok(text.length <= 1500, `attached ${text.length} chars`);
  // The pure pieces agree.
  const entries = await env.pctx.store.listEntries('project', { currentOnly: true });
  assert.match(recallManifest(entries).text, /\[wiki\] wiki_release\.md/u);
  assert.ok(buildRecallText([{ file: 'wiki_release.md', body }], { maxChars: 1500 }).length <= 1500);
});

test('link helpers: file names with or without .md, and a bare slug for a wiki page', () => {
  assert.deepEqual(wikiLinks('See [[a]], [[b.md|alias]] and `[[c]]`\n```\n[[d]]\n```'), ['a', 'b.md', 'c']);
  const files = new Set(['wiki_x.md', 'project_y.md']);
  assert.equal(resolveWikiLink('project_y', files), 'project_y.md');
  assert.equal(resolveWikiLink('project_y.md', files), 'project_y.md');
  assert.equal(resolveWikiLink('x', files), 'wiki_x.md');
  assert.equal(resolveWikiLink('wiki_x', files), 'wiki_x.md');
  assert.equal(resolveWikiLink('nope', files), '');
});

test('wiki limits have defaults and clamp', () => {
  assert.equal(resolveConfig({}).wikiPageMaxChars, 8000);
  assert.equal(resolveConfig({}).wikiTotalMaxChars, 40000);
  assert.equal(resolveConfig({ wikiPageMaxChars: 10 }).wikiPageMaxChars, 500);
  assert.equal(resolveConfig({ wikiTotalMaxChars: '12000' }).wikiTotalMaxChars, 12000);
});
