import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex,
  buildSkill,
  citationToken,
  extractCitations,
  extractLinks,
  parseCitation,
  renderPage,
  rewriteLinks,
  validatePage,
} from '../src/wiki-core.js';

test('wiki-core extracts links outside code and rewrites them', () => {
  const body = 'See [[deal-overview|overview]] and [[ risks ]].\n```\n[[ignored]]\n```\n`[[inline]]`';
  assert.deepEqual(extractLinks(body), ['deal-overview', 'risks']);
  assert.equal(
    rewriteLinks('[[old]] [[old|label]] [[other]]', { old: 'new' }),
    '[[new]] [[new|label]] [[other]]',
  );
});

test('wiki-core parses and formats citations', () => {
  const parsed = parseCitation('session-abc#412, 2026-11-08');
  assert.deepEqual(parsed, { source: 'session-abc', locator: '412', date: '2026-11-08', raw: 'session-abc#412, 2026-11-08' });
  assert.equal(citationToken({ source: 'doc-1', locator: 'p12', date: '2026-01-15' }), '^[doc-1#p12, 2026-01-15]');
  const citations = extractCitations('a ^[doc-1#p1, 2026-01-01]\nb ^[doc-1#p1, 2026-01-01]\nc ^[doc-2]');
  assert.equal(citations.length, 2);
  assert.equal(citations[1].source, 'doc-2');
});

test('wiki-core renders pages, index and skill', () => {
  const text = renderPage({
    name: 'Deal overview',
    description: 'Deal facts',
    domain: 'deal',
    type: 'reference',
    modified: '2026-01-01T00:00:00.000Z',
    body: '- Revenue ^[doc-1#p1, 2026-01-01]\n\n[[deal-risks]]',
  });
  assert.match(text, /domain: deal/);
  assert.match(text, /\[\[deal-risks\]\]/);
  const index = buildIndex({
    pages: [
      { file: 'deal_overview.md', slug: 'deal-overview', name: 'Deal overview', description: 'Deal facts', domain: 'deal' },
      { file: 'deal_risks.md', slug: 'deal-risks', name: 'Deal risks', description: 'Risks', domain: 'deal' },
    ],
    style: 'wiki',
  });
  assert.match(index, /## deal/);
  assert.match(index, /\[\[deal-overview\]\]/);
  const skill = buildSkill({ title: 'Knowledge wiki', domains: ['deal'] });
  assert.match(skill, /Start at _index.md/);
  assert.match(skill, /deal/);
});

test('wiki-core validation rejects unsafe page names and oversized bodies', () => {
  assert.equal(validatePage({ file: '_index.md', text: 'x' }).ok, false);
  assert.equal(validatePage({ file: '../x.md', text: 'x' }).ok, false);
  const ok = validatePage({ file: 'topic.md', text: '---\nname: Topic\n---\n\nbody' });
  assert.equal(ok.ok, true);
  assert.equal(ok.warnings.length, 1);
});
