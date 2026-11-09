/**
 * Tests for src/frontmatter.js (memory-core).
 *
 * The interface doc does not pin the export names of this module, so the tests
 * resolve the parse/serialize pair by capability (the first known alias that is
 * a function) and fail with the actual export list when none matches. The
 * observable contract is: `---` delimited YAML-ish frontmatter with the stable
 * field order `name, description, type, modified`, followed by a Markdown body;
 * parsing and serializing round-trip, tolerate CRLF input and special
 * characters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers.mjs';

const PARSE_CANDIDATES = [
  'parseFrontmatter',
  'parseMemoryFile',
  'parseMemoryDocument',
  'parseFrontmatterDocument',
  'parseMarkdownFrontmatter',
  'parseMemoryEntry',
  'parseMemoryDoc',
  'parse',
];
const SERIALIZE_CANDIDATES = [
  'serializeFrontmatter',
  'stringifyFrontmatter',
  'serializeMemoryFile',
  'stringifyMemoryFile',
  'serializeMemoryDocument',
  'formatMemoryFile',
  'renderMemoryFile',
  'formatFrontmatter',
  'serializeDocument',
  'serialize',
  'stringify',
  'format',
];

let apiPromise;

function frontmatterApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const mod = await loadModule('../src/frontmatter.js');
      const sources = [mod];
      if (mod.default && typeof mod.default === 'object') sources.push(mod.default);
      let parse;
      let serialize;
      for (const source of sources) {
        if (!parse) {
          for (const name of PARSE_CANDIDATES) {
            if (typeof source[name] === 'function') {
              parse = source[name];
              break;
            }
          }
        }
        if (!serialize) {
          for (const name of SERIALIZE_CANDIDATES) {
            if (typeof source[name] === 'function') {
              serialize = source[name];
              break;
            }
          }
        }
      }
      if (typeof parse !== 'function' || typeof serialize !== 'function') {
        throw new Error(
          '[missing-export] src/frontmatter.js must expose a parse and a serialize function. ' +
            `Tried parse: ${PARSE_CANDIDATES.join(', ')}. Tried serialize: ${SERIALIZE_CANDIDATES.join(', ')}. ` +
            `Actual exports: ${Object.keys(mod).join(', ') || '(none)'}`,
        );
      }
      return { parse, serialize };
    })();
  }
  return apiPromise;
}

function firstDefined(object, names) {
  if (!object || typeof object !== 'object') return undefined;
  for (const name of names) {
    if (object[name] !== undefined) return object[name];
  }
  return undefined;
}

/** Normalize whatever shape the parser returns into { fm, body }. */
function normalizeParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`frontmatter parser returned ${typeof parsed}; expected an object like { frontmatter, body }`);
  }
  const rawFields = firstDefined(parsed, ['frontmatter', 'data', 'attributes', 'meta', 'fields']);
  const body = firstDefined(parsed, ['body', 'content', 'text', 'markdown', 'source']);
  const fields = rawFields === null || rawFields === undefined ? {} : rawFields;
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error(`frontmatter parser returned a non-object field bag: ${JSON.stringify(rawFields)}`);
  }
  return { fields, body: typeof body === 'string' ? body : undefined };
}

const BASIC_DOC = [
  '---',
  'name: role',
  'description: Who the user is',
  'type: user',
  'modified: 2026-11-06T23:10:00.000Z',
  '---',
  '',
  'Prefers TypeScript.',
  '',
].join('\n');

test('parses a normal frontmatter document', async () => {
  const { parse } = await frontmatterApi();
  const { fields, body } = normalizeParsed(parse(BASIC_DOC));
  assert.equal(fields.name, 'role');
  assert.equal(fields.description, 'Who the user is');
  assert.equal(fields.type, 'user');
  assert.equal(fields.modified, '2026-11-06T23:10:00.000Z');
  assert.equal(typeof body, 'string');
  assert.match(body, /Prefers TypeScript\./);
});

test('parses a document without frontmatter as plain body', async () => {
  const { parse } = await frontmatterApi();
  const text = 'Just a plain note.\nSecond line.\n';
  const { fields, body } = normalizeParsed(parse(text));
  assert.equal(typeof fields, 'object');
  assert.equal(typeof body, 'string');
  assert.match(body, /Just a plain note\./);
  assert.match(body, /Second line\./);
});

test('parses CRLF documents without leaking carriage returns into values', async () => {
  const { parse } = await frontmatterApi();
  const crlf = BASIC_DOC.replace(/\n/g, '\r\n');
  const { fields, body } = normalizeParsed(parse(crlf));
  assert.equal(fields.name, 'role');
  assert.equal(fields.description, 'Who the user is', 'CRLF must not leave a trailing \\r in field values');
  assert.equal(fields.type, 'user');
  assert.equal(fields.modified, '2026-11-06T23:10:00.000Z');
  assert.match(String(body), /Prefers TypeScript\./);
});

test('parses an empty body and a body containing --- separators', async () => {
  const { parse } = await frontmatterApi();
  const empty = normalizeParsed(parse('---\nname: empty\ntype: user\nmodified: 2026-11-06T23:10:00.000Z\n---\n'));
  assert.equal(empty.fields.name, 'empty');
  assert.equal(empty.body.trim(), '', 'empty body stays empty');

  const separatorDoc = [
    '---',
    'name: separators',
    'description: body has rules',
    'type: project',
    'modified: 2026-11-06T23:10:00.000Z',
    '---',
    'intro line',
    '---',
    'after the horizontal rule',
    '',
  ].join('\n');
  const parsed = normalizeParsed(parse(separatorDoc));
  assert.equal(parsed.fields.name, 'separators');
  assert.match(parsed.body, /intro line/);
  assert.match(parsed.body, /after the horizontal rule/, 'a later --- line is body, not a closing delimiter');
});

test('parses quoted YAML values with special characters', async () => {
  const { parse } = await frontmatterApi();
  const doc = [
    '---',
    'name: "role with spaces"',
    'description: "prefers TypeScript: strict mode #2"',
    'type: user',
    'modified: 2026-11-06T23:10:00.000Z',
    '---',
    '',
    'body',
    '',
  ].join('\n');
  const { fields } = normalizeParsed(parse(doc));
  assert.equal(fields.name, 'role with spaces');
  assert.equal(fields.description, 'prefers TypeScript: strict mode #2');
});

/** Try the documented serializer call shapes and return the first that round-trips. */
function serializeAndReparse(parse, serialize, fields, body, bodyMarker = 'After a separator.') {
  const attempts = [
    ['serialize(fields, body)', () => serialize(fields, body)],
    ['serialize({frontmatter, body})', () => serialize({ frontmatter: fields, body })],
    ['serialize({data, content})', () => serialize({ data: fields, content: body })],
    ['serialize({fields, body})', () => serialize({ fields, body })],
    [
      'serialize(fields) + body',
      () => {
        const head = serialize(fields);
        return typeof head === 'string' ? `${head.replace(/\s*$/, '')}\n\n${body}\n` : head;
      },
    ],
  ];
  const problems = [];
  for (const [label, attempt] of attempts) {
    let text;
    try {
      text = attempt();
    } catch (error) {
      problems.push(`${label}: threw ${error && error.message}`);
      continue;
    }
    if (typeof text !== 'string') {
      problems.push(`${label}: returned ${typeof text}`);
      continue;
    }
    let parsed;
    try {
      parsed = normalizeParsed(parse(text));
    } catch (error) {
      problems.push(`${label}: re-parse threw ${error && error.message}`);
      continue;
    }
    const fieldsOk = Object.entries(fields).every(([key, value]) => parsed.fields[key] === value);
    const bodyOk = typeof parsed.body === 'string' && parsed.body.includes(bodyMarker);
    if (fieldsOk && bodyOk) return text;
    problems.push(`${label}: mismatch fields=${JSON.stringify(parsed.fields)} bodyHasMarker=${bodyOk}`);
  }
  throw new Error(`frontmatter round-trip failed for every serializer call shape:\n  ${problems.join('\n  ')}`);
}

test('serialize -> parse round-trips special characters and multi-line bodies', async () => {
  const { parse, serialize } = await frontmatterApi();
  const fields = {
    name: '用户 role',
    description: 'prefers TypeScript: strict mode #2 and "quoted" words',
    type: 'user',
    modified: '2026-11-06T23:10:00.000Z',
  };
  const body = 'First line.\n\nSecond paragraph with \\ backslash.\n\n---\n\nAfter a separator.';
  const text = serializeAndReparse(parse, serialize, fields, body);

  assert.equal(text.startsWith('---\n'), true, `serialized document must start with "---\\n", got: ${JSON.stringify(text.slice(0, 20))}`);
  assert.equal(text.includes('\r'), false, 'serialized frontmatter must use LF line endings');
  assert.equal(text.charCodeAt(0), 45, 'serialized document must not start with a BOM');

  const reparsed = normalizeParsed(parse(text));
  for (const [key, value] of Object.entries(fields)) {
    assert.equal(reparsed.fields[key], value, `round-trip field ${key}`);
  }
  assert.match(reparsed.body, /First line\./);
  assert.match(reparsed.body, /After a separator\./);
});

test('serialized field order is name, description, type, modified', async () => {
  const { parse, serialize } = await frontmatterApi();
  const fields = {
    name: 'order-check',
    description: 'checks the stable field order',
    type: 'reference',
    modified: '2026-11-06T23:10:00.000Z',
  };
  const text = serializeAndReparse(parse, serialize, fields, 'body', 'body');
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], '---');
  const close = lines.indexOf('---', 1);
  assert.ok(close > 1, 'serialized document must have a closing ---');
  const fieldNames = lines.slice(1, close).map((line) => {
    const colon = line.indexOf(':');
    assert.ok(colon > 0, `expected "key: value" frontmatter line, got ${JSON.stringify(line)}`);
    return line.slice(0, colon).trim();
  });
  assert.deepEqual(fieldNames, ['name', 'description', 'type', 'modified']);
});
