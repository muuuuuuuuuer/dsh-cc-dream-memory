/**
 * The Mt. Moon real-model runner with the model replaced: seeding, the Dream
 * call and scoring all run for real, so a broken runner fails here instead of
 * after a paid run. The seeded memory roots are also loaded through the
 * plugin's own store and state to prove they say what the case says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases } from '../eval/mt-moon/lib.mjs';
import { makeEnv } from './v10-helpers.mjs';
import { buildSuspects } from '../src/dream-focus.js';
import { buildPaths } from '../src/paths.js';
import { MemoryStore } from '../src/store.js';
import { ProjectState } from '../src/state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function runFake(t, mode) {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'cc-mt-moon-smoke-'));
  t.after(() => rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const result = spawnSync(process.execPath, ['eval/mt-moon/run.mjs', mode], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, EVAL_RUNS_DIR: runsDir, DEEPSEEK_API_KEY: '' },
  });
  assert.equal(result.status, 0, `runner failed:\n${result.stdout}\n${result.stderr}`);
  const [stamp] = await readdir(runsDir);
  const runRoot = path.join(runsDir, stamp);
  return { report: JSON.parse(await readFile(path.join(runRoot, 'report.json'), 'utf8')), runRoot };
}

test('fake model that applies each scripted fix: every case passes', async (t) => {
  const { report } = await runFake(t, '--fake-model');
  assert.deepEqual(report.cases.map(({ id, pass }) => [id, pass]), (await loadCases()).map(({ id }) => [id, true]));
});

test('fake model that changes nothing: every wrong note fails, the two controls pass', async (t) => {
  const { report } = await runFake(t, '--fake-model=noop');
  assert.deepEqual(report.cases.map(({ id, pass }) => [id, pass]),
    (await loadCases()).map(({ id }) => [id, id.includes('control')]));
});

test('the runner seeds what the case describes: notes with their source session, reviewed sessions, suspects', async (t) => {
  const { runRoot } = await runFake(t, '--fake-model');
  for (const testCase of await loadCases()) {
    const env = await makeEnv(t);
    const workspaceDir = path.join(runRoot, testCase.id, 'workspace');
    const paths = buildPaths({ memoryRoot: path.join(runRoot, testCase.id, 'memory-root'), homeDir: env.tmp, workspaceDir, projectId: 'eval-project' });
    const store = new MemoryStore({ paths, getConfig: () => env.config });
    const state = new ProjectState(paths);
    await state.load();
    const entries = await store.listEntries('project');
    const sessionOf = (id) => `mt-${testCase.id}-${id}`;
    assert.deepEqual(entries.map(({ file, sourceSession }) => [file, sourceSession]).sort(),
      testCase.notes.map(({ file, sourceSession }) => [file, sessionOf(sourceSession)]).sort());
    assert.deepEqual(state.snapshot().dreamProcessedSessions.map(({ id }) => id).sort(),
      testCase.sessions.filter(({ reviewed }) => reviewed).map(({ id }) => sessionOf(id)).sort());
    const suspects = await buildSuspects({ paths, store, state }, env.config);
    assert.deepEqual(suspects.map(({ file }) => file), testCase.suspect ? [testCase.suspect.file] : []);
  }
});
