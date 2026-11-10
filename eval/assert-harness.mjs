#!/usr/bin/env node
/**
 * Model-free harness assertions for the A/B/C evaluation.
 *
 * Behavior rules are tested in test/eval-harness.test.mjs; this script checks the
 * installed profile/environment and the frozen artifacts, without calling a model.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HARNESS_CONTRACT,
  assessToolDiscovery,
  hashFile,
  validateFrozenManifest,
} from './harness-lib.mjs';
import { resolveDshPaths } from './dsh-paths.mjs';
import { assertProfileSource } from './profile-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = fs.readFileSync(path.join(ROOT, 'eval', 'run.mjs'), 'utf8');
const { DSH_EXE, DSH_CLI } = resolveDshPaths();
const errors = [];
const checks = [];

function check(label, ok, detail = '') {
  checks.push({ label, ok });
  if (!ok) errors.push(`${label}${detail ? `: ${detail}` : ''}`);
}

let profileSource;
try {
  profileSource = assertProfileSource({ expectedRoot: process.env.EVAL_PLUGIN_ROOT || ROOT });
  check('evaluation profile loads the owning package/version/canonical source', true);
} catch (error) {
  check('evaluation profile loads the owning package/version/canonical source', false, error.message);
}

const dump = profileSource ? spawnSync(DSH_EXE, ['--expose-internals', DSH_CLI, '--profile', 'cc-memory-eval', '--dump-config'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  windowsHide: true,
}) : { status: 1, stdout: '', stderr: 'source preflight failed; tool discovery skipped' };
const ids = [];
for (const line of String(dump.stdout ?? '').split('\n')) {
  const match = line.match(/^- id: (tool-[A-Za-z0-9-]+)$/);
  if (!match) continue;
  if (/^tool-executor-/.test(match[1]) || match[1] === 'tool-result-pruner') continue;
  ids.push(match[1]);
}
const discovery = assessToolDiscovery({ status: dump.status, stdout: dump.stdout, stderr: dump.stderr, ids });
check('tool discovery succeeds and finds lockable tools', discovery.valid, discovery.reasons.join('; '));
for (const required of ['tool-fs', 'tool-fs-search', 'tool-pwsh', 'tool-bash', 'tool-skill', 'tool-subagent']) {
  if (discovery.valid) check(`lockable tool present: ${required}`, ids.includes(required));
}

check('runner aborts when tool discovery is invalid', /discovery\.valid|assessToolDiscovery/.test(RUNNER));
check('runner validates the frozen manifest before model calls', RUNNER.includes('validateFrozenManifest'));
check('runner records validity/failureKind for every condition', RUNNER.includes('classifyTestOutcome'));
check('runner distinguishes grading-missing', RUNNER.includes('grading-missing'));
check('runner keeps separate before/after-Dream checkpoints', RUNNER.includes('checkpoint-before-dream') && RUNNER.includes('checkpoint-after-dream'));
check('runner verifies restored snapshot hashes', RUNNER.includes('restoredHashOk'));
check('runner marks Dream purity violations invalid', RUNNER.includes('dream-purity') || RUNNER.includes('dreamValid'));

const scenarios = fs.readFileSync(path.join(ROOT, 'eval', 'scenarios.dev.json'), 'utf8');
const data = JSON.parse(scenarios);
const variant = data.scenarios.find((scenario) => scenario.id === 'dev-01-stable-preference')?.test?.variants?.find((item) => item.id === 'current-instruction-wins');
check('current-instruction variant is rubric v2', variant?.rubricVersion === 2);
const dev3 = data.scenarios.find((scenario) => scenario.id === 'dev-03-cross-session-composition');
check('cross-session facts are not in a repo fixture', dev3 && Object.keys(dev3.setup ?? {}).length === 0);
const dev4 = data.scenarios.find((scenario) => scenario.id === 'dev-04-project-isolation');
check('project-isolation capability note is present', typeof dev4?.capabilityNote === 'string');

const manifestFile = path.join(ROOT, 'eval', 'frozen-manifest.json');
check('frozen manifest exists', fs.existsSync(manifestFile));
if (fs.existsSync(manifestFile)) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const actual = {
    runnerContract: HARNESS_CONTRACT,
    pluginVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    scenarioHash: hashFile(path.join(ROOT, 'eval', 'scenarios.dev.json')),
    rubricHashes: Object.fromEntries(fs.readdirSync(path.join(ROOT, 'eval', 'rubrics')).filter((name) => name.endsWith('.json')).map((name) => [name, hashFile(path.join(ROOT, 'eval', 'rubrics', name))])),
  };
  const result = validateFrozenManifest(manifest, actual);
  check('frozen manifest matches current assets/contract/version', result.ok, result.errors.join('; '));
}

const failed = checks.filter((item) => !item.ok);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: failed.length === 0, contract: HARNESS_CONTRACT, profileSource, checks, errors }, null, 2));
} else {
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}`);
  if (profileSource) console.log(`SOURCE ${profileSource.name}@${profileSource.version} ${profileSource.target}`);
  for (const error of errors) console.log(`  ERROR ${error}`);
  console.log(failed.length === 0 ? 'RESULT: PASS (no model called)' : `RESULT: FAIL (${failed.length} checks)`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
