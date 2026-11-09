/**
 * Minimal, dependency-free YAML frontmatter for memory topic files.
 *
 * Memory files use the Claude Code shape:
 *
 *     ---
 *     name: user_role
 *     description: Who the user is
 *     type: user
 *     modified: 2026-11-06T23:10:00.000Z
 *     ---
 *
 *     Markdown body...
 *
 * Only the tiny `key: value` subset that this plugin writes and reads is
 * supported: no third-party YAML parser exists in a local bundle, and a full
 * YAML implementation is not needed. Parsing and serialization are deliberately
 * stable (canonical field order, normalized newlines, trimmed body) so a
 * read -> write round trip is idempotent.
 *
 * @module dsh-cc-dream-memory/frontmatter
 */

/**
 * Frontmatter fields in canonical serialization order.
 *
 * The first four fields are the v0 format every memory file has; `created`,
 * `source_session` and `via` are the optional v7 provenance fields (written
 * only when the caller supplies provenance, so older files and plain writes
 * keep the four-field shape).
 */
export const FRONTMATTER_FIELDS = Object.freeze([
  'name',
  'description',
  'type',
  'modified',
  'created',
  'source_session',
  'via',
]);

const OPENING = /^---[ \t]*\r?\n/;
const BODY = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const KEY_VALUE = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/;
/** Scalars that would need quoting to stay one plain YAML scalar. */
const NEEDS_QUOTE = /^[-?:,\[\]{}#&*!|>'"%@`]/;
/** A colon followed by whitespace would start a nested mapping in YAML. */
const COLON_SPACE = /:[ \t]/;
const HASH_SPACE = /[ \t]#/;

/**
 * Remove a UTF-8 byte-order mark.
 * @param {string} text
 * @returns {string}
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Normalize line endings to `\n` so parsed and serialized text is stable.
 * @param {string} text
 * @returns {string}
 */
function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Decode one plain or quoted frontmatter scalar.
 * Double-quoted values are JSON strings (escapes work); single-quoted values
 * follow YAML's `''` escape. Everything else is returned verbatim.
 * @param {string} raw
 * @returns {string}
 */
function decodeScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      return typeof decoded === 'string' ? decoded : String(decoded);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * Parse the `key: value` lines of a frontmatter block.
 * Unsupported lines (nested mappings, lists, block scalars, comments) are
 * ignored on purpose: this plugin never writes them.
 * @param {string} block frontmatter text without the `---` fences.
 * @returns {Record<string, string>}
 */
function parseFields(block) {
  /** @type {Record<string, string>} */
  const data = {};
  for (const line of block.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const match = KEY_VALUE.exec(line);
    if (match === null) continue;
    data[match[1]] = decodeScalar(match[2]);
  }
  return data;
}

/**
 * Parse a memory file into its frontmatter fields and body.
 *
 * The body is returned without the leading separator line that follows the
 * closing fence and without trailing newlines, so `stringify(parse(text))`
 * round-trips even when the source formatting drifts.
 *
 * @param {string|Buffer|undefined|null} input file text.
 * @returns {{
 *   data: Record<string, string>,
 *   frontmatter: Record<string, string>,
 *   body: string,
 *   hasFrontmatter: boolean,
 *   raw: string,
 * }}
 */
export function parseFrontmatter(input) {
  const raw = Buffer.isBuffer(input)
    ? input.toString('utf8')
    : input === undefined || input === null
      ? ''
      : String(input);
  const text = normalizeNewlines(stripBom(raw));
  const match = BODY.exec(text);
  if (match === null) {
    const data = {};
    return {
      data,
      frontmatter: data,
      body: text.replace(/\n+$/, ''),
      hasFrontmatter: false,
      raw,
    };
  }
  const data = parseFields(match[1]);
  const body = text.slice(match[0].length).replace(/^\n/, '').replace(/\n+$/, '');
  return { data, frontmatter: data, body, hasFrontmatter: true, raw };
}

/**
 * Serialize one plain YAML scalar.
 * @param {unknown} value
 * @returns {string}
 */
function encodeScalar(value) {
  let text = String(value ?? '');
  text = normalizeNewlines(text).replace(/\n+/g, ' ').trim();
  if (text === '') return '';
  const needsQuote =
    text !== text.trim() ||
    NEEDS_QUOTE.test(text) ||
    COLON_SPACE.test(text) ||
    HASH_SPACE.test(text) ||
    text.includes('"');
  return needsQuote ? JSON.stringify(text) : text;
}

/**
 * Build canonical, stable frontmatter + body text.
 *
 * `stringifyFrontmatter(parsed)` is also accepted: when the first argument is a
 * `parseFrontmatter()` result and no body is supplied, its fields and body are
 * used.
 *
 * @param {Record<string, unknown>|{data?:Record<string,string>,frontmatter?:Record<string,string>,body?:string}} dataOrParsed
 * @param {string} [body]
 * @returns {string} UTF-8 memory file text ending in a single newline.
 */
export function stringifyFrontmatter(dataOrParsed, body) {
  let data;
  let content;
  if (
    dataOrParsed !== null &&
    typeof dataOrParsed === 'object' &&
    body === undefined &&
    ('frontmatter' in dataOrParsed || 'data' in dataOrParsed)
  ) {
    data = dataOrParsed.frontmatter ?? dataOrParsed.data ?? {};
    content = dataOrParsed.body;
  } else {
    data = dataOrParsed;
    content = body;
  }
  const fields = [];
  const seen = new Set();
  for (const key of FRONTMATTER_FIELDS) {
    if (data !== null && typeof data === 'object' && data[key] !== undefined && data[key] !== null) {
      fields.push([key, data[key]]);
      seen.add(key);
    }
  }
  if (data !== null && typeof data === 'object') {
    for (const key of Object.keys(data).sort()) {
      if (seen.has(key)) continue;
      if (data[key] === undefined || data[key] === null) continue;
      fields.push([key, data[key]]);
    }
  }
  const header = fields.map(([key, value]) => `${key}: ${encodeScalar(value)}`).join('\n');
  const prefix = header === '' ? '---\n---\n' : `---\n${header}\n---\n`;
  const text = normalizeNewlines(String(content ?? '')).replace(/^\n+/, '').replace(/\n+$/, '');
  return text === '' ? prefix : `${prefix}\n${text}\n`;
}
