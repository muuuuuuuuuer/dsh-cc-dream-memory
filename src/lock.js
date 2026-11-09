/**
 * Cross-process file lock for project memory writes (v10).
 *
 * The lock is advisory: callers wrap a mutation with `withFileLock(lockFile, fn)`.
 * A held lock gets a small retry window; stale locks (older than `ttlMs`) are
 * reclaimed. If contention cannot be resolved the operation still runs
 * best-effort so a dead process can never wedge memory writes forever.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_WAIT_MS = 2_000;
const RETRY_BASE_MS = 15;

/**
 * Windows reports transient lock-file races as EPERM/EACCES/EBUSY (the file is
 * delete-pending or scanned by AV). Those are contention, not fatal errors: a
 * short retry is the correct behavior, otherwise concurrent writers silently
 * degrade and can drop index updates.
 */
const CONTENTION_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Is the process that wrote the lock still alive? EPERM means "alive, other owner". */
async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

/**
 * @param {string} file lock file path.
 * @param {() => Promise<any>} fn critical section.
 * @param {{ttlMs?:number, waitMs?:number, onDegrade?:(error:unknown)=>void}} [options]
 * @returns {Promise<any>} fn's result.
 */
export async function withFileLock(file, fn, options = {}) {
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Math.max(1_000, Number(options.ttlMs)) : DEFAULT_TTL_MS;
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : DEFAULT_WAIT_MS;
  const startedAt = Date.now();
  let handle = null;
  while (Date.now() - startedAt < waitMs) {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      handle = await fs.open(file, 'wx');
      // Metadata write is part of acquisition: on failure release the empty
      // lock and retry instead of leaving a lock that claims ownership.
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      } catch (writeError) {
        try {
          await handle.close();
        } catch {
          /* already closed */
        }
        handle = null;
        try {
          await fs.unlink(file);
        } catch {
          /* lock already gone */
        }
        throw writeError;
      }
      break;
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : '';
      if (CONTENTION_CODES.has(code)) {
        // A fresh lock means wait; a missing/stale lock means retry now.
        try {
          const stat = await fs.stat(file);
          if (Date.now() - stat.mtimeMs > ttlMs) {
            // Stale by age, but never steal a lock whose owner process is still
            // alive: a slow-but-running critical section must finish first.
            let ownerPid = 0;
            try {
              const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
              ownerPid = Number(parsed?.pid);
            } catch {
              ownerPid = 0;
            }
            if (await isProcessAlive(ownerPid)) {
              await sleep(RETRY_BASE_MS + Math.floor(Math.random() * 20));
              continue;
            }
            try {
              await fs.unlink(file);
            } catch {
              /* another waiter reclaimed it */
            }
            continue;
          }
          await sleep(RETRY_BASE_MS + Math.floor(Math.random() * 20));
        } catch {
          await sleep(RETRY_BASE_MS);
        }
        continue;
      }
      // Non-contention failure (permissions on the parent, bad path, ...):
      // degrade so a broken lock file can never wedge memory writes.
      try {
        options.onDegrade?.(error);
      } catch {
        /* ignore diagnostics */
      }
      break;
    }
  }
  try {
    return await fn();
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        /* already closed */
      }
      try {
        await fs.unlink(file);
      } catch {
        /* lock already reclaimed */
      }
    }
  }
}

/** Read the current lock metadata, or null when the lock is absent. */
export async function readLock(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
