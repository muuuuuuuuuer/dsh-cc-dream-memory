/**
 * v10 P1-13: file lock + store write-lock serialization.
 * Contract §7. Uses os.tmpdir() only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeEnv, lockModule, exists, sleep } from './v10-helpers.mjs';
import { loadModule } from './helpers.mjs';

test('v10 lock: withFileLock runs, serializes and removes the lock file', async (t) => {
  const env = await makeEnv(t);
  const { withFileLock } = await lockModule();
  const lockFile = path.join(env.tmp, 'write.lock');

  const result = await withFileLock(lockFile, async () => {
    assert.equal(await exists(lockFile), true, 'the lock file exists while the critical section runs');
    const raw = await readFile(lockFile, 'utf8');
    assert.equal(raw.includes('pid'), true, 'the lock records the owner pid');
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(await exists(lockFile), false, 'the lock file is removed after the section');

  // Exceptions still release the lock.
  await assert.rejects(
    withFileLock(lockFile, async () => {
      throw new Error('inside');
    }),
    /inside/,
  );
  assert.equal(await exists(lockFile), false, 'the lock file is removed after a throw');
});

test('v10 lock: two critical sections do not overlap (mutual exclusion)', async (t) => {
  const env = await makeEnv(t);
  const { withFileLock } = await lockModule();
  const lockFile = path.join(env.tmp, 'mutex.lock');
  const events = [];
  let active = 0;

  const critical = (name, ms) =>
    withFileLock(lockFile, async () => {
      active += 1;
      assert.equal(active, 1, `${name} overlapped another critical section`);
      events.push(`start:${name}`);
      await sleep(ms);
      events.push(`end:${name}`);
      active -= 1;
    });

  await Promise.all([critical('a', 60), critical('b', 20), critical('c', 10)]);
  assert.equal(active, 0);
  assert.equal(events.includes('start:a') && events.includes('start:b') && events.includes('start:c'), true);
  // Every start is immediately followed by its own end before the next start.
  for (let index = 0; index < events.length; index += 2) {
    assert.match(events[index], /^start:/);
    assert.equal(events[index + 1]?.startsWith('end:'), true, `events: ${events.join(' ')}`);
  }
});

test('v10 lock: a stale lock is taken over', async (t) => {
  const env = await makeEnv(t);
  const { withFileLock } = await lockModule();
  const lockFile = path.join(env.tmp, 'stale.lock');
  await writeFile(lockFile, JSON.stringify({ pid: 999999, at: 1 }), 'utf8');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(lockFile, old, old);

  let ran = false;
  const result = await withFileLock(
    lockFile,
    async () => {
      ran = true;
      return 'recovered';
    },
    { ttlMs: 1000, waitMs: 2000 },
  );
  assert.equal(ran, true, 'a stale lock must not block the section');
  assert.equal(result, 'recovered');
  assert.equal(await exists(lockFile), false);
});

test('v10 lock: a held fresh lock degrades to best-effort instead of hanging', async (t) => {
  const env = await makeEnv(t);
  const { withFileLock } = await lockModule();
  const lockFile = path.join(env.tmp, 'held.lock');
  await mkdir(path.dirname(lockFile), { recursive: true });
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');

  const startedAt = Date.now();
  let ran = false;
  const result = await withFileLock(
    lockFile,
    async () => {
      ran = true;
      return 'degraded';
    },
    { ttlMs: 60_000, waitMs: 120 },
  );
  assert.equal(ran, true, 'a busy lock degrades to best-effort instead of staying blocked');
  assert.equal(result, 'degraded');
  assert.ok(Date.now() - startedAt < 3000, 'the degraded path returns promptly');
});

test('v10 lock: paths expose writeLockFile and interleaved store writes keep the index in sync', async (t) => {
  const env = await makeEnv(t);
  assert.equal(typeof env.paths.writeLockFile, 'string', 'paths.writeLockFile is added by v10');
  assert.ok(path.isAbsolute(env.paths.writeLockFile));

  // Two store instances over the same memory dir (simulates two sessions).
  const second = new env.mods.store.MemoryStore({ paths: env.paths, config: env.config });
  await second.ensure();
  const saves = [];
  for (let index = 0; index < 10; index += 1) {
    const store = index % 2 === 0 ? env.store : second;
    saves.push(
      store.saveEntry({
        name: `locked note ${index}`,
        type: 'project',
        description: `locked note ${index}`,
        content: `locked body ${index}`,
      }),
    );
  }
  await Promise.all(saves);
  const entries = await env.store.listEntries();
  const lines = (await env.store.indexText()).split(/\r?\n/).filter((line) => line.trim() !== '');
  assert.equal(entries.length, 10);
  assert.equal(lines.length, entries.length, 'no index line may be lost by interleaved writes');
  for (const entry of entries) {
    assert.ok(lines.some((line) => line.includes(`](${entry.file})`)), `missing index line for ${entry.file}`);
  }
});
