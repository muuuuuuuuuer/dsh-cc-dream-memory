/**
 * Read-only data the redesigned Memory page needs: per-entry trust facts on
 * `/status` (hot set, host ledger, STATUS marker), pending-write details,
 * knowledge-wiki pages and the Dream v2 coverage carried by the plan preview.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callHttp, httpEnv, memoryFile, writePlan } from './v10-helpers.mjs';
import { recordVerification } from '../src/verification-ledger.js';
import { queuePendingWrite } from '../src/pending-writes.js';
import { WikiStore } from '../src/wiki-store.js';

async function seed(env, file, meta, body) {
  await writeFile(path.join(env.pctx.paths.memoryDir, file), memoryFile(meta, body), 'utf8');
}

test('status: entries carry hot, ledger and STATUS trust facts', async (t) => {
  const env = await httpEnv(t, { injectHotOnly: true, injectHotEntries: 3 });
  const store = env.pctx.store;
  await seed(env, 'project_hot.md', { name: 'Hot', type: 'project', description: 'verified' }, 'STATUS: current\nfact');
  await seed(env, 'project_edited.md', { name: 'Edited', type: 'project', description: 'changed' }, 'STATUS: current\nold fact');
  await seed(env, 'project_stale.md', { name: 'Stale', type: 'project', description: 'old' }, 'STATUS: stale\nold');
  await seed(env, 'user_plain.md', { name: 'Plain', type: 'user', description: 'no markers' }, 'plain note');
  for (const file of ['project_hot.md', 'project_edited.md']) {
    const read = await store.readEntry(file, 'project');
    await recordVerification({
      store, scope: 'project', file, name: read.frontmatter.name, description: read.frontmatter.description,
      body: read.body, date: '2026-11-10', source: 'dream',
    });
  }
  await seed(env, 'project_edited.md', { name: 'Edited', type: 'project', description: 'changed' }, 'STATUS: current\nnew fact');

  const status = (await callHttp(env, { path: '/status?sessionId=s1' })).json();
  assert.equal(status.ok, true);
  assert.equal(status.injection.hotOnly, true);
  assert.equal(status.injection.hotLimit, 3);
  assert.deepEqual(status.injection.hotFiles, ['project_hot.md']);
  const byFile = Object.fromEntries(status.entries.map((entry) => [entry.file, entry]));
  assert.equal(byFile['project_hot.md'].hot, true);
  assert.deepEqual(byFile['project_hot.md'].verified, { date: '2026-11-10', source: 'dream' });
  assert.equal(byFile['project_hot.md'].status, 'current');
  assert.equal(byFile['project_edited.md'].verified, null, 'an edit voids the ledger record');
  assert.equal(byFile['project_edited.md'].verifiedOutdated, true);
  assert.equal(byFile['project_edited.md'].hot, false);
  assert.equal(byFile['project_stale.md'].current, false);
  assert.equal(byFile['project_stale.md'].status, 'stale');
  assert.equal(byFile['user_plain.md'].status, '');
  assert.equal(byFile['user_plain.md'].current, true);
  assert.equal(byFile['user_plain.md'].verifiedOutdated, false);
});

test('status: without hot-only injection nothing is marked hot', async (t) => {
  const env = await httpEnv(t);
  await seed(env, 'user_lang.md', { name: 'Lang', description: 'reply in Chinese' }, 'STATUS: current\nreply in Chinese');
  const status = (await callHttp(env, { path: '/status?sessionId=s1' })).json();
  assert.equal(status.injection.hotOnly, false);
  assert.deepEqual(status.injection.hotFiles, []);
  assert.equal(status.entries[0].hot, false);
});

test('pending writes: list carries action and file; content only on request', async (t) => {
  const env = await httpEnv(t);
  await queuePendingWrite(env.pctx.paths, {
    action: 'update',
    file: 'user_lang.md',
    candidate: { name: 'Lang', type: 'user', description: 'reply in German', content: 'Always reply in German.' },
    reasons: ['user-explicit evidence does not support the new lines'],
  });
  const plain = (await callHttp(env, { path: '/pending-writes?sessionId=s1' })).json();
  assert.equal(plain.items[0].action, 'update');
  assert.equal(plain.items[0].file, 'user_lang.md');
  assert.equal('content' in plain.items[0].candidate, false);
  const full = (await callHttp(env, { path: '/pending-writes?sessionId=s1&content=1' })).json();
  assert.equal(full.items[0].candidate.content, 'Always reply in German.');
});

test('wiki: pages and read are read-only API actions', async (t) => {
  const env = await httpEnv(t);
  const wiki = new WikiStore({ rootDir: env.pctx.paths.wikiDir });
  await wiki.ensure();
  await wiki.writePage('timeouts.md', {
    name: 'Timeouts',
    description: 'request timeouts',
    domain: 'ops',
    body: 'Read timeout is 15 seconds. ^[spec.md#p2, 2026-11-10]\n\nSee [[retries]].',
  });
  wiki.close();
  const pages = (await callHttp(env, { method: 'POST', path: '/wiki', body: { sessionId: 's1', action: 'pages' } })).json();
  assert.equal(pages.ok, true);
  assert.equal(pages.result.pages.length, 1);
  assert.equal(pages.result.pages[0].file, 'timeouts.md');
  assert.equal(pages.result.pages[0].domain, 'ops');
  assert.equal(pages.result.pages[0].citations, 1);
  assert.deepEqual(pages.result.pages[0].links, ['retries']);
  const read = (await callHttp(env, { method: 'POST', path: '/wiki', body: { sessionId: 's1', action: 'read', file: 'timeouts.md' } })).json();
  assert.equal(read.ok, true);
  assert.match(read.result.page.body, /15 seconds/);
  const missing = (await callHttp(env, { method: 'POST', path: '/wiki', body: { sessionId: 's1', action: 'read', file: 'nope.md' } })).json();
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not-found');
});

test('status: carries the UI data contract version', async (t) => {
  const env = await httpEnv(t);
  const status = (await callHttp(env, { path: '/status?sessionId=s1' })).json();
  const { UI_API } = await import('../src/status.js');
  assert.equal(status.uiApi, UI_API);
});

test('dream preview marks what apply-ops would refuse, including dependent deletes', async (t) => {
  const env = await httpEnv(t, { dreamAllowDelete: true });
  await seed(env, 'project_eval.md', { name: 'Eval', type: 'project', description: 'eval harness' }, 'The harness runs nightly.');
  await seed(env, 'feedback_concise.md', { name: 'Concise', type: 'feedback', description: 'short replies' }, 'Keep replies short.');
  await seed(env, 'user_language.md', { name: 'Language', type: 'user', description: 'reply language' }, 'Answer in Chinese.');
  await writePlan(env, {
    summary: 'v2 plan',
    kind: 'dream-v2',
    coverageVersion: 1,
    coverageComplete: true,
    expectedSessions: 0,
    processedSessions: 0,
    failedSessions: [],
    partialSessions: [],
    sessions: [],
    reads: [],
    evidence: [],
    truncatedFiles: [],
    operations: [
      // An uncited cross-link line: the evidence gate refuses it.
      { op: 'write', scope: 'project', type: 'project', file: 'project_eval.md', name: 'Eval', description: 'eval harness',
        body: 'The harness runs nightly.\n相关：[[project_plugin]]（被评估插件）' },
      // Merge target that paraphrases the moved fact: refused too.
      { op: 'write', scope: 'project', type: 'user', file: 'user_language.md', name: 'Language', description: 'reply language',
        body: 'Answer in Chinese.\n- 回复风格：用户要求回答简短。' },
      // Deleting the merge source would now lose its fact.
      { op: 'delete', scope: 'project', file: 'feedback_concise.md' },
    ],
  });
  const response = (await callHttp(env, { method: 'POST', path: '/dream', body: { sessionId: 's1', action: 'preview' } })).json();
  assert.equal(response.ok, true);
  const ops = response.result.ops;
  assert.match(ops[0].rejected, /^project_eval\.md: new line has no source citation/);
  assert.match(ops[1].rejected, /^user_language\.md: /);
  assert.match(ops[2].rejected, /^merge dependency/);
  assert.equal(response.result.evidenceError ?? '', '');

  // The refusal is real: applying the first change alone fails the same way.
  const applied = (await callHttp(env, { method: 'POST', path: '/dream', body: { sessionId: 's1', action: 'apply-ops', indexes: [0] } })).json();
  assert.equal(applied.result.applied, false);
  assert.match(applied.result.error, /evidence-rejected: project_eval\.md: new line has no source citation/);
});

test('dream preview leaves applicable operations unmarked and flags a missing evidence bundle', async (t) => {
  const env = await httpEnv(t);
  await seed(env, 'project_eval.md', { name: 'Eval', type: 'project', description: 'eval harness' }, 'The harness runs nightly.');
  await writePlan(env, {
    summary: 'classic plan',
    truncatedFiles: [],
    operations: [{ op: 'write', scope: 'project', type: 'project', file: 'project_eval.md', name: 'Eval', description: 'eval harness', body: 'The harness runs nightly at 2am.' }],
  });
  const classic = (await callHttp(env, { method: 'POST', path: '/dream', body: { sessionId: 's1', action: 'preview' } })).json();
  assert.equal(classic.result.ops[0].rejected, undefined, 'classic plans have no evidence gate');

  await writePlan(env, {
    summary: 'v2 without evidence',
    kind: 'dream-v2',
    expectedSessions: 2,
    truncatedFiles: [],
    operations: [{ op: 'write', scope: 'project', type: 'project', file: 'project_eval.md', name: 'Eval', description: 'eval harness', body: 'x' }],
  });
  const missing = (await callHttp(env, { method: 'POST', path: '/dream', body: { sessionId: 's1', action: 'preview' } })).json();
  assert.match(missing.result.evidenceError, /no evidence bundle/);
});

test('dream preview carries v2 session coverage', async (t) => {
  const env = await httpEnv(t);
  await writePlan(env, {
    summary: 'v2 plan',
    kind: 'dream-v2',
    coverageComplete: false,
    expectedSessions: 3,
    processedSessions: 2,
    failedSessions: ['s3'],
    partialSessions: [],
    verifiedFiles: ['user_lang.md'],
    evidenceWarnings: ['one quote was not found'],
    operations: [],
    truncatedFiles: [],
  });
  const response = (await callHttp(env, { method: 'POST', path: '/dream', body: { sessionId: 's1', action: 'preview' } })).json();
  assert.equal(response.ok, true);
  const preview = response.result;
  assert.equal(preview.kind, 'dream-v2');
  assert.equal(preview.coverageComplete, false);
  assert.equal(preview.expectedSessions, 3);
  assert.equal(preview.processedSessions, 2);
  assert.deepEqual(preview.failedSessions, ['s3']);
  assert.deepEqual(preview.verifiedFiles, ['user_lang.md']);
  assert.deepEqual(preview.evidenceWarnings, ['one quote was not found']);
});

test('an empty dream plan is not offered as a pending review', async (t) => {
  const env = await httpEnv(t);
  await writePlan(env, {
    summary: 'nothing to change',
    kind: 'dream-v2',
    coverageComplete: true,
    expectedSessions: 0,
    processedSessions: 0,
    failedSessions: [],
    partialSessions: [],
    operations: [],
    truncatedFiles: [],
  });
  const status = (await callHttp(env, { path: '/status?sessionId=s1' })).json();
  assert.equal(status.ok, true);
  assert.equal(status.state.lastPlanPath, '');
  assert.match(status.state.lastError, /nothing to change/u);
});

test('a plan with work stays reviewable', async (t) => {
  const env = await httpEnv(t);
  const planPath = await writePlan(env, {
    summary: 'one note',
    kind: 'dream-v2',
    coverageComplete: true,
    expectedSessions: 0,
    processedSessions: 0,
    failedSessions: [],
    partialSessions: [],
    operations: [{ op: 'index', content: '- [Eval](project_eval.md) — eval harness\n' }],
    truncatedFiles: [],
  });
  const status = (await callHttp(env, { path: '/status?sessionId=s1' })).json();
  assert.equal(status.state.lastPlanPath, planPath);
});
