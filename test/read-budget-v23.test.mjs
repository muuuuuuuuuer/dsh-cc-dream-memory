/**
 * v23 read budget: one request reads each topic file at most once.
 *
 * Why: every surface used to parse the same eight notes again — the list, the
 * search, the trust table and the Dream input each opened the directory and
 * re-read the bodies. The store now keeps one content cache per operation
 * (validated by mtime + size, cleared by every write), so the budget is
 * "number of notes", not "number of callers".
 *
 * The counter is the store's own `contentReads` (real file reads, not cache
 * hits), so this measures disk work rather than call counts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeEnv } from './v10-helpers.mjs';

const NOTES = 8;

async function seed(env) {
  for (let index = 0; index < NOTES; index += 1) {
    await env.pctx.store.saveEntry({
      scope: 'project',
      type: 'project',
      name: `note ${index}`,
      description: `budget note ${index} about deploy steps`,
      content: `STATUS: current\n\nDeploy step ${index} runs npm run build.\n`,
      source: { via: 'test' },
    });
  }
  // The writes clear the cache; start every measurement from a clean slate.
  env.pctx.store.contentReads = 0;
}

test('v23 read budget: listing eight notes reads each file at most once', async (t) => {
  const env = await runtimeEnv(t, {});
  await seed(env);
  const entries = await env.pctx.store.listEntries('project');
  assert.equal(entries.length, NOTES);
  assert.ok(
    env.pctx.store.contentReads <= NOTES,
    `listing must not re-read: ${env.pctx.store.contentReads} reads for ${NOTES} notes`,
  );
});

test('v23 read budget: repeated reads inside one operation hit the cache', async (t) => {
  const env = await runtimeEnv(t, {});
  await seed(env);
  const store = env.pctx.store;
  const entries = await store.listEntries('project');
  for (const entry of entries) await store.readEntry(entry.file, 'project');
  assert.ok(
    store.contentReads <= NOTES,
    `list + eight reads must stay at one read per file, saw ${store.contentReads}`,
  );
});

test('v23 read budget: a search over eight notes reads each file at most once', async (t) => {
  const env = await runtimeEnv(t, {});
  await seed(env);
  const hits = await env.pctx.store.search('deploy step', { scope: 'project', currentOnly: true });
  assert.ok(hits.length > 0, 'the seeded notes must be findable');
  assert.ok(
    env.pctx.store.contentReads <= NOTES,
    `search must reuse the cached parse, saw ${env.pctx.store.contentReads}`,
  );
});

test('v23 read budget: a write invalidates the cache so the next read is fresh', async (t) => {
  const env = await runtimeEnv(t, {});
  await seed(env);
  const store = env.pctx.store;
  const before = await store.readEntry('note-0.md', 'project').catch(() => null);
  const file = (await store.listEntries('project'))[0].file;
  const first = await store.readEntry(file, 'project');
  assert.ok(first.body.includes('Deploy step'), 'sanity: the note reads back');
  await store.writeRawEntry(file, {
    scope: 'project',
    type: 'project',
    name: first.frontmatter.name,
    description: first.frontmatter.description,
    body: 'STATUS: current\n\nDeploy step replaced by npm run ship.\n',
    source: { via: 'test' },
  });
  const again = await store.readEntry(file, 'project');
  assert.ok(again.body.includes('npm run ship'), 'a write must not be masked by the cache');
  assert.equal(before, null, 'the first read was of a file that does not exist');
});
