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
