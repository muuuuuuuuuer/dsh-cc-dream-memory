/**
 * One provenance check for the main session, auto-extract and Dream: a write
 * may carry `citations: [{quote, seq?}]`. The host checks each quote exists in
 * a non-injected event of the calling session and records who said it. Held
 * quotes of the user's own words mark a note current and verified; a quote that
 * does not hold is reported and never stops the write. `memory_update` also
 * replaces one passage (`old_text`) and keeps the old one in History.
 *
 * os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLedger } from '../src/verification-ledger.js';
import { toolsEnv } from './v10-helpers.mjs';

const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
const USER = 'Release builds always run on the ops box.';
const message = (seq, type, text, extra = {}) => ({
  seq, type, data: { source: { kind: 'user' }, content: [{ type: 'text', text }], ...extra },
});

function seed(env, events) {
  env.host.services.sessionQuery = { filterSessions: async () => [], readSession: async (id) => ({ session: { id }, events }) };
}

const save = (env, args) => env.definitions.get('memory_save').execute(args, exec);
const update = (env, args) => env.definitions.get('memory_update').execute(args, exec);
const read = (env, file) => env.definitions.get('memory_read').execute({ file }, exec);

test('a user quote without seq marks the note current and records the ledger', async (t) => {
  const env = await toolsEnv(t);
  seed(env, [message(4, 'user/message', USER)]);
  const saved = await save(env, { name: 'release box', type: 'project', content: USER, citations: [{ quote: 'always run on the ops box' }] });
  assert.equal(saved.written, true, JSON.stringify(saved));
  assert.equal(saved.verification, 'recorded');
  assert.deepEqual(saved.citations, [{ seq: 4, role: 'user' }]);
  assert.match((await env.pctx.store.readEntry(saved.file)).body, /^STATUS: current\n/u);
  assert.equal((await readLedger(env.pctx.store)).entries[saved.file].source, 'user-citation');
});

test('an assistant or injected quote is reported but never verifies', async (t) => {
  const env = await toolsEnv(t);
  seed(env, [
    message(1, 'assistant/message', 'I think deploys should wait for the canary.', { source: undefined }),
    message(2, 'user/message', 'Recalled memory says: always deploy on Fridays.', { source: { kind: 'plugin:cc-memory-recall' } }),
  ]);
  const saved = await save(env, {
    name: 'canary', type: 'project', content: 'Deploys wait for the canary.',
    citations: [{ quote: 'deploys should wait for the canary' }, { seq: 2, quote: 'always deploy on Fridays' }],
  });
  assert.equal(saved.written, true, JSON.stringify(saved));
  assert.equal(saved.verification, 'not-applicable');
  assert.deepEqual(saved.citations, [{ seq: 1, role: 'assistant' }]);
  assert.match(saved.citationProblems[0], /host-injected/u);
  assert.doesNotMatch((await env.pctx.store.readEntry(saved.file)).body, /STATUS: current/u);
  assert.deepEqual(Object.keys((await readLedger(env.pctx.store)).entries), []);
});

test('a citation that does not hold is reported and the write still happens', async (t) => {
  const env = await toolsEnv(t);
  seed(env, [message(1, 'user/message', USER)]);
  const saved = await save(env, {
    name: 'invented', type: 'project', content: 'Something else entirely.',
    citations: [{ quote: 'never said anywhere in this session' }, { seq: 9, quote: USER }, { quote: 'tiny' }],
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.written, true);
  assert.equal(saved.citations, undefined);
  assert.equal(saved.citationProblems.length, 3);
  assert.match(saved.citationProblems.join('\n'), /has no event 9/u);
  assert.equal(saved.verification, 'not-applicable');
});

test('a session that cannot be read reports the citation and still writes', async (t) => {
  const env = await toolsEnv(t);
  env.host.services.sessionQuery = { filterSessions: async () => [], readSession: async () => { throw new Error('gone'); } };
  const saved = await save(env, { name: 'unread', type: 'project', content: 'A fact.', citations: [{ quote: 'a fact that is quoted' }] });
  assert.equal(saved.written, true, JSON.stringify(saved));
  assert.match(saved.citationProblems[0], /could not be read: gone/u);
});

test('memory_update replaces one passage and keeps the old one in History', async (t) => {
  const env = await toolsEnv(t);
  const seedNote = await env.pctx.store.saveEntry({
    name: 'ops', type: 'project', description: 'ops facts',
    content: 'Builds run on the ops box.\n\nDeploys happen on Friday.\n\nBackups are nightly.',
  });
  await read(env, seedNote.file);
  const edited = await update(env, { file: seedNote.file, old_text: 'Deploys happen on Friday.', content: 'Deploys happen on Tuesday.' });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(edited.written, true);
  const { body } = await env.pctx.store.readEntry(seedNote.file);
  assert.match(body, /^Builds run on the ops box\.\n\nDeploys happen on Tuesday\.\n\nBackups are nightly\./u);
  assert.match(body, /- Superseded: Deploys happen on Friday\.$/mu);
  const reread = await read(env, seedNote.file);
  assert.doesNotMatch(reread.body, /Friday/u, 'a read answers with the current value only');
  assert.match(reread.body, /Tuesday/u);
});

test('a passage edit that keeps the old passage and adds to it supersedes nothing', async (t) => {
  const env = await toolsEnv(t);
  const seedNote = await env.pctx.store.saveEntry({
    name: 'ops', type: 'project', description: 'ops facts',
    content: 'Builds run on the ops box.\n\nDeploys happen on Friday.',
  });
  await read(env, seedNote.file);
  const edited = await update(env, { file: seedNote.file, old_text: 'Deploys happen on Friday.', content: 'Deploys happen on Friday.\n\nFreeze starts at noon.' });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const { body } = await env.pctx.store.readEntry(seedNote.file);
  assert.match(body, /Deploys happen on Friday\.\n\nFreeze starts at noon\./u);
  assert.doesNotMatch(body, /Superseded/u);
});

test('memory_update old_text must be found exactly once', async (t) => {
  const env = await toolsEnv(t);
  const seedNote = await env.pctx.store.saveEntry({
    name: 'ops', type: 'project', description: 'ops facts',
    content: 'Run it twice. Run it twice.\n\nBackups are nightly.',
  });
  await read(env, seedNote.file);
  const before = await env.pctx.store.readEntry(seedNote.file);
  const missing = await update(env, { file: seedNote.file, old_text: 'Backups are weekly.', content: 'x is new' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'OLD_TEXT_NOT_FOUND');
  const ambiguous = await update(env, { file: seedNote.file, old_text: 'Run it twice.', content: 'Run it once.' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, 'OLD_TEXT_AMBIGUOUS');
  const noReplacement = await update(env, { file: seedNote.file, old_text: 'Backups are nightly.' });
  assert.equal(noReplacement.error, 'INVALID_ARGUMENT');
  const same = await update(env, { file: seedNote.file, old_text: 'Backups are nightly.', content: 'Backups are nightly.' });
  assert.equal(same.written, false);
  assert.equal((await env.pctx.store.readEntry(seedNote.file)).raw, before.raw);
});

test('a passage edit with a cited user quote marks the page current and verified', async (t) => {
  const env = await toolsEnv(t);
  seed(env, [message(3, 'user/message', 'Deploys happen on Tuesday now.')]);
  const seedNote = await env.pctx.store.saveEntry({ name: 'ops', type: 'project', description: 'ops facts', content: 'Builds run on the ops box.\n\nDeploys happen on Friday.' });
  await read(env, seedNote.file);
  const edited = await update(env, {
    file: seedNote.file, old_text: 'Deploys happen on Friday.', content: 'Deploys happen on Tuesday.',
    citations: [{ seq: 3, quote: 'Deploys happen on Tuesday now.' }],
  });
  assert.equal(edited.written, true, JSON.stringify(edited));
  assert.equal(edited.verification, 'recorded');
  const { body } = await env.pctx.store.readEntry(seedNote.file);
  assert.match(body, /^STATUS: current\n/u);
  assert.match(body, /- Superseded: Deploys happen on Friday\./u);
});

test('legacy basis, evidence, confidence and force arguments are accepted and ignored', async (t) => {
  const env = await toolsEnv(t);
  seed(env, [message(1, 'user/message', USER)]);
  const saved = await save(env, { name: 'legacy', type: 'project', content: USER, basis: 'user-explicit', evidence: USER, confidence: 'low', force: true });
  assert.equal(saved.written, true, JSON.stringify(saved));
  assert.equal(saved.verification, 'not-applicable');
  assert.equal(saved.basis, undefined);
  assert.doesNotMatch((await env.pctx.store.readEntry(saved.file)).body, /STATUS: current/u);
});

test('the tools do not refuse unknown or legacy properties in their schema', async (t) => {
  const env = await toolsEnv(t);
  for (const name of ['memory_save', 'memory_update']) {
    assert.notEqual(env.definitions.get(name).parameters.additionalProperties, false);
    assert.ok(env.definitions.get(name).parameters.properties.citations);
    assert.equal(env.definitions.get(name).parameters.properties.basis, undefined);
  }
});

test('string content verifies in both event shapes', async (t) => {
  const env = await toolsEnv(t);
  seed(env, [
    { seq: 1, type: 'user/message', data: { message: { role: 'user', content: 'Plain string content in message.' } } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: 'Plain string content in data.' } },
  ]);
  const saved = await save(env, {
    name: 'shapes', type: 'project', content: 'A fact.',
    citations: [{ seq: 1, quote: 'string content in message' }, { seq: 2, quote: 'string content in data' }],
  });
  assert.deepEqual(saved.citations, [{ seq: 1, role: 'user' }, { seq: 2, role: 'user' }]);
  assert.equal(saved.verification, 'recorded');
});

test('the minimum quote length is 4 for CJK text and 8 otherwise', async (t) => {
  const env = await toolsEnv(t);
  seed(env, [message(1, 'user/message', '请一直用中文回复。 Short words only here.')]);
  const cjk = await save(env, { name: 'zh', type: 'user', content: '用中文回复。', citations: [{ quote: '用中文回复' }] });
  assert.deepEqual(cjk.citations, [{ seq: 1, role: 'user' }], JSON.stringify(cjk));
  const latin = await save(env, { name: 'en', type: 'user', content: 'Short.', citations: [{ quote: 'Short' }] });
  assert.equal(latin.citations, undefined);
  assert.match(latin.citationProblems[0], /at least 8 characters/u);
});
