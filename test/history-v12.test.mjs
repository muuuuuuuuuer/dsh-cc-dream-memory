/**
 * v12 design fix 1: model overwrites keep a `.history/<file>/` snapshot.
 * Contract §设计问题修复 1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeEnv, exists } from './v10-helpers.mjs';

function historyRoot(env) {
  const paths = env.pctx.paths;
  return paths.historyDir ?? paths.historyRoot ?? path.join(paths.projectDir, '.history');
}

async function historyFiles(env, file) {
  const root = path.join(historyRoot(env), file);
  const names = await readdir(root).catch(() => []);
  return { root, names: names.filter((name) => name.endsWith('.md')).sort() };
}

test('v12 history: overwriting an existing memory keeps the old content snapshot', async (t) => {
  const env = await makeEnv(t, { keepHistory: true });
  assert.equal(env.config.keepHistory, true, 'keepHistory defaults to true');
  const saved = await env.store.saveEntry({
    name: 'history note',
    type: 'user',
    description: 'history description',
    content: 'HISTORY BODY V1',
  });
  await env.store.updateEntry(saved.file, { content: 'HISTORY BODY V2' });
  const { names } = await historyFiles(env, saved.file);
  assert.equal(names.length >= 1, true, `expected a snapshot for ${saved.file}`);
  const snapshot = await readFile(path.join(historyRoot(env), saved.file, names[0]), 'utf8');
  assert.match(snapshot, /HISTORY BODY V1/, 'the snapshot holds the previous body');

  // A raw (dream/import) overwrite leaves a snapshot too.
  await env.store.writeRawEntry(saved.file, {
    type: 'user',
    name: 'history note',
    description: 'history description',
    body: 'HISTORY BODY V3',
    source: { via: 'tool:memory_save' },
  });
  const after = await historyFiles(env, saved.file);
  assert.equal(after.names.length >= 2, true, 'raw overwrites also snapshot the previous body');
  const contents = await Promise.all(
    after.names.map((name) => readFile(path.join(historyRoot(env), saved.file, name), 'utf8')),
  );
  assert.equal(contents.some((text) => /HISTORY BODY V2/.test(text)), true);
});

test('v12 history: historyMaxPerFile trims the oldest snapshots', async (t) => {
  const env = await makeEnv(t, { keepHistory: true, historyMaxPerFile: 2 });
  assert.equal(env.config.historyMaxPerFile, 2);
  const saved = await env.store.saveEntry({
    name: 'trim note',
    type: 'user',
    description: 'd',
    content: 'TRIM V1',
  });
  for (const version of ['TRIM V2', 'TRIM V3', 'TRIM V4']) {
    await env.store.updateEntry(saved.file, { content: version });
  }
  const { names } = await historyFiles(env, saved.file);
  assert.ok(names.length <= 2, `expected at most 2 snapshots, got ${names.length}: ${names.join(', ')}`);
  const contents = (
    await Promise.all(names.map((name) => readFile(path.join(historyRoot(env), saved.file, name), 'utf8')))
  ).join('\n');
  assert.doesNotMatch(contents, /TRIM V1/, 'the oldest snapshot is pruned');
  assert.match(contents, /TRIM V3|TRIM V4/, 'recent snapshots are kept');
});

test('v12 history: keepHistory:false writes no snapshots', async (t) => {
  const env = await makeEnv(t, { keepHistory: false });
  assert.equal(env.config.keepHistory, false);
  const saved = await env.store.saveEntry({
    name: 'no history note',
    type: 'user',
    description: 'd',
    content: 'NO HISTORY V1',
  });
  await env.store.updateEntry(saved.file, { content: 'NO HISTORY V2' });
  const root = path.join(historyRoot(env), saved.file);
  assert.equal(await exists(root), false, 'no .history directory is created when keepHistory is false');
});
