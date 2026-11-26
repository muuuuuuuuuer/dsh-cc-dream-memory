#!/usr/bin/env node
/**
 * "Mt. Moon" behavior cases against the real model: memory already holds a wrong
 * note, the source session shows what happened, and one Dream pass must fix it.
 * Not an A/B benefit comparison; each case is pass or fail on its own.
 *
 * Runs in process like eval/longmemeval: a MemoryRuntime on a fake host
 * (`makeHost` from lme-lib) whose Dream child is the real model driving the
 * plugin's scoped worker tools. Per case, in its own memory root: the fixture's
 * sessions become host sessions (every event, including host-injected and
 * pasted ones), the wrong notes and the suspect signal are seeded, one Dream
 * pass runs, its pending copy is switched in through the normal path, and the
 * notes are scored with the same data and function as test/dream-mt-moon.test.mjs.
 *
 * Needs DEEPSEEK_API_KEY. No DSH profile is involved.
 *
 * Usage:
 *   node eval/mt-moon/run.mjs                      # all cases
 *   node eval/mt-moon/run.mjs --only wrong-fact
 *   node eval/mt-moon/run.mjs --fake-model         # no model: applies each case's scripted fix
 *   node eval/mt-moon/run.mjs --fake-model=noop    # no model: Dream changes nothing
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashText } from '../harness-lib.mjs';
import { apiUsage, makeHost } from '../longmemeval/lme-lib.mjs';
import { resolveConfig } from '../../src/config.js';
import { MemoryRuntime } from '../../src/runtime.js';
import { eventText, loadCases, scoreCase } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS_DIR = process.env.EVAL_RUNS_DIR || path.join(ROOT, 'eval', 'runs');

const option = (name) => process.argv.find((item) => item === name || item.startsWith(`${name}=`));
const valueOf = (name) => { const item = option(name); return item?.includes('=') ? item.slice(name.length + 1) : item ? process.argv[process.argv.indexOf(item) + 1] : undefined; };
const FAKE = option('--fake-model') ? (valueOf('--fake-model') === 'noop' ? 'noop' : 'fix') : '';
const ONLY = valueOf('--only') ?? '';

/** The id a fixture session has as a host session. */
const hostId = (testCase, session) => `mt-${testCase.id}-${session.id}`;

/** Fixture sessions as host sessions: every event, in the shapes DSH logs. */
function hostSessions(testCase, cwd) {
  return testCase.sessions.map((session, index) => {
    const createdAt = Date.UTC(2026, 10, 1 + index);
    const id = hostId(testCase, session);
    const events = session.events.map((event, seq) => {
      const content = [{ type: 'text', text: eventText(event) }];
      const time = createdAt + seq * 1000;
      return event.role === 'assistant'
        ? { seq, type: 'assistant/message', time, data: { turn: 1, step: seq + 1, message: { role: 'assistant', content } } }
        : { seq, type: 'user/message', time, data: { role: 'user', source: { kind: event.injected || 'user' }, content } };
    });
    return { id, header: { id, cwd, createdAt, title: '' }, events };
  });
}

const noteText = (note, sessionId) => ['---', `name: ${note.name}`, `description: ${note.description}`, `type: ${note.type}`,
  `modified: ${new Date().toISOString()}`, `source_session: ${sessionId}`, 'via: eval-seed', '---', '', note.body, ''].join('\n');

/** The notes, the index and the signals that make a note a suspect, written straight into the memory root. */
function seed({ testCase, memoryRoot, sessionIds }) {
  const projectDir = path.join(memoryRoot, 'projects', 'eval-project');
  const memoryDir = path.join(projectDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const before = {};
  for (const note of testCase.notes) {
    before[note.file] = noteText(note, sessionIds[note.sourceSession]);
    fs.writeFileSync(path.join(memoryDir, note.file), before[note.file], 'utf8');
  }
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `${testCase.notes.map((note) => `- [${note.name}](${note.file}) — ${note.description}`).join('\n')}\n`, 'utf8');
  const reviewed = testCase.sessions.filter((session) => session.reviewed).map(({ id }) => sessionIds[id]);
  const stateFile = path.join(projectDir, '.state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  // A settled session: read to its end by an earlier Dream and not active since.
  state.dreamProcessedSessions = [...(state.dreamProcessedSessions ?? []), ...reviewed.map((id) => ({ id, at: Date.now(), seq: 1_000_000, coverageVersion: 2 }))];
  state.sessionsSince = (state.sessionsSince ?? []).filter(({ id }) => !reviewed.includes(id));
  if (testCase.suspect?.kind === 'corrected') {
    state.correctedFiles = [testCase.suspect.file];
    state.correctionVersions = { [testCase.suspect.file]: 'eval-seed' };
  }
  if (testCase.suspect?.kind === 'dismissed') state.recallDismissals = { 'eval-seed': [`project/${testCase.suspect.file}`] };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { before, memoryDir };
}

/** What a model that did its job leaves behind, for --fake-model only. */
function fakeFix(testCase, memoryDir) {
  const { fix } = testCase;
  if (!fix) return;
  const file = path.join(memoryDir, fix.file);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(fix.old_text, `${fix.body}\n\n- Superseded: ${fix.old_text}`), 'utf8');
}

function readNotes(memoryDir) {
  return Object.fromEntries(fs.readdirSync(memoryDir).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md')
    .map((name) => [name, fs.readFileSync(path.join(memoryDir, name), 'utf8')]));
}

async function runCase(testCase, runRoot) {
  const dir = path.join(runRoot, testCase.id);
  const memoryRoot = path.join(dir, 'memory-root');
  // Outside this repository: Dream leaves out conversations started in git-ignored folders such as eval/runs/.
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `mt-moon-${testCase.id}-`)));
  const record = { id: testCase.id, title: testCase.title, errors: [] };
  const sessionIds = Object.fromEntries(testCase.sessions.map((session) => [session.id, hostId(testCase, session)]));
  const { before, memoryDir } = seed({ testCase, memoryRoot, sessionIds });
  let dream = { fake: FAKE };
  let children = [];
  let evidence = [];
  if (!FAKE) {
    const host = makeHost({ workspaceDir: workspace, sessions: hostSessions(testCase, workspace) });
    const runtime = new MemoryRuntime(host, resolveConfig({
      memoryRoot, projectId: 'eval-project', userMemory: 'project', autoMemoryEnabled: true, autoExtract: false, autoDreamEnabled: false,
    }));
    // The plugin entry attaches the subagent tracker; it confines and equips Dream's child.
    runtime.subagents.attach(host);
    const pctx = await runtime.storeFor(workspace);
    pctx.agent = host.parent;
    const usageBefore = apiUsage();
    let result = await runtime.dream({ pctx, agent: host.parent, force: true });
    if (result.status === 'paused' && result.resumable) result = await runtime.dream({ pctx, agent: host.parent, runId: result.runId, resume: true });
    const pending = pctx.state.snapshot().shadowPending;
    evidence = (pending?.evidence ?? []).map(({ file, sessionId, seq, role, source, memoryFile, verified }) => ({ file, sessionId, seq, role, source, memoryFile, verified }));
    let switched = null;
    if (result.ready) switched = await runtime.switchDream({ pctx, runId: result.runId });
    await runtime.drain?.();
    children = host.childStats;
    const usageAfter = apiUsage();
    dream = { ready: result.ready === true, status: result.status ?? '', skipReason: result.skipReason ?? '', error: result.error ?? '',
      sessionsOffered: result.sessionsOffered ?? 0, sessionsReviewed: result.sessionsReviewed ?? 0, files: pending?.files?.length ?? 0,
      switched: switched ? switched.ok === true : null, switchError: switched?.error ?? '',
      usage: { requests: usageAfter.requests - usageBefore.requests, inputTokens: usageAfter.inputTokens - usageBefore.inputTokens, outputTokens: usageAfter.outputTokens - usageBefore.outputTokens } };
    // "nothing-new" and "incomplete-review" are outcomes; anything else (or no child at all) means Dream did not do its job.
    if (dream.error) record.errors.push({ stage: 'dream', error: dream.error });
    else if (dream.skipReason && !['nothing-new', 'incomplete-review'].includes(dream.skipReason)) record.errors.push({ stage: 'dream', error: `Dream skipped: ${dream.skipReason}` });
    else if (children.length === 0) record.errors.push({ stage: 'dream', error: 'no Dream child ran' });
    for (const child of children) if (child.error) record.errors.push({ stage: 'dream-child', error: child.error });
    if (switched && !switched.ok) record.errors.push({ stage: 'switch', error: switched.error || 'switch failed' });
  } else if (FAKE === 'fix') fakeFix(testCase, memoryDir);
  const after = readNotes(memoryDir);
  const score = scoreCase(testCase, { before, after });
  // A run whose Dream never completed says nothing about the model.
  Object.assign(record, {
    validity: record.errors.length === 0 ? 'valid' : 'invalid',
    pass: record.errors.length === 0 && score.pass,
    checks: score.checks,
    dream,
    children,
    evidence,
    notesAfter: Object.fromEntries(Object.entries(after).map(([file, text]) => [file, { hash: hashText(text), changed: text !== before[file], text }])),
  });
  return record;
}

async function main() {
  const cases = (await loadCases()).filter(({ id }) => !ONLY || id === ONLY);
  if (cases.length === 0) { console.error(`[mt-moon] no case matches --only ${ONLY}`); process.exit(1); }
  if (!FAKE && !process.env.DEEPSEEK_API_KEY) { console.error('DEEPSEEK_API_KEY is not set in this process environment; export it before running.'); process.exit(1); }
  const runRoot = path.join(RUNS_DIR, `mt-moon-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(runRoot, { recursive: true });
  const records = [];
  for (const testCase of cases) {
    console.log(`[mt-moon] ${testCase.id} ...`);
    const record = await runCase(testCase, runRoot);
    records.push(record);
    console.log(`[mt-moon] ${testCase.id}: ${record.pass ? 'PASS' : record.validity === 'invalid' ? 'INVALID' : 'FAIL'}`);
    for (const item of record.checks.filter(({ ok }) => !ok)) console.log(`    ${item.soft ? 'note' : 'FAIL'}: ${item.label}`);
    for (const { stage, error } of record.errors) console.log(`    error ${stage}: ${error}`);
  }
  const report = { startedAt: new Date().toISOString(), mode: FAKE ? `fake-model:${FAKE}` : 'real', passed: records.filter(({ pass }) => pass).length, total: records.length, cases: records };
  fs.writeFileSync(path.join(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[mt-moon] ${report.passed}/${report.total} passed (${report.mode}); report: ${path.join(runRoot, 'report.json')}`);
  if (records.some(({ validity }) => validity === 'invalid')) process.exitCode = 1;
}

await main();
