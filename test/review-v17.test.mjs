import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, toolsEnv } from './v10-helpers.mjs';

test('v17 index budget: byte overflow keeps whole head lines with CJK text', async (t) => {
  const env = await makeEnv(t, { indexMaxLines: 200, indexMaxBytes: 4096 });
  const lines = Array.from({ length: 40 }, (_, index) =>
    `- [记忆条目 ${index}](memory_${index}.md) — 这是用于测试中文索引字节预算的完整说明文字，不应被截断，编号 ${index}`);
  await env.store.writeIndex(`${lines.join('\n')}\n`);
  const index = await env.store.injectedIndex('project');
  assert.equal(index.truncated, true);
  assert.equal(index.overflow, true);
  assert.ok(index.bytes <= 4096, `injected bytes ${index.bytes} exceed 4096`);
  assert.match(index.text, /\[记忆条目 0\]\(memory_0\.md\)/, 'oldest head survives');
  assert.doesNotMatch(index.text, /\[记忆条目 39\]\(memory_39\.md\)/, 'content past the limit is dropped');
  assert.match(index.text, /index truncated at the read limit/);
  const rows = index.text.trimEnd().split('\n');
  for (const row of rows) {
    if (row.startsWith('<!--')) continue;
    assert.match(row, /^- \[记忆条目 \d+\]\(memory_\d+\.md\) — .+编号 \d+$/, `row must be whole: ${row}`);
  }
  assert.equal(index.text.endsWith('\n'), true, 'output ends with a full line');
});

test('v17 memory_update: failed rename+content leaves no half-applied state', async (t) => {
  const env = await toolsEnv(t);
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const seed = await env.pctx.store.saveEntry({
    name: 'atomic old name',
    type: 'project',
    description: 'old description',
    content: 'OLD BODY',
  });
  const before = await env.pctx.store.indexText();
  const tooLarge = await env.definitions.get('memory_update').execute(
    { file: seed.file, name: 'atomic new name', content: 'x'.repeat(200 * 1024) },
    exec,
  );
  assert.equal(tooLarge.ok, false, JSON.stringify(tooLarge));
  assert.equal(tooLarge.error, 'CONTENT_TOO_LARGE');
  const entries = await env.pctx.store.listEntries();
  assert.equal(entries.some((entry) => entry.name === 'atomic old name'), true, 'old name stays');
  assert.equal(entries.some((entry) => entry.name === 'atomic new name'), false, 'no new file was written');
  const after = await env.pctx.store.readEntry(seed.file);
  assert.equal(after.body, 'OLD BODY', 'old body stays');
  assert.equal(await env.pctx.store.indexText(), before, 'index stays unchanged');
});

test('v17 memory_update: case-only rename is not a conflict', async (t) => {
  const env = await toolsEnv(t);
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
  const seed = await env.pctx.store.saveEntry({
    name: 'Case Sensitive Name',
    type: 'project',
    description: 'case description',
    content: 'case body',
  });
  const updated = await env.definitions.get('memory_update').execute(
    { file: seed.file, name: 'case sensitive name', content: 'case body updated' },
    exec,
  );
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const entry = (await env.pctx.store.listEntries()).find((item) => item.name === 'case sensitive name');
  assert.ok(entry, 'frontmatter name is updated');
  const read = await env.pctx.store.readEntry(entry.file);
  assert.equal(read.body, 'case body updated');
});
