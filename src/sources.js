/**
 * Note sources: repo-relative anchors (`path` or `path#symbol`) a note's facts
 * depend on. The host checks them against the project root with plain file
 * reads; there is no model call. A source is "broken" when its file is gone,
 * its symbol no longer appears in the file text, or it points outside the root.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_SOURCES = 10;
/** Larger files are not read for a symbol; the check says `unknown`, never broken. */
const MAX_SYMBOL_FILE_BYTES = 1024 * 1024;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_SOURCES' });
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Split `path#symbol` at the first `#`. */
export function parseSource(source) {
  const text = String(source ?? '').trim();
  const at = text.indexOf('#');
  return at < 0 ? { path: text, symbol: '' } : { path: text.slice(0, at).trim(), symbol: text.slice(at + 1).trim() };
}

/**
 * Validate the `sources` argument of a write: a list of at most ten
 * repo-relative paths, none absolute and none climbing out with `..`.
 * @returns {string[]|undefined} the cleaned list, or undefined when absent.
 */
export function normalizeSources(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw invalid('sources must be a list of repo-relative paths');
  const clean = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') throw invalid('each source must be a non-empty string');
    const text = item.trim().replace(/\\/g, '/');
    const { path: file } = parseSource(text);
    if (file === '' || path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.split('/').includes('..')) {
      throw invalid(`source must be a repo-relative path inside the project: ${item}`);
    }
    if (!clean.includes(text)) clean.push(text);
  }
  if (clean.length > MAX_SOURCES) throw invalid(`at most ${MAX_SOURCES} sources per note`);
  return clean;
}

/** Check one source: ok | missing | symbol-missing | outside | unknown. */
async function checkOne(root, source, withRevision) {
  const { path: file, symbol } = parseSource(source);
  const target = path.resolve(root, file);
  if (file === '' || path.isAbsolute(file) || !isInside(root, target)) return { source, status: 'outside' };
  let info;
  try {
    const [real, realRoot] = await Promise.all([fs.realpath(target), fs.realpath(root)]);
    if (!isInside(realRoot, real)) return { source, status: 'outside' };
    info = await fs.stat(real);
  } catch {
    return { source, status: 'missing' };
  }
  const details = withRevision ? { source, revision: `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}` } : { source };
  if (symbol === '' || !info.isFile()) return { ...details, status: 'ok' };
  if (info.size > MAX_SYMBOL_FILE_BYTES) return { ...details, status: 'unknown' };
  try {
    return { ...details, status: (await fs.readFile(target, 'utf8')).includes(symbol) ? 'ok' : 'symbol-missing' };
  } catch {
    return { source, status: 'missing' };
  }
}

/**
 * Check every source of one note against the project root.
 * @param {string} root project root (absolute).
 * @param {string[]} sources
 * @param {{withRevision?:boolean}} [options] Include a file revision for maintenance deduplication.
 * @returns {Promise<{items:Array<{source:string,status:string}>, broken:Array<{source:string,status:string}>}>}
 */
export async function checkSources(root, sources, { withRevision = false } = {}) {
  const list = Array.isArray(sources) ? sources.slice(0, MAX_SOURCES) : [];
  if (list.length === 0 || typeof root !== 'string' || root === '') return { items: [], broken: [] };
  const base = path.resolve(root);
  const items = await Promise.all(list.map((source) => checkOne(base, source, withRevision)));
  return { items, broken: items.filter((item) => item.status !== 'ok' && item.status !== 'unknown') };
}

/** One short line naming the broken sources, or ''. */
export function brokenNote(check) {
  if (!check || check.broken.length === 0) return '';
  return `sources changed; verify before relying: ${check.broken.map((item) => `${item.source} (${item.status})`).join(', ')}`;
}
