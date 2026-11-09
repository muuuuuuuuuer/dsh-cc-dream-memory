#!/usr/bin/env node
/**
 * Paired A/B/C evaluation runner for dsh-cc-dream-memory.
 *
 * Runs the six development scenarios with the real model through the `dsh`
 * headless profile, in three paired conditions:
 *   A  no memory (no injection, no memory tools)
 *   B  memory saved + recalled (dream off)
 *   C  B's frozen memory checkpoint copied, then one Dream pass
 *
 * Hardware requirements: a `cc-memory-eval` profile with this plugin linked,
 * and DEEPSEEK_API_KEY in the environment. The runner is intentionally
 * conservative: every model call is a separate headless process, every
 * condition has its own memoryRoot, and test tasks never enter history/dream
 * sessions.
 *
 * Usage:
 *   node eval/run.mjs --only dev-01 --runs 1        # pilot one scenario
 *   node eval/run.mjs --runs 1                      # all six
 *   node eval/run.mjs --runs 1 --no-judge           # deterministic grading only
 *   node eval/run.mjs --plan                       # print the plan, no calls
 *   node eval/run.mjs --fake-model                 # run all orchestration, no model
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HARNESS_CONTRACT,
  assessToolDiscovery,
  classifyTestOutcome,
  clearTopicFiles,
  comparisonEligible,
  conditionConfig,
  dreamPurityError,
  hashFile,
  summarizeValidity,
  validateFrozenManifest,
} from './harness-lib.mjs';
import { resolveDshPaths } from './dsh-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SCENARIO_FILE = path.join(ROOT, 'eval', 'scenarios.dev.json');
const SCENARIO_FILE = path.resolve(arg('--scenario-file', DEFAULT_SCENARIO_FILE));
const RUNS_DIR = process.env.EVAL_RUNS_DIR || path.join(ROOT, 'eval', 'runs');
const { DSH_EXE, DSH_CLI } = resolveDshPaths();
const PROFILE = 'cc-memory-eval';
const PLUGIN_ROOT = ROOT;
const CALL_TIMEOUT_MS = Number(process.env.EVAL_CALL_TIMEOUT_MS || 240000);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const OPTIONS = {
  plan: process.argv.includes('--plan'),
  only: arg('--only', ''),
  runs: Math.max(1, Number(arg('--runs', '1')) || 1),
  noJudge: process.argv.includes('--no-judge'),
  keepRuns: process.argv.includes('--keep'),
  fakeModel: process.argv.includes('--fake-model'),
};

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stripBom(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(from, to) {
  ensureDir(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function discoverToolLockIds() {
  const result = spawnSync(DSH_EXE, ['--expose-internals', DSH_CLI, '--profile', PROFILE, '--dump-config'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  const ids = new Set();
  for (const line of String(result.stdout ?? '').split('\n')) {
    const match = line.match(/^- id: (tool-[A-Za-z0-9-]+)$/);
    if (!match) continue;
    // Executors and the result pruner are infrastructure, not model-facing
    // tools: disabling them breaks the agent runtime instead of restricting it.
    if (/^tool-executor-/.test(match[1]) || match[1] === 'tool-result-pruner') continue;
    ids.add(match[1]);
  }
  return { ids: [...ids].sort(), status: result.status, stderr: result.stderr, stdout: result.stdout };
}

let TOOL_LOCK_IDS = [];

// A: no memory/tools. B0: identical tools + empty memory (control for tool
// availability). B: memory from history. C: memory + Dream.
const CONDITIONS = ['A', 'B0', 'B', 'C'];

function writePatch(file, config, toolLockIds = TOOL_LOCK_IDS) {
  const lines = [];
  for (const id of toolLockIds) lines.push(`- id: ${id}\n  disabled: true`);
  lines.push('- id: cc-dream-memory', '  config:');
  for (const [key, value] of Object.entries(config)) {
    lines.push(`    ${key}: ${JSON.stringify(value)}`);
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function conditionPatchPath(runRoot, scenario, condition, phase, memoryRoot, openTools = false) {
  const dir = path.join(runRoot, scenario, condition, 'patches');
  ensureDir(dir);
  const file = path.join(dir, `${phase}.yml`);
  const extra = phase === 'dream' ? { evalMode: true } : {};
  // Ordinary coding scenarios run with the real tool surface; memory scenarios
  // keep the tool lock so only memory tools are selectable.
  writePatch(file, conditionConfig(condition, memoryRoot, extra), openTools ? [] : TOOL_LOCK_IDS);
  return file;
}

/** Stands in for the model under --fake-model, so the runner itself can be tested. */
function fakeHeadless({ prompt, sessionId }) {
  const isJudge = prompt.startsWith('You are an independent evaluator');
  const isDream = prompt.includes('memory_eval_dream');
  const events = isDream
    ? [{ type: 'tool_result', result: JSON.stringify({ ok: true, sessionsReviewed: /"sessions":\s*true/.test(prompt) ? 1 : 0 }) }]
    : [];
  const finalText = isJudge
    ? JSON.stringify({ taskCompleted: true, formatViolation: false, providedForbiddenContent: [], fabricatedHistory: false, boundaryFailure: false, clarification: false, evidence: [] })
    : 'fake answer';
  return { ok: true, code: 0, events, finalText, sessionId: sessionId || 'fake-session', stdout: '', stderr: '', toolCalls: [], toolResults: [], usage: sumUsage(events) };
}

/** Every memory the agent could read, so a judge can tell recall from fabrication. */
function readMemoryText(memoryRoot) {
  const projects = path.join(memoryRoot, 'projects');
  if (!fs.existsSync(projects)) return '';
  const parts = [];
  for (const project of fs.readdirSync(projects)) {
    const dir = path.join(projects, project, 'memory');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.md') && name !== 'MEMORY.md') parts.push(`## ${name}\n${fs.readFileSync(path.join(dir, name), 'utf8')}`);
    }
  }
  return parts.join('\n\n').slice(0, 6000);
}

/** One headless run; returns parsed events + final text + session id. */
async function runHeadless({ cwd, patch, prompt, sessionId, timeoutMs = CALL_TIMEOUT_MS, env = process.env }) {
  if (OPTIONS.fakeModel) return fakeHeadless({ prompt, sessionId });
  const args = ['--profile', PROFILE, '--patch', patch, 'headless', '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  args.push(prompt);
  return await new Promise((resolve) => {
    const child = spawn(DSH_EXE, ['--expose-internals', DSH_CLI, ...args], {
      cwd,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ ok: false, error: 'timeout', stdout, stderr, events: parseEvents(stdout), finalText: '' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String(error?.message ?? error), stdout, stderr, events: parseEvents(stdout), finalText: '' });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const events = parseEvents(stdout);
      const final = events.find((event) => event.type === 'final');
      const session = events.find((event) => event.type === 'session');
      resolve({
        ok: code === 0 && final !== undefined,
        code,
        events,
        finalText: final?.text ?? '',
        sessionId: session?.sessionId ?? sessionId ?? '',
        stdout,
        stderr,
        toolCalls: events.filter((event) => event.type === 'tool_call').map((event) => ({ tool: event.tool, input: event.input })),
        toolResults: events.filter((event) => event.type === 'tool_result').map((event) => ({ tool: event.result })),
        usage: sumUsage(events),
      });
    });
  });
}

function parseEvents(stdout) {
  const events = [];
  for (const line of String(stdout).split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try { events.push(JSON.parse(text)); } catch { /* ignore non-JSON */ }
  }
  return events;
}

function sumUsage(events) {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const event of events) {
    for (const key of Object.keys(usage)) usage[key] += Number(event?.usage?.[key] ?? 0);
  }
  return usage;
}

function extractJson(text) {
  const source = String(text ?? '');
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : source;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

function checkDeterministic(answer, checks) {
  const results = [];
  for (const check of checks ?? []) {
    const value = answer ?? '';
    let ok = false;
    switch (check.kind) {
      case 'includes': ok = value.includes(check.value); break;
      case 'notIncludes': ok = !value.includes(check.value); break;
      case 'regex': ok = new RegExp(check.value, 'm').test(value); break;
      case 'notMatches': ok = !new RegExp(check.value, 'm').test(value); break;
      case 'maxLines': ok = value.split('\n').length <= Number(check.value); break;
      default: ok = false;
    }
    results.push({ label: check.label, ok });
  }
  return { ok: results.every((item) => item.ok), results };
}

async function judgeAnswer({ runRoot, scenario, answer, rubric, variant, memoryText = '' }) {
  const dir = path.join(runRoot, '_judge');
  ensureDir(dir);
  const patch = path.join(dir, 'patch.yml');
  writePatch(patch, { memoryRoot: path.join(dir, 'memory-root').replaceAll('\\', '/'), enabled: false, tools: false, injectIndex: false });
  const prompt = [
    'You are an independent evaluator. Answer ONLY with a JSON object, no markdown.',
    'Assess the response against the rubric. Do not reward confidence; reward factuality and instruction-following.',
    'Return keys: taskCompleted (boolean), formatViolation (boolean), providedForbiddenContent (string[]), fabricatedHistory (boolean), boundaryFailure (boolean), clarification (boolean), evidence (string[]).',
    "Judge the response against the rubric and known facts. Distinguish MENTIONING or NEGATING forbidden words (for example \"I did not add rollback steps\") from actually providing those actions/content: only the latter is a boundary/content violation. Set formatViolation only when FORMAT REQUIREMENTS below is non-empty and the response breaks one of them; it is recorded separately and is not a content/boundary violation.",
    '',
    `TASK: ${variant ? variant.task : scenario.test.task}`,
    `TASK MATERIALS: ${scenario.test.materials ?? '(none)'}`,
    `KNOWN USER HISTORY (facts the agent legitimately had): ${JSON.stringify(scenario.history.flatMap((session) => session.messages))}`,
    `MEMORY FILES THE AGENT COULD READ (a statement backed by these is recall, not fabrication): ${memoryText || '(none)'}`,
    `RUBRIC REQUIRED FACTS: ${JSON.stringify(rubric.requiredFacts ?? [])}`,
    `RUBRIC FORBIDDEN FACTS: ${JSON.stringify(rubric.forbiddenFacts ?? [])}`,
    `SEMANTIC CRITERIA: ${JSON.stringify(rubric.semantic ?? [])}`,
    `BOUNDARY FAILURES: ${JSON.stringify(rubric.boundaryFailures ?? [])}`,
    `FORMAT REQUIREMENTS: ${JSON.stringify(rubric.formatRequirements ?? [])}`,
    '',
    'RESPONSE TO GRADE:',
    '"""',
    String(answer).slice(0, 8000),
    '"""',
  ].join('\n');
  const result = await runHeadless({ cwd: dir, patch, prompt, timeoutMs: CALL_TIMEOUT_MS });
  const parsed = extractJson(result.finalText);
  return parsed ?? { taskCompleted: false, parseError: true, raw: result.finalText };
}

async function runScenario({ scenario, runRoot, runIndex }) {
  const out = { scenario: scenario.id, runs: [] };
  for (let repeat = 0; repeat < OPTIONS.runs; repeat += 1) {
    const repeatDir = path.join(runRoot, scenario.id, `repeat-${repeat + 1}`);
    ensureDir(repeatDir);
    // Open-tool scenarios must not run inside this repository: the rubric and
    // plugin checkout would be visible to the agent. Use a temp git workspace.
    const workspaceRoot = scenario.openTools === true
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'cc-memory-eval-'))
      : repeatDir;
    const baseline = path.join(repeatDir, 'baseline-workspace');
    ensureDir(baseline);
    for (const [name, content] of Object.entries(scenario.setup ?? {})) {
      const relative = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`;
      const file = path.join(baseline, relative);
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, stripBom(content), 'utf8');
    }
    const record = {
      scenario: scenario.id,
      repeat: repeat + 1,
      conditions: {},
      variants: {},
      errors: [],
      order: [],
      startedAt: new Date().toISOString(),
    };
    const conditionDirs = {};
    const workspaces = {};
    for (const condition of CONDITIONS) {
      conditionDirs[condition] = path.join(repeatDir, condition);
      workspaces[condition] = path.join(workspaceRoot, condition, 'workspace');
      ensureDir(workspaces[condition]);
      ensureDir(path.join(conditionDirs[condition], 'memory-root'));
      for (const entry of fs.readdirSync(baseline)) {
        const from = path.join(baseline, entry);
        const to = path.join(workspaces[condition], entry);
        if (fs.statSync(from).isDirectory()) copyDir(from, to); else fs.copyFileSync(from, to);
      }
      if (scenario.openTools === true) initGitWorkspace(workspaces[condition]);
    }
    // History: only B needs it. A has no memory, so replaying the same user
    // history there would only burn calls without changing its test context.
    for (const condition of ['B']) {
      const patch = conditionPatchPath(runRoot, scenario.id, condition, 'run', path.join(conditionDirs[condition], 'memory-root'), scenario.openTools === true);
      const context = conditionDirs[condition];
      const sessions = [];
      for (const historySession of scenario.history) {
        let sessionId = '';
        const turns = [];
        for (const message of historySession.messages) {
          const result = await runHeadless({ cwd: workspaces[condition], patch, prompt: message, sessionId });
          if (!result.ok) record.errors.push({ stage: `history:${condition}:${historySession.id}`, error: result.error ?? result.code });
          sessionId = result.sessionId || sessionId;
          turns.push({ prompt: message, finalText: result.finalText, usage: result.usage, tools: result.toolCalls.map((call) => call.tool) });
        }
        sessions.push({ id: historySession.id, sessionId, turns });
      }
      record.conditions[condition] = { history: sessions, memoryFiles: [] };
    }
    record.conditions.A = { history: [], memoryFiles: [], note: 'A has no memory; history would not survive into the test session' };
    record.conditions.B0 = { history: [], memoryFiles: [], note: 'B0 has the same memory tools/injection as B but an empty memory (tool-availability control)' };
    // Two immutable checkpoints: before-Dream (B tests) and after-Dream (C
    // tests). C's Dream result must never be overwritten by a B restore.
    const preCheckpoint = path.join(repeatDir, 'checkpoint-before-dream');
    rmDir(preCheckpoint);
    ensureDir(preCheckpoint);
    copyDir(path.join(conditionDirs.B, 'memory-root'), path.join(preCheckpoint, 'memory-root'));
    rmDir(path.join(conditionDirs.C, 'memory-root'));
    ensureDir(path.join(conditionDirs.C, 'memory-root'));
    copyDir(path.join(preCheckpoint, 'memory-root'), path.join(conditionDirs.C, 'memory-root'));
    // A transcript scenario starts from no memory: otherwise what the history
    // session saved would answer the test and prove nothing about Dream.
    if (scenario.dreamSessions === true) clearTopicFiles(path.join(conditionDirs.C, 'memory-root'));
    record.checkpoint = {
      hash: hashDirectory(path.join(preCheckpoint, 'memory-root')),
      memoryFiles: listFiles(path.join(preCheckpoint, 'memory-root')),
      kind: 'before-dream',
    };
    // C: one real Dream pass on the frozen checkpoint.
    const dreamPatch = conditionPatchPath(runRoot, scenario.id, 'C', 'dream', path.join(conditionDirs.C, 'memory-root'));
    const dreamInstruction = scenario.dreamSessions === true
      ? 'Call the memory_eval_dream tool exactly once with {"dryRun": false, "sessions": true}. Then reply with the tool result summary.'
      : 'Call the memory_eval_dream tool exactly once with dryRun:false. Then reply with the tool result summary.';
    const dream = await runHeadless({
      cwd: workspaces.C,
      patch: dreamPatch,
      prompt: dreamInstruction,
      timeoutMs: Math.max(CALL_TIMEOUT_MS, 600000),
    });
    const dreamToolResult = dream.events
      .filter((event) => event.type === 'tool_result')
      .map((event) => { try { return typeof event.result === 'string' ? JSON.parse(event.result) : event.result; } catch { return null; } })
      .find((value) => value && value.sessionsReviewed !== undefined && value.ok === true) ?? null;
    record.conditions.C = { ...(record.conditions.C ?? {}), history: [], dream: { ok: dream.ok, finalText: dream.finalText, tools: dream.toolCalls.map((call) => call.tool), usage: dream.usage, toolResult: dreamToolResult, sessionsReviewed: dreamToolResult?.sessionsReviewed ?? null, memoryEmptied: scenario.dreamSessions === true } };
    if (!dream.ok) record.errors.push({ stage: 'dream', error: dream.error ?? dream.code });
    const purityError = dreamPurityError(dreamToolResult, scenario);
    if (purityError) record.errors.push({ stage: 'dream-purity', error: purityError });
    const postCheckpoint = path.join(repeatDir, 'checkpoint-after-dream');
    rmDir(postCheckpoint);
    ensureDir(postCheckpoint);
    copyDir(path.join(conditionDirs.C, 'memory-root'), path.join(postCheckpoint, 'memory-root'));
    record.postCheckpoint = {
      hash: hashDirectory(path.join(postCheckpoint, 'memory-root')),
      memoryFiles: listFiles(path.join(postCheckpoint, 'memory-root')),
      kind: 'after-dream',
      sessionsReviewed: dreamToolResult?.sessionsReviewed ?? null,
      expectedSessionsReviewed: scenario.dreamSessions === true ? '>0' : 0,
    };
    record.conditions.C.memoryFilesAfterDream = listFiles(path.join(conditionDirs.C, 'memory-root'));
    // Test sessions: one fresh session per condition/variant; restore snapshot first.
    const testDefinitions = [{ id: 'default', task: scenario.test.task, rubric: scenario.test.rubric }];
    for (const variant of scenario.test.variants ?? []) {
      const rubric = { ...scenario.test.rubric, ...(variant.rubricOverride ?? {}) };
      testDefinitions.push({ id: variant.id, task: variant.task, rubric });
    }
    for (const testDef of testDefinitions) {
      const order = CONDITIONS.slice();
      // Shuffle condition order per test to spread service drift.
      for (let index = order.length - 1; index > 0; index -= 1) {
        const swap = randomInt(0, index + 1);
        [order[index], order[swap]] = [order[swap], order[index]];
      }
      record.order.push({ test: testDef.id, conditions: order });
      for (const condition of order) {
        const context = conditionDirs[condition];
        // Restore workspace + memory snapshot before each test.
        resetWorkspace(baseline, workspaces[condition]);
        if (scenario.openTools === true) initGitWorkspace(workspaces[condition]);
        const expectedSnapshot = condition === 'B' ? preCheckpoint : condition === 'C' ? postCheckpoint : null;
        rmDir(path.join(context, 'memory-root'));
        ensureDir(path.join(context, 'memory-root'));
        if (expectedSnapshot) copyDir(path.join(expectedSnapshot, 'memory-root'), path.join(context, 'memory-root'));
        const restoredHash = expectedSnapshot ? hashDirectory(path.join(context, 'memory-root')) : hashDirectory(path.join(context, 'memory-root'));
        const restoredHashOk = expectedSnapshot ? restoredHash === (condition === 'B' ? record.checkpoint.hash : record.postCheckpoint.hash) : true;
        if (!restoredHashOk) record.errors.push({ stage: `restore:${condition}:${testDef.id}`, error: 'snapshot hash mismatch' });
        const patch = conditionPatchPath(
          runRoot,
          scenario.id,
          condition,
          'test',
          path.join(conditionDirs[condition], 'memory-root'),
          scenario.openTools === true,
        );
        const prompt = testDef.task + (scenario.test.materials ? `\n\n材料：${scenario.test.materials}` : '');
        const workspaceBefore = snapshotWorkspace(workspaces[condition]);
        const testHashesBefore = scenario.openTools === true ? testFileHashes(scenario, workspaces[condition]) : null;
        const result = await runHeadless({ cwd: workspaces[condition], patch, prompt, timeoutMs: CALL_TIMEOUT_MS });
        if (!result.ok) record.errors.push({ stage: `test:${condition}:${testDef.id}`, error: result.error ?? result.code });
        const artifactText = changedWorkspaceText(workspaceBefore, workspaces[condition]);
        const gradedText = [result.finalText, artifactText].filter(Boolean).join('\n\n');
        const deterministic = checkDeterministic(gradedText, testDef.rubric.deterministic);
        const objective = runObjectiveCheck(scenario, workspaces[condition], testHashesBefore ?? {});
        const judged = OPTIONS.noJudge || !result.ok ? null : await judgeAnswer({
          runRoot,
          scenario,
          answer: gradedText,
          rubric: testDef.rubric,
          variant: testDef,
          memoryText: readMemoryText(path.join(conditionDirs[condition], 'memory-root')),
        });
        const judgeMissing = !OPTIONS.noJudge && (judged === null || judged.parseError === true);
        const dreamValid = condition !== 'C' || (record.conditions.C?.dream?.toolResult != null && purityError === null);
        if (objective && !objective.ok) {
          record.errors.push({ stage: `objective:${condition}:${testDef.id}`, error: `objective check failed (exit ${objective.exitCode}, testHashUnchanged=${objective.testHashUnchanged})` });
        }
        const classification = classifyTestOutcome({
          snapshotValid: restoredHashOk,
          dreamValid,
          modelOk: result.ok,
          judgeMissing,
          deterministicOk: deterministic.ok,
          judged,
          formatRequired: Array.isArray(testDef.rubric.formatRequirements) && testDef.rubric.formatRequirements.length > 0,
        });
        const success = classification.success && (objective === null || objective.ok);
        const entry = {
          finalText: result.finalText,
          artifactText,
          usage: result.usage,
          toolCalls: result.toolCalls,
          deterministic,
          judged,
          ...(objective ? { objective } : {}),
          success,
          validity: classification.validity,
          comparisonEligible: classification.comparisonEligible,
          failureKind: classification.failureKind,
          classificationReasons: classification.reasons,
          orderIndex: order.indexOf(condition),
          memoryFiles: listFiles(path.join(context, 'memory-root')),
          restoredHash,
          restoredHashOk,
        };
        record.variants[testDef.id] = record.variants[testDef.id] ?? {};
        record.variants[testDef.id][condition] = entry;
      }
    }
    record.finishedAt = new Date().toISOString();
    out.runs.push(record);
    fs.writeFileSync(path.join(repeatDir, 'record.json'), JSON.stringify(record, null, 2), 'utf8');
  }
  return out;
}

function snapshotWorkspace(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  (function walk(current, rel) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(current, entry.name), next);
      else if (/\.(md|txt|js|mjs|cjs|json)$/i.test(entry.name)) out.set(next, sha(fs.readFileSync(path.join(current, entry.name))));
    }
  })(dir, '');
  return out;
}

function changedWorkspaceText(before, dir) {
  const after = snapshotWorkspace(dir);
  const parts = [];
  for (const [rel, hash] of after) {
    if (before.get(rel) === hash) continue;
    parts.push(`--- ${rel} ---\n${fs.readFileSync(path.join(dir, rel), 'utf8')}`);
  }
  return parts.join('\n');
}

function initGitWorkspace(dir) {
  if (!fs.existsSync(dir)) ensureDir(dir);
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  run(['init', '-q']);
  run(['config', 'user.email', 'eval@example.invalid']);
  run(['config', 'user.name', 'cc-memory eval']);
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'baseline']);
}

/** Run the scenario's objective check and verify test files were not edited. */
function testFileHashes(scenario, workspace) {
  const testFiles = Array.isArray(scenario.verify?.testFiles) ? scenario.verify.testFiles : [];
  const hashFile = (rel) => {
    try { return createHash('sha256').update(fs.readFileSync(path.join(workspace, rel))).digest('hex'); }
    catch { return ''; }
  };
  return Object.fromEntries(testFiles.map((rel) => [rel, hashFile(rel)]));
}

function runObjectiveCheck(scenario, workspace, before = {}) {
  const verify = scenario.verify;
  if (!verify || typeof verify !== 'object') return null;
  const testFiles = Array.isArray(verify.testFiles) ? verify.testFiles : [];
  const hashFile = (rel) => {
    try { return createHash('sha256').update(fs.readFileSync(path.join(workspace, rel))).digest('hex'); }
    catch { return ''; }
  };
  const args = Array.isArray(verify.args) && verify.args.length > 0 ? verify.args : ['--test'];
  const command = `${path.basename(process.execPath)} ${args.join(' ')}`;
  // A parent test runner's marker would make a nested `node --test` exit 0 regardless.
  const result = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const after = Object.fromEntries(testFiles.map((rel) => [rel, hashFile(rel)]));
  const testHashUnchanged = testFiles.every((rel) => before[rel] !== '' && before[rel] === after[rel]);
  const sourceChecks = (Array.isArray(verify.sourceIncludes) ? verify.sourceIncludes : []).map((check) => {
    let text = '';
    try { text = fs.readFileSync(path.join(workspace, check.file), 'utf8'); } catch { /* missing */ }
    return { file: check.file, pattern: check.pattern, ok: new RegExp(check.pattern, check.flags ?? 'm').test(text) };
  });
  return {
    command,
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    testFiles,
    testHashUnchanged,
    sourceChecks,
    ok: result.status === 0 && testHashUnchanged && sourceChecks.every((check) => check.ok),
    stdoutTail: String(result.stdout ?? '').slice(-1200),
    stderrTail: String(result.stderr ?? '').slice(-600),
  };
}

function resetWorkspace(baseline, workspace) {
  rmDir(workspace);
  ensureDir(workspace);
  for (const entry of fs.readdirSync(baseline)) {
    const from = path.join(baseline, entry);
    const to = path.join(workspace, entry);
    if (fs.statSync(from).isDirectory()) copyDir(from, to); else fs.copyFileSync(from, to);
  }
}

function hashDirectory(dir) {
  const files = listFiles(dir);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(file.rel);
    hash.update(fs.readFileSync(path.join(dir, file.rel)));
  }
  return hash.digest('hex');
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  (function walk(current, rel) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(current, entry.name), next);
      else out.push({ rel: next, bytes: fs.statSync(path.join(current, entry.name)).size });
    }
  })(dir, '');
  return out;
}

function report(records) {
  const summary = summarizeValidity(records.flatMap((scenario) => scenario.runs));
  const lines = ['# 同场景配对实验：开发试点报告', '', '> A=无记忆无工具；B0=相同工具+空记忆（工具可用性对照）；B=记忆；C=记忆+Dream。', '', `生成时间：${new Date().toISOString()}`, '', `运行有效性：valid ${summary.valid} / device-invalid ${summary.invalid} / grading-missing ${summary.gradingMissing} / task-failed ${summary.taskFailed}`, '', ...(summary.invalidReasons.length ? [`Device-invalid reasons: ${summary.invalidReasons.join('; ')}`, ''] : [])];
  for (const scenario of records) {
    lines.push(`## ${scenario.scenario}`, '');
    for (const run of scenario.runs) {
      lines.push(`### repeat ${run.repeat}`, '');
      for (const testName of Object.keys(run.variants)) {
        const row = run.variants[testName];
        lines.push(`**${testName}**`);
        lines.push('| 组 | 有效性 | 主指标 | 确定性检查 | 任务完成 | 边界失败 | 编造 | tokens |');
        lines.push('|---|---|---|---|---|---|---|---|');
        for (const condition of CONDITIONS) {
          const item = row[condition];
          if (!item) { lines.push(`| ${condition} | - | - | - | - | - | - | - |`); continue; }
          const validity = item.validity === 'invalid' ? 'INVALID' : item.failureKind === 'grading-missing' ? 'GRADE-MISSING' : 'valid';
          lines.push(`| ${condition} | ${validity} | ${item.success ? 'PASS' : 'FAIL'} | ${item.deterministic.ok ? 'PASS' : 'FAIL'} | ${item.judged?.taskCompleted ?? '?'} | ${item.judged?.boundaryFailure ?? '?'} | ${item.judged?.fabricatedHistory ?? '?'} | ${item.usage?.totalTokens ?? 0} |`);
        }
        lines.push('');
        lines.push(`A->B0: ${comparison(row.A, row.B0)} | B0->B: ${comparison(row.B0, row.B)} | B->C: ${comparison(row.B, row.C)}`);
        lines.push('');
        for (const condition of CONDITIONS) {
          if (row[condition] && !row[condition].success) {
            lines.push(`- ${condition} 失败：${failureNote(row[condition])}`);
          }
        }
        lines.push('');
      }
      if (run.errors.length) lines.push(`运行错误：${JSON.stringify(run.errors)}`, '');
    }
  }
  return lines.join('\n');
}

function comparison(left, right) {
  if (!left || !right) return 'missing';
  if (!comparisonEligible(left, right)) return `invalid (${[left, right].filter((item) => item && item.validity === 'invalid').length} invalid, ${[left, right].filter((item) => item && item.failureKind === 'grading-missing').length} grading-missing)`;
  if (right.success && !left.success) return '改善';
  if (!right.success && left.success) return '退化';
  return '持平';
}

function failureNote(item) {
  const issues = [...(item.deterministic.results ?? []).filter((check) => !check.ok).map((check) => `确定性:${check.label}`)];
  if (item.judged) {
    if (item.judged.boundaryFailure) issues.push('边界失败');
    if (item.judged.fabricatedHistory) issues.push('编造历史');
    if (item.judged.taskCompleted !== true) issues.push('任务未完成');
  }
  return [...new Set(issues)].join(', ') || '未分类';
}

async function main() {
  const data = JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8'));
  const selected = OPTIONS.only ? data.scenarios.filter((scenario) => scenario.id === OPTIONS.only) : data.scenarios;
  if (selected.length === 0) { console.error(`unknown scenario ${OPTIONS.only}`); process.exit(1); }

  // The frozen manifest covers EVERY scenario file, not just the default pack;
  // this runs before --plan so a custom --scenario-file cannot skip the gate.
  const manifestFile = path.join(ROOT, 'eval', 'frozen-manifest.json');
  if (!fs.existsSync(manifestFile)) {
    console.error('[eval] frozen manifest missing; run node eval/freeze.mjs first');
    process.exit(1);
  }
  const frozen = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const pluginVersion = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version;
  const rubricHashes = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'eval', 'rubrics')).filter((name) => name.endsWith('.json')).map((name) => [name, hashFile(path.join(ROOT, 'eval', 'rubrics', name))]));
  const scenarioHashes = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'eval')).filter((name) => /^scenarios\..*\.json$/.test(name)).map((name) => [name, hashFile(path.join(ROOT, 'eval', name))]));
  const manifestCheck = validateFrozenManifest(frozen, {
    runnerContract: HARNESS_CONTRACT,
    pluginVersion,
    scenarioHash: hashFile(SCENARIO_FILE),
    scenarioHashes,
    rubricHashes,
  });
  if (!manifestCheck.ok) {
    for (const error of manifestCheck.errors) console.error(`[eval] ${error}`);
    console.error('[eval] refusing to start: rerun node eval/freeze.mjs after intentional asset changes');
    process.exit(1);
  }
  if (OPTIONS.plan) {
    console.log(`scenarios: ${selected.map((scenario) => scenario.id).join(', ')}`);
    console.log(`runs per scenario: ${OPTIONS.runs}`);
    console.log('conditions: A(no memory, no tools) / B0(same tools, empty memory) / B(memory) / C(memory + dream)');
    console.log(`headless profile: ${PROFILE}`);
    console.log(`judge: ${OPTIONS.noJudge ? 'off' : 'on'}`);
    console.log('frozen manifest: ok (all scenario files)');
    return;
  }
  if (!OPTIONS.fakeModel) {
    if (!process.env.DEEPSEEK_API_KEY) {
      console.error('DEEPSEEK_API_KEY is not set in this process environment; export it before running the eval.');
      process.exit(1);
    }
    const discovery = discoverToolLockIds();
    const discoveryCheck = assessToolDiscovery(discovery);
    if (!discoveryCheck.valid) {
      for (const reason of discoveryCheck.reasons) console.error(`[eval] tool discovery: ${reason}`);
      console.error('[eval] refusing to start: cannot establish tool isolation');
      process.exit(1);
    }
    TOOL_LOCK_IDS = discoveryCheck.ids;
  }
  console.log(`[eval] frozen manifest ok: ${frozen.frozenAt} | plugin ${pluginVersion} | contract ${HARNESS_CONTRACT}`);
  console.log(`[eval] tool lock: ${TOOL_LOCK_IDS.length} base tools disabled for every session`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runRoot = path.join(RUNS_DIR, stamp);
  ensureDir(runRoot);
  fs.writeFileSync(path.join(runRoot, 'manifest.json'), JSON.stringify({
    startedAt: new Date().toISOString(),
    pluginVersion: JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version,
    scenarios: selected.map((scenario) => scenario.id),
    runs: OPTIONS.runs,
    judge: !OPTIONS.noJudge,
    profile: PROFILE,
    model: process.env.EVAL_MODEL ?? 'profile default',
  }, null, 2), 'utf8');
  const records = [];
  for (const scenario of selected) {
    console.log(`[eval] ${scenario.id} ...`);
    records.push(await runScenario({ scenario, runRoot, runIndex: records.length }));
    console.log(`[eval] ${scenario.id} done`);
  }
  const text = report(records);
  fs.writeFileSync(path.join(runRoot, 'report.md'), text, 'utf8');
  fs.writeFileSync(path.join(runRoot, 'records.json'), JSON.stringify(records, null, 2), 'utf8');
  console.log(`[eval] report: ${path.join(runRoot, 'report.md')}`);
}

function reportOne(record) {
  return report([record]);
}

await main();
