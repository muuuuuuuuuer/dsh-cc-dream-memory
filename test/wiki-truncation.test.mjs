import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitPageBody, normalizeWikiWrites, buildWikiOrganizerPrompt } from '../src/wiki-build.js';

test('an oversized page is split at line boundaries without losing a character', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `Line ${index} ${'x'.repeat(40)}`);
  const body = lines.join('\n');
  const parts = splitPageBody(body, 300);
  assert.ok(parts.length > 1);
  assert.equal(parts.join('\n'), body);
  for (const part of parts) assert.ok(part.length <= 300 + 50);
});

test('normalizeWikiWrites never silently truncates a page body', () => {
  const body = `## One\n${'a'.repeat(400)}\n\n## Two\n${'b'.repeat(400)}`;
  const writes = normalizeWikiWrites(
    { writes: [{ file: 'project.md', name: 'Project', body }] },
    { maxWrites: 10, maxPageChars: 500 },
  );
  assert.ok(writes.length > 1);
  const rebuilt = writes.map((write) => write.body).join('\n');
  assert.equal(rebuilt.replace(/\n+$/u, ''), body.replace(/\n+$/u, ''));
  assert.deepEqual(writes.map((write) => write.file), ['project.md', 'project-2.md']);
  assert.match(writes[1].name, /part 2/);
});

test('the organizer prompt names the pages it had to omit', () => {
  const stats = {};
  const prompt = buildWikiOrganizerPrompt({
    pages: [
      { file: 'a.md', body: 'A'.repeat(100) },
      { file: 'b.md', body: 'B'.repeat(400) },
    ],
    writes: [],
    maxChars: 150,
    stats,
  });
  assert.match(prompt, /omitted for budget: b\.md/);
  assert.deepEqual(stats.omitted, ['b.md']);
});
