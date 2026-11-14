/**
 * v20 index hygiene: an index line is a pointer, not the note. Claude Code
 * demotes entries over ~200 characters; the host does the same by clipping the
 * hook so MEMORY.md stays scannable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './v10-helpers.mjs';

test('a long index line is clipped in MEMORY.md to the index budget', async (t) => {
  const env = await makeEnv(t);
  const long = 'x'.repeat(160);
  await env.pctx.store.saveEntry({
    scope: 'project',
    name: `long note ${'n'.repeat(60)}`,
    type: 'project',
    description: long,
    content: 'The detail lives in the topic file.\n',
    source: { kind: 'user' },
  });
  const [line] = (await env.pctx.store.indexText()).trim().split('\n');
  const link = /\]\(([^)]+)\)/.exec(line)?.[1];
  assert.ok(link, 'the index line still links to the topic file');
  assert.ok(line.length <= 200, `index line stays within 200 chars, got ${line.length}`);
  assert.match(line, /…$/, 'the clipped hook ends with an ellipsis');
  assert.match(await env.pctx.store.readEntry(link).then((entry) => entry.raw), new RegExp(long), 'the topic file keeps the full description');
});
