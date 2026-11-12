import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { WikiStore } from '../src/wiki-store.js';
import { makeTempDir } from './helpers.mjs';

test('WikiStore writes, reads, searches and audits pages', async (t) => {
  const root = await makeTempDir(t);
  const store = new WikiStore({ rootDir: path.join(root, 'wiki') });
  await store.ensure();
  await store.writePage('deal-overview.md', {
    name: 'Deal overview',
    description: 'Key deal facts',
    domain: 'deal',
    body: '- Revenue $123M. ^[doc-1#p12, 2026-01-15]\n\n[[deal-risks]]',
  });
  await store.writePage('deal-risks.md', {
    name: 'Deal risks',
    description: 'Risk list',
    domain: 'deal',
    body: '- Antitrust review is pending. ^[doc-2#p3, 2026-01-16]',
  });
  await store.writeIndex('- [[deal-overview]] — Key deal facts\n- [[deal-risks]] — Risk list\n');
  await store.writeSkill('---\nname: deal\ndescription: Deal wiki\n---\n\nStart at _index.md.');
  const pages = await store.listPages();
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.find((page) => page.file === 'deal-overview.md').links, ['deal-risks']);
  const read = await store.readPage('deal-overview.md');
  assert.match(read.body, /Revenue/);
  const hits = await store.search('revenue');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].page, 'deal-overview.md');
  const backlinks = await store.backlinks('deal-risks');
  assert.deepEqual(backlinks, ['deal-overview']);
  const audit = await store.audit();
  assert.equal(audit.ok, true);
  assert.equal(audit.pages, 2);
});

test('WikiStore reports dangling links and missing index entries', async (t) => {
  const root = await makeTempDir(t);
  const store = new WikiStore({ rootDir: path.join(root, 'wiki') });
  await store.ensure();
  await store.writePage('one.md', { name: 'One', description: 'One', body: '[[missing]]' });
  const audit = await store.audit();
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.dangling, [{ from: 'one.md', to: 'missing' }]);
  assert.deepEqual(audit.indexMissing, ['one.md']);
});

test('WikiStore stores source documents and latest manifest', async (t) => {
  const root = await makeTempDir(t);
  const store = new WikiStore({ rootDir: path.join(root, 'wiki') });
  await store.ensure();
  const id = await store.writeSource('doc-1', 'hello source', { path: 'a.txt' });
  assert.equal(id, 'doc-1');
  assert.equal((await store.readSource('doc-1')).text, 'hello source');
  assert.deepEqual(await store.listSources(), ['doc-1']);
  await store.writeBuildManifest('run-1', { kind: 'wiki', pages: 1 });
  assert.equal((await store.latestBuildManifest()).pages, 1);
});
