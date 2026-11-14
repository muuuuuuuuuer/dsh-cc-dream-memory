/**
 * The public identity of the package. npm's `dsh-cc-memory` belongs to another
 * publisher, and the Claude Code name may be used in plain text but not as a
 * product or feature name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const en = JSON.parse(await read('locale/en.json'));
const zh = JSON.parse(await read('locale/zh.json'));

test('package.json carries the public identity', () => {
  assert.equal(pkg.name, 'dsh-cc-dream-memory');
  assert.equal(pkg.version, '0.20.0');
  assert.equal(
    pkg.description,
    'Claude Code-style auto memory and reviewable Dream consolidation for DeepSeek Harness. Community plugin, not affiliated with Anthropic.',
  );
  for (const keyword of ['dsh-plugin', 'deepseek-harness', 'claude-code', 'claude-code-memory', 'dream']) {
    assert.ok(pkg.keywords.includes(keyword), keyword);
  }
  assert.equal(pkg.repository.url, 'git+https://github.com/muuuuuuuuuer/dsh-cc-dream-memory.git');
  assert.equal(pkg.homepage, 'https://github.com/muuuuuuuuuer/dsh-cc-dream-memory#readme');
  assert.equal(pkg.bugs.url, 'https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/issues');
});

test('the shop catalog entry is complete', () => {
  assert.ok(pkg.dsh.bundle.patch);
  assert.ok(pkg.dsh.catalog.category);
  assert.ok(pkg.dsh.catalog.summary.en && pkg.dsh.catalog.summary.zh);
});

test('the pack holds only what a user needs', () => {
  for (const file of ['README.md', 'README.zh.md', 'CHANGELOG.md', 'LICENSE', 'index.js', 'client.js', 'src/*.js']) {
    assert.ok(pkg.files.includes(file), file);
  }
  for (const file of pkg.files) assert.doesNotMatch(file, /FIXES|INTERFACES|ARCHITECTURE|\.github/);
});

test('the bundle row id does not collide with the unrelated dsh-cc-memory plugin', async () => {
  const patch = await read('cordis.patch.yml');
  assert.match(patch, /id: cc-dream-memory/);
  assert.match(patch, /name: dsh-cc-dream-memory/);
});

test('the client module id and locale namespace follow the package name', async () => {
  const client = await read('client.js');
  assert.match(client, /id: 'dsh-cc-dream-memory'/);
  assert.match(client, /const NS = 'dsh-cc-dream-memory'/);
  assert.doesNotMatch(client, /dsh-cc-memory/);
});

test('the Claude name is not the feature name in the interface', () => {
  assert.equal(en['inbox.planTitle'], 'A Dream result is ready');
  assert.equal(zh['inbox.planTitle'], 'Dream 结果已就绪');
  assert.doesNotMatch(JSON.stringify([en, zh]), /Claude/);
});

test('the old package name is gone from code', async () => {
  for (const file of ['index.js', 'src/config.js', 'src/status.js', 'scripts/verify.mjs', 'eval/run.mjs']) {
    assert.doesNotMatch(await read(file), /dsh-cc-memory/, file);
  }
});
