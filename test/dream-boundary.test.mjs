import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runtimeEnv } from './v10-helpers.mjs';
import * as evidence from '../src/dream-evidence.js';
import { validateDreamPlan } from '../src/dream.js';

const op = (extra = {}) => ({ op: 'write', scope: 'project', type: 'project', file: 'project_deploy.md', name: 'deploy', description: 'deployment', body: 'Deploy on GCP Cloud Run.', ...extra });
const corpus = [{ tag: 'user', sessionId: 's1', seq: 7, date: '2026-11-08', text: evidence.normalizeForMatch('Deploy on GCP Cloud Run. Always use vitest.') }];

test('structured evidence must cover each new body line', () => {
  const operation = op({ body: 'Deploy on GCP Cloud Run.\nThe release window is Friday.', evidence: [{ statement: 'Deploy on GCP Cloud Run.', quote: 'Deploy on GCP Cloud Run.' }] });
  const r = evidence.checkPlanEvidence([operation], { corpus });
  assert.equal(r.operations.length, 0);
  assert.match(r.dropped.join(' '), /uncovered|every new statement/i);
});

test('a decimal or punctuation change is a new statement, not an unchanged fact', () => {
  const r = evidence.checkPlanEvidence([op({ body: 'Limit is 15 seconds.' })], { corpus: [], memoryFiles: [{ file: 'project_deploy.md', body: 'Limit is 1.5 seconds.' }] });
  assert.equal(r.operations.length, 0);
});

test('short-session sources retain the event sequence without adding transcript text', async (t) => {
  const e = await runtimeEnv(t);
  e.host.services.sessionQuery = {
    filterSessions: async () => [],
    readSession: async () => ({ session: { id: 'source-session' }, events: [{ type: 'user/message', seq: 7, time: Date.parse('2026-11-08T12:00:00Z'), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Deploy on GCP Cloud Run.' }] } }] }),
  };
  await e.pctx.state.ensureSession('source-session', 1);
  const { gatherDreamInput } = await import('../src/dream-input.js');
  const input = await gatherDreamInput({ ctx: e.host, store: e.pctx.store, state: e.pctx.state, config: e.config, workspaceDir: e.workspaceDir });
  const r = evidence.checkPlanEvidence([op({ evidence: [{ statement: 'Deploy on GCP Cloud Run.', quote: 'Deploy on GCP Cloud Run.' }] })], { corpus: evidence.buildEvidenceCorpus(input) });
  assert.equal(r.operations.length, 1);
  assert.equal(r.operations[0].evidenceSources[0].sessionId, 'source-session');
  assert.equal(r.operations[0].evidenceSources[0].seq, 7);
});

test('structured citations retain host-resolved locations and ignore claimed locations', () => {
  const r = evidence.checkPlanEvidence([op({ evidence: [{ statement: 'Deploy on GCP Cloud Run.', quote: 'Deploy on GCP Cloud Run.', sessionId: 'forged', seq: 999 }] })], { corpus });
  assert.equal(r.operations.length, 1);
  assert.deepEqual(r.operations[0].evidenceSources, [{ statement: 'Deploy on GCP Cloud Run.', quote: 'Deploy on GCP Cloud Run.', tag: 'user', sessionId: 's1', seq: 7, date: '2026-11-08' }]);
});

test('plan normalization preserves structured evidence for application and preview', () => {
  const r = validateDreamPlan({ operations: [op({ evidence: [{ statement: 'Deploy on GCP Cloud Run.', quote: 'Deploy on GCP Cloud Run.' }] })] });
  assert.deepEqual(r.plan.operations[0].evidence, [{ statement: 'Deploy on GCP Cloud Run.', quote: 'Deploy on GCP Cloud Run.' }]);
});

test('editing a note keeps its name when the plan only restyles it', () => {
  const existingFiles = [{ file: 'project_deploy.md', name: 'Deploy command' }];
  const restyled = validateDreamPlan({ operations: [op({ name: 'deploy_command' })] }, { existingFiles });
  assert.equal(restyled.plan.operations[0].name, 'Deploy command');
  const renamed = validateDreamPlan({ operations: [op({ name: 'Release process' })] }, { existingFiles });
  assert.equal(renamed.plan.operations[0].name, 'Release process', 'a real rename still goes through');
});

test('legacy operation-level quotes remain manually usable with a review warning', () => {
  const r = evidence.checkPlanEvidence([op({ evidence: ['Deploy on GCP Cloud Run.'] })], { corpus });
  assert.equal(r.operations.length, 1);
  assert.match(r.warnings.join(' '), /operation-level|legacy/i);
});

test('automatic review allows whitespace normalization but reviews changed facts and metadata', () => {
  assert.equal(typeof evidence.automaticReviewReasons, 'function');
  const memoryFiles = [{ file: 'project_deploy.md', type: 'project', name: 'deploy', description: 'deployment', body: 'Deploy on GCP Cloud Run.' }];
  assert.deepEqual(evidence.automaticReviewReasons([op({ body: ' Deploy on GCP Cloud Run. \n' })], memoryFiles), []);
  for (const change of [{ body: 'Deploy on AWS.' }, { description: 'deployment is forbidden' }, { body: '' }, { type: 'user' }]) {
    assert.ok(evidence.automaticReviewReasons([op(change)], memoryFiles).length > 0);
  }
  const codeBody = '```python\nif enabled:\n    deploy()\n```';
  const altered = '```python\nif enabled:\ndeploy()\n```';
  assert.ok(evidence.automaticReviewReasons([op({ body: altered })], [{ ...memoryFiles[0], body: codeBody }]).length > 0, 'code indentation changes are semantic');
});

test('automatic deletion requires identical content preserved in a surviving file', () => {
  assert.equal(typeof evidence.automaticReviewReasons, 'function');
  const memories = [{ file: 'project_a.md', body: 'Keep this fact.' }, { file: 'project_b.md', body: 'Keep this fact.' }];
  assert.deepEqual(evidence.automaticReviewReasons([{ op: 'delete', file: 'project_a.md' }], memories), []);
  assert.ok(evidence.automaticReviewReasons(memories.map((m) => ({ op: 'delete', file: m.file })), memories).length > 0);
});

test('an automatic semantic rewrite becomes a proposal and does not consume sessions', async (t) => {
  const plan = { operations: [op({ body: 'New unverified fact.' })] };
  const e = await runtimeEnv(t, { minHours: 0, minSessions: 1, scanThrottleMs: 1000 }, { plan });
  const saved = await e.pctx.store.saveEntry({ name: 'deploy', type: 'project', description: 'deployment', content: 'Old fact.' });
  await e.pctx.state.ensureSession('s1', 1);
  const r = await e.runtime.dream({ pctx: e.pctx, force: true, trigger: 'auto', noSessions: true });
  assert.equal(r.applied, false, JSON.stringify(r));
  assert.equal(r.mode, 'review');
  assert.equal((await e.pctx.store.readEntry(saved.file)).body, 'Old fact.');
  assert.ok((await e.pctx.state.read()).sessionsSince.length > 0);
  const proposal = JSON.parse(await readFile(r.proposalPath, 'utf8'));
  assert.match(proposal.warnings.join(' '), /review/i);
  const second = await e.runtime.dream({ pctx: e.pctx, force: true, trigger: 'auto', noSessions: true });
  assert.equal(second.skipReason, 'pending-proposal');
  assert.equal(second.proposalPath, r.proposalPath);
});

test('a large automatic shrink is proposed for review without consuming the source session', async (t) => {
  const plan = { operations: [op({ body: 'Keep this important fact.' })] };
  const e = await runtimeEnv(t, {}, { plan });
  const original = 'Keep this important fact.\n' + 'Another fact that must survive.\n'.repeat(20);
  const saved = await e.pctx.store.saveEntry({ name: 'deploy', type: 'project', description: 'deployment', content: original });
  await e.pctx.state.ensureSession('s1', 1);
  const r = await e.runtime.dream({ pctx: e.pctx, force: true, trigger: 'auto', noSessions: true });
  assert.equal(r.mode, 'review');
  assert.equal(r.applied, false);
  assert.equal(r.operations, 1);
  assert.equal((await e.pctx.store.readEntry(saved.file)).body, original.trim());
  assert.equal(e.pctx.state.snapshot().sessionsSince.length, 1);
});

test('tool evidence locates the result event in short and mapped transcripts', async () => {
  const { buildSessionTranscript, chunkTranscript } = await import('../src/dream-session-text.js');
  const transcript = buildSessionTranscript([
    { type: 'tool/call', seq: 4, data: { callId: 't', name: 'read', arguments: '{}' } },
    { type: 'tool/result', seq: 9, data: { message: { toolCallId: 't', content: [{ type: 'text', text: 'Deploy on GCP Cloud Run.' }] } } },
  ]);
  const [chunk] = chunkTranscript(transcript, { chunkChars: 2000, toolCharsPerChunk: 1000 });
  const built = evidence.buildEvidenceCorpus({ sessions: [{ id: 's-tool', excerpt: chunk.text, evidenceBlocks: chunk.evidenceBlocks }] });
  assert.equal(built.find((item) => item.tag === 'tool-result').seq, 9);
  assert.equal(built.find((item) => item.tag === 'tool-call').seq, 4);
  const { analyzeLongSessions } = await import('../src/dream-map.js');
  const input = { sessions: [{ id: 's-tool', chunks: [chunk], baseSeq: 0 }], reads: [] };
  await analyzeLongSessions({ input, config: {}, tokensSpent: () => 0, parseJson: JSON.parse,
    complete: async () => ({ text: JSON.stringify({ facts: [{ text: 'Deployment uses GCP.', quote: 'Deploy on GCP Cloud Run.' }] }) }) });
  assert.equal(input.sessions[0].facts[0].seq, 9);
});
