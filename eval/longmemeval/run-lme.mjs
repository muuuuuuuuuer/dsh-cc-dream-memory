#!/usr/bin/env node
/**
 * LongMemEval-S, three lines on the same questions:
 *   A  no plugin           fresh DSH session, the plugin disabled
 *   B  memory              notes formed by the plugin's auto-extract over the
 *                          verbatim history, frozen as checkpoint-before-dream
 *   C  memory + Dream      the same checkpoint, then Dream over the same
 *                          history with the normal evidence check and switch
 *                          (blocked drafts are deferred, not confirmed)
 * Every line answers the original question in its own fresh headless DSH
 * session with the same model. Grading uses the official LongMemEval prompts
 * with DeepSeek as the judge (not the official GPT-4o judge).
 *
 *   node eval/longmemeval/run-lme.mjs build  [--only id,id] [--concurrency 4]
 *   node eval/longmemeval/run-lme.mjs answer [--only ...]
 *   node eval/longmemeval/run-lme.mjs grade
 *   node eval/longmemeval/run-lme.mjs report
 * Environment: LME_DATA (dataset json), LME_RUN (output dir), DEEPSEEK_API_KEY.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRuntime } from '../../src/runtime.js';
import { resolveConfig } from '../../src/config.js';
import { runAutoExtract } from '../../src/auto-extract.js';
import { registerTools } from '../../src/tools.js';
import { resolveDshPaths } from '../dsh-paths.mjs';
import { apiUsage, judge, loadDataset, makeHost, sampleQuestions, sessionsOf } from './lme-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = process.env.LME_DATA || path.join(process.env.LOCALAPPDATA ?? '', 'Temp', 'lme-data', 'longmemeval_s_cleaned.json');
const RUN = path.resolve(process.env.LME_RUN || path.join(process.env.LOCALAPPDATA ?? '', 'Temp', 'lme-runs', 'run-1'));
const PROFILE = process.env.LME_PROFILE || 'cc-memory-lme';
const PROJECT_ID = 'eval-project';
const TOOL_LOCK = ['tool-plugin-manager', 'tool-working-directory', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'tool-skill', 'tool-agent-team', 'tool-subagent-control', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-goal', 'tool-web'];
// tool-todo stays on in every line: with no tools at all the model writes tool calls as text instead of answering.
const [phase] = process.argv.slice(2);
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });
const write = (file, value) => { ensure(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const copy = (from, to) => { fs.rmSync(to, { recursive: true, force: true }); fs.cpSync(from, to, { recursive: true }); };
const listNotes = (memoryRoot) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') out.push(path.relative(memoryRoot, full));
    }
  };
  walk(memoryRoot);
  return out.sort();
};

const config = (memoryRoot) => resolveConfig({
  memoryRoot, projectId: PROJECT_ID, userMemory: 'project', autoExtract: true, autoMemoryEnabled: true, autoDreamEnabled: false,
});

function questionsToRun(dataset) {
  const sample = sampleQuestions(dataset);
  write(path.join(RUN, 'sample.json'), sample);
  const only = option('--only', '');
  const wanted = only ? new Set(only.split(',')) : null;
  const byId = new Map(dataset.map((q) => [q.question_id, q]));
  return sample.picked.filter(({ id }) => !wanted || wanted.has(id)).map(({ group, id }) => ({ group, q: byId.get(id) }));
}

async function pool(items, limit, work) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length > 0) await work(queue.shift());
  }));
}

/** B: the plugin's auto-extract over every session, oldest first, one window at a time. */
async function formMemory(q, dir, sessions, record) {
  const memoryRoot = path.join(dir, 'B', 'memory-root');
  fs.rmSync(memoryRoot, { recursive: true, force: true });
  ensure(memoryRoot);
  const host = makeHost({ workspaceDir: path.join(dir, 'workspace'), sessions });
  const runtime = new MemoryRuntime(host, config(memoryRoot));
  registerTools(host, runtime);
  const pctx = await runtime.storeFor(path.join(dir, 'workspace'));
  const started = Date.now();
  const windows = [];
  for (const session of sessions) {
    for (let window = 0; window < 60; window += 1) {
      const result = await runAutoExtract({ runtime, pctx, sessionId: session.id, agent: { id: session.id }, trigger: 'eval' });
      windows.push({ session: session.id, ok: result.ok, reason: result.reason ?? '', saved: result.saved ?? result.count ?? undefined });
      if (!result.ok && ['no-new-events', 'empty-transcript', 'disabled', 'no-session-query', 'read-failed'].includes(result.reason)) break;
      if (!result.ok && window > 0 && windows.at(-2)?.reason === result.reason && result.reason !== 'nothing-to-save') break;
    }
  }
  await runtime.drain?.();
  record.B = { ms: Date.now() - started, windows: windows.length, failures: windows.filter((w) => !w.ok && !['no-new-events', 'empty-transcript'].includes(w.reason)).map((w) => w.reason), notes: listNotes(memoryRoot) };
  copy(memoryRoot, path.join(dir, 'checkpoint-before-dream'));
}

/** C: Dream on the same checkpoint and history until every session was offered; blocked drafts are deferred. */
async function dream(q, dir, sessions, record) {
  const memoryRoot = path.join(dir, 'C', 'memory-root');
  copy(path.join(dir, 'checkpoint-before-dream'), memoryRoot);
  const host = makeHost({ workspaceDir: path.join(dir, 'workspace'), sessions });
  const runtime = new MemoryRuntime(host, config(memoryRoot));
  // The plugin entry attaches the subagent tracker; it confines and equips Dream's child.
  runtime.subagents.attach(host);
  const pctx = await runtime.storeFor(path.join(dir, 'workspace'));
  pctx.agent = host.parent;
  const started = Date.now();
  const runs = [];
  const reviewed = new Set();
  const sourceIds = new Set(sessions.map(({ id }) => id));
  let idle = 0;
  const maxRuns = Math.ceil(sessions.length / runtime.config.dreamMaxTasks) + 6;
  let coverage = await runtime.dreamCoverage(pctx);
  for (const session of coverage.sessions) if (session.status === 'done') reviewed.add(session.id);
  for (let attempt = 0; attempt < maxRuns; attempt += 1) {
    if ([...sourceIds].every((id) => reviewed.has(id))) break;
    const priorReviewed = reviewed.size;
    let result = await runtime.dream({ pctx, agent: host.parent, force: true });
    if (result.status === 'paused' && result.resumable) result = await runtime.dream({ pctx, agent: host.parent, runId: result.runId, resume: true });
    const entry = { runId: result.runId, ready: result.ready === true, skipReason: result.skipReason ?? '', error: result.error ?? '', status: result.status ?? '', sessionsReviewed: result.sessionsReviewed ?? 0 };
    if (result.ready) {
      const pending = pctx.state.snapshot().shadowPending;
      for (const item of pending?.reviewRecords ?? []) if (item.complete) reviewed.add(item.id);
      const blocked = (pending?.proofs ?? []).filter((proof) => proof.kind === 'missing').map((proof) => proof.file);
      const switched = await runtime.switchDream({ pctx, runId: result.runId, defer: blocked });
      Object.assign(entry, { files: pending?.files?.length ?? 0, blocked: blocked.length, switched: switched.ok === true, switchError: switched.error ?? '' });
      if (!switched.ok) {
        await runtime.discardDream?.({ pctx, runId: result.runId }).catch(() => {});
      }
    }
    runs.push(entry);
    coverage = await runtime.dreamCoverage(pctx);
    for (const session of coverage.sessions) if (session.status === 'done') reviewed.add(session.id);
    idle = reviewed.size > priorReviewed ? 0 : idle + 1;
    log(q.question_id, 'dream', attempt + 1, JSON.stringify(entry));
    if (idle >= 2) break;
  }
  record.C = {
    ms: Date.now() - started, runs, coverage: coverage.counts, uniqueReviewed: reviewed.size, sourceSessions: sourceIds.size,
    blocked: runs.reduce((sum, run) => sum + (run.blocked ?? 0), 0), proposed: runs.reduce((sum, run) => sum + (run.files ?? 0), 0),
    children: host.childStats, notes: listNotes(memoryRoot),
  };
  copy(memoryRoot, path.join(dir, 'checkpoint-after-dream'));
}

async function build(dataset) {
  const items = questionsToRun(dataset);
  await pool(items, Number(option('--concurrency', 4)), async ({ group, q }) => {
    const dir = path.join(RUN, q.question_id);
    const recordFile = path.join(dir, 'build.json');
    const record = read(recordFile, { id: q.question_id, group, type: q.question_type });
    if (record.C && !process.argv.includes('--force')) return;
    ensure(path.join(dir, 'workspace'));
    // LME_SMOKE_SESSIONS keeps only the latest N sessions: wiring checks only, never a reported run.
    const smoke = Number(process.env.LME_SMOKE_SESSIONS) || 0;
    const sessions = sessionsOf(q, path.join(dir, 'workspace')).slice(smoke > 0 ? -smoke : 0);
    try {
      if (!record.B || process.argv.includes('--force')) {
        log(q.question_id, 'memory: start', sessions.length, 'sessions');
        await formMemory(q, dir, sessions, record);
        write(recordFile, record);
        log(q.question_id, 'memory: done', record.B.notes.length, 'notes', Math.round(record.B.ms / 1000) + 's');
      }
      log(q.question_id, 'dream: start');
      await dream(q, dir, sessions, record);
      write(recordFile, record);
      log(q.question_id, 'dream: done', record.C.notes.length, 'notes', Math.round(record.C.ms / 1000) + 's', 'blocked', record.C.blocked);
    } catch (error) {
      record.error = String(error?.stack ?? error);
      write(recordFile, record);
      log(q.question_id, 'FAILED', error?.message ?? error);
    }
  });
  write(path.join(RUN, 'api-usage-build.json'), apiUsage());
}

function patchFor(condition, dir) {
  const lines = TOOL_LOCK.map((id) => `- id: ${id}\n  disabled: true`);
  if (condition === 'A') lines.push('- id: cc-dream-memory\n  disabled: true');
  else {
    const memoryRoot = path.join(dir, condition, 'memory-root').replaceAll('\\', '/');
    lines.push('- id: cc-dream-memory', '  config:');
    for (const [key, value] of Object.entries({ memoryRoot, projectId: PROJECT_ID, userMemory: 'project', enabled: true, autoMemoryEnabled: true,
      tools: true, autoExtract: false, autoDreamEnabled: false })) lines.push(`    ${key}: ${JSON.stringify(value)}`);
  }
  const file = path.join(dir, 'patches', condition + '.yml');
  ensure(path.dirname(file));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function headless({ cwd, patch, prompt, timeoutMs = 300_000 }) {
  const { DSH_EXE, DSH_CLI } = resolveDshPaths();
  return new Promise((resolve) => {
    const child = spawn(DSH_EXE, ['--expose-internals', DSH_CLI, '--profile', PROFILE, '--patch', patch, '--json', prompt], {
      cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const events = stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{')).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const final = events.find((event) => event.type === 'final');
      resolve({ ok: code === 0 && Boolean(final), code, text: final?.text ?? '', tools: events.filter((e) => e.type === 'tool_call').map((e) => e.tool), stderr: stderr.slice(-2000) });
    });
  });
}

async function answer(dataset) {
  const items = questionsToRun(dataset);
  await pool(items, Number(option('--concurrency', 3)), async ({ q }) => {
    const dir = path.join(RUN, q.question_id);
    const build = read(path.join(dir, 'build.json'), null);
    if (!build?.C) { log(q.question_id, 'answer skipped: not built'); return; }
    const file = path.join(dir, 'answers.json');
    const answers = read(file, {});
    for (const condition of ['A', 'B', 'C']) {
      if (answers[condition]?.ok && !process.argv.includes('--force')) continue;
      // Answer from the frozen snapshot; anything the session writes is discarded afterwards.
      if (condition !== 'A') copy(path.join(dir, condition === 'B' ? 'checkpoint-before-dream' : 'checkpoint-after-dream'), path.join(dir, condition, 'memory-root'));
      const workspace = path.join(dir, 'workspace');
      // The same prompt for every line; the short instruction keeps a line without memory
      // tools from exploring the empty workspace instead of answering.
      const prompt = `Current date: ${q.question_date}\n\n${q.question}\n\nAnswer directly.`;
      const started = Date.now();
      // With no tools on offer the model sometimes writes a tool call as text
      // (DSML markup) instead of answering; such a reply is retried, then flagged.
      let result;
      let attempts = 0;
      do {
        attempts += 1;
        result = await headless({ cwd: workspace, patch: patchFor(condition, dir), prompt });
      } while (attempts < 3 && (!result.ok || /DSML/u.test(result.text)));
      answers[condition] = { ok: result.ok, hypothesis: result.text, tools: result.tools, ms: Date.now() - started, attempts,
        malformed: /DSML/u.test(result.text), ...(result.ok ? {} : { stderr: result.stderr, code: result.code }) };
      write(file, answers);
      log(q.question_id, condition, result.ok ? 'answered' : 'FAILED', result.text.slice(0, 80).replace(/\s+/gu, ' '));
    }
  });
}

async function grade(dataset) {
  const items = questionsToRun(dataset);
  const hyps = { A: [], B: [], C: [] };
  await pool(items, 6, async ({ q }) => {
    const dir = path.join(RUN, q.question_id);
    const answers = read(path.join(dir, 'answers.json'), {});
    const grades = read(path.join(dir, 'grades.json'), {});
    for (const condition of ['A', 'B', 'C']) {
      const hypothesis = answers[condition]?.hypothesis;
      if (typeof hypothesis !== 'string') continue;
      hyps[condition].push({ question_id: q.question_id, hypothesis });
      if (grades[condition]?.hypothesis === hypothesis) continue;
      grades[condition] = { hypothesis, ...(await judge(q, hypothesis)) };
    }
    write(path.join(dir, 'grades.json'), grades);
  });
  // Official hypothesis files, one JSON object per line.
  for (const [condition, list] of Object.entries(hyps)) {
    fs.writeFileSync(path.join(RUN, `hypotheses-${condition}.jsonl`), list.map((item) => JSON.stringify(item)).join('\n') + '\n');
  }
}

function report(dataset) {
  const items = questionsToRun(dataset);
  const rows = items.map(({ group, q }) => {
    const dir = path.join(RUN, q.question_id);
    return { group, q, build: read(path.join(dir, 'build.json'), {}), answers: read(path.join(dir, 'answers.json'), {}), grades: read(path.join(dir, 'grades.json'), {}) };
  }).filter((row) => row.grades.A && row.grades.B && row.grades.C);
  const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-');
  const right = (row, c) => row.grades[c]?.label === true;
  const lines = ['# LongMemEval-S: no plugin / memory / memory + Dream', '',
    `Sample: ${read(path.join(RUN, 'sample.json'), {}).rule}. Graded ${rows.length} of ${items.length}.`,
    'Judge: the official LongMemEval answer-check prompts with DeepSeek (deepseek-flash) as the judge, not the official GPT-4o judge.', '',
    '| group | n | A no plugin | B memory | C memory + Dream |', '|---|---:|---:|---:|---:|'];
  for (const group of ['all', 'knowledge-update', 'multi-session', 'abstention']) {
    const set = rows.filter((row) => group === 'all' || row.group === group);
    lines.push(`| ${group} | ${set.length} | ${pct(set.filter((r) => right(r, 'A')).length, set.length)} | ${pct(set.filter((r) => right(r, 'B')).length, set.length)} | ${pct(set.filter((r) => right(r, 'C')).length, set.length)} |`);
  }
  const flip = (from, to, a, b) => rows.filter((row) => right(row, from) === a && right(row, to) === b);
  lines.push('', '## Per-question changes', '',
    `- B wrong, C right: ${flip('B', 'C', false, true).length} — ${flip('B', 'C', false, true).map((r) => r.q.question_id).join(', ') || 'none'}`,
    `- B right, C wrong: ${flip('B', 'C', true, false).length} — ${flip('B', 'C', true, false).map((r) => r.q.question_id).join(', ') || 'none'}`,
    `- A wrong, B right: ${flip('A', 'B', false, true).length}; A right, B wrong: ${flip('A', 'B', true, false).length}`, '');
  const blocked = rows.reduce((sum, row) => sum + (row.build.C?.blocked ?? 0), 0);
  const proposed = rows.reduce((sum, row) => sum + (row.build.C?.proposed ?? 0), 0);
  lines.push('## Dream', '', `- Proposed note changes: ${proposed}; blocked by the evidence check (deferred, not applied): ${blocked} (${proposed ? Math.round((100 * blocked) / proposed) : 0}%)`,
    `- Questions with at least one blocked change: ${rows.filter((row) => (row.build.C?.blocked ?? 0) > 0).length}`, '');
  const measured = rows.map((row) => row.build.C).filter((run) => Number.isInteger(run?.uniqueReviewed) && Number.isInteger(run?.sourceSessions));
  if (measured.length) {
    const total = (key) => measured.reduce((sum, run) => sum + run[key], 0);
    lines.push(`- Unique source sessions fully reviewed: ${total('uniqueReviewed')}/${total('sourceSessions')} across ${measured.length} questions with coverage records.`, '');
  }
  lines.push('## Questions', '', '| id | group | A | B | C | B notes | C notes | blocked |', '|---|---|:-:|:-:|:-:|---:|---:|---:|');
  for (const row of rows) {
    const mark = (c) => (right(row, c) ? '✓' : '✗');
    lines.push(`| ${row.q.question_id} | ${row.group} | ${mark('A')} | ${mark('B')} | ${mark('C')} | ${row.build.B?.notes?.length ?? '-'} | ${row.build.C?.notes?.length ?? '-'} | ${row.build.C?.blocked ?? '-'} |`);
  }
  for (const row of flip('B', 'C', true, false)) {
    lines.push('', `### ${row.q.question_id} (B right, C wrong)`, '', `Question: ${row.q.question}`, '', `Reference: ${row.q.answer}`, '',
      `B: ${row.answers.B?.hypothesis}`, '', `C: ${row.answers.C?.hypothesis}`);
  }
  fs.writeFileSync(path.join(RUN, 'report.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

const dataset = loadDataset(DATA);
ensure(RUN);
if (phase === 'build') await build(dataset);
else if (phase === 'answer') await answer(dataset);
else if (phase === 'grade') await grade(dataset);
else if (phase === 'report') report(dataset);
else {
  console.log('usage: run-lme.mjs build|answer|grade|report [--only id,id] [--concurrency N] [--force]');
  process.exitCode = 2;
}
