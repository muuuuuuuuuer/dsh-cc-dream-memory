/**
 * v10 P1-11: Claude Code memory dir import/export.
 * Contract §5. os.tmpdir() only; no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { httpEnv, commandEnv, callHttp, importExportModule, exists } from './v10-helpers.mjs';

async function makeClaudeDir(env) {
  const sourceDir = path.join(env.tmp, 'claude-memory');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    path.join(sourceDir, 'MEMORY.md'),
    ['- [role](user_role.md) — Who the user is', '- [plain note](plain_note.md) — plain note from the index'].join('\n') + '\n',
    'utf8',
  );
  await writeFile(
    path.join(sourceDir, 'user_role.md'),
    ['---', 'name: role', 'description: Who the user is', 'type: user', '---', '', 'Prefers TypeScript.', ''].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(sourceDir, 'plain_note.md'),
    '# Plain note\n\nThis file has no frontmatter.\n',
    'utf8',
  );
  return sourceDir;
}

test('v10 import: HTTP POST /import reads CC memory dir (index + files, no frontmatter) and skips duplicates', async (t) => {
  const env = await httpEnv(t);
  // Pre-existing memory with the same file name makes the CC file a duplicate.
  await env.pctx.store.saveEntry({
    name: 'role',
    type: 'user',
    description: 'local role already exists',
    content: 'local role body',
  });
  const sourceDir = await makeClaudeDir(env);

  const res = await callHttp(env, {
    method: 'POST',
    path: '/import',
    body: { path: sourceDir },
    origin: 'http://127.0.0.1:61784',
  });
  assert.equal(res.statusCode, 200, res.bodyText());
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.imported), JSON.stringify(body));
  assert.ok(Array.isArray(body.skipped));
  assert.ok(Array.isArray(body.errors));
  assert.ok(body.imported.length >= 1, `expected imported files: ${JSON.stringify(body)}`);
  assert.ok(body.skipped.length >= 1, 'the pre-existing role file is skipped as a duplicate');

  const entries = await env.pctx.store.listEntries();
  const plain = entries.find((entry) => entry.name === 'plain note' || entry.file.includes('plain_note'));
  assert.ok(plain, `the no-frontmatter file is imported: ${JSON.stringify(entries.map((e) => e.file))}`);
  const read = await env.pctx.store.readEntry(plain.file);
  assert.equal(read.frontmatter.via, 'import:claude', 'imports are attributed via import:claude');
  assert.equal(read.frontmatter.type, 'reference', 'imports default to reference type');
  assert.match(read.frontmatter.description, /Plain note|plain note/i, 'description derived from the first line/index');

  // Token still required.
  assert.equal((await callHttp(env, { method: 'POST', path: '/import', body: { path: sourceDir }, token: 'bad' })).statusCode, 401);
});

test('v10 import: direct importClaudeMemory module also imports and reports errors', async (t) => {
  const env = await httpEnv(t);
  const mod = await importExportModule();
  assert.equal(typeof mod.importClaudeMemory, 'function');
  assert.equal(typeof mod.exportClaudeMemory, 'function');
  const sourceDir = await makeClaudeDir(env);
  const result = await mod.importClaudeMemory({
    paths: env.pctx.paths,
    store: env.pctx.store,
    config: env.config,
    sourceDir,
  });
  assert.ok(Array.isArray(result.imported));
  assert.ok(Array.isArray(result.skipped));
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.imported.length >= 1, JSON.stringify(result));
});

test('import and export expand a leading ~ to the home directory', async (t) => {
  const env = await httpEnv(t);
  const mod = await importExportModule();
  const sourceDir = await makeClaudeDir(env);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HOME = path.dirname(sourceDir);
  process.env.USERPROFILE = path.dirname(sourceDir);

  const imported = await mod.importClaudeMemory({
    paths: env.pctx.paths,
    store: env.pctx.store,
    sourceDir: `~/${path.basename(sourceDir)}`,
  });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.ok(imported.imported.length >= 1, JSON.stringify(imported));

  const exported = await mod.exportClaudeMemory({ paths: env.pctx.paths, store: env.pctx.store, targetDir: '~/exported' });
  assert.equal(exported.targetDir, path.join(path.dirname(sourceDir), 'exported', 'memory'));
  assert.equal(await exists(path.join(exported.targetDir, 'MEMORY.md')), true);
});

test('v10 export: HTTP POST /export writes a Claude-compatible memory dir plus rules', async (t) => {
  const env = await httpEnv(t);
  await env.pctx.store.saveEntry({
    name: 'export role',
    type: 'user',
    description: 'exported description',
    content: 'exported body',
  });
  await env.runtime.saveRules(env.pctx, 'project', '- V10 exported rule: keep memory small');
  const targetDir = path.join(env.tmp, 'export-target');

  const res = await callHttp(env, {
    method: 'POST',
    path: '/export',
    body: { path: targetDir },
    origin: 'http://127.0.0.1:61784',
  });
  assert.equal(res.statusCode, 200, res.bodyText());
  const body = res.json();
  assert.equal(body.ok, true);
  const exportedCount = Array.isArray(body.exported) ? body.exported.length : Number(body.exported);
  assert.equal(typeof exportedCount, 'number');
  assert.ok(exportedCount >= 1);
  assert.equal(body.targetDir, targetDir);
  assert.ok(String(body.targetDir).startsWith(targetDir), `targetDir: ${body.targetDir}`);

  const memoryDir = path.join(targetDir, 'memory');
  assert.equal(await exists(path.join(memoryDir, 'MEMORY.md')), true, 'the export includes the MEMORY.md index');
  const exportedFiles = (await readdir(memoryDir)).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md');
  assert.ok(exportedFiles.length >= 1, 'topic files are exported');
  const exportedText = await readFile(path.join(memoryDir, exportedFiles[0]), 'utf8');
  assert.match(exportedText, /^---\n/, 'exported files keep frontmatter');
  assert.match(exportedText, /name:/);
  assert.match(exportedText, /description:/);
  assert.match(exportedText, /type:/);

  const rulesFile = path.join(targetDir, '.claude', 'rules', 'dsh-memory.md');
  assert.equal(await exists(rulesFile), true, 'project rules are exported to .claude/rules/dsh-memory.md');
  assert.match(await readFile(rulesFile, 'utf8'), /V10 exported rule/);

  const bad = await callHttp(env, {
    method: 'POST',
    path: '/import',
    body: { path: path.join(env.tmp, 'missing-claude-dir') },
  });
  assert.equal(bad.statusCode === 200 ? bad.json().ok : false, false, 'a missing import path is refused');
});

test('v10 import/export: /memory import and /memory export commands', async (t) => {
  const env = await commandEnv(t);
  const sourceDir = await makeClaudeDir(env);
  // The slash-command tokenizer treats backslashes as escapes, so Windows
  // absolute paths are passed with forward slashes (as a user would).
  const asCommandPath = (value) => value.replaceAll('\\', '/');
  const imported = await env.invokeMemory(`import ${asCommandPath(sourceDir)}`);
  assert.equal(imported.kind, 'success', imported.text);
  assert.match(imported.text, /import/i);

  const targetDir = path.join(env.tmp, 'command-export');
  const exported = await env.invokeMemory(`export ${asCommandPath(targetDir)}`);
  assert.equal(exported.kind, 'success', exported.text);
  assert.match(exported.text, /export/i);
  assert.equal(await exists(path.join(targetDir, 'memory', 'MEMORY.md')), true);
});
