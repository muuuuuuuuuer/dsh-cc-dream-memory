import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWikiTopics, repairWikiLinks, markSupersededFacts, SUPERSEDED_MARK } from '../src/wiki-build.js';

function page(file, name, body, description = '') {
  return { file, name, description, domain: 'General', body };
}

test('two pages for one topic become one page with every cited line kept once', () => {
  const pages = new Map([
    ['deal.md', page('deal.md', 'Deal Overview', '- Revenue is $123M. ^[a#p1, 2026-01-01]')],
    ['deal-notes.md', page('deal-notes.md', 'Deal-Overview', '- Revenue is $123M. ^[a#p1, 2026-01-01]\n- Signed in March. ^[b#p2, 2026-03-01]')],
  ]);
  const warnings = [];
  const merged = mergeWikiTopics(pages, { warnings });
  assert.equal(merged, 1);
  assert.deepEqual([...pages.keys()], ['deal-notes.md'], 'the richer page survives');
  const body = pages.get('deal-notes.md').body;
  assert.equal(body.split('\n').filter((line) => line.includes('Revenue is $123M')).length, 1);
  assert.match(body, /Signed in March/u);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /merged deal\.md into deal-notes\.md/u);
});

test('a dangling link is pointed at the one page it can only mean', () => {
  const pages = new Map([
    ['deal.md', page('deal.md', 'Deal Overview', '- Revenue. ^[a#p1, 2026-01-01]')],
    ['index.md', page('index.md', 'Index', 'See [[deal overview]].')],
  ]);
  const warnings = [];
  assert.equal(repairWikiLinks(pages, { warnings }), 1);
  assert.equal(pages.get('index.md').body, 'See [[deal]].');
  assert.deepEqual(warnings, []);
});

test('an ambiguous link is left alone and reported', () => {
  const pages = new Map([
    ['deal-a.md', page('deal-a.md', 'Deal One', 'x')],
    ['deal-b.md', page('deal-b.md', 'Deal Two', 'y')],
    ['notes.md', page('notes.md', 'Notes', 'See [[deal one|two]].')],
  ]);
  const warnings = [];
  assert.equal(repairWikiLinks(pages, { warnings }), 0);
  assert.equal(pages.get('notes.md').body, 'See [[deal one|two]].');
});

test('the older of two conflicting values is marked as replaced, both lines stay', () => {
  const pages = new Map([
    ['release.md', page('release.md', 'Release', [
      '- Release takes 12 seconds. ^[a#p1, 2026-01-01]',
      '- Release takes 9 seconds. ^[b#p2, 2026-02-01]',
    ].join('\n'))],
  ]);
  const warnings = [];
  const result = markSupersededFacts(pages, { warnings });
  assert.deepEqual(result, { superseded: 1, conflicts: 1 });
  const lines = pages.get('release.md').body.split('\n');
  assert.match(lines[1], new RegExp(SUPERSEDED_MARK.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(lines[1], /2026-02-01/u);
  assert.match(lines[1], /：9）/u);
  assert.match(lines[2], /Release takes 9 seconds/u, 'the newer value is not marked');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /conflicting values/u);
});

test('one value repeated is not a conflict', () => {
  const pages = new Map([
    ['release.md', page('release.md', 'Release', [
      '- Release takes 9 seconds. ^[a#p1, 2026-01-01]',
      '- Release takes 9 seconds. ^[b#p2, 2026-02-01]',
    ].join('\n'))],
  ]);
  assert.deepEqual(markSupersededFacts(pages), { superseded: 0, conflicts: 0 });
});
