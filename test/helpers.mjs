/**
 * Shared test utilities for dsh-cc-dream-memory.
 *
 * Modules under test are imported *dynamically* so that a not-yet-written
 * implementation surfaces as a clear per-test "[module-not-ready]" failure
 * instead of an opaque top-level import error. Every temp dir is created under
 * `os.tmpdir()` and removed by the node:test cleanup hook, so the real
 * `~/.dsh` (or any other user data) is never touched.
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(TEST_DIR, '..');

const moduleCache = new Map();

/**
 * Import a plugin module relative to the test directory.
 * @param {string} relPath e.g. '../src/store.js'
 * @param {{requireExports?: string[]}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadModule(relPath, { requireExports = [] } = {}) {
  const abs = path.resolve(TEST_DIR, relPath);
  let mod = moduleCache.get(abs);
  if (!mod) {
    try {
      mod = await import(pathToFileURL(abs).href);
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error(
          `[module-not-ready] cannot import ${relPath} (resolved to ${abs}). ` +
            'The implementation module is missing or imports a missing sibling. ' +
            `Original error: ${error.message}`,
        );
      }
      throw new Error(`[module-load-failed] ${relPath}: ${error && error.stack ? error.stack : String(error)}`);
    }
    moduleCache.set(abs, mod);
  }
  const missing = requireExports.filter((name) => mod[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `[missing-export] ${relPath} does not export ${missing.map((name) => JSON.stringify(name)).join(', ')}. ` +
        `Actual exports: ${Object.keys(mod).join(', ') || '(none)'}`,
    );
  }
  return mod;
}

/**
 * Resolve the first matching function export (used where the interface doc does
 * not pin the export name, e.g. src/frontmatter.js).
 * @param {Record<string, unknown>} mod
 * @param {string} relPath
 * @param {string[]} candidates export names in preference order
 * @param {string} description human description for the error message
 * @returns {Function}
 */
export function pickFunction(mod, relPath, candidates, description) {
  for (const name of candidates) {
    if (typeof mod[name] === 'function') return mod[name];
  }
  throw new Error(
    `[missing-export] ${relPath} exposes no ${description} export. ` +
      `Tried: ${candidates.join(', ')}. Actual exports: ${Object.keys(mod).join(', ') || '(none)'}`,
  );
}

/**
 * Create a unique temp directory that is removed when the test finishes.
 * @param {import('node:test').TestContext} t
 * @param {string} [prefix]
 * @returns {Promise<string>} absolute path
 */
export async function makeTempDir(t, prefix = 'cc-memory-test-') {
  if (!t || typeof t.after !== 'function') {
    throw new TypeError('makeTempDir(t, ...) requires a node:test TestContext so cleanup is registered');
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  // Background metrics writes can still be finishing when a test ends; retrying
  // keeps that race (ENOTEMPTY) from failing an otherwise passing test.
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

/**
 * Create a throwaway workspace (optionally a fake git repo root) plus a fake
 * home directory, all inside a temp dir.
 * @param {import('node:test').TestContext} t
 * @param {{git?: boolean, name?: string}} [options]
 * @returns {Promise<{tmp:string, workspaceDir:string, projectRoot:string, homeDir:string}>}
 */
export async function makeWorkspace(t, { git = false, name = 'workspace' } = {}) {
  const tmp = await makeTempDir(t);
  const workspaceDir = path.join(tmp, name);
  await mkdir(workspaceDir, { recursive: true });
  let projectRoot = workspaceDir;
  if (git) {
    projectRoot = tmp;
    await mkdir(path.join(tmp, '.git'), { recursive: true });
  }
  return { tmp, workspaceDir, projectRoot, homeDir: path.join(tmp, 'home') };
}

/** Split text into non-empty lines (tolerates CRLF and trailing newlines). */
export function splitLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  const text = String(haystack ?? '');
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

/** True when `child` is inside (or equal to) `parent`; both absolute paths. */
export function isInsidePath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Assert an async operation rejects with an error carrying the given `code`. */
export async function assertRejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(
      error && error.code,
      code,
      `expected rejection with code ${JSON.stringify(code)}, got: ${error && (error.code || error.message)}`,
    );
    return true;
  });
}

/** Compact error description for assertion messages. */
export function describeError(error) {
  if (!error) return String(error);
  return `${error.name || 'Error'}: ${error.message || String(error)}${error.code ? ` (code=${error.code})` : ''}`;
}

/**
 * A fake agent context shaped like a Cordis context: services through `get`,
 * `effect` runs the factory, `on` subscribes. Fields given in `services`
 * (and any `on`/`effect` override) win.
 */
export function withCordis(services) {
  return { get: (name) => services[name], effect: (factory) => factory(), on: () => () => {}, ...services };
}

/**
 * A Cordis-style `inject(deps, callback)` whose services are already up: the
 * callback runs at once, and disposing the fiber runs its effects' disposers.
 */
export function injectNow(ctx) {
  return (deps, callback) => {
    const stops = [];
    callback({ ...ctx, effect: (factory) => { const stop = factory(); stops.push(stop); return stop; } });
    return {
      dispose() {
        for (const stop of stops.splice(0)) if (typeof stop === 'function') stop();
      },
    };
  };
}
