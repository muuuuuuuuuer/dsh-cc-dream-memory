#!/usr/bin/env node
/**
 * dsh-cc-dream-memory verification harness.
 *
 * Runs three serial stages and prints a PASS/FAIL summary; exits 1 on any
 * failure:
 *   1. structure  — required plugin files exist and locale JSON parses;
 *   2. syntax     — `node --check` every .js/.mjs source file (client bundle
 *                   included; it is never executed);
 *   3. tests      — every `test/*.test.mjs` file through `node --test`, one
 *                   process at a time (serial, so failures are attributable).
 *
 * Usage: node scripts/verify.mjs [--verbose]
 * Run from anywhere; paths are resolved from this script's location.
 */
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const TEST_DIR = path.join(PLUGIN_ROOT, 'test');
const VERBOSE = process.argv.includes('--verbose');

const REQUIRED_FILES = [
  'package.json',
  'index.js',
  'cordis.patch.yml',
  'icon.svg',
  'docs/INTERFACES.md',
  'docs/ARCHITECTURE.md',
  'docs/manual.zh.md',
  'README.md',
  'README.zh.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'UI-FREEZE.md',
  'CHANGELOG.md',
  'LICENSE',
  '.github/workflows/ci.yml',
  'src/config.js',
  'src/paths.js',
  'src/meta.js',
  'src/metrics.js',
  'src/state.js',
  'src/runtime.js',
  'src/scheduler.js',
  'src/frontmatter.js',
  'src/store.js',
  'src/inject.js',
  'src/tools.js',
  'src/dream.js',
  'src/dream-prompt.js',
  'src/dream-input.js',
  'src/dream-session-text.js',
  'src/dream-map.js',
  'src/dream-evidence.js',
  'src/write-review.js',
  'src/recall.js',
  'src/commands.js',
  'src/status.js',
  'src/secrets.js',
  'src/policy.js',
  'src/pending-writes.js',
  'src/identity.js',
  'src/readiness.js',
  'src/lock.js',
  'src/import-export.js',
];

// The Web client bundle is optional while the UI is still being finished: when
// it exists it enters the syntax stage automatically (the walker picks up every
// .js file), when it does not the harness just notes that it is skipped.
const OPTIONAL_FILES = ['client.js'];

const results = [];
let failures = 0;

function record(stage, name, ok, detail = '') {
  results.push({ stage, name, ok, detail });
  if (!ok) failures += 1;
  const label = ok ? 'PASS' : 'FAIL';
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`  ${label}  ${name}${suffix}`);
}

function indent(text, prefix = '        ') {
  return String(text)
    .split(/\r?\n/)
    .map((line) => (line === '' ? '' : prefix + line))
    .join('\n');
}

async function walkJsFiles(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsFiles(abs, out);
    } else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: PLUGIN_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 180_000,
    ...options,
  });
}

async function stageStructure() {
  console.log('[1/3] structure');
  for (const rel of REQUIRED_FILES) {
    try {
      await readFile(path.join(PLUGIN_ROOT, rel));
      // File exists and is readable; individual stage 3 tests cover behavior.
      if (VERBOSE) record('structure', `file ${rel}`, true);
    } catch (error) {
      record('structure', `file ${rel}`, false, `missing or unreadable (${error.code ?? error.message})`);
    }
  }
  for (const rel of OPTIONAL_FILES) {
    try {
      await readFile(path.join(PLUGIN_ROOT, rel));
      // Present: it is syntax-checked by the walker in stage 2.
      record('structure', `optional file ${rel} present (syntax-checked below)`, true);
    } catch {
      console.log(`  SKIP  optional ${rel} not present yet (will be syntax-checked when it lands)`);
    }
  }
  for (const locale of ['locale/en.json', 'locale/zh.json']) {
    try {
      const text = await readFile(path.join(PLUGIN_ROOT, locale), 'utf8');
      JSON.parse(text);
      if (VERBOSE) record('structure', `json ${locale}`, true);
    } catch (error) {
      record('structure', `json ${locale}`, false, `invalid JSON (${error.message})`);
    }
  }
  if (!VERBOSE && failures === 0) record('structure', 'all required files present', true);
}

async function stageSyntax() {
  console.log('[2/3] syntax (node --check)');
  const files = await walkJsFiles(PLUGIN_ROOT);
  files.sort();
  let checked = 0;
  for (const file of files) {
    const rel = path.relative(PLUGIN_ROOT, file).split(path.sep).join('/');
    const run = runNode(['--check', file], { timeout: 60_000 });
    checked += 1;
    if (run.status === 0) {
      if (VERBOSE) record('syntax', `node --check ${rel}`, true);
    } else {
      const output = `${run.stderr || ''}${run.stdout || ''}`.trim();
      record('syntax', `node --check ${rel}`, false, 'syntax error');
      if (output) console.log(indent(output));
    }
  }
  if (!VERBOSE && failures === 0) record('syntax', `${checked} JavaScript files pass node --check`, true);
}

async function discoverTestFiles() {
  let entries;
  try {
    entries = await readdir(TEST_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.test\.mjs$/.test(entry.name))
    .map((entry) => path.join(TEST_DIR, entry.name))
    .sort();
}

function parseTapSummary(output) {
  const summary = { pass: 0, fail: 0 };
  // Node 24 prints the `spec` reporter when stdout is piped; older versions /
  // TAP mode use `# pass N`. Support both.
  const specPass = output.match(/^\s*ℹ pass (\d+)\s*$/m);
  const specFail = output.match(/^\s*ℹ fail (\d+)\s*$/m);
  const tapPass = output.match(/^# pass (\d+)\s*$/m);
  const tapFail = output.match(/^# fail (\d+)\s*$/m);
  if (specPass) summary.pass = Number(specPass[1]);
  else if (tapPass) summary.pass = Number(tapPass[1]);
  if (specFail) summary.fail = Number(specFail[1]);
  else if (tapFail) summary.fail = Number(tapFail[1]);
  return summary;
}

async function stageTests() {
  console.log('[3/3] unit tests (node --test, serial)');
  const testFiles = await discoverTestFiles();
  if (testFiles.length === 0) {
    record('tests', 'test/*.test.mjs discovered', false, 'no test files found');
    return;
  }
  let totalPass = 0;
  let totalFail = 0;
  for (const file of testFiles) {
    const rel = path.relative(PLUGIN_ROOT, file).split(path.sep).join('/');
    const run = runNode(['--test', file]);
    const output = `${run.stdout || ''}\n${run.stderr || ''}`.trim();
    const summary = parseTapSummary(output);
    const ok = run.status === 0 && summary.fail === 0;
    totalPass += summary.pass;
    totalFail += summary.fail + (summary.pass === 0 && summary.fail === 0 && !ok ? 1 : 0);
    record(
      'tests',
      rel,
      ok,
      ok
        ? `${summary.pass} passed`
        : `${summary.pass} passed, ${summary.fail} failed${run.signal ? ` (${run.signal})` : ''}`,
    );
    if (!ok) {
      // Show the failing assertions with their file/line and messages.
      const failureLines = output
        .split(/\r?\n/)
        .filter((line) => /not ok|AssertionError|Error:|expected|actual|code=|at .*\.test\.mjs/.test(line))
        .slice(0, 120);
      console.log(indent(failureLines.length > 0 ? failureLines.join('\n') : output.slice(-4000)));
    }
  }
  record('tests', `${testFiles.length} test files / ${totalPass + totalFail} assertions`, totalFail === 0);
}

function stageSummary() {
  console.log('');
  console.log('=== SUMMARY ===');
  for (const stage of ['structure', 'syntax', 'tests']) {
    const stageResults = results.filter((entry) => entry.stage === stage);
    const failed = stageResults.filter((entry) => !entry.ok);
    const label = failed.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${label}  ${stage}: ${stageResults.length - failed.length}/${stageResults.length} checks passed`);
    for (const failure of failed) console.log(`   - ${failure.name}${failure.detail ? `: ${failure.detail}` : ''}`);
  }
  const allPassed = failures === 0;
  console.log('');
  console.log(allPassed ? 'RESULT: PASS' : `RESULT: FAIL (${failures} failing check${failures === 1 ? '' : 's'})`);
  process.exitCode = allPassed ? 0 : 1;
}

console.log('dsh-cc-dream-memory verify');
console.log(`plugin root: ${PLUGIN_ROOT}`);
console.log(`node: ${process.execPath} (${process.version})`);
console.log('');

try {
  await stageStructure();
  await stageSyntax();
  await stageTests();
} catch (error) {
  failures += 1;
  record('harness', 'unexpected harness error', false, error && error.stack ? error.stack : String(error));
}
stageSummary();
