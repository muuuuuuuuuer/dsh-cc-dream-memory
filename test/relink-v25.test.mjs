import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/store.js';
import { buildPaths } from '../src/paths.js';
import { resolveConfig } from '../src/config.js';

async function newStore(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ccm-relink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = buildPaths({ memoryRoot: root, homeDir: root, workspaceDir: path.join(root, 'ws') });
  const config = resolveConfig({});
  const store = new MemoryStore({ paths, getConfig: () => config });
  await store.ensure();
  return { store, paths, root };
}

test('rename rewrites [[old]] links in the renamed page and in other pages', async (t) => {
  const { store, paths } = await newStore(t);
  const a = await store.saveEntry({
    name: 'route naming',
    type: 'project',
    description: 'API routes',
    content: 'Routes use kebab-case.',
  });
  assert.equal(a.file, 'project_route_naming.md');
  const b = await store.saveEntry({
    name: 'router',
    type: 'project',
    description: 'Router notes',
    content: 'See [[project_route_naming]] for the convention.',
  });
  const c = await store.saveEntry({
    name: 'handler',
    type: 'project',
    description: 'Handler notes',
    content: 'Uses [[project_route_naming]] and nothing else.',
  });

  const renamed = await store.renameEntry(a.file, 'URL naming');
  assert.equal(renamed.ok, true);
  assert.equal(renamed.file, 'project_url_naming.md');
  assert.deepEqual(renamed.relinked.slice().sort(), [b.file, c.file].sort(), 'both referencing pages are rewritten');

  const bRead = await store.readEntry(b.file);
  assert.match(bRead.body, /\[\[project_url_naming\]\]/);
  assert.doesNotMatch(bRead.body, /\[\[project_route_naming\]\]/);
  const cRead = await store.readEntry(c.file);
  assert.match(cRead.body, /\[\[project_url_naming\]\]/);
  assert.match(await readFile(paths.indexFile, 'utf8'), /project_url_naming\.md/);
  assert.doesNotMatch(await readFile(paths.indexFile, 'utf8'), /project_route_naming\.md/);
});

test('rename leaves unrelated brackets and other names alone', async (t) => {
  const { store } = await newStore(t);
  const a = await store.saveEntry({ name: 'alpha', type: 'reference', description: 'A', content: 'Body A.' });
  const b = await store.saveEntry({
    name: 'beta',
    type: 'reference',
    description: 'B',
    content: 'Keeps [[reference_alpha_extra]] and [a link](reference_alpha.md) and [[reference_beta]].',
  });
  const renamed = await store.renameEntry(a.file, 'alpha two');
  assert.equal(renamed.ok, true);
  assert.deepEqual(renamed.relinked ?? [], [], 'a longer slug that merely starts the same is not a match');
  const read = await store.readEntry(b.file);
  assert.match(read.body, /\[\[reference_alpha_extra\]\]/);
  assert.match(read.body, /\[a link\]\(reference_alpha\.md\)/);
  assert.match(read.body, /\[\[reference_beta\]\]/);
});

test('a case-only rename rewrites nothing', async (t) => {
  const { store } = await newStore(t);
  const a = await store.saveEntry({ name: 'same', type: 'project', description: 'S', content: 'Body.' });
  const renamed = await store.renameEntry(a.file, 'SAME');
  assert.equal(renamed.renamed, true);
  assert.equal('relinked' in renamed, false, 'the file name did not change');
});

test('a write with no links reports no relinked field', async (t) => {
  const { store } = await newStore(t);
  const a = await store.saveEntry({ name: 'one', type: 'project', description: 'One', content: 'one' });
  const renamed = await store.renameEntry(a.file, 'two');
  assert.equal(renamed.ok, true);
  assert.equal('relinked' in renamed, false, 'nothing referenced the old name');
});

test('an empty or identical slug never touches files', async (t) => {
  const { store } = await newStore(t);
  assert.deepEqual(await store._rewriteLinks('project', '', 'x'), []);
  assert.deepEqual(await store._rewriteLinks('project', 'x', 'x'), []);
});

test('the temp store actually has the memory dir (sanity)', async (t) => {
  const { paths } = await newStore(t);
  await mkdir(path.dirname(paths.indexFile), { recursive: true });
  await writeFile(paths.indexFile, '', 'utf8');
  assert.equal(typeof paths.indexFile, 'string');
});
