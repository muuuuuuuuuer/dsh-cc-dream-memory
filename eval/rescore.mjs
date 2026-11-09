#!/usr/bin/env node
/**
 * Re-score the existing "current-instruction-wins" answers under the corrected
 * v2 rubric, without rerunning the agents. Old scores stay in the original
 * records; this writes a separate, anonymous review artifact.
 *
 *   node eval/rescore.mjs [--run eval/runs/<timestamp>]
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshPaths } from './dsh-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { DSH_EXE: EXE, DSH_CLI: CLI } = resolveDshPaths();
const PROFILE = 'cc-memory-eval';

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; }

async function runHeadless({ cwd, patch, prompt, timeoutMs = 240000 }) {
  return await new Promise((resolve) => {
    const child = spawn(EXE, ['--expose-internals', CLI, '--profile', PROFILE, '--patch', patch, 'headless', '--json', prompt], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, text: '', out, err }); }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', () => {
      clearTimeout(timer);
      const events = out.split('\n').filter((line) => line.trim().startsWith('{')).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const final = events.find((event) => event.type === 'final');
      resolve({ ok: final !== undefined, text: final?.text ?? '', out, err });
    });
  });
}

function extractJson(text) {
  const match = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = match ? match[1] : String(text ?? '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch { return null; }
}

function toolLockPatch(dir) {
  const dump = spawnSync(EXE, ['--expose-internals', CLI, '--profile', PROFILE, '--dump-config'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  const ids = [];
  for (const line of String(dump.stdout ?? '').split('\n')) {
    const match = line.match(/^- id: (tool-[A-Za-z0-9-]+)$/);
    if (!match) continue;
    if (/^tool-executor-/.test(match[1]) || match[1] === 'tool-result-pruner') continue;
    ids.push(match[1]);
  }
  fs.mkdirSync(dir, { recursive: true });
  const lines = ids.map((id) => `- id: ${id}\n  disabled: true`);
  lines.push(`- id: cc-dream-memory\n  config:\n    memoryRoot: "${dir.replaceAll('\\', '/')}/memory-root"\n    enabled: false\n    autoMemoryEnabled: false\n    injectIndex: false\n    tools: false\n    evalMode: false`);
  const patch = path.join(dir, 'patch.yml');
  fs.writeFileSync(patch, lines.join('\n') + '\n', 'utf8');
  return patch;
}

async function main() {
  const scenarios = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'scenarios.dev.json'), 'utf8'));
  const scenario = scenarios.scenarios.find((item) => item.id === 'dev-01-stable-preference');
  const variant = scenario.test.variants.find((item) => item.id === 'current-instruction-wins');
  const v2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'rubrics', 'dev-01-current-instruction.v2.json'), 'utf8'));
  let runDir = arg('--run');
  if (!runDir) {
    const runs = fs.readdirSync(path.join(ROOT, 'eval', 'runs')).filter((name) => fs.existsSync(path.join(ROOT, 'eval', 'runs', name, 'records.json'))).sort();
    runDir = path.join(ROOT, 'eval', 'runs', runs.at(-1));
  }
  const records = JSON.parse(fs.readFileSync(path.join(runDir, 'records.json'), 'utf8'));
  const run = records[0].runs[0];
  const row = run.variants['current-instruction-wins'];
  if (!row) throw new Error('this run has no current-instruction-wins answers');
  const labels = ['A', 'B', 'C'];
  const order = ['A', 'B', 'C'].slice();
  for (let i = order.length - 1; i > 0; i -= 1) { const j = randomInt(0, i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const dir = path.join(ROOT, 'eval', 'rescores', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const patch = toolLockPatch(path.join(dir, 'judge'));
  const judgeDir = path.join(dir, 'judge', 'workspace');
  fs.mkdirSync(judgeDir, { recursive: true });
  const results = {};
  for (const label of order) {
    const item = row[label];
    const answer = [item.finalText, item.artifactText].filter(Boolean).join('\n\n');
    const prompt = [
      'You are an independent, anonymous evaluator. Return ONLY JSON with keys:',
      'taskCompleted(boolean), formatViolation(boolean), boundaryFailure(boolean), fabricatedHistory(boolean), providedForbiddenContent(string[]), evidence(string[]).',
      'Do not guess the group; judge only the response against the rubric and known facts.',
      'MENTIONING/NEGATING a forbidden word is not a violation; only actually providing the action/content counts. Headings/lists when a single paragraph is required are formatViolation, not a boundary violation.',
      `TASK: ${variant.task}`,
      `MATERIALS: ${scenario.test.materials}`,
      `KNOWN USER HISTORY: ${JSON.stringify(scenario.history.flatMap((session) => session.messages))}`,
      `RUBRIC REQUIRED: ${JSON.stringify(v2.requiredFacts)}`,
      `RUBRIC FORBIDDEN: ${JSON.stringify(v2.forbiddenFacts)}`,
      `BOUNDARY FAILURES: ${JSON.stringify(v2.boundaryFailures)}`,
      `FORMAT REQUIREMENTS: ${JSON.stringify(v2.formatRequirements ?? [])}`,
      'ANONYMOUS RESPONSE:',
      '"""', answer.slice(0, 8000), '"""',
    ].join('\n');
    const judged = extractJson((await runHeadless({ cwd: judgeDir, patch, prompt })).text) ?? { parseError: true };
    results[label] = { old: item.judged ?? null, oldSuccess: item.success, new: judged };
  }
  const lines = ['# 旧答案对 v2 约束的兼容性检查（匿名重评分）', '', `run: ${runDir}`, `rubric: v2 (frozen)`, `anonymous order: ${order.join(' -> ')}`, '', '| 实际组 | 旧 judge | 旧主指标 | 新 judge | 新主指标 |', '|---|---|---|---|---|'];
  for (const label of ['A', 'B', 'C']) {
    const item = results[label];
    const oldJudge = item.old ? `done=${item.old.taskCompleted} boundary=${item.old.boundaryFailure}` : '?';
    const newJudge = item.new && !item.new.parseError ? `done=${item.new.taskCompleted} boundary=${item.new.boundaryFailure} forbidden=${JSON.stringify(item.new.forbiddenContent ?? [])}` : 'parse-error';
    const newSuccess = item.new && item.new.taskCompleted === true && item.new.boundaryFailure !== true && item.new.fabricatedHistory !== true;
    lines.push(`| ${label} | ${oldJudge} | ${item.oldSuccess} | ${newJudge} | ${newSuccess} |`);
  }
  lines.push('', '说明：旧答案没有见过 v2 新增限制，本表只检查“旧答案与 v2 约束的兼容性”，不能据此断言模型违反了当时收到的指令。旧评分保留在原始 `records.json`。');
  fs.writeFileSync(path.join(dir, 'report.md'), lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'rescore.json'), JSON.stringify({ runDir, order, results }, null, 2), 'utf8');
  console.log('rescored ->', path.join(dir, 'report.md'));
  console.log(lines.join('\n'));
}

await main();
