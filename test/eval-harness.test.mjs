import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HARNESS_CONTRACT,
  assessToolDiscovery,
  classifyTestOutcome,
  clearTopicFiles,
  comparisonEligible,
  conditionConfig,
  dreamPurityError,
  summarizeValidity,
  validateFrozenManifest,
} from '../eval/harness-lib.mjs';

test('eval harness: tool discovery fails closed on non-zero exit / EPERM / empty ids', () => {
  const ok = assessToolDiscovery({ status: 0, stdout: '', ids: Array.from({ length: 15 }, (_, i) => `tool-x${i}`) });
  assert.equal(ok.valid, true);
  assert.equal(ok.reasons.length, 0);

  const nonZero = assessToolDiscovery({ status: 1, ids: Array.from({ length: 15 }, (_, i) => `tool-x${i}`) });
  assert.equal(nonZero.valid, false, 'a failed dump-config must not continue with zero lock entries');

  const empty = assessToolDiscovery({ status: 0, ids: [] });
  assert.equal(empty.valid, false);

  const denied = assessToolDiscovery({ status: 0, ids: [], stderr: 'EPERM: operation not permitted, open cordis.yml' });
  assert.equal(denied.valid, false);
  assert.ok(denied.reasons.some((reason) => /permission|denied/i.test(reason)));
});

test('eval harness: frozen manifest mismatch aborts before the first model call', () => {
  const actual = {
    scenarioHash: 'sha256:scenario',
    rubricHashes: { 'rubric.v2.json': 'sha256:r2' },
    pluginVersion: '0.10.7',
    runnerContract: HARNESS_CONTRACT,
  };
  const manifest = {
    harnessContract: HARNESS_CONTRACT,
    pluginVersion: '0.10.7',
    scenarioHash: 'sha256:scenario',
    rubrics: { 'rubric.v2.json': 'sha256:r2' },
  };
  assert.equal(validateFrozenManifest(manifest, actual).ok, true);

  const stalePlugin = validateFrozenManifest({ ...manifest, pluginVersion: '0.10.5' }, actual);
  assert.equal(stalePlugin.ok, false);
  assert.match(stalePlugin.errors.join('\n'), /pluginVersion/);

  const changedScenario = validateFrozenManifest({ ...manifest, scenarioHash: 'sha256:old' }, actual);
  assert.equal(changedScenario.ok, false);

  const missing = validateFrozenManifest(null, actual);
  assert.equal(missing.ok, false);
});

test('eval harness: device-invalid and grading-missing conditions are not comparison eligible', () => {
  const snapshotBad = classifyTestOutcome({ snapshotValid: false, modelOk: true, judgeMissing: false });
  assert.equal(snapshotBad.validity, 'invalid');
  assert.equal(snapshotBad.comparisonEligible, false);
  assert.equal(snapshotBad.failureKind, 'harness-invalid');

  const dreamBad = classifyTestOutcome({ dreamValid: false });
  assert.equal(dreamBad.failureKind, 'harness-invalid');

  const modelFailed = classifyTestOutcome({ modelOk: false });
  assert.equal(modelFailed.validity, 'valid');
  assert.equal(modelFailed.failureKind, 'task-failed');
  assert.equal(modelFailed.comparisonEligible, true, 'a real model failure is a scored task failure');

  const judgeMissing = classifyTestOutcome({ judgeMissing: true });
  assert.equal(judgeMissing.failureKind, 'grading-missing');
  assert.equal(judgeMissing.comparisonEligible, false);
});

test('eval harness: success requires deterministic checks + judge gate', () => {
  const success = classifyTestOutcome({ deterministicOk: true, judged: { taskCompleted: true } });
  assert.equal(success.success, true);
  assert.equal(success.failureKind, null);

  assert.equal(classifyTestOutcome({ deterministicOk: false, judged: { taskCompleted: true } }).success, false);
  assert.equal(classifyTestOutcome({ deterministicOk: true, judged: { taskCompleted: true, boundaryFailure: true } }).success, false);
  assert.equal(classifyTestOutcome({ deterministicOk: true, judged: { taskCompleted: true, fabricatedHistory: true } }).success, false);
  assert.equal(comparisonEligible({ comparisonEligible: true }, { comparisonEligible: true }), true);
  assert.equal(comparisonEligible({ comparisonEligible: true }, { comparisonEligible: false }), false);
});

test('eval harness: validity summary counts invalid/grading-missing/task-failed separately', () => {
  const records = [
    {
      scenario: 's1',
      variants: {
        default: {
          A: { validity: 'valid', failureKind: null },
          B: { validity: 'invalid', reasons: ['snapshot hash mismatch'] },
          C: { validity: 'valid', failureKind: 'grading-missing' },
        },
      },
    },
  ];
  const summary = summarizeValidity(records);
  assert.equal(summary.valid, 1);
  assert.equal(summary.invalid, 1);
  assert.equal(summary.gradingMissing, 1);
  assert.equal(summary.taskFailed, 0);
  assert.deepEqual(summary.invalidReasons, ['s1/B: snapshot hash mismatch']);
});

test('eval harness: every condition shares one project identity, so a copied memory root is found', () => {
  const b = conditionConfig('B', 'C:\\tmp\\run\\B\\memory-root');
  const c = conditionConfig('C', 'C:/tmp/run/C/memory-root');
  assert.equal(b.projectId, c.projectId, 'each condition has its own workspace path, so a path-derived identity would split them');
  assert.ok(b.projectId !== '');
  assert.equal(b.memoryRoot, 'C:/tmp/run/B/memory-root');
});

test('eval harness: only condition A runs without memory', () => {
  assert.equal(conditionConfig('A', 'x').tools, false);
  assert.equal(conditionConfig('A', 'x').autoMemoryEnabled, false);
  for (const condition of ['B0', 'B', 'C']) {
    assert.equal(conditionConfig(condition, 'x').tools, true, condition);
    assert.equal(conditionConfig(condition, 'x').injectIndex, true, condition);
  }
});

test('eval harness: a format complaint only counts when the task states a format', () => {
  const judged = { taskCompleted: true, boundaryFailure: false, fabricatedHistory: false, formatViolation: true };
  assert.equal(classifyTestOutcome({ deterministicOk: true, judged, formatRequired: false }).success, true);
  assert.equal(classifyTestOutcome({ deterministicOk: true, judged, formatRequired: true }).success, false);
});

test('eval harness: dream purity depends on whether the scenario reads transcripts', () => {
  assert.equal(dreamPurityError({ sessionsReviewed: 0 }, { dreamSessions: false }), null);
  assert.match(dreamPurityError({ sessionsReviewed: 2 }, { dreamSessions: false }), /sessionsReviewed=2/);
  assert.equal(dreamPurityError({ sessionsReviewed: 2 }, { dreamSessions: true }), null);
  assert.match(dreamPurityError({ sessionsReviewed: 0 }, { dreamSessions: true }), /sessionsReviewed=0/);
  assert.equal(dreamPurityError(null, { dreamSessions: true }), null, 'a missing result is reported elsewhere');
});

test('eval harness: clearing memory removes the notes and keeps the session state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-eval-clear-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects', 'eval-project');
  await mkdir(path.join(project, 'memory'), { recursive: true });
  await writeFile(path.join(project, 'memory', 'MEMORY.md'), '- [a](a.md) — d\n');
  await writeFile(path.join(project, 'memory', 'project_a.md'), 'Aurora');
  await writeFile(path.join(project, '.state.json'), '{"sessionsSince":[{"id":"s1"}]}');
  clearTopicFiles(root);
  assert.deepEqual(await readdir(path.join(project, 'memory')), ['MEMORY.md']);
  assert.equal(await readFile(path.join(project, 'memory', 'MEMORY.md'), 'utf8'), '');
  assert.ok((await readFile(path.join(project, '.state.json'), 'utf8')).includes('s1'));
});
