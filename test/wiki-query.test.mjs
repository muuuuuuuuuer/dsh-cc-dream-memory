import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { WikiStore, extractFactClaims } from '../src/wiki-store.js';
import {
  pageCitations,
  readWikiPage,
  searchWiki,
  validateWikiAnswer,
  wikiLinks,
} from '../src/wiki-query.js';
import { registerWikiTools } from '../src/wiki-tools.js';
import { makeTempDir } from './helpers.mjs';

const OVERVIEW_BODY = [
  '- Revenue $123M. ^[doc-1#p1, 2026-01-01]',
  '- Revenue is $125M in the latest filing. ^[doc-2#p2, 2026-02-01]',
  '',
  '[[deal-risks]]',
].join('\n');

async function seed(t) {
  const tmp = await makeTempDir(t);
  const store = new WikiStore({ rootDir: path.join(tmp, 'wiki') });
  await store.ensure();
  await store.writePage('deal-overview.md', {
    name: 'Deal overview',
    description: 'Deal facts',
    domain: 'deal',
    body: OVERVIEW_BODY,
  });
  await store.writePage('deal-risks.md', {
    name: 'Deal risks',
    description: 'Risks',
    domain: 'deal',
    body: '- Antitrust review is pending. ^[doc-3#p3, 2026-01-02]',
  });
  await store.writeIndex('- [[deal-overview]] — Deal facts\n- [[deal-risks]] — Risks\n');
  return { tmp, store, wikiDir: store.rootDir };
}

function fakeToolsCtx(store) {
  const defs = [];
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          register(definition) {
            defs.push(definition);
            return () => {};
          },
        };
      }
      return undefined;
    },
  };
  const runtime = {
    config: { wikiEnabled: true, enabled: true },
    async forAgent() {
      return { paths: { wikiDir: store.rootDir } };
    },
  };
  return { defs, dispose: registerWikiTools(ctx, runtime) };
}

test('wiki query helpers search, read and traverse links', async (t) => {
  const { store } = await seed(t);
  const hits = await searchWiki(store, 'revenue');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].page, 'deal-overview.md');
  const page = await readWikiPage(store, 'deal-overview.md');
  assert.match(page.body, /Revenue/);
  const graph = await wikiLinks(store, 'deal-overview.md');
  assert.deepEqual(graph.links, ['deal-risks']);
  assert.deepEqual(graph.backlinks, []);
});

test('fact claims carry stable ids and the source trace of their fact line', async (t) => {
  const { store } = await seed(t);
  const page = await readWikiPage(store, 'deal-overview.md');
  assert.equal(Array.isArray(page.claims), true);
  assert.equal(page.claims.length, 2);
  for (const claim of page.claims) {
    assert.deepEqual(Object.keys(claim).sort(), ['claimId', 'date', 'locator', 'source', 'text']);
    assert.match(claim.claimId, /^c[0-9a-f]{12}$/);
    assert.doesNotMatch(claim.text, /\^\[/);
    assert.doesNotMatch(claim.text, /^- /);
  }
  const first = page.claims.find((claim) => claim.source === 'doc-1');
  const second = page.claims.find((claim) => claim.source === 'doc-2');
  assert.equal(first.text, 'Revenue $123M.');
  assert.equal(first.locator, 'p1');
  assert.equal(first.date, '2026-01-01');
  assert.equal(second.text, 'Revenue is $125M in the latest filing.');
  assert.equal(second.locator, 'p2');
  assert.equal(second.date, '2026-02-01');
  assert.notEqual(first.claimId, second.claimId);

  // The same fact line always derives the same claim id.
  const again = await readWikiPage(store, 'deal-overview.md');
  assert.deepEqual(again.claims, page.claims);
  assert.deepEqual(extractFactClaims(OVERVIEW_BODY, { file: 'deal-overview.md' }), page.claims);

  // Search hits expose the same claim ids, so a citation can be built from search.
  const hits = await searchWiki(store, 'revenue');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].claims.map((claim) => claim.claimId), page.claims.map((claim) => claim.claimId));
  assert.equal(hits[0].citations.length, 2);
  assert.equal(hits[0].citations[0].claimId, page.claims[0].claimId);

  // Page citations are enriched with the matching claim id.
  assert.deepEqual(pageCitations(page).map((citation) => citation.claimId), page.claims.map((claim) => claim.claimId));
});

test('claims ignore unsourced lines, incomplete citations and code blocks', async (t) => {
  const { store } = await seed(t);
  await store.writePage('misc.md', {
    name: 'Misc',
    description: 'Unsourced notes',
    body: [
      '- A plain line without a source.',
      '- A source without a date. ^[doc-9#p9]',
      '- Inline code `^[doc-9#p9, 2026-01-01]` is not a claim.',
      '```',
      '- Fenced ^[doc-9#p9, 2026-01-01]',
      '```',
    ].join('\n'),
  });
  const page = await readWikiPage(store, 'misc.md');
  assert.deepEqual(page.claims, []);
});

test('wiki answer validation accepts claim ids and rejects unrelated claims', async (t) => {
  const { store } = await seed(t);
  const overview = await readWikiPage(store, 'deal-overview.md');
  const risks = await readWikiPage(store, 'deal-risks.md');
  const revenueClaim = overview.claims.find((claim) => claim.source === 'doc-1');
  const riskClaim = risks.claims[0];

  const ok = await validateWikiAnswer(store, {
    answer: 'Revenue was $123M',
    citations: [{ page: 'deal-overview.md', claimId: revenueClaim.claimId }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.citations.length, 1);
  assert.equal(ok.citations[0].claimId, revenueClaim.claimId);
  assert.equal(ok.citations[0].claim.text, revenueClaim.text);
  assert.equal(ok.citations[0].claim.source, 'doc-1');

  const okWithQuote = await validateWikiAnswer(store, {
    answer: 'Revenue was $123M',
    citations: [{ page: 'deal-overview.md', claimId: revenueClaim.claimId, quote: 'Revenue $123M' }],
  });
  assert.equal(okWithQuote.ok, true);

  // A page that exists but whose cited claim id belongs to another page is rejected.
  const unrelated = await validateWikiAnswer(store, {
    answer: 'Antitrust review is pending',
    citations: [{ page: 'deal-risks.md', claimId: revenueClaim.claimId }],
  });
  assert.equal(unrelated.ok, false);
  assert.match(unrelated.errors.join('; '), /no record of that fact on deal-risks\.md/);
  assert.equal(unrelated.noRecord, true);

  // The claim id of the other page still validates against its own page.
  const ownPage = await validateWikiAnswer(store, {
    answer: 'Antitrust review is pending',
    citations: [{ page: 'deal-risks.md', claimId: riskClaim.claimId }],
  });
  assert.equal(ownPage.ok, true);

  // A bogus claim id on an existing page is rejected too.
  const bogus = await validateWikiAnswer(store, {
    answer: 'x',
    citations: [{ page: 'deal-overview.md', claimId: 'c000000000000' }],
  });
  assert.equal(bogus.ok, false);
  assert.match(bogus.errors.join('; '), /no record of that fact/);
  assert.equal(bogus.noRecord, true);

  // A quote from a sibling claim on the same page does not verify this claim.
  const otherClaim = overview.claims.find((claim) => claim.claimId !== revenueClaim.claimId);
  const badQuote = await validateWikiAnswer(store, {
    answer: 'x',
    citations: [{ page: 'deal-overview.md', claimId: revenueClaim.claimId, quote: otherClaim.text }],
  });
  assert.equal(badQuote.ok, false);
  assert.match(badQuote.errors.join('; '), /quote does not match claim/);

  // The claim id must be a string when present.
  const badType = await validateWikiAnswer(store, {
    answer: 'x',
    citations: [{ page: 'deal-overview.md', claimId: 42 }],
  });
  assert.equal(badType.ok, false);
  assert.match(badType.errors.join('; '), /claimId must be a string/);

  // A page-level citation cannot support a fact: the claim id is required.
  const pageOnly = await validateWikiAnswer(store, {
    answer: 'Revenue was $123M',
    citations: [{ page: 'deal-overview.md', quote: 'Revenue $123M' }, 'deal-risks'],
  });
  assert.equal(pageOnly.ok, false);
  assert.equal(pageOnly.noRecord, false);
  assert.match(pageOnly.errors.join('; '), /needs a claimId for one fact line of deal-overview\.md/);
  assert.match(pageOnly.errors.join('; '), /needs a claimId for one fact line of deal-risks\.md/);

  const missing = await validateWikiAnswer(store, { answer: 'x', citations: [{ page: 'missing.md' }] });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(';'), /does not exist/);
});

test('wiki tools expose claims and validate claim citations', async (t) => {
  const { store } = await seed(t);
  const { defs, dispose } = fakeToolsCtx(store);
  assert.deepEqual(defs.map((def) => def.name).sort(), ['wiki_answer', 'wiki_links', 'wiki_read', 'wiki_search']);
  const exec = { agent: { id: 'a' } };

  const search = defs.find((def) => def.name === 'wiki_search');
  const searchResult = await search.execute({ query: 'revenue' }, exec);
  assert.equal(searchResult.ok, true);
  assert.equal(searchResult.hits.length, 1);
  assert.equal(searchResult.hits[0].claims.length, 2);
  const claimId = searchResult.hits[0].claims[0].claimId;

  const read = defs.find((def) => def.name === 'wiki_read');
  const readResult = await read.execute({ page: 'deal-overview.md' }, exec);
  assert.equal(readResult.ok, true);
  assert.equal(readResult.claims.length, 2);
  assert.equal(readResult.claims[0].claimId, claimId);
  assert.match(readResult.body, /Revenue/);

  const answer = defs.find((def) => def.name === 'wiki_answer');
  const accepted = await answer.execute({
    answer: 'Revenue was $123M',
    citations: [{ page: 'deal-overview.md', claimId }],
  }, exec);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.citations[0].claimId, claimId);

  const rejected = await answer.execute({
    answer: 'Antitrust review is pending',
    citations: [{ page: 'deal-risks.md', claimId }],
  }, exec);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.accepted, false);

  dispose();
});
