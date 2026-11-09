/**
 * The whole evaluation runner, end to end, with the model replaced: every
 * orchestration path runs for real (workspaces, git init, checkpoints, restores,
 * objective checks, report), so a broken runner fails here instead of after a
 * paid run has started. `--plan` cannot catch that: it returns before any of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function runFake(t, args) {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'cc-eval-smoke-'));
  t.after(() => rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const result = spawnSync(process.execPath, ['eval/run.mjs', '--fake-model', '--runs', '1', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, EVAL_RUNS_DIR: runsDir, DEEPSEEK_API_KEY: '' },
  });
  assert.equal(result.status, 0, `runner failed:\n${result.stdout}\n${result.stderr}`);
  const [stamp] = await readdir(runsDir);
  const records = JSON.parse(await readFile(path.join(runsDir, stamp, 'records.json'), 'utf8'));
  return { records, report: await readFile(path.join(runsDir, stamp, 'report.md'), 'utf8'), runRoot: path.join(runsDir, stamp) };
}

test('locked memory scenarios run through every condition', async (t) => {
  const { records, report } = await runFake(t, ['--only', 'dev-02-correction']);
  const [run] = records[0].runs;
  assert.deepEqual(Object.keys(run.variants.default).sort(), ['A', 'B', 'B0', 'C']);
  assert.deepEqual(run.errors.filter((error) => !/^objective/.test(error.stage)), []);
  assert.ok(run.variants.default.C.restoredHashOk, 'C restored its post-dream checkpoint');
  assert.match(report, /dev-02-correction/);
});

test('open-tool scenarios work in temp git workspaces and run the objective check', async (t) => {
  const { records } = await runFake(t, ['--scenario-file', 'eval/scenarios.coding.dev.json']);
  const coding = records.find((record) => record.scenario === 'dev-07-open-coding');
  const [run] = coding.runs;
  const { objective } = run.variants.default.B;
  assert.ok(objective, 'the objective check ran');
  assert.equal(objective.ok, false, 'the fake model fixed nothing, so `node --test` must fail');
  assert.equal(objective.testHashUnchanged, true);
  assert.equal(run.variants.default.B.success, false, 'an objective failure fails the task whatever the text says');
});

test('a transcript scenario gives Dream empty memory, so it can only learn from sessions', async (t) => {
  const { records } = await runFake(t, ['--scenario-file', 'eval/scenarios.dream-session.dev.json']);
  const [run] = records[0].runs;
  assert.deepEqual(run.errors, []);
  assert.equal(run.conditions.C.dream.sessionsReviewed, 1);
  assert.equal(run.conditions.C.dream.memoryEmptied, true);
  assert.equal(run.variants.default.C.validity, 'valid');
});
