import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsEnv } from './v10-helpers.mjs';
import { polarityOf } from '../src/policy.js';

const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
const examples = [
  {
    topic: 'deployment',
    original: { name: 'deployment policy', description: 'Release commands', content: 'Never run legacy-deploy.sh. Deploy with make release for production.' },
    addition: { name: 'staging deployment', description: 'Staging release command', content: 'Staging deploy uses make release-staging for preview environments.' },
  },
  {
    topic: 'exports',
    original: { name: 'export policy', description: 'TypeScript export conventions', content: 'Avoid default exports. Use named exports for TypeScript modules.' },
    addition: { name: 'module checks', description: 'TypeScript compiler and lint rules', content: 'TypeScript modules use strict mode; lint checks named exports.' },
  },
];

// Restoring whole-text negative dominance or substring polarity would reject
// these complementary facts. Exercise the actual tool and persisted files.
for (const example of examples) {
  for (const operation of ['save', 'update']) {
    test(`${operation} accepts complementary ${example.topic} clauses without changing the existing rule`, async (t) => {
      const e = await toolsEnv(t);
      const original = await e.pctx.store.saveEntry({ type: 'project', ...example.original });
      const before = await e.pctx.store.readEntry(original.file);
      let target;
      if (operation === 'update') {
        target = await e.pctx.store.saveEntry({ name: 'working note', type: 'project', description: 'Unrelated placeholder', content: 'A fact awaiting details.' });
      }
      const args = operation === 'save'
        ? { type: 'project', ...example.addition }
        : { file: target.file, ...example.addition };
      const result = await e.definitions.get(`memory_${operation}`).execute(args, exec);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.notEqual(result.written, false, JSON.stringify(result));
      assert.equal((await e.pctx.store.readEntry(result.file ?? target.file)).body, example.addition.content);
      assert.equal((await e.pctx.store.readEntry(original.file)).raw, before.raw);
    });
  }
}

test('English polarity words do not match inside user or identifiers', () => {
  assert.equal(polarityOf('The user and username fields describe reusable values.'), null);
  assert.equal(polarityOf('The disabled_flag and enablement fields are documented.'), null);
  assert.equal(polarityOf('Use named exports.'), 'positive');
  assert.equal(polarityOf('Avoid default exports.'), 'negative');
  assert.equal(polarityOf('Never use legacy-deploy.sh. Use make release.'), null);
});

test('a contradiction of a positive clause stops the write and names the owner', async (t) => {
  const e = await toolsEnv(t);
  const original = await e.pctx.store.saveEntry({ name: 'release policy', type: 'project', description: 'Production release rules', content: 'Never run legacy-deploy.sh. Use make release for production deploys.' });
  const before = await e.pctx.store.readEntry(original.file);
  const result = await e.definitions.get('memory_save').execute({ name: 'release correction', type: 'project', description: 'New production command guidance', content: 'Never use make release for production deploys.' }, exec);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, 'CONFLICT');
  assert.equal(result.existingFile ?? result.conflicts[0].file, original.file);
  assert.match(result.conflicts[0].reason, /opposite polarity/);
  assert.equal((await e.pctx.store.readEntry(original.file)).raw, before.raw);
  assert.equal((await e.pctx.store.listEntries()).length, 1);

  // force:true is the documented escape hatch: the model states it is deliberate.
  const forced = await e.definitions.get('memory_save').execute({ name: 'release correction', type: 'project', description: 'New production command guidance', content: 'Never use make release for production deploys.', force: true }, exec);
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(forced.written, true);
  assert.equal((await e.pctx.store.listEntries()).length, 2);
});

test('an opposite fact against another page stops and leaves both files untouched', async (t) => {
  const e = await toolsEnv(t);
  const owner = await e.pctx.store.saveEntry({ name: 'indentation', type: 'user', description: 'Indentation preference', content: 'Always use tabs for indentation.' });
  const target = await e.pctx.store.saveEntry({ name: 'draft convention', type: 'user', description: 'Another convention', content: 'Pending a concrete convention.' });
  const ownerBefore = await e.pctx.store.readEntry(owner.file);
  const result = await e.definitions.get('memory_update').execute({ file: target.file, description: 'Changed indentation', content: 'Never use tabs for indentation.' }, exec);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, 'CONFLICT');
  assert.equal(result.existingFile ?? result.conflicts[0].file, owner.file);
  assert.equal((await e.pctx.store.readEntry(target.file)).body, 'Pending a concrete convention.');
  assert.equal((await e.pctx.store.readEntry(owner.file)).raw, ownerBefore.raw);

  // force:true writes the reviewed bytes into the target page only.
  const forced = await e.definitions.get('memory_update').execute({ file: target.file, description: 'Changed indentation', content: 'Never use tabs for indentation.', force: true }, exec);
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal((await e.pctx.store.readEntry(target.file)).body, 'Never use tabs for indentation.');
  assert.equal((await e.pctx.store.readEntry(owner.file)).raw, ownerBefore.raw);
});

test('cross-file conflict updates stop and never overwrite the conflict owner', async (t) => {
  const e = await toolsEnv(t);
  const owner = await e.pctx.store.saveEntry({ name: 'indentation', type: 'user', description: 'Indentation preference', content: 'Always use tabs for indentation.' });
  const target = await e.pctx.store.saveEntry({ name: 'draft convention', type: 'user', description: 'Another convention', content: 'Pending a concrete convention.' });
  const ownerBefore = await e.pctx.store.readEntry(owner.file);
  const result = await e.definitions.get('memory_update').execute({ file: target.file, description: 'Changed indentation', content: 'Never use tabs for indentation.' }, exec);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, 'CONFLICT');
  assert.equal(result.existingFile ?? result.conflicts[0].file, owner.file);
  assert.equal((await e.pctx.store.readEntry(target.file)).body, 'Pending a concrete convention.');
  assert.equal((await e.pctx.store.readEntry(owner.file)).raw, ownerBefore.raw);
});

test('complementary clauses write directly whatever the confidence', async (t) => {
  const e = await toolsEnv(t);
  await e.pctx.store.saveEntry({ type: 'project', ...examples[0].original });
  const result = await e.definitions.get('memory_save').execute({ type: 'project', ...examples[0].addition, confidence: 'low' }, exec);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, true);
  assert.equal((await e.pctx.store.listEntries()).length, 2);
});
