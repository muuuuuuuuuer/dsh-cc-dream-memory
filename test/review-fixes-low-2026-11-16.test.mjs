/**
 * The eight low-severity findings from
 * `docs/superpowers/reviews/2026-11-16-code-review.md` (line 127-140).
 *
 * Each test reproduces the state the report described; on the code before the
 * fix it fails (an index line loses its link, a page loses its line, a clipped
 * body reads as the whole page, a stale pending record blocks every run, a
 * restore overwrites without a history snapshot, a delegated session can write).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeEnv, commandEnv } from './v10-helpers.mjs';
import { buildRecallText } from '../src/recall.js';

const CLIPPED = '(use memory_read for the rest)';

/** Link targets of every index line, in order. */
function indexTargets(text) {
  return [...text.matchAll(/- \[[^\]]*\]\(([^()]*)\)/gu)].map((match) => match[1]);
}

test('a page whose name nearly fills an index line keeps its link', async (t) => {
  const env = await makeEnv(t);
  const store = env.store;
  const name = `long-${'a'.repeat(96)}`;
  const saved = await store.saveEntry({
    name,
    type: 'reference',
    description: 'a description long enough to be shortened',
    content: '# Long\n\nbody\n',
  });
  const own = async () => (await store.indexText('project'))
    .split('\n')
    .filter((line) => indexTargets(line).includes(saved.file));
  const lines = await own();
  assert.equal(lines.length, 1, 'the page has exactly one index line');
  assert.ok(
    lines[0].startsWith(`- [${saved.name}](${saved.file})`),
    `the link must survive truncation, got: ${lines[0]}`,
  );

  // Rewriting the page finds that line again instead of appending a new one.
  await store.saveEntry({ name, type: 'reference', description: 'second', content: '# Long\n\nsecond\n' });
  await store.saveEntry({ name, type: 'reference', description: 'third', content: '# Long\n\nthird\n' });
  assert.equal((await own()).length, 1, 'three saves leave one line');
  await store.reconcileIndex('project');
  assert.equal((await own()).length, 1, 'reconcile adopts the line instead of appending');
});

test('a description that links another page does not own that page\'s line', async (t) => {
  const env = await makeEnv(t);
  const store = env.store;
  await store.saveEntry({
    name: 'alpha',
    type: 'reference',
    description: 'Related: [beta](reference_beta.md) covers the same topic.',
    content: '# Alpha\n\nbody\n',
  });
  const beta = await store.saveEntry({
    name: 'beta',
    type: 'reference',
    description: 'beta page',
    content: '# Beta\n\nbody\n',
  });
  const targets = async () => indexTargets(await store.indexText('project'));
  assert.ok((await targets()).includes('reference_alpha.md'), 'saving beta keeps alpha\'s line');
  assert.ok((await targets()).includes(beta.file));

  await store.trashEntry(beta.file, { scope: 'project', reason: 'test' });
  assert.ok((await targets()).includes('reference_alpha.md'), 'trashing beta leaves alpha\'s line');
  assert.equal((await targets()).includes(beta.file), false);
});

test('a clipped body always carries the read-more pointer', () => {
  const body = `# One\n\n${'x'.repeat(200)}`;
  const text = buildRecallText([{ file: 'a.md', body }], { maxChars: 340 });
  assert.match(text, /a\.md/);
  const shown = text.split('\n').filter((line) => line.startsWith('x'));
  assert.equal(shown.length, 1);
  assert.ok(shown[0].endsWith(CLIPPED), `a clipped body must say it was clipped: ${shown[0]}`);

  // Eight notes in the same budget leave no room for the pointer.
  const many = Array.from({ length: 8 }, (_, index) => ({ file: `note_${index}.md`, body }));
  const tight = buildRecallText(many, { maxChars: 300 });
  for (const line of tight.split('\n').filter((item) => item.startsWith('x'))) {
    assert.ok(
      line.endsWith(CLIPPED) || line === 'x'.repeat(200),
      `a fragment without the pointer reads as the whole page: ${line}`
    );
  }
});

test('a pending record whose copy is gone stops blocking runs', async (t) => {
  const env = await makeEnv(t);
  const pending = {
    dir: path.join(env.paths.dreamsDir, 'shadow-gone'),
    createdAt: 1,
    runId: 'run-1',
    summary: 'stale',
    base: {},
    files: [],
    counts: { added: 0, changed: 0, removed: 0 },
    sessions: [],
    proposals: {},
    links: {},
  };
  await env.state.setShadowPending(pending);
  assert.equal(await env.state.dropStaleShadowPending(), true, 'the missing directory is dropped');
  assert.equal(env.state.snapshot().shadowPending, null);

  await fs.mkdir(pending.dir, { recursive: true });
  await env.state.setShadowPending(pending);
  assert.equal(await env.state.dropStaleShadowPending(), false, 'a live copy is left for the reviewer');
  assert.equal(env.state.snapshot().shadowPending?.runId, 'run-1');
});

test('a delegated session cannot restore files over the live memory', async (t) => {
  const env = await commandEnv(t, { subagentMemory: 'off' });
  const child = { id: 'child', session: { header: { parentSession: 'parent' } } };
  const result = await env.invokeMemory('restore trash batch-1', child);
  assert.equal(result.kind, 'error');
  assert.match(result.text, /subagent-readonly/u);
});

test('restore keeps the page it replaces in the history', async (t) => {
  const env = await commandEnv(t);
  const store = env.store;
  const first = await store.saveEntry({
    name: 'beta',
    type: 'reference',
    description: 'beta page',
    content: '# Beta\n\nfirst version\n',
  });
  const trashed = await store.trashEntry(first.file, { scope: 'project', reason: 'test' });
  const batch = path.basename(trashed.trashDir);
  // A new page with the same name now owns the path the restore is about to take.
  const second = await store.saveEntry({
    name: 'beta',
    type: 'reference',
    description: 'beta page',
    content: '# Beta\n\nsecond version\n',
  });
  assert.equal(second.file, first.file);

  const restored = await env.invokeMemory(`restore trash ${batch}`);
  assert.equal(restored.kind, 'success', restored.text);
  const live = await store.readEntry(first.file, 'project');
  assert.match(live.body, /first version/u, 'the trashed copy is back');

  const snapshots = await fs.readdir(path.join(store.historyRoot, first.file));
  const contents = await Promise.all(snapshots.map((name) => fs.readFile(path.join(store.historyRoot, first.file, name), 'utf8')));
  assert.ok(
    contents.some((text) => text.includes('second version')),
    'the overwritten page is recoverable from .history'
  );
});
