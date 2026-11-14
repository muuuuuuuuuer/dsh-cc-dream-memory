/**
 * Tests for src/store.js (memory-core).
 *
 * Contract: INTERFACES.md "src/store.js" — per-project memory files with
 * frontmatter, a MEMORY.md index kept in sync on every write, injection budgets
 * (lines/bytes), path-escape protection, user-scope gating and a search/status
 * surface. Every test uses a throwaway temp dir (never the real ~/.dsh).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertRejectsWithCode,
  countOccurrences,
  loadModule,
  makeTempDir,
  splitLines,
} from './helpers.mjs';

let depsPromise;

async function deps() {
  if (!depsPromise) {
    depsPromise = (async () => {
      const storeMod = await loadModule('../src/store.js', { requireExports: ['MemoryStore'] });
      const pathsMod = await loadModule('../src/paths.js', { requireExports: ['buildPaths'] });
      const configMod = await loadModule('../src/config.js', { requireExports: ['resolveConfig'] });
      return { MemoryStore: storeMod.MemoryStore, buildPaths: pathsMod.buildPaths, resolveConfig: configMod.resolveConfig };
    })();
  }
  return depsPromise;
}

/** Build an isolated store rooted in a fresh temp dir. */
async function newStore(t, configOverrides = {}) {
  const { MemoryStore, buildPaths, resolveConfig } = await deps();
  const tmp = await makeTempDir(t);
  const home = path.join(tmp, 'home');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const memoryRoot = path.join(tmp, 'memory-root');
  const config = resolveConfig({ memoryRoot, ...configOverrides });
  const paths = buildPaths({ memoryRoot: config.memoryRoot, homeDir: home, workspaceDir });
  const store = new MemoryStore({ paths, getConfig: () => config });
  await store.ensure();
  return { store, paths, config, tmp, workspaceDir };
}

function workspaceFile(paths, file) {
  return path.join(paths.memoryDir, file);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

test('ensure() creates the memory dir and initializes an empty MEMORY.md', async (t) => {
  const { store, paths } = await newStore(t);
  const dirStat = await stat(paths.memoryDir);
  assert.equal(dirStat.isDirectory(), true, 'memoryDir must be created');
  assert.equal(await fileExists(paths.indexFile), true, 'MEMORY.md must be created');
  assert.equal((await readFile(paths.indexFile, 'utf8')).trim(), '', 'MEMORY.md is initialized empty');
  assert.equal((await store.indexText()).trim(), '');
  assert.deepEqual(await store.listEntries(), []);
  await store.ensure(); // idempotent
  assert.deepEqual(await store.listEntries(), []);
});

test('ensure() does not clobber an existing MEMORY.md', async (t) => {
  const { MemoryStore } = await deps();
  const { paths, config } = await newStore(t);
  await writeFile(paths.indexFile, '- [kept](user_kept.md) — kept line\n', 'utf8');
  const reopened = new MemoryStore({ paths, getConfig: () => config });
  await reopened.ensure();
  assert.match(await reopened.indexText(), /kept line/);
});

test('saveEntry() writes a frontmatter file and appends the index line', async (t) => {
  const { store, paths, config } = await newStore(t);
  const result = await store.saveEntry({
    name: 'role',
    type: 'user',
    description: 'Who the user is',
    content: 'Prefers TypeScript.',
  });

  assert.equal(result.ok, true);
  assert.equal(result.file, 'user_role.md');
  assert.equal(result.name, 'role');
  assert.equal(result.type, 'user');
  assert.equal(result.created, true);
  assert.equal(result.description, 'Who the user is');
  assert.ok(result.index && typeof result.index === 'object', 'SaveResult.index budget is missing');
  assert.equal(result.index.maxLines, config.indexMaxLines);
  assert.equal(result.index.maxBytes, config.indexMaxBytes);
  assert.equal(result.index.overflow, false);

  const raw = await readFile(workspaceFile(paths, result.file), 'utf8');
  assert.equal(raw.charCodeAt(0), 45, 'file must start with "---" (no BOM)');
  assert.equal(raw.includes('\r'), false, 'written memory files use LF');
  const lines = raw.split(/\r?\n/);
  assert.equal(lines[0], '---');
  const close = lines.indexOf('---', 1);
  assert.ok(close > 1, 'frontmatter must be closed');
  const fieldNames = lines.slice(1, close).map((line) => line.slice(0, line.indexOf(':')).trim());
  assert.deepEqual(fieldNames, ['name', 'description', 'type', 'modified'], 'stable frontmatter field order');
  assert.match(raw, /name:\s*role/);
  assert.match(raw, /description:\s*Who the user is/);
  assert.match(raw, /type:\s*user/);
  assert.match(raw, /modified:\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.match(raw, /Prefers TypeScript\./);

  const indexLines = splitLines(await store.indexText());
  assert.equal(indexLines.length, 1);
  assert.equal(indexLines[0], '- [role](user_role.md) — Who the user is');
});

test('listEntries()/readEntry() expose metadata, frontmatter and body', async (t) => {
  const { store } = await newStore(t);
  await store.saveEntry({ name: 'role', type: 'user', description: 'Who the user is', content: 'Prefers TypeScript.' });
  await store.saveEntry({ name: 'testing', type: 'feedback', description: 'Testing rules', content: 'Run tests before commit.' });

  const entries = await store.listEntries();
  assert.equal(entries.length, 2);
  const role = entries.find((entry) => entry.file === 'user_role.md');
  assert.ok(role, `user_role.md missing from ${JSON.stringify(entries.map((entry) => entry.file))}`);
  assert.equal(role.name, 'role');
  assert.equal(role.description, 'Who the user is');
  assert.equal(role.type, 'user');
  assert.ok(role.bytes > 0);
  assert.ok(role.lines > 0);
  assert.equal(Number.isNaN(Date.parse(role.modified)), false, 'modified is an ISO timestamp');
  assert.equal(entries.some((entry) => entry.file === 'feedback_testing.md'), true);

  const read = await store.readEntry('user_role.md');
  assert.equal(read.file, 'user_role.md');
  assert.equal(read.scope, 'project');
  assert.equal(read.frontmatter.name, 'role');
  assert.equal(read.frontmatter.description, 'Who the user is');
  assert.equal(read.frontmatter.type, 'user');
  assert.equal(read.frontmatter.modified, role.modified);
  assert.match(read.body, /Prefers TypeScript\./);
  assert.equal(read.raw.startsWith('---'), true);
  assert.ok(read.bytes > 0);
});

test('updateEntry() rewrites content/description and replaces the index line', async (t) => {
  const { store } = await newStore(t);
  await store.saveEntry({ name: 'role', type: 'user', description: 'Who the user is', content: 'Prefers TypeScript.' });

  const updated = await store.updateEntry('user_role.md', { content: 'Loves Rust.', description: 'Updated description' });
  assert.equal(updated.ok, true);
  assert.equal(updated.file, 'user_role.md');
  assert.equal(updated.created, false);

  const read = await store.readEntry('user_role.md');
  assert.match(read.body, /Loves Rust\./);
  assert.equal(read.frontmatter.description, 'Updated description');

  const indexText = await store.indexText();
  const indexLines = splitLines(indexText);
  assert.equal(indexLines.length, 1, 'update must replace, not duplicate, the index line');
  assert.equal(countOccurrences(indexText, '(user_role.md)'), 1);
  assert.match(indexLines[0], /Updated description/);
  assert.doesNotMatch(indexLines[0], /Who the user is/);

  // Content-only updates keep the description.
  await store.updateEntry('user_role.md', { content: 'Changed again.' });
  assert.equal((await store.readEntry('user_role.md')).frontmatter.description, 'Updated description');
});

test('saving the same name twice overwrites instead of duplicating', async (t) => {
  const { store, paths } = await newStore(t);
  const first = await store.saveEntry({ name: 'role', type: 'user', description: 'v1', content: 'version one' });
  assert.equal(first.created, true);
  const second = await store.saveEntry({ name: 'role', type: 'user', description: 'v2', content: 'version two' });
  assert.equal(second.created, false);

  const files = (await readdir(paths.memoryDir)).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md');
  assert.deepEqual(files, ['user_role.md']);
  const lines = splitLines(await store.indexText());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /v2/);
  assert.match((await store.readEntry('user_role.md')).body, /version two/);
});

test('readEntry()/updateEntry() on a missing entry report NOT_FOUND', async (t) => {
  const { store } = await newStore(t);
  await assertRejectsWithCode(store.readEntry('missing.md'), 'NOT_FOUND');
  await assertRejectsWithCode(store.updateEntry('missing.md', { content: 'x' }), 'NOT_FOUND');
});

test('writes rebuild a missing index line automatically', async (t) => {
  const { store } = await newStore(t);
  await store.saveEntry({ name: 'alpha', type: 'user', description: 'Alpha', content: 'alpha body' });

  await store.writeIndex('');
  assert.equal((await store.indexText()).trim(), '');
  await store.saveEntry({ name: 'beta', type: 'project', description: 'Beta', content: 'beta body' });
  let lines = splitLines(await store.indexText());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /project_beta\.md/);

  // An update also re-adds a lost index line.
  await store.writeIndex('');
  await store.updateEntry('user_alpha.md', { content: 'alpha body v2' });
  lines = splitLines(await store.indexText());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /user_alpha\.md/);
});

test('injectedIndex() returns the whole index when under budget', async (t) => {
  const { store, config } = await newStore(t);
  await store.saveEntry({ name: 'one', type: 'user', description: 'One', content: 'one' });
  await store.saveEntry({ name: 'two', type: 'user', description: 'Two', content: 'two' });

  const injected = await store.injectedIndex();
  assert.equal(injected.truncated, false);
  assert.equal(injected.overflow, false);
  assert.equal(injected.lines, 2);
  assert.equal(injected.bytes, Buffer.byteLength(injected.text, 'utf8'));
  assert.equal(injected.maxLines, config.indexMaxLines);
  assert.equal(injected.maxBytes, config.indexMaxBytes);
  assert.match(injected.text, /user_one\.md/);
  assert.match(injected.text, /user_two\.md/);
});

test('index over the line budget still saves, warns, and truncates injection', async (t) => {
  const { store } = await newStore(t, { indexMaxLines: 3 });
  let last;
  for (let index = 0; index < 5; index += 1) {
    last = await store.saveEntry({
      name: `entry_${index}`,
      type: 'user',
      description: `Entry ${index}`,
      content: `Body ${index}`,
    });
    assert.equal(last.ok, true, 'saving over budget must still succeed');
  }
  assert.equal(last.index.overflow, true, 'save result must report the overflow');
  assert.match(String(last.warning ?? ''), /over its read limit/i, 'save result must carry an over-budget warning');

  const fullLines = splitLines(await store.indexText());
  assert.equal(fullLines.length, 5, 'the index file keeps all lines');

  const injected = await store.injectedIndex();
  assert.equal(injected.maxLines, 3);
  assert.equal(injected.truncated, true);
  assert.equal(injected.overflow, true);
  assert.equal(splitLines(injected.text).length <= 3, true, `injected text must respect the line budget: ${injected.lines}`);
});

test('index over the byte budget truncates injected text by bytes', async (t) => {
  const { store } = await newStore(t, { indexMaxBytes: 256 });
  const result = await store.saveEntry({
    name: 'cjk',
    type: 'user',
    description: '中'.repeat(160),
    content: 'multibyte body',
  });
  assert.equal(result.ok, true);
  assert.equal(result.index.overflow, true);
  assert.match(String(result.warning ?? ''), /over its read limit/i);

  const injected = await store.injectedIndex();
  assert.equal(injected.maxBytes, 256);
  assert.equal(injected.truncated, true);
  assert.equal(injected.overflow, true);
  assert.ok(injected.bytes <= 256, `injected bytes must respect the byte budget, got ${injected.bytes}`);
  assert.ok(Buffer.byteLength(injected.text, 'utf8') <= 256, 'injected text must fit the byte budget');
});

test('writeIndex() rewrites the index and reports its budget', async (t) => {
  const { store, config } = await newStore(t);
  const index = ['- [alpha](user_alpha.md) — first', '- [beta](user_beta.md) — second', ''].join('\n');
  const budget = await store.writeIndex(index);
  assert.equal(budget.lines, 2);
  assert.ok(budget.bytes > 0);
  assert.equal(budget.overflow, false);
  assert.equal(budget.maxLines, config.indexMaxLines);
  assert.equal(budget.maxBytes, config.indexMaxBytes);
  assert.match(await store.indexText(), /user_alpha\.md/);

  const over = await store.writeIndex(`- [x](user_x.md) — ${'y'.repeat(40_000)}\n`);
  assert.equal(over.overflow, true);
  assert.match(String(over.warning ?? ''), /over its read limit/i);
});

test('path escapes are rejected with PATH_ESCAPE and never touch the disk', async (t) => {
  const { store, tmp, paths } = await newStore(t);
  for (const evil of ['../outside.md', '..\\outside.md']) {
    await assertRejectsWithCode(store.readEntry(evil), 'PATH_ESCAPE');
    await assertRejectsWithCode(
      store.writeRawEntry(evil, { type: 'user', name: 'evil', description: 'evil', body: 'evil' }),
      'PATH_ESCAPE',
    );
    await assertRejectsWithCode(store.updateEntry(evil, { content: 'x' }), 'PATH_ESCAPE');
    await assertRejectsWithCode(store.trashEntry(evil), 'PATH_ESCAPE');
  }
  // Absolute paths outside the memory dir are rejected too.
  const absoluteEvil = path.join(tmp, 'outside.md');
  await assert.rejects(store.readEntry(absoluteEvil), (error) => {
    assert.ok(['PATH_ESCAPE', 'INVALID_NAME'].includes(error.code), `unexpected error code ${error.code}`);
    return true;
  });
  assert.equal(await fileExists(absoluteEvil), false, 'escape attempt must not create files');
  assert.equal(await fileExists(path.join(tmp, 'outside.md')), false);
  assert.equal(await fileExists(path.join(paths.projectDir, 'outside.md')), false);
});

test('the user scope is gone: memory lives in this project only', async (t) => {
  const { store } = await newStore(t);
  await assertRejectsWithCode(
    store.saveEntry({ scope: 'user', name: 'pref', type: 'feedback', description: 'Pref', content: 'likes tabs' }),
    'INVALID_SCOPE',
  );
  await assertRejectsWithCode(store.listEntries('user'), 'INVALID_SCOPE');
  await assert.rejects(store.readEntry('feedback_pref.md', 'user'), (error) => {
    assert.equal(error.code, 'INVALID_SCOPE', `unexpected error code ${error.code}`);
    return true;
  });
  const status = await store.status();
  assert.equal('userScope' in status, false, 'status reports no user scope');
});

test('invalid type and oversized content are rejected with coded errors', async (t) => {
  const { store } = await newStore(t, { maxContentBytes: 1024 });
  await assertRejectsWithCode(
    store.saveEntry({ name: 'bad', type: 'bogus', description: 'bad', content: 'x' }),
    'INVALID_TYPE',
  );
  await assertRejectsWithCode(
    store.saveEntry({ name: 'huge', type: 'user', description: 'huge', content: 'x'.repeat(5000) }),
    'CONTENT_TOO_LARGE',
  );
});

test('writeRawEntry() writes exact frontmatter/body and indexes the file', async (t) => {
  const { store, paths } = await newStore(t);
  const result = await store.writeRawEntry('manual_note.md', {
    type: 'reference',
    name: 'note',
    description: 'Manual note',
    body: 'Manual body.',
  });
  assert.equal(result.ok, true);
  assert.equal(result.file, 'manual_note.md');
  const read = await store.readEntry('manual_note.md');
  assert.equal(read.frontmatter.type, 'reference');
  assert.equal(read.frontmatter.name, 'note');
  assert.equal(read.frontmatter.description, 'Manual note');
  assert.match(read.body, /Manual body\./);
  assert.match(await store.indexText(), /- \[note\]\(manual_note\.md\) — Manual note/);

  await assert.rejects(
    store.writeRawEntry('bad name.md', { type: 'user', name: 'bad', description: 'bad', body: 'x' }),
    (error) => {
      assert.ok(['INVALID_NAME', 'PATH_ESCAPE'].includes(error.code), `unexpected error code ${error.code}`);
      return true;
    },
  );
  assert.equal(await fileExists(workspaceFile(paths, 'bad name.md')), false);
});

test('long/multi-line descriptions are flattened to a single short index line', async (t) => {
  const { store } = await newStore(t);
  const description = `multi line description\nwith ${'x'.repeat(300)}`;
  const result = await store.saveEntry({ name: 'long', type: 'user', description, content: 'body' });
  assert.equal(result.ok, true);
  const lines = splitLines(await store.indexText());
  assert.equal(lines.length, 1, 'a multi-line description must not break the index line format');
  const match = lines[0].match(/^\- \[long\]\(user_long\.md\) — (.*)$/);
  assert.ok(match, `unexpected index line: ${lines[0]}`);
  assert.equal(match[1].length <= 160, true, `index description must be <= 160 chars, got ${match[1].length}`);
});

test('search() finds matches in names and bodies', async (t) => {
  const { store } = await newStore(t);
  await store.saveEntry({ name: 'storage', type: 'project', description: 'Database choice', content: 'The project standardizes on SQLite.' });
  await store.saveEntry({ name: 'style', type: 'feedback', description: 'Formatting rules', content: 'Use two spaces for indentation.' });

  const hits = await store.search('sqlite');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'project_storage.md');
  assert.equal(hits[0].name, 'storage');
  assert.equal(hits[0].type, 'project');
  assert.equal(typeof hits[0].snippets[0], 'string');

  const caseInsensitive = await store.search('SQLITE');
  assert.equal(caseInsensitive.length, 1, 'search is case-insensitive');

  assert.deepEqual(await store.search('no-such-thing-anywhere'), []);

  const limited = await store.search('e', { limit: 1 });
  assert.equal(limited.length <= 1, true);
});

test('status() summarizes the project store', async (t) => {
  const { store, paths, config } = await newStore(t);
  await store.saveEntry({ name: 'one', type: 'user', description: 'One', content: 'one' });

  const status = await store.status();
  assert.equal(status.dir, paths.memoryDir);
  assert.equal(status.indexFile, paths.indexFile);
  assert.equal(typeof status.index, 'object');
  assert.equal(status.index.lines, 1);
  assert.equal(status.index.maxLines, config.indexMaxLines);
  assert.equal(Array.isArray(status.entries), true);
  assert.equal(status.entries.length, 1);
  assert.equal(typeof status.userScope, 'undefined');
});

test('writeChangelog() appends to .dream-log.md', async (t) => {
  const { store, paths } = await newStore(t);
  await store.writeChangelog('## 2026-11-06T23:10:00.000Z\n- trigger: auto, sessions: 3, ops: 4\n');
  await store.writeChangelog('## 2026-11-07T01:00:00.000Z\n- trigger: manual\n');
  const log = await readFile(paths.changelogFile, 'utf8');
  assert.match(log, /trigger: auto/);
  assert.match(log, /trigger: manual/);
  assert.ok(log.indexOf('trigger: auto') < log.indexOf('trigger: manual'), 'entries are appended in order');
});

test('listBackups() reports dream backup directories', async (t) => {
  const { store, paths } = await newStore(t);
  assert.deepEqual(await store.listBackups(), []);

  const backupDir = path.join(paths.dreamsDir, '2026-11-06T23-10-00');
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, 'MEMORY.md'), '', 'utf8');
  await writeFile(path.join(backupDir, 'user_role.md'), '', 'utf8');

  const backups = await store.listBackups();
  assert.equal(backups.length, 1);
  assert.equal(backups[0].name, '2026-11-06T23-10-00');
  assert.equal(backups[0].files, 2);
  assert.equal(typeof backups[0].at, 'number');
});

test('paths/config getters expose the constructor inputs', async (t) => {
  const { store, paths, config } = await newStore(t);
  assert.deepEqual(store.paths, paths);
  assert.deepEqual(store.config, config);
  assert.equal(Object.isFrozen(store.config), true);
});
