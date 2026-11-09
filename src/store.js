/**
 * Durable memory store: a `MEMORY.md` index plus one Markdown topic file per
 * memory, each with a small YAML frontmatter (`name`, `description`, `type`,
 * `modified`).
 *
 * Layout is owned by `src/paths.js`; this module only ever uses the resolved
 * absolute `paths.*` fields, so the same store serves both the project scope
 * (`paths.memoryDir`) and the optional cross-project user scope
 * (`paths.userMemoryDir`).
 *
 * Invariants:
 * - every write is atomic (temp file + rename) and refuses to follow a
 *   symbolic link, so a memory file cannot be redirected outside the memory
 *   directory;
 * - the index is rebuilt/patched after each write, so `MEMORY.md` and the
 *   topic files never drift;
 * - the index budget (200 lines / 25 KB by default) never blocks a write: the
 *   write succeeds and the result carries a warning, matching Claude Code's
 *   behaviour;
 * - errors carry a stable `code` (`INVALID_NAME`, `INVALID_TYPE`, `NOT_FOUND`,
 *   `PATH_ESCAPE`, `SCOPE_DISABLED`, `CONTENT_TOO_LARGE`) so tools and commands
 *   can turn them into structured results.
 *
 * @module dsh-cc-dream-memory/store
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import {
  SECRET_DETECTED,
  scanSecrets,
  secretScanDecision,
  secretScanMode,
  secretWarnings,
} from './secrets.js';

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

/** Cached dynamic import of the v10 cross-process write-lock module. */
let writeLockModulePromise = null;
function loadWriteLockModule() {
  if (writeLockModulePromise === null) {
    writeLockModulePromise = import('./lock.js').catch((error) => {
      warn('write lock unavailable', error);
      return null;
    });
  }
  return writeLockModulePromise;
}

/**
 * Windows can transiently refuse a rename over a destination another handle
 * holds (antivirus, editor, a concurrent reader). Retry those specific codes a
 * few times; every other failure surfaces immediately.
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function renameWithRetry(from, to) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!RENAME_RETRY_CODES.has(error?.code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Default index file name inside a memory directory. */
const INDEX_NAME = 'MEMORY.md';
/** Dream changelog file name (beside the memory directory). */
const CHANGELOG_NAME = '.dream-log.md';
/** Files the store never treats as topic entries nor lets callers rewrite raw. */
const RESERVED_FILES = new Set([INDEX_NAME, CHANGELOG_NAME]);
/** Topic file names accepted from callers: any Unicode letters/digits plus `.`, `_`, `-`. */
const MEMORY_FILE_RE = /^[\p{L}\p{N}._-]+\.md$/u;
/** Supported memory types. */
/** Compare inside the store write lock, before history, rename or deletion. */
function assertExpectedHash(raw, expectedHash, file) {
  if (expectedHash === undefined) return;
  if (typeof raw !== 'string' || createHash('sha256').update(raw).digest('hex') !== expectedHash) {
    throw memoryError('STALE_WRITE', `memory changed since this edit was proposed: ${file}`);
  }
}

export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference']);
const DEFAULT_TYPE = 'user';
const FALLBACK_TYPE = 'project';
const MAX_DESCRIPTION = 160;
const MAX_NAME = 200;
/** Slug length cap (code points) before a file name gets unwieldy. */
const MAX_SLUG_CHARS = 80;
/** Hash suffix length used to disambiguate colliding names. */
const CONFLICT_HASH_CHARS = 6;
/** Extra `-2`…`-5` attempts after the hash suffix, per FIXES-v2. */
const CONFLICT_ATTEMPTS = 5;
/** Fallback trash directory name when paths.trashRoot is absent. */
const TRASH_DIR_NAME = '.trash';
/** Directory-name timestamp used for one trash batch. */
function trashStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Build an Error carrying a stable memory error code. */
function memoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** A missing path (ENOENT/ENOTDIR) is not an error for reads. */
function isMissing(error) {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** Byte length of a UTF-8 string. */
function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** Normalize line endings. */
function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

/** Split text into lines without a trailing empty line. */
function splitLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  const parts = normalizeNewlines(text).split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Number of lines in a text blob (empty text has zero lines). */
function countLines(text) {
  return splitLines(text).length;
}

/** Truncate a UTF-8 string to at most `maxBytes`, never splitting a character. */
function truncateBytes(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, Math.trunc(maxBytes));
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/** Collapse arbitrary text to one trimmed line. */
function cleanInline(value) {
  if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/** Models often write a memory's name as a file name; the extension is not part of it. */
const withoutMdSuffix = (name) => name.replace(/\.md$/i, '').trim();

/**
 * Slug used in the topic file name: NFKC-normalized, lowercase, every run of
 * non-letter/non-digit characters collapsed to `_`, trimmed and capped at 80
 * code points. Unicode letters and digits are preserved, so a Chinese memory
 * name keeps its identity instead of collapsing to the generic `memory`
 * (which used to make two Chinese memories overwrite the same file).
 * An empty slug becomes `memory`.
 * @param {unknown} name
 * @returns {string}
 */
export function slugify(name) {
  const normalized = withoutMdSuffix(cleanInline(name)).normalize('NFKC').toLowerCase();
  const slug = normalized
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  const capped = Array.from(slug).slice(0, MAX_SLUG_CHARS).join('');
  return capped === '' ? 'memory' : capped;
}

/** Normalize a description to one line of at most 160 characters. */
function normalizeDescription(value) {
  return cleanInline(value).slice(0, MAX_DESCRIPTION).trim();
}

/** Normalize a name to one line of at most 200 characters. */
function normalizeName(value) {
  return withoutMdSuffix(cleanInline(value).slice(0, MAX_NAME).trim());
}

/** Normalize a body: `\n` newlines, no trailing newlines. */
function normalizeBody(content) {
  if (content === undefined || content === null) return '';
  return normalizeNewlines(content).replace(/\n+$/, '');
}

/** Is `child` inside `parent` (or equal)? */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Derive a type from the conventional `${type}_${slug}.md` file name. */
function typeFromFile(file) {
  const match = /^(user|feedback|project|reference)_/.exec(file);
  return match === null ? FALLBACK_TYPE : match[1];
}

/**
 * Normalize an optional write provenance into plain strings.
 * `source = { sessionId, via }` comes from tools, commands and the dream engine.
 * @param {unknown} source
 * @returns {{sessionId:string, via:string}}
 */
function normalizeSource(source) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return {
    sessionId: cleanInline(value.sessionId).slice(0, 200),
    via: cleanInline(value.via).slice(0, 64),
  };
}

/** Provenance fields of one parsed frontmatter bag ('' when absent). */
function provenanceOf(data) {
  const value = data && typeof data === 'object' ? data : {};
  return {
    created: cleanInline(value.created),
    sourceSession: cleanInline(value.source_session),
    via: cleanInline(value.via),
  };
}

/** Strip a trailing `.md` extension. */
function stripExtension(file) {
  return file.replace(/\.md$/i, '');
}

/** Resolve the scope name, accepting only the two supported scopes. */
function normalizeScope(scope) {
  if (scope === undefined || scope === null || scope === '') return 'project';
  if (scope === 'project' || scope === 'user') return scope;
  throw memoryError('INVALID_SCOPE', `unknown memory scope: ${String(scope)}`);
}

/** The type argument of a write, defaulted and validated. */
function normalizeType(value, fallback = DEFAULT_TYPE) {
  const type = cleanInline(value);
  if (type === '') return fallback;
  if (!MEMORY_TYPES.includes(type)) {
    throw memoryError('INVALID_TYPE', `memory type must be one of ${MEMORY_TYPES.join(', ')}: ${type}`);
  }
  return type;
}

/**
 * Validate one caller-supplied topic file name.
 * `..`, path separators and anything that is not a plain `.md` name are
 * rejected before any path is resolved.
 * @param {unknown} file
 * @returns {string} the validated file name.
 */
function validateFileName(file) {
  if (typeof file !== 'string') {
    throw memoryError('INVALID_NAME', 'memory file must be a file name string');
  }
  const name = file.trim();
  if (name === '') throw memoryError('INVALID_NAME', 'memory file must not be empty');
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw memoryError('PATH_ESCAPE', `memory file must not escape the memory directory: ${name}`);
  }
  if (!MEMORY_FILE_RE.test(name)) {
    throw memoryError('INVALID_NAME', `memory file must match ${MEMORY_FILE_RE.source}: ${name}`);
  }
  return name;
}

/** Build the canonical index line for one entry. */
function indexLine(meta) {
  return `- [${meta.name}](${meta.file}) — ${meta.description}`;
}

/** Extract the first Markdown link target of one index line. */
function referencedFile(line) {
  const match = /\]\(([^()]*)\)/.exec(line);
  if (match === null) return undefined;
  return match[1].trim();
}

/** True when one link target is a plain memory topic file name. */
function isIndexEntryReference(reference) {
  return typeof reference === 'string' && MEMORY_FILE_RE.test(reference);
}

/** Marker line used whenever the injected index is shortened. */
const INDEX_TRUNCATION_MARKER = '<!-- … index truncated for budget; oldest and newest lines kept … -->';

/**
 * Select whole index lines within both budgets. When bytes are the binding
 * limit, keep the oldest head and the newest tail (whole lines only) instead of
 * cutting the file mid-line, which used to hide recent entries.
 */
function selectIndexLinesWithinBudget(lines, maxLines, maxBytes) {
  const markerText = `${INDEX_TRUNCATION_MARKER}\n`;
  const markerBytes = byteLength(markerText);
  // A marker plus one line is the minimum useful representation.
  const byteCap = Math.max(0, maxBytes - markerBytes);
  const tailCap = Math.floor(byteCap * 0.5);
  const headCap = byteCap - tailCap;
  const head = [];
  const tail = [];
  let headBytes = 0;
  let tailBytes = 0;
  // Newest lines first (guarantees the latest entries survive byte pressure).
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const size = byteLength(`${lines[i]}\n`);
    if (tailBytes + size > tailCap) break;
    tail.unshift(lines[i]);
    tailBytes += size;
  }
  const headLimit = Math.min(lines.length - tail.length, lines.length);
  for (let i = 0; i < headLimit; i += 1) {
    const size = byteLength(`${lines[i]}\n`);
    if (headBytes + size > headCap) break;
    head.push(lines[i]);
    headBytes += size;
  }
  if (tail.length === 0 && lines.length > 0) {
    // Even the newest line is larger than half the budget: keep a clipped final
    // line so at least the newest entry is visible.
    const room = Math.max(0, maxBytes - markerBytes - byteLength('\n'));
    const clipped = truncateBytes(lines[lines.length - 1], room);
    return [...head, INDEX_TRUNCATION_MARKER, `${clipped}…`];
  }
  let selected = [...head, INDEX_TRUNCATION_MARKER, ...tail];
  // If byte selection was generous but the line budget is still smaller, keep
  // a head/tail split rather than dropping the whole tail.
  if (maxLines > 0 && selected.length > maxLines) {
    const trailing = Math.max(1, Math.min(lines.length, Math.floor((maxLines - 1) / 2)));
    const headCount = Math.max(0, maxLines - trailing - 1);
    let candidate = [...lines.slice(0, headCount), INDEX_TRUNCATION_MARKER, ...lines.slice(-trailing)];
    // Rebuilding from the original lines can exceed the byte budget; drop the
    // oldest middle lines first while always keeping the newest tail line.
    while (byteLength(`${candidate.join('\n')}\n`) > maxBytes && candidate.length > 2) {
      const markerAt = candidate.indexOf(INDEX_TRUNCATION_MARKER);
      if (markerAt > 1) candidate = [candidate[0], ...candidate.slice(2)];
      else break;
    }
    selected = candidate;
  }
  return selected;
}

/** Render one project's injected index head within the line/byte budget. */
function buildIndexHead(text, maxLines, maxBytes) {
  const all = splitLines(text);
  const render = (lines) => (lines.length > 0 ? `${lines.join('\n')}\n` : '');
  const totalLines = all.length;
  const totalBytes = byteLength(render(all));
  const total = { totalLines, totalBytes };
  const fits = (lines) =>
    (maxLines <= 0 || lines.length <= maxLines) && byteLength(render(lines)) <= maxBytes;
  if (fits(all)) {
    const head = render(all);
    return {
      text: head,
      lines: countLines(head),
      bytes: byteLength(head),
      truncated: false,
      overflow: false,
      maxLines,
      maxBytes,
      ...total,
    };
  }
  const selected = selectIndexLinesWithinBudget(all, maxLines, maxBytes);
  let head = render(selected);
  // Final safety net for a budget smaller than the marker itself: never emit a
  // broken UTF-8 or a half line, even if that means only the marker fits.
  if (byteLength(head) > maxBytes) {
    head = byteLength(INDEX_TRUNCATION_MARKER) <= maxBytes
      ? `${INDEX_TRUNCATION_MARKER}\n`
      : truncateBytes(INDEX_TRUNCATION_MARKER, maxBytes);
  }
  return {
    text: head,
    lines: countLines(head),
    bytes: byteLength(head),
    truncated: true,
    overflow: true,
    maxLines,
    maxBytes,
    ...total,
  };
}

/** Recursively count regular files below a directory. */
async function countFiles(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) total += await countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

/** Parse a dream backup directory name (ISO, also accepting `-` in the time). */
function backupTimestamp(name) {
  const iso = name.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1T$2:$3:$4');
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * One project's memory files and index.
 *
 * @example
 * const store = new MemoryStore({ paths, config });
 * await store.ensure();
 * await store.saveEntry({ name: 'user_role', type: 'user', description: 'Backend engineer', content: '...' });
 */
export class MemoryStore {
  /**
   * @param {{ paths: Record<string, string>, config?: Record<string, any>,
   *   getConfig?: () => Record<string, any> }} input
   *   `paths` is the object returned by `src/paths.js`. `config` is a config
   *   snapshot kept for backward compatibility; when `getConfig` is supplied the
   *   store reads every setting through it on demand, so runtime toggles
   *   (`/memory on|off`, `/memory user on|off`, config overrides) take effect in
   *   an already-created store without a reload.
   */
  constructor({ paths, config, getConfig } = {}) {
    if (!paths || typeof paths !== 'object') {
      throw new TypeError('MemoryStore requires a paths object');
    }
    if (typeof paths.memoryDir !== 'string' || paths.memoryDir === '') {
      throw new TypeError('MemoryStore requires paths.memoryDir');
    }
    this._paths = MemoryStore.resolvePaths(paths);
    this._config = config && typeof config === 'object' ? config : {};
    this._getConfig = typeof getConfig === 'function' ? getConfig : null;
    this._tail = Promise.resolve();
    this._ensured = null;
  }

  /**
   * Normalize a paths object, deriving any optional field the caller omitted so
   * the store still works with a minimal `{ memoryDir }`.
   * @param {Record<string, string>} paths
   * @returns {Record<string, string>}
   */
  static resolvePaths(paths) {
    const memoryDir = path.resolve(String(paths.memoryDir));
    const projectDir = paths.projectDir ? path.resolve(String(paths.projectDir)) : path.dirname(memoryDir);
    const root = paths.root ? path.resolve(String(paths.root)) : path.dirname(projectDir);
    const userMemoryDir = paths.userMemoryDir
      ? path.resolve(String(paths.userMemoryDir))
      : path.join(root, 'user', 'memory');
    return {
      ...paths,
      root,
      projectDir,
      memoryDir,
      indexFile: paths.indexFile ? path.resolve(String(paths.indexFile)) : path.join(memoryDir, INDEX_NAME),
      userMemoryDir,
      userIndexFile: paths.userIndexFile
        ? path.resolve(String(paths.userIndexFile))
        : path.join(userMemoryDir, INDEX_NAME),
      stateFile: paths.stateFile ? path.resolve(String(paths.stateFile)) : path.join(projectDir, '.state.json'),
      lockFile: paths.lockFile ? path.resolve(String(paths.lockFile)) : path.join(projectDir, '.consolidate-lock'),
      changelogFile: paths.changelogFile
        ? path.resolve(String(paths.changelogFile))
        : path.join(projectDir, CHANGELOG_NAME),
      dreamsDir: paths.dreamsDir ? path.resolve(String(paths.dreamsDir)) : path.join(projectDir, '.dreams'),
      pendingDir: paths.pendingDir ? path.resolve(String(paths.pendingDir)) : path.join(projectDir, '.pending'),
      // v10 cross-process write lock (Lead's paths.writeLockFile when present).
      writeLockFile: paths.writeLockFile
        ? path.resolve(String(paths.writeLockFile))
        : path.join(projectDir, '.write.lock'),
    };
  }

  /** Resolved absolute paths used by this store. */
  get paths() {
    return this._paths;
  }

  /**
   * Live plugin config used by this store. With a `getConfig` provider every
   * read reflects the current runtime config (v12 Bug 1); without one the
   * frozen constructor snapshot is returned.
   */
  get config() {
    if (this._getConfig !== null) {
      try {
        const current = this._getConfig();
        if (current && typeof current === 'object') return current;
      } catch (error) {
        warn('store config provider', error);
      }
    }
    return this._config;
  }

  /** Maximum index lines accepted before the warning triggers. */
  get indexMaxLines() {
    const value = Number(this.config.indexMaxLines);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 200;
  }

  /** Maximum index bytes accepted before the warning triggers. */
  get indexMaxBytes() {
    const value = Number(this.config.indexMaxBytes);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 25 * 1024;
  }

  /** Maximum lines of the independent user-scope index (v9). */
  get userIndexMaxLines() {
    const value = Number(this.config.userIndexMaxLines);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 30;
  }

  /** Maximum bytes of the independent user-scope index (v9). */
  get userIndexMaxBytes() {
    const value = Number(this.config.userIndexMaxBytes);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 4096;
  }

  /** Maximum bytes of one memory body. */
  get maxContentBytes() {
    const value = Number(this.config.maxContentBytes);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 128 * 1024;
  }

  /** Whether the cross-project user scope is enabled. */
  get userScopeEnabled() {
    return this.config.userMemoryEnabled === true;
  }

  /** Whether overwritten memory content is kept under `.history/` (v12). */
  get keepHistoryEnabled() {
    return this.config.keepHistory !== false;
  }

  /** Maximum history snapshots kept per memory file (v12). */
  get historyMaxPerFile() {
    const value = Number(this.config.historyMaxPerFile);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 20;
  }

  /** Absolute history root: `<projectDir>/.history`. */
  get historyRoot() {
    return path.join(this._paths.projectDir, '.history');
  }

  /**
   * Absolute soft-delete root. Uses `paths.trashRoot` when the paths builder
   * provides it (FIXES-v2) and otherwise falls back to `<projectDir>/.trash`,
   * so the store also works with a minimal paths object.
   */
  get trashRoot() {
    return this._paths.trashRoot
      ? path.resolve(String(this._paths.trashRoot))
      : path.join(this._paths.projectDir, TRASH_DIR_NAME);
  }

  // ---------------------------------------------------------------------------
  // Scope and path helpers
  // ---------------------------------------------------------------------------

  /** Directory that stores the given scope's memory files. */
  _scopeDir(scope) {
    return scope === 'user' ? this._paths.userMemoryDir : this._paths.memoryDir;
  }

  /** Index file of the given scope. */
  _indexFile(scope) {
    return scope === 'user' ? this._paths.userIndexFile : this._paths.indexFile;
  }

  /** Index file name of the given scope. */
  _indexName(scope) {
    return path.basename(this._indexFile(scope));
  }

  /**
   * Read-side scope check: a disabled user scope behaves as if it were empty.
   * @returns {boolean} whether reads should return an empty value.
   */
  _scopeReadable(scope) {
    if (scope !== 'user') return true;
    if (this.userScopeEnabled) return true;
    return false;
  }

  /** Write-side scope check: a disabled user scope rejects every write. */
  _assertScopeWritable(scope) {
    if (scope === 'user' && !this.userScopeEnabled) {
      throw memoryError('SCOPE_DISABLED', 'user memory scope is disabled (userMemoryEnabled=false)');
    }
  }

  /** Read-side path for one entry; a disabled user scope reports NOT_FOUND. */
  _readableEntry(file, scope) {
    if (scope === 'user' && !this.userScopeEnabled) {
      throw memoryError('NOT_FOUND', `user memory scope is disabled: ${String(file)}`);
    }
    return this._entryTarget(file, scope);
  }

  /** Resolve one validated file name to its absolute target inside the scope. */
  _entryTarget(file, scope) {
    const name = validateFileName(file);
    const dir = this._scopeDir(scope);
    const target = path.resolve(dir, name);
    if (!isInside(dir, target)) {
      throw memoryError('PATH_ESCAPE', `memory file must resolve inside ${dir}: ${name}`);
    }
    return { name, target };
  }

  /** Serialize mutating operations so index read-modify-write cannot interleave. */
  _run(operation) {
    const locked = () => this._withWriteLock(operation);
    const next = this._tail.then(locked, locked);
    this._tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Run one mutating operation under the cross-process write lock (v10).
   * The lock module is imported lazily; when it is unavailable (older build or
   * import failure) the operation still runs unlocked so memory writes never
   * wedge. `ttlMs` tolerates a crashed writer, `waitMs` bounds the contention
   * wait and the lock module itself degrades to best-effort past that budget.
   * @param {() => Promise<any>} operation
   */
  async _withWriteLock(operation) {
    const lockFile = this._paths.writeLockFile;
    if (typeof lockFile !== 'string' || lockFile === '') return operation();
    let lockModule;
    try {
      lockModule = await loadWriteLockModule();
    } catch (error) {
      warn('write lock', error);
      return operation();
    }
    if (!lockModule || typeof lockModule.withFileLock !== 'function') return operation();
    return lockModule.withFileLock(lockFile, operation, {
      ttlMs: 30_000,
      waitMs: 2_000,
      onDegrade: (error) => warn('write lock degrade', error),
    });
  }

  /** Read a text file, returning `undefined` when it does not exist. */
  async _readText(file) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** Whether a path exists (without following a final symbolic link). */
  async _exists(file) {
    try {
      await fs.lstat(file);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  /**
   * Atomic write: temp file in the same directory, then rename.
   * A final symbolic link is refused instead of followed.
   */
  async _atomicWrite(target, data) {
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true });
    try {
      const existing = await fs.lstat(target);
      if (existing.isSymbolicLink()) {
        throw memoryError('PATH_ESCAPE', `refusing to write through symbolic link: ${path.basename(target)}`);
      }
    } catch (error) {
      if (error?.code === 'PATH_ESCAPE') throw error;
      if (!isMissing(error)) throw error;
    }
    const temporary = path.join(
      dir,
      `.${path.basename(target)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    try {
      await fs.writeFile(temporary, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await renameWithRetry(temporary, target);
    } catch (error) {
      try {
        await fs.unlink(temporary);
      } catch {
        // The temporary file may never have been created; nothing to clean.
      }
      throw error;
    }
  }

  /** Reject a symbolic link / non-file target before reading it. */
  async _assertReadableFile(target, file) {
    let info;
    try {
      info = await fs.lstat(target);
    } catch (error) {
      if (isMissing(error)) throw memoryError('NOT_FOUND', `memory file not found: ${file}`);
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw memoryError('PATH_ESCAPE', `refusing to follow symbolic link: ${file}`);
    }
    if (!info.isFile()) throw memoryError('NOT_FOUND', `memory file not found: ${file}`);
    return info;
  }

  // ---------------------------------------------------------------------------
  // Index helpers
  // ---------------------------------------------------------------------------

  /**
   * Measure index text against the configured budget of one scope.
   * The user scope has its own independent (smaller) v9 budget.
   */
  _budget(text, scope = 'project') {
    const lines = countLines(text);
    const bytes = byteLength(text);
    const maxLines = scope === 'user' ? this.userIndexMaxLines : this.indexMaxLines;
    const maxBytes = scope === 'user' ? this.userIndexMaxBytes : this.indexMaxBytes;
    const overflow = lines > maxLines || bytes > maxBytes;
    const budget = { lines, bytes, maxLines, maxBytes, overflow };
    const nearLimit = !overflow && maxLines > 0 && maxBytes > 0
      && (lines / maxLines >= 0.8 || bytes / maxBytes >= 0.8);
    if (nearLimit) budget.nearLimit = true;
    if (overflow) {
      budget.warning =
        `index is over budget (${lines} lines/${bytes} bytes) and the injected index will be truncated; ` +
        'merge related notes with memory_update (delete: true removes one); the human can consolidate from the Memory page (Dry run) or /dream run';
    } else if (nearLimit) {
      budget.warning =
        `index is nearing budget (${lines}/${maxLines} lines, ${bytes}/${maxBytes} bytes), ` +
        'merge related notes with memory_update (delete: true removes one) before adding more';
    }
    return budget;
  }

  /** Write one index file (caller already holds the write lock). */
  async _writeIndexLocked(scope, text) {
    const indexFile = this._indexFile(scope);
    await this._atomicWrite(indexFile, text);
    return this._budget(text, scope);
  }

  /** Insert or replace the index line of one entry (caller holds the lock). */
  async _upsertIndexLine(scope, meta) {
    const indexFile = this._indexFile(scope);
    const existing = (await this._readText(indexFile)) ?? '';
    const lines = splitLines(existing);
    const line = indexLine(meta);
    const needle = `](${meta.file})`;
    const next = [];
    let replaced = false;
    for (const candidate of lines) {
      if (candidate.includes(needle)) {
        if (!replaced) {
          next.push(line);
          replaced = true;
        }
        continue;
      }
      next.push(candidate);
    }
    if (!replaced) next.push(line);
    const text = next.length > 0 ? `${next.join('\n')}\n` : '';
    return this._writeIndexLocked(scope, text);
  }

  /** Remove the index line of one entry (caller holds the lock). */
  async _removeIndexLine(scope, file) {
    const indexFile = this._indexFile(scope);
    const existing = (await this._readText(indexFile)) ?? '';
    const needle = `](${file})`;
    const lines = splitLines(existing).filter((line) => !line.includes(needle));
    const text = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    return this._writeIndexLocked(scope, text);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create the memory directory and an empty `MEMORY.md` when needed.
   * Idempotent; the runtime calls this whenever it resolves a project.
   * @returns {Promise<void>}
   */
  ensure() {
    if (this._ensured === null) {
      this._ensured = this._run(async () => {
        await fs.mkdir(this._paths.memoryDir, { recursive: true });
        if (!(await this._exists(this._paths.indexFile))) {
          await this._atomicWrite(this._paths.indexFile, '');
        }
      }).catch((error) => {
        this._ensured = null;
        throw error;
      });
    }
    return this._ensured;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Raw index text of one scope (`''` when the file or scope is absent).
   * @param {'project'|'user'} [scope]
   * @returns {Promise<string>}
   */
  async indexText(scope = 'project') {
    const normalized = normalizeScope(scope);
    if (!this._scopeReadable(normalized)) return '';
    return (await this._readText(this._indexFile(normalized))) ?? '';
  }

  /**
   * The index head that the prompt receives: the first `maxLines` lines and the
   * first `maxBytes` bytes, whichever is smaller.
   *
   * The optional second argument overrides the scope budget. Without it the
   * project scope uses `indexMaxLines/Bytes` and the user scope uses its own
   * independent `userIndexMaxLines/Bytes` (v9: 30 lines / 4 KiB).
   * @param {'project'|'user'} [scope]
   * @param {{maxLines?:number, maxBytes?:number}} [budget]
   * @returns {Promise<{text:string,lines:number,bytes:number,truncated:boolean,
   *   overflow:boolean,maxLines:number,maxBytes:number}>}
   */
  async injectedIndex(scope = 'project', budget = {}) {
    const normalized = normalizeScope(scope);
    const limits = budget && typeof budget === 'object' && !Array.isArray(budget) ? budget : {};
    const maxLinesValue = Number(limits.maxLines);
    const maxBytesValue = Number(limits.maxBytes);
    const fallbackLines = normalized === 'user' ? this.userIndexMaxLines : this.indexMaxLines;
    const fallbackBytes = normalized === 'user' ? this.userIndexMaxBytes : this.indexMaxBytes;
    const maxLines =
      Number.isFinite(maxLinesValue) && maxLinesValue > 0 ? Math.trunc(maxLinesValue) : fallbackLines;
    const maxBytes =
      Number.isFinite(maxBytesValue) && maxBytesValue > 0 ? Math.trunc(maxBytesValue) : fallbackBytes;
    const text = this._scopeReadable(normalized) ? await this.indexText(normalized) : '';
    return buildIndexHead(text, maxLines, maxBytes);
  }

  /**
   * Every topic file in one scope, sorted by file name.
   * @param {'project'|'user'} [scope]
   * @returns {Promise<Array<{file:string,name:string,description:string,type:string,
   *   modified:string,bytes:number,lines:number}>>}
   */
  async listEntries(scope = 'project') {
    const normalized = normalizeScope(scope);
    if (!this._scopeReadable(normalized)) return [];
    const dir = this._scopeDir(normalized);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const indexName = this._indexName(normalized);
    const entries = [];
    for (const name of names.sort()) {
      if (!MEMORY_FILE_RE.test(name) || name === indexName || RESERVED_FILES.has(name)) continue;
      let raw;
      try {
        raw = await fs.readFile(path.join(dir, name), 'utf8');
      } catch (error) {
        if (isMissing(error)) continue;
        continue;
      }
      const parsed = parseFrontmatter(raw);
      entries.push(this._entryMeta(name, parsed, raw));
    }
    return entries;
  }

  /** Build one `EntryMeta` from a parsed file. */
  _entryMeta(file, parsed, raw) {
    const data = parsed.data;
    return {
      file,
      name: normalizeName(data.name) || stripExtension(file),
      description: normalizeDescription(data.description),
      type: MEMORY_TYPES.includes(cleanInline(data.type)) ? cleanInline(data.type) : typeFromFile(file),
      modified: cleanInline(data.modified),
      created: cleanInline(data.created),
      sourceSession: cleanInline(data.source_session),
      via: cleanInline(data.via),
      bytes: byteLength(raw),
      lines: countLines(raw),
    };
  }

  /**
   * Read one memory file in full.
   * @param {string} file topic file name.
   * @param {'project'|'user'} [scope]
   * @returns {Promise<{file:string,scope:string,frontmatter:{name:string,
   *   description:string,type:string,modified:string},body:string,raw:string,bytes:number}>}
   */
  async readEntry(file, scope = 'project') {
    const normalized = normalizeScope(scope);
    const { name, target } = this._readableEntry(file, normalized);
    await this._assertReadableFile(target, name);
    const raw = await fs.readFile(target, 'utf8');
    const parsed = parseFrontmatter(raw);
    const meta = this._entryMeta(name, parsed, raw);
    return {
      file: name,
      scope: normalized,
      frontmatter: {
        name: meta.name,
        description: meta.description,
        type: meta.type,
        modified: meta.modified,
        created: meta.created,
        source_session: meta.sourceSession,
        via: meta.via,
      },
      body: parsed.body,
      raw,
      bytes: byteLength(raw),
    };
  }

  /** Frontmatter fields normalized for safe reuse by update/write paths. */
  _frontmatterOf(data, file, { fallbackName } = {}) {
    const type = MEMORY_TYPES.includes(cleanInline(data.type)) ? cleanInline(data.type) : typeFromFile(file);
    const provenance = provenanceOf(data);
    return {
      name: normalizeName(data.name) || fallbackName || stripExtension(file),
      description: normalizeDescription(data.description),
      type,
      modified: cleanInline(data.modified),
      created: provenance.created,
      sourceSession: provenance.sourceSession,
      via: provenance.via,
    };
  }

  /**
   * Compose one memory file's text, attributing the write when provenance is
   * available.
   *
   * Provenance fields are only written when the caller supplies a `source` or
   * the file already carried them, so plain writes and legacy files keep the
   * original four-field frontmatter. `created` is the first-write timestamp and
   * survives every later update. `preserveCreatedAbsence` (used by the v10 raw
   * editor path) keeps a legacy file without `created` from gaining one on
   * update; the normal update path stamps it on the first attributed update.
   * @param {{name:string,description:string,type:string,modified:string,
   *   body:string,existing?:Record<string,string>,source?:object,
   *   preserveCreatedAbsence?:boolean}} input
   * @returns {string} memory file text
   */
  _composeFrontmatter({ name, description, type, modified, body, existing, source, preserveCreatedAbsence = false }) {
    const src = normalizeSource(source);
    const prior = existing && typeof existing === 'object' ? existing : {};
    const hadProvenance =
      cleanInline(prior.created) !== '' ||
      cleanInline(prior.via) !== '' ||
      cleanInline(prior.source_session) !== '';
    const wantsProvenance = hadProvenance || src.via !== '' || src.sessionId !== '';
    const fields = { name, description, type, modified };
    if (wantsProvenance) {
      // `created` is the first-write timestamp: a creation gets one, an update
      // keeps the existing one, and (only on the raw editor path) a legacy file
      // with no `created` stays without one.
      const priorCreated = cleanInline(prior.created);
      const isNewFile = existing === undefined || existing === null || typeof existing !== 'object';
      const created = priorCreated !== ''
        ? priorCreated
        : isNewFile
          ? modified
          : preserveCreatedAbsence
            ? ''
            : modified;
      if (created !== '') fields.created = created;
      const via = src.via || cleanInline(prior.via);
      if (via !== '') fields.via = via;
      const sessionId = src.sessionId || cleanInline(prior.source_session);
      if (sessionId !== '') fields.source_session = sessionId;
    }
    return stringifyFrontmatter(fields, body);
  }

  /**
   * Scan text for credentials and enforce the v11 severity policy.
   *
   * - `secretScan:'off'` disables the scan entirely;
   * - a deny-severity match (unambiguous credential format) always refuses the
   *   write, even in the default `warn` mode;
   * - warn-severity heuristics (generic assignments, high-entropy blobs) only
   *   add warnings, except in the strict `deny` mode where they refuse too.
   *
   * @param {string} text
   * @returns {{warnings:string[]}} secret warnings to surface on the result.
   * @throws {Error} code `SECRET_DETECTED` when a match must block the write.
   */
  _scanContent(text) {
    const mode = secretScanMode(this.config);
    if (mode === 'off') return { warnings: [] };
    const scan = scanSecrets(typeof text === 'string' ? text : '');
    const decision = secretScanDecision(scan, this.config);
    const warnings = secretWarnings(scan.matches);
    if (decision.block) {
      const error = memoryError(
        SECRET_DETECTED,
        `refusing to write memory: possible secret detected (${warnings.join('; ')})`,
      );
      error.matches = scan.matches;
      error.warnings = warnings;
      throw error;
    }
    return { warnings };
  }

  // ---------------------------------------------------------------------------
  // Overwrite history (v12 design 1)
  // ---------------------------------------------------------------------------

  /**
   * Keep one copy of a memory file's previous content before it is overwritten:
   * `<projectDir>/.history/<file>/<ts>-<hash8>.md`. Enabled by default
   * (`config.keepHistory !== false`); only the newest `historyMaxPerFile`
   * snapshots are retained. Strictly best-effort: a history failure must never
   * block or fail the memory write itself.
   * @param {string} file validated topic file name
   * @param {string|undefined} raw the content that is about to be replaced
   */
  async _recordHistory(file, raw) {
    if (typeof raw !== 'string' || raw === '') return;
    if (!this.keepHistoryEnabled || this.historyMaxPerFile <= 0) return;
    try {
      const dir = path.join(this.historyRoot, file);
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
      const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8);
      await fs.writeFile(path.join(dir, `${stamp}-${digest}.md`), raw, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await this._pruneHistory(dir);
    } catch (error) {
      warn('memory history', error);
    }
  }

  /**
   * Delete the oldest snapshots of one history directory down to the configured
   * maximum. Snapshot names start with a timestamp, so lexical order is age
   * order. Best-effort.
   * @param {string} dir history directory for one memory file
   */
  async _pruneHistory(dir) {
    const max = this.historyMaxPerFile;
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    const snapshots = names.filter((name) => name.endsWith('.md')).sort();
    const excess = snapshots.length - max;
    for (const name of snapshots.slice(0, Math.max(0, excess))) {
      try {
        await fs.unlink(path.join(dir, name));
      } catch {
        /* best-effort pruning */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Create or update one memory from a name/type/description/content.
   *
   * The base file name is `${type}_${slug(name)}.md`. When that file already
   * belongs to a *different* memory name (two names normalizing to the same
   * slug), a `-<sha1(name)[0..6]>` suffix is appended, then `-2`…`-5`; an
   * existing file whose frontmatter name matches is updated in place. This is
   * the P0-2 guarantee: two Chinese memory names must not collapse onto the
   * same `user_memory.md`.
   *
   * @param {{scope?:'project'|'user',name:string,type?:string,description?:string,
   *   content?:string}} input
   * @returns {Promise<object>} SaveResult
   */
  saveEntry(input = {}) {
    return this._run(async () => {
      const scope = normalizeScope(input.scope);
      this._assertScopeWritable(scope);
      const name = normalizeName(input.name);
      if (name === '') {
        throw memoryError('INVALID_NAME', 'memory name must be a non-empty string');
      }
      const type = normalizeType(input.type ?? DEFAULT_TYPE);
      const description = normalizeDescription(input.description);
      const body = normalizeBody(input.content);
      if (byteLength(body) > this.maxContentBytes) {
        throw memoryError(
          'CONTENT_TOO_LARGE',
          `memory content is ${byteLength(body)} bytes, limit is ${this.maxContentBytes} bytes`,
        );
      }
      const scan = this._scanContent(`${name}\n${description}\n${body}`);
      const { file, created, existing } = await this._chooseSaveFile(scope, type, name);
      const { target } = this._entryTarget(file, scope);
      const modified = new Date().toISOString();
      const raw = this._composeFrontmatter({
        name,
        description,
        type,
        modified,
        body,
        existing,
        source: input.source,
      });
      // v12: keep the replaced version before overwriting an existing memory.
      if (!created) await this._recordHistory(file, await this._readText(target));
      await this._atomicWrite(target, raw);
      const index = await this._upsertIndexLine(scope, { file, name, description });
      return {
        ok: true,
        file,
        name,
        type,
        created,
        description,
        index,
        ...(scan.warnings.length > 0 ? { warnings: scan.warnings } : {}),
        ...(index.warning === undefined ? {} : { warning: index.warning }),
      };
    });
  }

  /**
   * Pick the topic file for one save, keeping colliding names apart.
   * @returns {Promise<{file:string, created:boolean, existing:Record<string,string>|undefined}>}
   */
  async _chooseSaveFile(scope, type, name) {
    const dir = this._scopeDir(scope);
    const base = `${type}_${slugify(name)}`;
    const digest = createHash('sha1').update(name, 'utf8').digest('hex').slice(0, CONFLICT_HASH_CHARS);
    const candidates = [`${base}.md`, `${base}-${digest}.md`];
    for (let attempt = 2; attempt <= CONFLICT_ATTEMPTS; attempt += 1) {
      candidates.push(`${base}-${digest}-${attempt}.md`);
    }
    for (const candidate of candidates) {
      const target = path.join(dir, candidate);
      if (!(await this._exists(target))) return { file: candidate, created: true, existing: undefined };
      const existing = await this._readEntryData(target);
      if (normalizeName(existing?.name) === name) return { file: candidate, created: false, existing };
    }
    // Five hash/counter collisions: mint a fresh name instead of overwriting.
    const fallback = createHash('sha1')
      .update(`${name}\u0000${Date.now()}\u0000${Math.random()}`)
      .digest('hex')
      .slice(0, 10);
    return { file: `${base}-${fallback}.md`, created: true, existing: undefined };
  }

  /** Parsed frontmatter of a topic file, or `undefined` when unreadable. */
  async _readEntryData(target) {
    try {
      const raw = await fs.readFile(target, 'utf8');
      return parseFrontmatter(raw).data;
    } catch {
      return undefined;
    }
  }

  /**
   * Update the body and/or description of an existing memory in place.
   * @param {string} file topic file name.
   * @param {{scope?:'project'|'user',content?:string,description?:string}} [changes]
   * @returns {Promise<object>} SaveResult
   */
  updateEntry(file, changes = {}) {
    return this._run(async () => {
      const scope = normalizeScope(changes.scope);
      // A disabled user scope reads as absent, so updating reports NOT_FOUND
      // (only saveEntry reports SCOPE_DISABLED, per the interface contract).
      if (scope === 'user' && !this.userScopeEnabled) {
        throw memoryError('NOT_FOUND', `user memory scope is disabled: ${String(file)}`);
      }
      const { name, target } = this._entryTarget(file, scope);
      const raw = await this._readText(target);
      if (raw === undefined) throw memoryError('NOT_FOUND', `memory file not found: ${name}`);
      assertExpectedHash(raw, changes.expectedHash, name);
      const parsed = parseFrontmatter(raw);
      const existing = this._frontmatterOf(parsed.data, name);
      const body = changes.content === undefined ? parsed.body : normalizeBody(changes.content);
      if (byteLength(body) > this.maxContentBytes) {
        throw memoryError(
          'CONTENT_TOO_LARGE',
          `memory content is ${byteLength(body)} bytes, limit is ${this.maxContentBytes} bytes`,
        );
      }
      const description =
        changes.description === undefined ? existing.description : normalizeDescription(changes.description);
      const scan = this._scanContent(`${existing.name}\n${description}\n${body}`);
      const modified = new Date().toISOString();
      const next = this._composeFrontmatter({
        name: existing.name,
        description,
        type: existing.type,
        modified,
        body,
        existing: parsed.data,
        source: changes.source,
        // v12: the pending-review approver preserves a legacy file's missing
        // `created` instead of inventing one at approval time.
        preserveCreatedAbsence: changes.preserveCreatedAbsence === true,
      });
      // v12: keep the previous version before it is replaced.
      await this._recordHistory(name, raw);
      await this._atomicWrite(target, next);
      const index = await this._upsertIndexLine(scope, {
        file: name,
        name: existing.name,
        description,
      });
      return {
        ok: true,
        file: name,
        name: existing.name,
        type: existing.type,
        created: false,
        description,
        index,
        ...(scan.warnings.length > 0 ? { warnings: scan.warnings } : {}),
        ...(index.warning === undefined ? {} : { warning: index.warning }),
      };
    });
  }

  /**
   * Rename one memory: write a new slug file with the same body, trash the old
   * file (recoverable) and move its index line. Used by memory_update's `name`.
   * @param {string} file old topic file.
   * @param {string} newName new human name; file slug is derived from it.
   * @param {{scope?:'project'|'user',source?:string}} [options]
   */
  renameEntry(file, newName, options = {}) {
    return this._run(async () => {
      const scope = normalizeScope(options.scope);
      if (scope === 'user' && !this.userScopeEnabled) {
        throw memoryError('NOT_FOUND', `user memory scope is disabled: ${String(file)}`);
      }
      const { name: oldFile, target } = this._entryTarget(file, scope);
      const raw = await this._readText(target);
      if (raw === undefined) throw memoryError('NOT_FOUND', `memory file not found: ${oldFile}`);
      assertExpectedHash(raw, options.expectedHash, oldFile);
      const parsed = parseFrontmatter(raw);
      const existing = this._frontmatterOf(parsed.data, oldFile);
      const cleanName = normalizeName(newName);
      if (cleanName === '') throw memoryError('INVALID_NAME', 'new name must be a non-empty string');
      const hasBodyChange = options.content !== undefined || options.description !== undefined;
      if (cleanName === existing.name && !hasBodyChange) {
        return { ok: true, file: oldFile, name: existing.name, type: existing.type, description: existing.description, renamed: false };
      }
      const newFile = `${existing.type}_${slugify(cleanName)}.md`;
      // A case-only rename points at the same file on Windows; rewrite it in
      // place instead of reporting a spurious conflict.
      const sameFile = newFile.toLowerCase() === oldFile.toLowerCase();
      const newTarget = sameFile ? target : this._entryTarget(newFile, scope).target;
      if (!sameFile && (RESERVED_FILES.has(newFile) || (await this._exists(newTarget)))) {
        throw memoryError('CONFLICT', `a memory file already exists for name: ${cleanName}`);
      }
      // Validate body/description BEFORE touching disk so a rejected rename
      // cannot leave a renamed file with stale content.
      const body = options.content === undefined ? parsed.body : normalizeBody(options.content);
      if (byteLength(body) > this.maxContentBytes) {
        throw memoryError(
          'CONTENT_TOO_LARGE',
          `memory content is ${byteLength(body)} bytes, limit is ${this.maxContentBytes} bytes`,
        );
      }
      const description =
        options.description === undefined ? existing.description : normalizeDescription(options.description);
      const scan = this._scanContent(`${cleanName}\n${description}\n${body}`);
      const next = this._composeFrontmatter({
        name: cleanName,
        description,
        type: existing.type,
        modified: new Date().toISOString(),
        body,
        existing: parsed.data,
        source: options.source,
      });
      await this._recordHistory(oldFile, raw);
      await this._atomicWrite(newTarget, next);
      if (!sameFile) {
        // Inline the trash move: calling trashEntry() would re-enter this._run()
        // and deadlock on the store's write lock.
        const trashDir = path.join(this.trashRoot, trashStamp());
        await fs.mkdir(trashDir, { recursive: true });
        const trashPath = await this._uniqueTrashPath(trashDir, oldFile);
        try {
          await fs.rename(target, trashPath);
        } catch {
          await fs.copyFile(target, trashPath);
          await fs.unlink(target);
        }
        await this._removeIndexLine(scope, oldFile);
      }
      const finalFile = sameFile ? oldFile : newFile;
      const index = await this._upsertIndexLine(scope, {
        file: finalFile,
        name: cleanName,
        description,
      });
      return {
        ok: true,
        file: finalFile,
        ...(sameFile ? {} : { oldFile }),
        name: cleanName,
        type: existing.type,
        description,
        renamed: true,
        index,
        ...(scan.warnings.length > 0 ? { warnings: scan.warnings } : {}),
      };
    });
  }

  /**
   * Write a memory file with explicit name/type/description/body.
   * Used by the dream engine applying a whole-file plan; the canonical
   * `MEMORY.md` index line is maintained like any other write.
   * @param {string} file topic file name.
   * @param {{scope?:'project'|'user',type?:string,name?:string,description?:string,
   *   body?:string,content?:string}} [input]
   * @returns {Promise<object>} SaveResult
   */
  writeRawEntry(file, input = {}) {
    return this._run(async () => {
      const scope = normalizeScope(input.scope);
      this._assertScopeWritable(scope);
      const { name: fileName, target } = this._entryTarget(file, scope);
      if (RESERVED_FILES.has(fileName)) {
        throw memoryError('INVALID_NAME', `reserved memory file: ${fileName}`);
      }
      const existingRaw = await this._readText(target);
      const existingData = existingRaw === undefined ? undefined : parseFrontmatter(existingRaw).data;
      const existing = this._frontmatterOf(existingData ?? {}, fileName, {
        fallbackName: stripExtension(fileName),
      });
      const name = normalizeName(input.name) || existing.name;
      const type = normalizeType(input.type, existing.type);
      const description =
        input.description === undefined ? existing.description : normalizeDescription(input.description);
      const body = normalizeBody(input.body !== undefined ? input.body : input.content);
      if (byteLength(body) > this.maxContentBytes) {
        throw memoryError(
          'CONTENT_TOO_LARGE',
          `memory content is ${byteLength(body)} bytes, limit is ${this.maxContentBytes} bytes`,
        );
      }
      const created = existingRaw === undefined;
      const scan = this._scanContent(`${name}\n${description}\n${body}`);
      const modified = new Date().toISOString();
      const raw = this._composeFrontmatter({
        name,
        description,
        type,
        modified,
        body,
        existing: existingData,
        source: input.source,
        preserveCreatedAbsence: true,
      });
      // v12: raw dream/apply writes also keep the overwritten version.
      if (existingRaw !== undefined) await this._recordHistory(fileName, existingRaw);
      await this._atomicWrite(target, raw);
      const index = await this._upsertIndexLine(scope, { file: fileName, name, description });
      return {
        ok: true,
        file: fileName,
        name,
        type,
        created,
        description,
        index,
        ...(scan.warnings.length > 0 ? { warnings: scan.warnings } : {}),
        ...(index.warning === undefined ? {} : { warning: index.warning }),
      };
    });
  }

  /**
   * Replace one scope's index file with the supplied text.
   * Over-budget text is still written; the returned budget carries the warning.
   * @param {string} text
   * @param {'project'|'user'} [scope]
   * @returns {Promise<object>} IndexBudget
   */
  writeIndex(text, scope = 'project') {
    return this._run(async () => {
      const normalized = normalizeScope(scope);
      this._assertScopeWritable(normalized);
      const content = normalizeNewlines(text === undefined || text === null ? '' : String(text));
      const payload = content === '' || content.endsWith('\n') ? content : `${content}\n`;
      return this._writeIndexLocked(normalized, payload);
    });
  }

  /**
   * Delete one memory file and its index line.
   * @param {string} file topic file name.
   * @param {'project'|'user'} [scope]
   * @returns {Promise<{deleted:boolean,file:string}>}
   */
  deleteEntry(file, scope = 'project') {
    return this._run(async () => {
      const normalized = normalizeScope(scope);
      if (normalized === 'user' && !this.userScopeEnabled) {
        throw memoryError('NOT_FOUND', `user memory scope is disabled: ${String(file)}`);
      }
      const { name, target } = this._entryTarget(file, normalized);
      if (RESERVED_FILES.has(name)) {
        throw memoryError('INVALID_NAME', `refusing to delete reserved memory file: ${name}`);
      }
      if (!(await this._exists(target))) return { deleted: false, file: name };
      await fs.unlink(target);
      await this._removeIndexLine(normalized, name);
      return { deleted: true, file: name };
    });
  }

  /**
   * Soft-delete one memory: move the file into `paths.trashRoot/<timestamp>/`
   * and remove its index line. The file stays recoverable, which is why the
   * dream engine and the `memory_delete` tool use this instead of `deleteEntry`.
   * `deleteEntry` remains the hard delete for tests and legacy callers.
   * @param {string} file topic file name.
   * @param {{scope?:'project'|'user',reason?:string}} [options]
   * @returns {Promise<{trashed:true,file:string,trashPath:string,trashDir:string,reason:string}>}
   */
  trashEntry(file, options = {}) {
    return this._run(async () => {
      const normalized = normalizeScope(options.scope);
      if (normalized === 'user' && !this.userScopeEnabled) {
        throw memoryError('NOT_FOUND', `user memory scope is disabled: ${String(file)}`);
      }
      const { name, target } = this._entryTarget(file, normalized);
      if (RESERVED_FILES.has(name)) {
        throw memoryError('INVALID_NAME', `refusing to trash reserved memory file: ${name}`);
      }
      await this._assertReadableFile(target, name);
      if (options.expectedHash !== undefined) assertExpectedHash(await this._readText(target), options.expectedHash, name);
      const trashDir = path.join(this.trashRoot, trashStamp());
      await fs.mkdir(trashDir, { recursive: true });
      const trashPath = await this._uniqueTrashPath(trashDir, name);
      try {
        await fs.rename(target, trashPath);
      } catch {
        // Cross-device move or a locked file: copy then unlink.
        await fs.copyFile(target, trashPath);
        await fs.unlink(target);
      }
      const reason = typeof options.reason === 'string' ? options.reason.trim().slice(0, 500) : '';
      if (reason !== '') {
        try {
          await fs.writeFile(`${trashPath}.reason.txt`, `${reason}\n`, 'utf8');
        } catch {
          // The audit sidecar is best-effort; the file is already safe in trash.
        }
      }
      await this._removeIndexLine(normalized, name);
      return { trashed: true, file: name, trashPath, trashDir, reason };
    });
  }

  /** First free path for one trashed file inside a trash batch directory. */
  async _uniqueTrashPath(dir, file) {
    const stem = stripExtension(file);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = path.join(dir, attempt === 0 ? file : `${stem}-${attempt}.md`);
      if (!(await this._exists(candidate))) return candidate;
    }
    return path.join(dir, `${stem}-${Date.now()}.md`);
  }

  // ---------------------------------------------------------------------------
  // Index consistency (audit / reconcile)
  // ---------------------------------------------------------------------------

  /**
   * Compare the on-disk topic files with the index.
   *
   * - `missing`: topic files that exist but have no `](file)` index line;
   * - `dangling`: index entries whose topic file no longer exists.
   *
   * Link targets that are not plain `.md` file names (headings, external URLs
   * in a hand-written index) are ignored instead of being reported as dangling.
   *
   * @param {'project'|'user'} [scope]
   * @returns {Promise<{files:string[],missing:Array<{file:string,name:string,
   *   description:string,type:string}>,dangling:string[]}>}
   */
  async auditIndex(scope = 'project') {
    const normalized = normalizeScope(scope);
    const empty = { files: [], missing: [], dangling: [] };
    if (!this._scopeReadable(normalized)) return empty;
    const entries = await this.listEntries(normalized);
    const files = entries.map((entry) => entry.file);
    const disk = new Set(files);
    const lines = splitLines(await this.indexText(normalized));
    const referenced = new Set();
    const dangling = [];
    for (const line of lines) {
      const reference = referencedFile(line);
      if (!isIndexEntryReference(reference)) continue;
      if (!disk.has(reference)) {
        if (!dangling.includes(reference)) dangling.push(reference);
        continue;
      }
      referenced.add(reference);
    }
    const missing = [];
    for (const entry of entries) {
      if (referenced.has(entry.file)) continue;
      missing.push({
        file: entry.file,
        name: entry.name,
        description: entry.description,
        type: entry.type,
      });
    }
    return { files, missing, dangling };
  }

  /**
   * Repair the index: keep lines whose topic file still exists (in their
   * current order), drop dangling entries and append a canonical index line for
   * every missing topic file (ordered by the file `modified` timestamp).
   * @param {'project'|'user'} [scope]
   * @returns {Promise<{appended:string[],removed:string[]}>}
   */
  reconcileIndex(scope = 'project') {
    return this._run(async () => {
      const normalized = normalizeScope(scope);
      this._assertScopeWritable(normalized);
      const audit = await this.auditIndex(normalized);
      const disk = new Set(audit.files);
      const lines = splitLines(await this.indexText(normalized));
      const kept = [];
      const removed = [];
      for (const line of lines) {
        const reference = referencedFile(line);
        if (!isIndexEntryReference(reference) || disk.has(reference)) {
          kept.push(line);
          continue;
        }
        if (!removed.includes(reference)) removed.push(reference);
      }
      const entries = await this.listEntries(normalized);
      const modifiedByFile = new Map(entries.map((entry) => [entry.file, entry.modified ?? '']));
      const missing = audit.missing.slice().sort((left, right) => {
        const leftAt = modifiedByFile.get(left.file) ?? '';
        const rightAt = modifiedByFile.get(right.file) ?? '';
        const byTime = String(leftAt).localeCompare(String(rightAt));
        return byTime !== 0 ? byTime : left.file.localeCompare(right.file);
      });
      const appended = [];
      for (const meta of missing) {
        kept.push(indexLine(meta));
        appended.push(meta.file);
      }
      const text = kept.length > 0 ? `${kept.join('\n')}\n` : '';
      await this._writeIndexLocked(normalized, text);
      return { appended, removed };
    });
  }

  // ---------------------------------------------------------------------------
  // Search and status
  // ---------------------------------------------------------------------------

  /**
   * Ranked keyword search across one scope's memory files (v10).
   *
   * Scoring: field weights (name 5, description 3, body 1) for every query
   * token, a +2 whole-phrase bonus when the normalized query appears verbatim,
   * and a +0.5 recency bump for files modified within the last 30 days. Ties
   * break on file name so results are deterministic. Supports `type` filtering
   * and `offset` pagination and returns 1-2 matched snippets per file.
   *
   * @param {string} query
   * @param {{scope?:'project'|'user',limit?:number,offset?:number,type?:string}} [options]
   * @returns {Promise<Array<{file:string,name:string,description:string,type:string,
   *   modified:string,score:number,recency:number,snippets:string[],snippet:string,
   *   via:string,created:string}>>}
   */
  async search(query, options = {}) {
    const scope = normalizeScope(options.scope);
    const text = cleanInline(query);
    if (text === '') return [];
    if (!this._scopeReadable(scope)) return [];
    const limitValue = Number(options.limit);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(200, Math.trunc(limitValue))) : 20;
    const offsetValue = Number(options.offset);
    const offset = Number.isFinite(offsetValue) ? Math.max(0, Math.trunc(offsetValue)) : 0;
    const typeFilter = MEMORY_TYPES.includes(options.type) ? options.type : '';
    const tokens = this._searchTokens(text);
    const phrase = String(text).toLowerCase();
    const now = Date.now();
    const recencyWindowMs = 30 * 24 * 60 * 60 * 1000;
    const dir = this._scopeDir(scope);
    const entries = await this.listEntries(scope);
    const scored = [];
    for (const meta of entries) {
      if (typeFilter !== '' && meta.type !== typeFilter) continue;
      let raw;
      try {
        raw = await fs.readFile(path.join(dir, meta.file), 'utf8');
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(raw);
      const body = parsed.body;
      const nameText = meta.name.toLowerCase();
      const descriptionText = meta.description.toLowerCase();
      const bodyText = body.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (nameText.includes(token)) score += 5;
        if (descriptionText.includes(token)) score += 3;
        if (bodyText.includes(token)) score += 1;
      }
      if (score === 0) continue;
      if (phrase.length >= 2 && (nameText.includes(phrase) || descriptionText.includes(phrase) || bodyText.includes(phrase))) {
        score += 2;
      }
      let recency = 0;
      const modifiedAt = Date.parse(meta.modified);
      if (Number.isFinite(modifiedAt) && now - modifiedAt <= recencyWindowMs) {
        score += 0.5;
        recency = 0.5;
      }
      const rounded = Math.round(score * 100) / 100;
      const snippets = this._snippets(body, tokens, phrase);
      scored.push({
        score: rounded,
        hit: {
          file: meta.file,
          name: meta.name,
          description: meta.description,
          type: meta.type,
          modified: meta.modified,
          created: meta.created ?? '',
          via: meta.via ?? '',
          score: rounded,
          recency,
          snippets,
          // Backward-compatible single snippet for older callers.
          snippet: snippets[0] ?? meta.description,
        },
      });
    }
    scored.sort((left, right) => right.score - left.score || left.hit.file.localeCompare(right.hit.file));
    return scored.slice(offset, offset + limit).map((item) => item.hit);
  }

  /**
   * Tokenize a query for search. Whitespace words for latin text, plus CJK
   * bigrams so a Chinese query without spaces still matches a sentence.
   */
  _searchTokens(text) {
    const lower = String(text).toLowerCase();
    const tokens = lower.split(/\s+/).filter(Boolean).slice(0, 8);
    const unique = new Set(tokens);
    for (const token of tokens) {
      if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token)) continue;
      const chars = Array.from(token);
      if (chars.length === 1) {
        unique.add(token);
        continue;
      }
      for (let index = 0; index + 1 < chars.length; index += 1) {
        unique.add(chars[index] + chars[index + 1]);
      }
    }
    return [...unique].slice(0, 24);
  }

  /**
   * Up to two body lines that match the query phrase or one of its tokens.
   * The first existing snippet is the backward-compatible `snippet` field.
   */
  _snippets(body, tokens, phrase) {
    const snippets = [];
    for (const line of normalizeNewlines(body).split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const lower = trimmed.toLowerCase();
      const matched =
        (phrase.length >= 2 && lower.includes(phrase)) || tokens.some((token) => lower.includes(token));
      if (!matched) continue;
      snippets.push(trimmed.slice(0, MAX_DESCRIPTION));
      if (snippets.length >= 2) break;
    }
    return snippets;
  }

  /**
   * Full status of one scope, for the `memory_status` tool and `/memory json`.
   * @param {'project'|'user'} [scope]
   * @returns {Promise<{dir:string,indexFile:string,index:object,entries:object[],
   *   userScope:{enabled:boolean,dir:string,entries:object[]}}>}
   */
  async status(scope = 'project') {
    const normalized = normalizeScope(scope);
    const dir = this._scopeDir(normalized);
    const indexFile = this._indexFile(normalized);
    const index = this._budget(await this.indexText(normalized), normalized);
    const entries = await this.listEntries(normalized);
    const userEntries = this.userScopeEnabled ? await this.listEntries('user') : [];
    return {
      dir,
      indexFile,
      index,
      entries,
      trashRoot: this.trashRoot,
      trashCount: await this.countTrash(),
      userScope: {
        enabled: this.userScopeEnabled,
        dir: this._paths.userMemoryDir,
        entries: userEntries,
      },
    };
  }

  /**
   * Number of soft-deleted memory files under `trashRoot`.
   * @returns {Promise<number>}
   */
  async countTrash() {
    const root = this.trashRoot;
    let names;
    try {
      names = await fs.readdir(root);
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    let count = 0;
    for (const name of names) {
      const batch = path.join(root, name);
      let info;
      try {
        info = await fs.stat(batch);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      let files;
      try {
        files = await fs.readdir(batch);
      } catch {
        continue;
      }
      for (const file of files) if (MEMORY_FILE_RE.test(file)) count += 1;
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Dream audit trail
  // ---------------------------------------------------------------------------

  /**
   * Append one section to the dream changelog (`paths.changelogFile`).
   * @param {string} text
   * @returns {Promise<void>}
   */
  writeChangelog(text) {
    return this._run(async () => {
      const payload = typeof text === 'string' ? text : String(text ?? '');
      if (payload === '') return;
      const file = this._paths.changelogFile;
      await fs.mkdir(path.dirname(file), { recursive: true });
      const chunk = payload.endsWith('\n') ? payload : `${payload}\n`;
      await fs.appendFile(file, chunk, 'utf8');
    });
  }

  /**
   * List dream backups under `paths.dreamsDir`, newest first.
   * @returns {Promise<Array<{name:string,at:number,files:number}>>}
   */
  async listBackups() {
    const dir = this._paths.dreamsDir;
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const backups = [];
    for (const name of names) {
      const full = path.join(dir, name);
      let info;
      try {
        info = await fs.stat(full);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      let files = 0;
      try {
        files = await countFiles(full);
      } catch {
        files = 0;
      }
      const timestamp = backupTimestamp(name);
      backups.push({ name, at: timestamp > 0 ? timestamp : info.mtimeMs, files });
    }
    backups.sort((left, right) => right.at - left.at || right.name.localeCompare(left.name));
    return backups;
  }
}
