import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callHttp, httpEnv } from './v10-helpers.mjs';
import { resolveConfig } from '../src/config.js';
import { MemoryRuntime } from '../src/runtime.js';

async function makeTempDir(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-memory-0231-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  return tmp;
}

test('Dream admits history from the project root, subdirectories and linked worktrees in either open order', async (t) => {
  // git records worktree paths in long form; a Windows 8.3 temp dir
  // (C:\Users\RUNNER~1 on CI) would otherwise name the repo two ways.
  const tmp = await realpath(await makeTempDir(t));
  const repo = path.join(tmp, 'repo');
  const subdir = path.join(repo, 'pkg');
  const worktree = path.join(tmp, 'worktree');
  const other = path.join(tmp, 'other');
  await mkdir(subdir, { recursive: true });
  await mkdir(other);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-q');
  git('-c', 'user.name=DSH Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
  git('worktree', 'add', '-q', '--detach', worktree);
  const records = [
    { id: 'other', cwd: other },
    { id: 'root', cwd: repo },
    { id: 'subdir', cwd: subdir },
    { id: 'branch', cwd: worktree },
    { id: 'delegated', cwd: repo, parentSession: 'root' },
  ].map((header, createdAt) => ({ header: { ...header, createdAt } }));
  const sessionQuery = {
    filterSessions: async (filters) => records.filter(({ header }) =>
      filters.every(({ kind, values }) => values.includes(header[kind]))),
  };
  for (const first of [repo, worktree]) {
    // A profile-level storage override must not import transcripts from an unrelated repository.
    for (const projectId of ['', 'same-bucket']) {
      const runtime = new MemoryRuntime({ get: () => sessionQuery }, resolveConfig({
        memoryRoot: path.join(tmp, 'memory'), sessionLookback: 4, projectId,
      }));
      const fromFirst = await runtime.storeFor(first);
      const fromSubdir = await runtime.storeFor(subdir);
      assert.equal(fromFirst, fromSubdir);
      const estimate = await runtime.estimateDream(fromSubdir);
      assert.equal(estimate.sessions, 3);
    }
  }
});

test('independent runtime toggles retain both updates on disk and on the next edit', async (t) => {
  const config = resolveConfig({ memoryRoot: await makeTempDir(t) });
  const first = new MemoryRuntime({}, config);
  const second = new MemoryRuntime({}, config);
  first.overrides();
  second.overrides();
  await Promise.all([
    first.setOverrides({ autoDreamEnabled: false }),
    second.setOverrides({ autoMemoryEnabled: false }),
  ]);
  const disk = async () => JSON.parse(await readFile(first.overrideFile, 'utf8'));
  assert.deepEqual(await disk(), { autoDreamEnabled: false, autoMemoryEnabled: false });
  await first.setOverrides({ enabled: false });
  assert.deepEqual(await disk(), { enabled: false, autoDreamEnabled: false, autoMemoryEnabled: false });
});

test('compact status uses the requested project and returns only composer data', async (t) => {
  const env = await httpEnv(t);
  await env.runtime.storeFor(path.join(env.tmp, 'other-project'));
  await env.pctx.store.saveEntry({ name: 'Workflow', description: 'Fixture', content: 'Use pnpm.', type: 'project' });
  await env.runtime.setOverrides({ enabled: false });
  const result = await callHttp(env, { token: env.token, path: '/status?view=chip&sessionId=s1' });
  assert.equal(result.statusCode, 200);
  const summary = result.json();
  assert.equal(summary.config.enabled, false);
  assert.equal(summary.entryCount, 1);
  assert.equal(summary.needsReview, false);
  for (const key of ['entries', 'inbox', 'metrics', 'dreamRuns', 'rules']) assert.equal(key in summary, false);
});
