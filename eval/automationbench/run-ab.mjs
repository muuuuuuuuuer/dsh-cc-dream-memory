#!/usr/bin/env node
/**
 * AutomationBench through headless DSH: no plugin / plugin.
 *
 * Every task runs in its own fresh headless DSH session. The task's tools are
 * AutomationBench's own `api` toolset, served by ab_bench.py over stdio MCP;
 * every other model-side tool is off. Grading is the benchmark's own rubric
 * over the world state the agent leaves behind.
 *
 *   A  plugin disabled
 *   B  plugin enabled with its normal defaults; one memory root shared by
 *      every task, run in sample order, so whatever it learns carries forward
 *
 * Usage: node run-ab.mjs run [--lines A,B] [--only name,...] [--force]
 *        node run-ab.mjs report
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshPaths } from '../dsh-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMP = path.join(process.env.LOCALAPPDATA ?? '', 'Temp');
const AB_REPO = process.env.AB_REPO || path.join(TEMP, 'ab-bench');
const PYTHON = path.join(AB_REPO, '.venv', 'Scripts', 'python.exe');
const SAMPLE = process.env.AB_SAMPLE || path.join(TEMP, 'ab-bench-sample10.json');
const RUN = path.resolve(process.env.AB_RUN || path.join(TEMP, 'ab-runs', 'run-1'));
const TASKS = path.join(path.dirname(RUN), 'tasks');
const PROFILE = process.env.AB_PROFILE || 'cc-memory-lme';
const PROJECT_ID = 'eval-project';
const TIMEOUT_MS = 20 * 60_000;
// Only the benchmark's tools: every built-in model-side tool is off in every line.
const TOOL_LOCK = ['tool-plugin-manager', 'tool-working-directory', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'tool-skill', 'tool-agent-team', 'tool-subagent-control', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-goal', 'tool-web', 'tool-todo'];

const [phase] = process.argv.slice(2);
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });
const write = (file, value) => { ensure(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const yaml = (value) => JSON.stringify(value);

function listNotes(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

function python(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [path.join(HERE, 'ab_bench.py'), ...args], { cwd: HERE, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => {
      const line = out.trim().split('\n').at(-1) ?? '';
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`ab_bench ${args[0]} exited ${code}: ${err.slice(-800)}`)); }
    });
  });
}

function patchFor(line, task, dir) {
  const lines = TOOL_LOCK.map((id) => `- id: ${id}\n  disabled: true`);
  if (line === 'A') lines.push('- id: cc-dream-memory\n  disabled: true');
  else {
    lines.push('- id: cc-dream-memory', '  config:');
    const memoryRoot = path.join(RUN, line, 'memory-root').replaceAll('\\', '/');
    for (const [key, value] of Object.entries({ memoryRoot, projectId: PROJECT_ID, enabled: true, autoMemoryEnabled: true, tools: true,
      autoExtract: true, autoExtractEveryTurns: 1, autoDreamEnabled: false })) lines.push(`    ${key}: ${yaml(value)}`);
  }
  lines.push('- insert:', '    - id: ab-mcp', "      name: '@deepseek-ai/dsh-mcp-client'", '      config:',
    '        serverName: ab', '        transport: stdio',
    `        command: ${yaml(PYTHON.replaceAll('\\', '/'))}`,
    `        args: ${yaml([path.join(HERE, 'ab_bench.py'), 'serve', path.join(TASKS, task + '.json'), path.join(dir, 'world.json')].map((p) => p.replaceAll('\\', '/')))}`,
    `        cwd: ${yaml(HERE.replaceAll('\\', '/'))}`,
    '        failOnStartupError: true', '        startupTimeoutMs: 120000', '        toolCallTimeoutMs: 120000');
  const file = path.join(dir, 'patch.yml');
  ensure(dir);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function headless({ cwd, patch, prompt }) {
  const { DSH_EXE, DSH_CLI } = resolveDshPaths();
  return new Promise((resolve) => {
    const child = spawn(DSH_EXE, ['--expose-internals', DSH_CLI, '--profile', PROFILE, '--patch', patch, '--json', prompt], {
      cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const events = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).flatMap((l) => {
        try { return [JSON.parse(l)]; } catch { return []; }
      });
      const final = events.find((event) => event.type === 'final');
      resolve({ ok: code === 0 && Boolean(final), code, final, events, stderr: stderr.slice(-3000) });
    });
  });
}

/** The benchmark's system prompt leads the user message, since DSH keeps its own system prompt. */
function promptOf(task) {
  const system = task.prompt.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const user = task.prompt.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
  return system ? `${system}\n\n${user}` : user;
}

async function run() {
  const names = read(SAMPLE, []);
  const only = option('--only', '');
  const lines = option('--lines', 'A,B').split(',');
  const wanted = names.filter((name) => !only || only.split(',').includes(name));
  // Lines run side by side; tasks within a line run in sample order, so B's memory carries forward.
  await Promise.all(lines.map(async (line) => {
    for (const name of wanted) {
      const dir = path.join(RUN, line, 'tasks', name);
      const resultFile = path.join(dir, 'result.json');
      if (read(resultFile, null)?.grade && !process.argv.includes('--force')) continue;
      fs.rmSync(path.join(dir, 'world.json'), { force: true });
      const workspace = path.join(dir, 'workspace');
      ensure(workspace);
      const task = read(path.join(TASKS, name + '.json'), null);
      const notesBefore = line === 'A' ? [] : listNotes(path.join(RUN, line, 'memory-root'));
      log(line, name, 'start', line === 'A' ? '' : `${notesBefore.length} notes`);
      const started = Date.now();
      const result = await headless({ cwd: workspace, patch: patchFor(line, name, dir), prompt: promptOf(task) });
      const ms = Date.now() - started;
      fs.writeFileSync(path.join(dir, 'events.jsonl'), result.events.map((e) => JSON.stringify(e)).join('\n'));
      const grade = await python(['grade', path.join(TASKS, name + '.json'), path.join(dir, 'world.json')]);
      const tools = result.events.filter((e) => e.type === 'tool_call').map((e) => e.tool);
      const record = {
        line, task: name, ok: result.ok, code: result.code, ms, grade,
        toolCalls: tools.length, abCalls: tools.filter((t) => String(t).startsWith('mcp__ab__')).length,
        memoryCalls: tools.filter((t) => /memory/u.test(String(t))).length,
        usage: result.final?.usage ?? null, text: result.final?.text ?? '',
        notesBefore: notesBefore.length, notesAfter: line === 'A' ? 0 : listNotes(path.join(RUN, line, 'memory-root')).length,
        ...(result.ok ? {} : { stderr: result.stderr }),
      };
      write(resultFile, record);
      log(line, name, result.ok ? 'done' : 'FAILED', grade.passed ? 'PASS' : 'fail', `credit ${grade.partial_credit.toFixed(2)}`,
        `${record.abCalls} calls`, `${Math.round(ms / 1000)}s`);
    }
  }));
}

function report() {
  const names = read(SAMPLE, []);
  const lines = ['A', 'B'].filter((line) => fs.existsSync(path.join(RUN, line)));
  const rows = names.map((name) => Object.fromEntries(lines.map((line) => [line, read(path.join(RUN, line, 'tasks', name, 'result.json'), null)])));
  const pct = (n, d) => `${n}/${d} (${d ? Math.round((n / d) * 100) : 0}%)`;
  const out = ['# AutomationBench (public set): no plugin / plugin', '',
    `Sample: ${names.length} tasks, the first by sha256("automationbench-public:cc-memory-0.25.0:" + task), at most 2 per domain. Grading: the benchmark's own rubric.`, '',
    '| line | passed | mean partial credit | mean API calls | mean time |', '|---|---:|---:|---:|---:|'];
  for (const line of lines) {
    const done = rows.map((r) => r[line]).filter((r) => r?.grade);
    const mean = (f) => done.length ? done.reduce((s, r) => s + f(r), 0) / done.length : 0;
    out.push(`| ${line === 'A' ? 'A no plugin' : 'B plugin'} | ${pct(done.filter((r) => r.grade.passed).length, done.length)} | ${mean((r) => r.grade.partial_credit).toFixed(2)} | ${mean((r) => r.abCalls).toFixed(1)} | ${Math.round(mean((r) => r.ms) / 1000)}s |`);
  }
  out.push('', '| task | ' + lines.map((l) => `${l} pass | ${l} credit | ${l} calls`).join(' | ') + ' | B notes before→after |',
    '|---|' + lines.map(() => ':-:|---:|---:').join('|') + '|---|');
  for (const [i, name] of names.entries()) {
    const r = rows[i];
    out.push(`| ${name} | ` + lines.map((l) => r[l]?.grade ? `${r[l].grade.passed ? '✓' : '✗'} | ${r[l].grade.partial_credit.toFixed(2)} | ${r[l].abCalls}` : '– | – | –').join(' | ')
      + ` | ${r.B ? `${r.B.notesBefore}→${r.B.notesAfter}` : '–'} |`);
  }
  const failed = rows.flatMap((r) => lines.map((l) => r[l]).filter((x) => x && !x.ok));
  if (failed.length) out.push('', `Runs that did not finish cleanly: ${failed.map((x) => `${x.line}/${x.task} (exit ${x.code})`).join(', ')}`);
  fs.writeFileSync(path.join(RUN, 'report.md'), out.join('\n') + '\n');
  console.log(out.join('\n'));
}

if (phase === 'run') await run();
else if (phase === 'report') report();
else console.error('usage: node run-ab.mjs run|report');
