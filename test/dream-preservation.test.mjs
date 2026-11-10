import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runtimeEnv } from './v10-helpers.mjs';
import { checkPlanEvidence, buildEvidenceCorpus } from '../src/dream-evidence.js';
import { validateDreamPlan } from '../src/dream.js';

const a = { file: 'feedback_evidence.md', type: 'feedback', name: 'Evidence', description: 'Check results', body: 'Show concrete evidence before claiming success.' };
const b = { file: 'feedback_uncertainty.md', type: 'feedback', name: 'Uncertainty', description: 'Keep uncertainty', body: 'Keep uncertain conclusions explicitly qualified.' };
const mergeWrite = (body = `${a.body}\n${b.body}`) => ({ op: 'write', scope: 'project', ...a, body });
const deletion = { op: 'delete', scope: 'project', file: b.file, reason: 'absorbed by feedback_evidence.md' };
const index = { op: 'index', scope: 'project', content: `- [Evidence](${a.file}) — Check results\n` };
const options = { memoryFiles: [a, b], corpus: [], requireEvidence: true };

test('moving existing feedback between files does not require replaying its old user session', () => {
  const result = checkPlanEvidence([mergeWrite(), deletion, index], options);
  assert.equal(result.operations.filter(op => op.op === 'write').length, 1);
  assert.equal(result.operations.filter(op => op.op === 'delete').length, 1);
  assert.deepEqual(result.dropped, []);
});

test('project text cannot become a new user preference through the known-memory exemption', () => {
  const result = checkPlanEvidence([mergeWrite()], { ...options, memoryFiles: [a, { ...b, type: 'project' }] });
  assert.equal(result.operations.length, 0);
  assert.match(result.dropped.join(' '), /user|source|evidence/i);
});

test('the known-memory exemption does not erase meaningful code indentation', () => {
  const result = checkPlanEvidence([mergeWrite('deploy()')], { ...options, memoryFiles: [{ ...a, body: '    deploy()' }] });
  assert.equal(result.operations.length, 0);
});

test('a rejected merge write also removes its destructive delete and index operations', () => {
  const result = checkPlanEvidence([mergeWrite('A new preference that nobody stated.'), deletion, index], options);
  assert.deepEqual(result.operations, []);
  assert.match(result.dropped.join(' '), /depend|write.*rejected|write.*dropped/i);
});

test('operation-level evidence covers an edit without repeating one quote for every added line', () => {
  const input = { sessions: [{ id: 's1', excerpt: '[user] Always use vitest and run tests before claiming success.' }] };
  const result = checkPlanEvidence([mergeWrite('Use vitest.\nRun tests before claiming success.')], {
    ...options,
    corpus: buildEvidenceCorpus(input),
  });
  assert.equal(result.operations.length, 0, 'uncited new preference remains rejected');
  const cited = mergeWrite('Use vitest.\nRun tests before claiming success.');
  cited.evidence = [{ statement: 'Use vitest.', quote: 'Always use vitest and run tests before claiming success.' }];
  const accepted = checkPlanEvidence([cited], { ...options, corpus: buildEvidenceCorpus(input) });
  assert.equal(accepted.operations.length, 1);
  assert.equal(accepted.operations[0].evidenceSources[0].tag, 'user');
});

test('an existing feedback rewording can cite its own memory but requires explicit review', () => {
  const op = mergeWrite('Show concrete evidence before reporting success.');
  op.evidence = [a.body];
  const result = checkPlanEvidence([op], { ...options, corpus: buildEvidenceCorpus({ memory: { files: [a, b] } }) });
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].requiresReview, true);
  assert.equal(result.operations[0].evidenceSources[0].tag, 'memory');
});

async function mergeEnv(t, { body, trigger = 'manual', secret = false, malformed = false, rewriteQuote = false } = {}) {
  const plan = { summary: 'Merge complementary feedback', operations: [] };
  const e = await runtimeEnv(t, { dreamAllowDelete: true, dreamMode: 'apply', minHours: 0, minSessions: 1 }, { plan });
  const first = await e.pctx.store.saveEntry({ type: a.type, name: a.name, description: a.description, content: a.body });
  const second = await e.pctx.store.saveEntry({ type: b.type, name: b.name, description: b.description, content: b.body });
  const write = { ...mergeWrite(body), file: first.file };
  if (secret) write.body = `sk-ant-api03-${'X'.repeat(80)}`;
  if (malformed) write.file = '../escape.md';
  if (rewriteQuote) write.evidence = [a.body];
  plan.operations = [write, { ...deletion, file: second.file }, { ...index, content: `- [Evidence](${first.file}) — Check results\n` }];
  e.host.services.sessionQuery = {
    filterSessions: async () => [],
    readSession: async () => ({ session: { id: 'merge-session' }, events: [{ type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please continue working on the project safely.' }] } }] }),
  };
  await e.pctx.state.ensureSession('merge-session', Date.now());
  const result = await e.runtime.dream({ pctx: e.pctx, force: true, trigger });
  return { ...e, first, second, result };
}

test('manual Dream keeps both original feedback facts when applying a merge', async t => {
  const e = await mergeEnv(t);
  assert.equal(e.result.applied, true, JSON.stringify(e.result));
  const destination = await e.pctx.store.readEntry(e.first.file);
  assert.ok(destination.body.includes(a.body));
  assert.ok(destination.body.includes(b.body), 'the absorbed fact must survive deletion of its source');
  await assert.rejects(e.pctx.store.readEntry(e.second.file), /not found|ENOENT/i);
});

test('automatic Dream proposes the whole feedback merge rather than an orphan deletion', async t => {
  const e = await mergeEnv(t, { trigger: 'auto' });
  assert.equal(e.result.mode, 'review');
  const plan = JSON.parse(await readFile(e.result.proposalPath, 'utf8'));
  assert.equal(plan.operations.filter(op => op.op === 'write').length, 1);
  assert.equal(plan.operations.filter(op => op.op === 'delete').length, 1);
  assert.equal((await e.pctx.store.readEntry(e.second.file)).body, b.body);
});

test('manual Dream proposes a memory-sourced feedback correction rather than applying an unverified preference', async t => {
  const e = await mergeEnv(t, { body: `Show concrete evidence before reporting success.\n${b.body}`, rewriteQuote: true });
  assert.equal(e.result.mode, 'review');
  assert.equal(e.result.applied, false);
  const proposal = JSON.parse(await readFile(e.result.proposalPath, 'utf8'));
  assert.equal(proposal.operations.filter(op => op.op === 'write').length, 1);
  assert.equal((await e.pctx.store.readEntry(e.first.file)).body, a.body);
});

for (const reason of ['uncited', 'secret', 'malformed']) {
  test(`Dream preserves source memories and session progress when a ${reason} merge write is filtered`, async t => {
    const e = await mergeEnv(t, { body: 'A new preference that nobody stated.', secret: reason === 'secret', malformed: reason === 'malformed' });
    assert.equal((await e.pctx.store.readEntry(e.first.file)).body, a.body);
    assert.equal((await e.pctx.store.readEntry(e.second.file)).body, b.body);
    assert.ok(e.pctx.state.snapshot().sessionsSince.some(s => s.id === 'merge-session'));
  });
}

test('preview lists deleted body lines even when a rewrite shrinks less than half', async t => {
  const e = await runtimeEnv(t);
  const saved = await e.pctx.store.saveEntry({ type: 'project', name: 'Facts', description: 'Facts', content: 'Fact one.\nFact two.\nFact three.\nFact four.\nFact five.' });
  const { DreamEngine } = await import('../src/dream.js');
  const engine = new DreamEngine({ ctx: e.host, config: e.config });
  const preview = await engine.previewPlan({ pctx: e.pctx, plan: { operations: [{ ...mergeWrite('Fact one.\nFact two.\nFact three.'), file: saved.file, type: 'project' }] } });
  assert.deepEqual(preview.ops[0].removedLines.map(line => line.text), ['Fact four.', 'Fact five.']);
});

for (const body of [mergeWrite().body, 'Show evidence and retain explicit uncertainty.']) test('selective apply refuses a source deletion with an unselected merge destination', async t => {
  const e = await runtimeEnv(t, { dreamAllowDelete: true });
  const first = await e.pctx.store.saveEntry({ type: a.type, name: a.name, description: a.description, content: a.body });
  const second = await e.pctx.store.saveEntry({ type: b.type, name: b.name, description: b.description, content: b.body });
  const { DreamEngine } = await import('../src/dream.js');
  const engine = new DreamEngine({ ctx: e.host, config: e.config });
  const plan = { operations: [{ ...mergeWrite(body), file: first.file }, { ...deletion, file: second.file }] };
  const result = await engine.applyPlanOperations({ pctx: e.pctx, plan, indexes: [1] });
  assert.equal(result.applied, false);
  assert.match(result.error, /merge|depend|destination/i);
  assert.equal((await e.pctx.store.readEntry(second.file)).body, b.body);
});

test('a plan cannot overwrite a merge destination twice and invalidate its retained facts', () => {
  const result = validateDreamPlan({ operations: [mergeWrite(), mergeWrite(a.body), deletion] }, { config: { dreamAllowDelete: true } });
  assert.equal(result.ok, false);
  assert.match(result.error, /same|duplicate|multiple/i);
});

test('Dream cannot create a body larger than its configured full-read limit', () => {
  const result = validateDreamPlan({ operations: [mergeWrite('x'.repeat(101))] }, { config: { dreamMaxFileChars: 100 } });
  assert.equal(result.plan.operations.length, 0);
  assert.match(result.dropped.join(' '), /full-read|read limit|dreamMaxFileChars/i);
});

for (const selected of [false, true]) test(`a previously saved incomplete plan cannot apply orphan deletions (${selected ? 'selective' : 'full'} apply)`, async t => {
  const e = await runtimeEnv(t, { dreamAllowDelete: true });
  const saved = await e.pctx.store.saveEntry({ type: b.type, name: b.name, description: b.description, content: b.body });
  const { DreamEngine } = await import('../src/dream.js');
  const engine = new DreamEngine({ ctx: e.host, config: e.config });
  const plan = { operations: [{ ...deletion, file: saved.file }], dropped: ['write feedback_evidence.md: adds statements without evidence'] };
  const result = selected
    ? await engine.applyPlanOperations({ pctx: e.pctx, plan, indexes: [0] })
    : await engine.applyPending({ pctx: e.pctx, plan });
  assert.equal(result.applied, false);
  assert.match(result.error, /incomplete|regenerate|new.*plan/i);
  assert.equal((await e.pctx.store.readEntry(saved.file)).body, b.body);
});
