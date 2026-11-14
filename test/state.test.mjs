/**
 * Tests for src/state.js (Lead-owned module, already implemented).
 *
 * Contract: INTERFACES.md "src/state.js" — durable per-project dream state with
 * session de-duplication, atomic persistence and a snapshot view.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadModule, makeTempDir } from './helpers.mjs';

let stateModulePromise;

function stateModule() {
  if (!stateModulePromise) {
    stateModulePromise = loadModule('../src/state.js', { requireExports: ['ProjectState'] });
  }
  return stateModulePromise;
}

async function newState(t) {
  const { ProjectState } = await stateModule();
  const tmp = await makeTempDir(t);
  const paths = { stateFile: path.join(tmp, 'project', '.state.json') };
  const state = new ProjectState(paths);
  await state.load();
  return { state, paths, tmp };
}

test('load() on a missing state file yields the default snapshot', async (t) => {
  const { state } = await newState(t);
  const snapshot = state.snapshot();
  assert.equal(snapshot.lastDreamAt, 0);
  assert.equal(snapshot.lastDreamAttemptAt, 0);
  assert.equal(snapshot.lastScanAt, 0);
  assert.deepEqual(snapshot.sessionsSince, []);
  assert.equal(typeof snapshot.counters, 'object');
  assert.equal(snapshot.counters.dreams, 0);
});

test('load() on a corrupt state file falls back to defaults instead of throwing', async (t) => {
  const { ProjectState } = await stateModule();
  const tmp = await makeTempDir(t);
  const stateFile = path.join(tmp, 'project', '.state.json');
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, '{ this is not json ', 'utf8');
  const state = new ProjectState({ stateFile });
  await state.load();
  assert.deepEqual(state.snapshot().sessionsSince, []);
  assert.equal(state.snapshot().lastDreamAt, 0);
});

test('ensureSession de-duplicates session ids and persists them', async (t) => {
  const { state, paths } = await newState(t);
  await state.ensureSession('session-a', 1000);
  await state.ensureSession('session-b', 2000);
  await state.ensureSession('session-a', 3000);
  const snapshot = state.snapshot();
  assert.deepEqual(
    snapshot.sessionsSince.map((entry) => entry.id),
    ['session-a', 'session-b'],
  );
  assert.deepEqual(
    snapshot.sessionsSince.map((entry) => entry.at),
    [1000, 2000],
    'a duplicate ensureSession must not update the timestamp',
  );
  const onDisk = JSON.parse(await readFile(paths.stateFile, 'utf8'));
  assert.deepEqual(
    onDisk.sessionsSince.map((entry) => entry.id),
    ['session-a', 'session-b'],
    'sessions must be persisted atomically to the state file',
  );

  // A fresh instance loading the same file sees the persisted sessions.
  const { ProjectState } = await stateModule();
  const reloaded = new ProjectState(paths);
  await reloaded.load();
  assert.deepEqual(
    reloaded.snapshot().sessionsSince.map((entry) => entry.id),
    ['session-a', 'session-b'],
  );
});

test('consumeSessions returns the latest ids without consuming them', async (t) => {
  const { state } = await newState(t);
  for (const id of ['s1', 's2', 's3']) await state.ensureSession(id);
  assert.deepEqual(state.consumeSessions(2), ['s2', 's3']);
  assert.deepEqual(
    state.snapshot().sessionsSince.map((entry) => entry.id),
    ['s1', 's2', 's3'],
    'consumeSessions must not delete sessions',
  );
  assert.deepEqual(state.consumeSessions(0), []);
  assert.deepEqual(state.consumeSessions(99), ['s1', 's2', 's3']);
});

test('clearSessions removes only the given ids', async (t) => {
  const { state } = await newState(t);
  for (const id of ['s1', 's2', 's3']) await state.ensureSession(id);
  await state.clearSessions(['s1', 's3', 'unknown']);
  assert.deepEqual(
    state.snapshot().sessionsSince.map((entry) => entry.id),
    ['s2'],
  );
});

test('dream lifecycle markers update the snapshot', async (t) => {
  const { state } = await newState(t);
  await state.markDreamStart();
  assert.ok(state.snapshot().lastDreamAttemptAt > 0);

  await state.markDreamDone({ sessions: 3, ops: 4, files: 2, summary: 'merged duplicates' });
  const done = state.snapshot();
  assert.ok(done.lastDreamAt > 0);
  assert.equal(done.lastDreamSessions, 3);
  assert.equal(done.lastDreamOps, 4);
  assert.match(done.lastDreamSummary, /merged duplicates/);
  assert.equal(done.lastError, '');
  assert.equal(done.counters.dreams, 1);

  await state.markDreamFailed(new Error('llm exploded'));
  const failed = state.snapshot();
  assert.match(failed.lastError, /llm exploded/);
  assert.equal(failed.counters.failures, 1);
});

test('extract lifecycle markers update the snapshot', async (t) => {
  const { state } = await newState(t);
  await state.markExtractStart('auto');
  const started = state.snapshot();
  assert.ok(started.lastExtractAttemptAt > 0);
  assert.equal(started.lastExtractTrigger, 'auto');

  await state.markExtractResult({ ok: true, count: 2, reason: 'inbox', trigger: 'auto' });
  const done = state.snapshot();
  assert.ok(done.lastExtractAt > 0);
  assert.equal(done.lastExtractCount, 2);
  assert.equal(done.lastExtractReason, 'inbox');

  await state.markExtractResult({ ok: false, count: 0, reason: 'timeout', trigger: 'auto' });
  const failed = state.snapshot();
  assert.equal(failed.lastExtractReason, 'timeout');
  assert.equal(failed.lastExtractError, '');
});

test('snapshot() is a defensive copy', async (t) => {
  const { state } = await newState(t);
  const snapshot = state.snapshot();
  snapshot.sessionsSince.push({ id: 'injected-by-test', at: 0 });
  snapshot.counters.dreams = 999;
  assert.deepEqual(state.snapshot().sessionsSince, []);
  assert.equal(state.snapshot().counters.dreams, 0);
});

test('a pending dream copy persists until the human settles it', async (t) => {
  const { state, paths } = await newState(t);
  const pending = { dir: 'C:/data/.dreams/shadow', createdAt: '2026-11-13T10:00:00.000Z', runId: 'run-1', counts: { added: 1, changed: 0, removed: 0 } };
  await state.setShadowPending(pending);
  assert.deepEqual(state.snapshot().shadowPending, pending);
  const onDisk = JSON.parse(await readFile(paths.stateFile, 'utf8'));
  assert.deepEqual(onDisk.shadowPending, pending);
  assert.equal(onDisk.lastDreamMode, 'shadow');
  await state.clearShadowPending();
  assert.equal(state.snapshot().shadowPending, null);
});
