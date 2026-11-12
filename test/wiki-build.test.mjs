import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WikiBuilder, validateBuildManifest } from '../src/wiki-build.js';
import { WikiStore } from '../src/wiki-store.js';
import { readWikiPage, searchWiki, validateWikiAnswer } from '../src/wiki-query.js';
import { buildPaths } from '../src/paths.js';
import { resolveConfig } from '../src/config.js';
import { makeTempDir } from './helpers.mjs';

const PAGE_BODY = [
  '- Revenue is $123M. ^[a#p1, 2026-01-01]',
  '- Revenue is $125M in the latest filing. ^[b#p2, 2026-02-01]',
].join('\n');

function fakeCtx(handler) {
  return {
    get(name) {
      if (name === 'llm') {
        return {
          stream(options) {
            const purpose = String(options?.purpose ?? '');
            const stage = purpose.includes('extract') ? 'extract' : purpose.includes('analyze') ? 'analyze' : 'organize';
            const prompt = options?.messages?.[0]?.content?.[0]?.text ?? '';
            const reply = handler({ stage, prompt, options });
            if (reply instanceof Error) throw reply;
            const text = JSON.stringify(reply);
            return (async function* generate() {
              yield { type: 'text-delta', text };
              yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
              yield { type: 'finish', reason: { kind: 'stop' } };
            })();
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      return undefined;
    },
  };
}

/** Two source documents with different values and dates produce two claims. */
function twoSourceHandler({ failStage = '' } = {}) {
  return ({ stage, prompt }) => {
    if (failStage !== '' && stage === failStage) {
      return new Error(`fake ${stage} outage`);
    }
    if (stage === 'extract') {
      if (prompt.includes('$123M')) {
        return {
          claims: [{
            text: 'Revenue is $123M',
            quote: 'Revenue is $123M',
            page: 'deal-overview',
            kind: 'number',
            date: '2026-01-01',
          }],
        };
      }
      if (prompt.includes('$125M')) {
        return {
          claims: [{
            text: 'Revenue is $125M in the latest filing',
            quote: 'Revenue is $125M in the latest filing',
            page: 'deal-overview',
            kind: 'number',
            date: '2026-02-01',
          }],
        };
      }
      return { claims: [] };
    }
    if (stage === 'analyze') {
      return {
        writes: [{
          file: 'deal-overview.md',
          name: 'Deal overview',
          description: 'Deal facts and figures',
          domain: 'deal',
          body: PAGE_BODY,
        }],
      };
    }
    return {
      summary: 'organized',
      writes: [{
        file: 'deal-overview.md',
        name: 'Deal overview',
        description: 'Deal facts and figures',
        domain: 'deal',
        body: PAGE_BODY,
      }],
      deletes: [],
      links: [],
      conflicts: [],
    };
  };
}

async function makeEnv(t) {
  const tmp = await makeTempDir(t);
  const docs = path.join(tmp, 'docs');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(path.join(docs, 'a.txt'), 'Revenue is $123M.', 'utf8');
  await fs.writeFile(path.join(docs, 'b.txt'), 'Revenue is $125M in the latest filing.', 'utf8');
  const paths = buildPaths({ memoryRoot: path.join(tmp, 'data'), workspaceDir: path.join(tmp, 'workspace') });
  const config = resolveConfig({ memoryRoot: path.join(tmp, 'data'), wikiBuildConcurrency: 1 });
  return { tmp, docs, paths, config };
}

/** Read every wiki file except build manifests (byte-for-byte snapshot). */
async function snapshotWiki(wikiDir) {
  const snapshot = {};
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.builds' || entry.name === '.staging') continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(wikiDir, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      snapshot[relative] = await fs.readFile(absolute);
    }
  }
  await walk(wikiDir);
  return snapshot;
}

function assertWikiUnchanged(actual, expected) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const file of Object.keys(expected)) {
    assert.ok(actual[file].equals(expected[file]), `wiki file changed on a failed build: ${file}`);
  }
}

async function stagingAbsent(paths) {
  await assert.rejects(
    fs.access(path.join(paths.wikiDir, '.staging')),
    (error) => error?.code === 'ENOENT',
  );
}

async function assertWikiQueryable(store, claim) {
  const hits = await searchWiki(store, 'revenue');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].page, 'deal-overview.md');
  assert.equal(hits[0].claims.length, 2);
  const answer = await validateWikiAnswer(store, {
    answer: 'Revenue was $123M',
    citations: [{ page: 'deal-overview.md', claimId: claim.claimId }],
  });
  assert.equal(answer.ok, true);
}

test('WikiBuilder publishes a staged wiki whose pages carry fact-claim source traces', async (t) => {
  const env = await makeEnv(t);
  const builder = new WikiBuilder({ ctx: fakeCtx(twoSourceHandler()), config: env.config });
  const result = await builder.build({ pctx: { paths: env.paths }, docsDir: env.docs });

  assert.equal(result.ok, true, `ok=false: ${result.error} | ${JSON.stringify(result.manifest?.failures ?? result.failures ?? null)}`);
  assert.equal(result.dryRun, false);
  assert.equal(result.published, true);
  assert.ok(typeof result.manifestPath === 'string' && result.manifestPath.startsWith(env.paths.wikiDir));

  const manifest = result.manifest;
  assert.equal(manifest.applied, true);
  assert.equal(manifest.published, true);
  assert.equal(manifest.failedStage, '');
  assert.equal(manifest.documents.expected, 2);
  assert.equal(manifest.documents.processed, 2);
  assert.deepEqual(manifest.documents.failed, []);
  assert.deepEqual(manifest.stages.map((stage) => stage.name), ['normalize', 'extract', 'analyze', 'organize']);
  assert.ok(manifest.stages.every((stage) => stage.ok !== false && !stage.error));
  assert.equal(manifest.pages.total, 1);
  assert.equal(manifest.claims.total, 2);
  assert.equal(manifest.claims.pages, 1);
  assert.equal(manifest.schema, 2);
  assert.deepEqual(validateBuildManifest(manifest), { ok: true, reasons: [] });

  const storedManifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
  assert.equal(storedManifest.applied, true);
  assert.equal(storedManifest.published, true);
  assert.equal(storedManifest.claims.total, 2);

  const store = new WikiStore({ rootDir: env.paths.wikiDir });
  const pages = await store.listPages();
  assert.equal(pages.length, 1);
  assert.match(await store.readIndex(), /\[\[deal-overview\]\]/);
  assert.match(await store.readSkill(), /_index\.md/);
  assert.ok((await store.readSource('a')).text.includes('$123M'));
  assert.deepEqual(await store.listSources(), ['a', 'b']);
  await stagingAbsent(env.paths);

  const page = await readWikiPage(store, 'deal-overview.md');
  assert.equal(page.claims.length, 2);
  const first = page.claims.find((claim) => claim.source === 'a');
  const second = page.claims.find((claim) => claim.source === 'b');
  assert.equal(first.text, 'Revenue is $123M.');
  assert.equal(first.locator, 'p1');
  assert.equal(first.date, '2026-01-01');
  assert.equal(second.text, 'Revenue is $125M in the latest filing.');
  assert.equal(second.locator, 'p2');
  assert.equal(second.date, '2026-02-01');
  assert.notEqual(first.claimId, second.claimId);
  assert.match(first.text, /123M/);
  assert.match(second.text, /125M/);
  await assertWikiQueryable(store, first);

  // Rebuilding the same corpus keeps the derived claim ids stable.
  const secondBuild = await builder.build({ pctx: { paths: env.paths }, docsDir: env.docs });
  assert.equal(secondBuild.ok, true);
  const rebuilt = await readWikiPage(store, 'deal-overview.md');
  assert.deepEqual(rebuilt.claims.map((claim) => claim.claimId), page.claims.map((claim) => claim.claimId));
});

test('a dry-run extracts claims but publishes nothing', async (t) => {
  const env = await makeEnv(t);
  const builder = new WikiBuilder({ ctx: fakeCtx(twoSourceHandler()), config: env.config });
  const result = await builder.build({ pctx: { paths: env.paths }, docsDir: env.docs, dryRun: true });
  assert.equal(result.ok, true, `ok=false: ${result.error} | ${JSON.stringify(result.manifest?.failures ?? result.failures ?? null)}`);
  assert.equal(result.dryRun, true);
  assert.equal(result.published, false);
  assert.equal(result.manifest.published, false);
  assert.equal(result.manifest.applied, false);
  assert.equal(result.manifest.stages.some((stage) => stage.name === 'analyze'), false);
  await assert.rejects(
    fs.access(path.join(env.paths.wikiDir, '_index.md')),
    (error) => error?.code === 'ENOENT',
  );
});

test('an analyzer failure keeps the old wiki byte-identical and returns ok:false', async (t) => {
  const env = await makeEnv(t);
  const goodBuilder = new WikiBuilder({ ctx: fakeCtx(twoSourceHandler()), config: env.config });
  const first = await goodBuilder.build({ pctx: { paths: env.paths }, docsDir: env.docs });
  assert.equal(first.ok, true);
  const store = new WikiStore({ rootDir: env.paths.wikiDir });
  const claim = (await readWikiPage(store, 'deal-overview.md')).claims[0];
  const before = await snapshotWiki(env.paths.wikiDir);

  const failingBuilder = new WikiBuilder({
    ctx: fakeCtx(twoSourceHandler({ failStage: 'analyze' })),
    config: env.config,
  });
  const result = await failingBuilder.build({ pctx: { paths: env.paths }, docsDir: env.docs });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'analyze-failed');
  assert.equal(result.stage, 'analyze');
  assert.equal(result.published, false);
  assert.ok(Array.isArray(result.failures) && result.failures.length > 0);
  assert.match(result.failures[0].error, /fake analyze outage/);
  assert.equal(result.manifest.applied, false);
  assert.equal(result.manifest.published, false);
  assert.equal(result.manifest.failedStage, 'analyze');
  assert.equal(result.manifest.stages.find((stage) => stage.name === 'analyze').ok, false);
  assert.ok(result.manifest.errors.length > 0);

  // The previous wiki is untouched on disk (pages, index, skill, sources).
  assertWikiUnchanged(await snapshotWiki(env.paths.wikiDir), before);
  await stagingAbsent(env.paths);

  // The failed build recorded its failure but did not replace the last good manifest.
  const latest = await store.latestBuildManifest();
  assert.equal(latest.runId, result.manifest.runId);
  assert.equal(latest.applied, false);
  assert.equal(latest.published, false);

  // The old wiki is still queryable and its claim ids still validate.
  await assertWikiQueryable(store, claim);
});

test('an organizer failure keeps the old wiki byte-identical and returns ok:false', async (t) => {
  const env = await makeEnv(t);
  const goodBuilder = new WikiBuilder({ ctx: fakeCtx(twoSourceHandler()), config: env.config });
  assert.equal((await goodBuilder.build({ pctx: { paths: env.paths }, docsDir: env.docs })).ok, true);
  const store = new WikiStore({ rootDir: env.paths.wikiDir });
  const claim = (await readWikiPage(store, 'deal-overview.md')).claims[0];
  const before = await snapshotWiki(env.paths.wikiDir);

  const failingBuilder = new WikiBuilder({
    ctx: fakeCtx(twoSourceHandler({ failStage: 'organize' })),
    config: env.config,
  });
  const result = await failingBuilder.build({ pctx: { paths: env.paths }, docsDir: env.docs });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'organize-failed');
  assert.equal(result.stage, 'organize');
  assert.equal(result.published, false);
  assert.equal(result.manifest.applied, false);
  assert.equal(result.manifest.failedStage, 'organize');
  assert.equal(result.manifest.stages.find((stage) => stage.name === 'organize').ok, false);

  assertWikiUnchanged(await snapshotWiki(env.paths.wikiDir), before);
  await stagingAbsent(env.paths);
  await assertWikiQueryable(store, claim);
});

test('a published fact must match a claim the extractor verified against that source', async (t) => {
  const env = await makeEnv(t);
  const goodBuilder = new WikiBuilder({ ctx: fakeCtx(twoSourceHandler()), config: env.config });
  assert.equal((await goodBuilder.build({ pctx: { paths: env.paths }, docsDir: env.docs })).ok, true);
  const store = new WikiStore({ rootDir: env.paths.wikiDir });
  const claim = (await readWikiPage(store, 'deal-overview.md')).claims[0];
  const before = await snapshotWiki(env.paths.wikiDir);

  // The organizer swaps the value but keeps a real source and locator, and the
  // other line points at a source that was never read.
  const base = twoSourceHandler();
  const swappedBody = '- Revenue is $9M. ^[a#p1, 2026-01-01]\n- Revenue is $125M in the latest filing. ^[missing#p999, 2026-01-01]';
  const tampered = ({ stage, prompt, options }) => {
    const reply = base({ stage, prompt, options });
    if (stage === 'analyze' || stage === 'organize') {
      return { ...reply, writes: [{ ...reply.writes[0], body: swappedBody }] };
    }
    return reply;
  };
  const builder = new WikiBuilder({ ctx: fakeCtx(tampered), config: env.config });
  const result = await builder.build({ pctx: { paths: env.paths }, docsDir: env.docs });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'claim-not-verified');
  assert.equal(result.stage, 'publish');
  assert.equal(result.published, false);
  assert.equal(result.manifest.failedStage, 'publish');
  assert.match(result.failures[0].error, /fact not supported by its source/);
  assert.match(result.failures[0].error, /Revenue is \$9M/);
  assert.match(result.failures[0].error, /missing#p999/);

  // Nothing was published and the previous generation is still queryable.
  assertWikiUnchanged(await snapshotWiki(env.paths.wikiDir), before);
  await stagingAbsent(env.paths);
  await assertWikiQueryable(store, claim);
  const page = await readWikiPage(store, 'deal-overview.md');
  assert.equal(page.claims.length, 2);
  assert.equal(page.claims.some((candidate) => candidate.text.includes('$9M')), false);
});

test('an extractor failure skips the remaining stages and publishes nothing', async (t) => {
  const env = await makeEnv(t);
  const goodBuilder = new WikiBuilder({ ctx: fakeCtx(twoSourceHandler()), config: env.config });
  assert.equal((await goodBuilder.build({ pctx: { paths: env.paths }, docsDir: env.docs })).ok, true);
  const store = new WikiStore({ rootDir: env.paths.wikiDir });
  const claim = (await readWikiPage(store, 'deal-overview.md')).claims[0];
  const before = await snapshotWiki(env.paths.wikiDir);
  // A doc whose bytes changed must be extracted again, so the outage is hit.
  await fs.writeFile(path.join(env.docs, 'a.txt'), 'Revenue is $123M this year.', 'utf8');

  const failingBuilder = new WikiBuilder({
    ctx: fakeCtx(twoSourceHandler({ failStage: 'extract' })),
    config: env.config,
  });
  const result = await failingBuilder.build({ pctx: { paths: env.paths }, docsDir: env.docs });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'extract-failed');
  assert.equal(result.stage, 'extract');
  assert.equal(result.published, false);
  assert.equal(result.manifest.stages.some((stage) => stage.name === 'analyze'), false);
  assert.equal(result.manifest.stages.some((stage) => stage.name === 'organize'), false);
  assertWikiUnchanged(await snapshotWiki(env.paths.wikiDir), before);
  await stagingAbsent(env.paths);
  await assertWikiQueryable(store, claim);
});

/** One source document whose timeout value can be rebuilt with a new value. */
function timeoutHandler({ value = '15 seconds', extraPage = false } = {}) {
  const pages = [{
    file: 'deal-overview.md',
    name: 'Deal overview',
    description: 'Deal timeouts',
    domain: 'deal',
    body: `- Timeout is ${value}. ^[a#p1, 2026-01-01]`,
  }];
  if (extraPage) {
    pages.push({
      file: 'deal-notes.md',
      name: 'Deal notes',
      description: 'Deal notes',
      domain: 'deal',
      body: `- Timeout is ${value}. ^[a#p1, 2026-01-01]`,
    });
  }
  return ({ stage, prompt }) => {
    if (stage === 'extract') {
      return prompt.includes(value)
        ? { claims: [{ text: `Timeout is ${value}`, quote: `Timeout is ${value}`, page: 'deal-overview', kind: 'number', date: '2026-01-01' }] }
        : { claims: [] };
    }
    if (stage === 'analyze') return { writes: pages };
    return { summary: 'organized', writes: pages, deletes: [], links: [], conflicts: [] };
  };
}

test('a torn publish never exposes a mixture of two generations', async (t) => {
  const env = await makeEnv(t);
  await fs.writeFile(path.join(env.docs, 'a.txt'), 'Timeout is 15 seconds.', 'utf8');
  await fs.rm(path.join(env.docs, 'b.txt'));
  const builder = new WikiBuilder({ ctx: fakeCtx(timeoutHandler({ extraPage: true })), config: env.config });
  const first = await builder.build({ pctx: { paths: env.paths }, docsDir: env.docs });
  assert.equal(first.ok, true, first.error);
  const store = new WikiStore({ rootDir: env.paths.wikiDir });
  const claim = (await readWikiPage(store, 'deal-overview.md')).claims[0];
  const before = await snapshotWiki(env.paths.wikiDir);
  const generationPath = path.join(env.paths.wikiDir, 'GENERATION');
  const firstGeneration = (await fs.readFile(generationPath, 'utf8')).trim();
  assert.equal(firstGeneration, first.manifest.runId);
  assert.match(store.contentDir.replace(/\\/g, '/'), /\.generations\//u, 'readers resolve the generation the pointer names');
  assert.ok((await store.readSource('a')).text.includes('15 seconds'));

  // The corpus changes; the new generation is written but the pointer never moves.
  await fs.writeFile(path.join(env.docs, 'a.txt'), 'Timeout is 25 seconds.', 'utf8');
  const liveManifest = WikiStore.prototype.writeBuildManifest;
  const liveRoot = path.resolve(env.paths.wikiDir).toLowerCase();
  const duringPublish = [];
  WikiStore.prototype.writeBuildManifest = async function patchedWriteBuildManifest(runId, payload) {
    // Only the publish-time manifest marks `published: true`; the failure path
    // writes a second manifest after this one throws.
    if (path.resolve(this.rootDir).toLowerCase() === liveRoot && payload?.published === true) {
      // A reader that arrives mid-publish must see the previous generation whole:
      // one page text and one source text, both from the same generation.
      const reader = new WikiStore({ rootDir: env.paths.wikiDir });
      const page = await readWikiPage(reader, 'deal-overview.md').catch(() => null);
      const source = await reader.readSource('a').catch(() => null);
      duringPublish.push({ page: page?.claims?.[0]?.text ?? '', source: source?.text ?? '' });
      throw new Error('fake publish outage');
    }
    return liveManifest.call(this, runId, payload);
  };
  const rebuilt = new WikiBuilder({ ctx: fakeCtx(timeoutHandler({ value: '25 seconds', extraPage: true })), config: env.config });
  let result;
  try {
    result = await rebuilt.build({ pctx: { paths: env.paths }, docsDir: env.docs });
  } finally {
    WikiStore.prototype.writeBuildManifest = liveManifest;
  }

  assert.equal(duringPublish.length, 1);
  assert.match(duringPublish[0].page, /15 seconds/u);
  assert.match(duringPublish[0].source, /15 seconds/u);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'publish-failed');
  assert.equal(result.stage, 'publish');
  assert.equal(result.published, false);
  assert.match(result.failures[0].error, /fake publish outage/u);

  // The unpublished generation is gone and the pointer still names the old one.
  assertWikiUnchanged(await snapshotWiki(env.paths.wikiDir), before);
  assert.ok((await store.readSource('a')).text.includes('15 seconds'));
  assert.equal((await fs.readFile(generationPath, 'utf8')).trim(), firstGeneration);
  assert.deepEqual(await fs.readdir(path.join(env.paths.wikiDir, '.generations')), [firstGeneration]);

  // The previous generation is still fully queryable.
  const page = await readWikiPage(store, 'deal-overview.md');
  assert.equal(page.claims[0].claimId, claim.claimId);
  const answer = await validateWikiAnswer(store, {
    answer: 'The timeout is 15 seconds',
    citations: [{ page: 'deal-overview.md', claimId: claim.claimId }],
  });
  assert.equal(answer.ok, true);
});

test('a citation must pin to the passage and the fact the extractor verified', async (t) => {
  const env = await makeEnv(t);
  const published = await new WikiBuilder({ ctx: fakeCtx(twoSourceHandler()), config: env.config }).build({ pctx: { paths: env.paths }, docsDir: env.docs });
  assert.equal(published.ok, true, published.error);
  const before = await snapshotWiki(env.paths.wikiDir);

  // 1. An invented locator for a real source, and a source that was never read.
  const invented = ({ stage, prompt }) => {
    const reply = twoSourceHandler()({ stage, prompt });
    if (reply instanceof Error || stage !== 'organize') return reply;
    return {
      ...reply,
      writes: reply.writes.map((write) => ({
        ...write,
        body: `${PAGE_BODY}\n- Authentication is disabled. ^[a#p999, 1900-01-01]\n- Billing is monthly. ^[missing#p1, 2026-01-01]`,
      })),
    };
  };
  const first = await new WikiBuilder({ ctx: fakeCtx(invented), config: env.config }).build({ pctx: { paths: env.paths }, docsDir: env.docs });
  assert.equal(first.ok, false);
  assert.equal(first.error, 'claim-not-verified');
  assert.equal(first.manifest.failedStage, 'publish');
  assert.match(first.failures[0].error, /a#p999, 1900-01-01 was never verified/);
  assert.match(first.failures[0].error, /missing#p1, 2026-01-01 was never verified/);
  assertWikiUnchanged(await snapshotWiki(env.paths.wikiDir), before);

  // 2. A real passage cited for a fact that passage does not carry.
  const misplaced = ({ stage, prompt }) => {
    const reply = twoSourceHandler()({ stage, prompt });
    if (reply instanceof Error || stage !== 'organize') return reply;
    return {
      ...reply,
      writes: reply.writes.map((write) => ({
        ...write,
        body: `${PAGE_BODY}\n- Authentication is disabled. ^[a#p1, 2026-01-01]`,
      })),
    };
  };
  const second = await new WikiBuilder({ ctx: fakeCtx(misplaced), config: env.config }).build({ pctx: { paths: env.paths }, docsDir: env.docs });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'claim-not-verified');
  assert.match(second.failures[0].error, /a#p1 does not support "Authentication is disabled/);
  assertWikiUnchanged(await snapshotWiki(env.paths.wikiDir), before);
  await stagingAbsent(env.paths);
});

test('a verified citation cannot publish a value the source does not state', async (t) => {
  const env = await makeEnv(t);
  await fs.writeFile(path.join(env.docs, 'c.txt'), 'The timeout is 15 seconds.', 'utf8');
  const body = '- Timeout is 90 seconds. ^[c#p1, 2026-03-01]';
  const handler = ({ stage, prompt }) => {
    if (stage === 'extract') {
      if (!prompt.includes('The timeout is 15 seconds.')) return { claims: [] };
      return {
        claims: [{ text: 'Timeout is 15 seconds', quote: 'Timeout is 15 seconds.', page: 'ops', kind: 'number', date: '2026-03-01' }],
      };
    }
    return {
      summary: 'organized',
      writes: [{ file: 'ops.md', name: 'Timeout is 15 seconds', description: 'Timeout is 15 seconds', domain: 'ops', body }],
      deletes: [],
      links: [],
      conflicts: [],
    };
  };
  const result = await new WikiBuilder({ ctx: fakeCtx(handler), config: env.config }).build({ pctx: { paths: env.paths }, docsDir: env.docs });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'claim-not-verified');
  assert.match(result.failures[0].error, /c#p1 does not support "Timeout is 90 seconds/);
});

test('pruning keeps a generation a live reader is still on', async (t) => {
  const env = await makeEnv(t);
  const first = await new WikiBuilder({ ctx: fakeCtx(twoSourceHandler()), config: env.config }).build({ pctx: { paths: env.paths }, docsDir: env.docs });
  assert.equal(first.ok, true, `ok=false: ${first.error}`);
  const pinned = new WikiStore({ rootDir: env.paths.wikiDir });
  t.after(() => pinned.close());
  const pinnedGeneration = pinned.generation;
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const next = await new WikiBuilder({ ctx: fakeCtx(twoSourceHandler()), config: env.config }).build({ pctx: { paths: env.paths }, docsDir: env.docs });
    assert.equal(next.ok, true, `ok=false: ${next.error}`);
  }
  const page = await pinned.readPage('deal-overview.md');
  assert.match(page.body, /Revenue is \$123M/u, 'the pinned reader keeps its generation');
  const source = await pinned.readSource('a');
  assert.match(source.text, /Revenue is \$123M/u);
  const fresh = new WikiStore({ rootDir: env.paths.wikiDir });
  t.after(() => fresh.close());
  assert.notEqual(fresh.generation, pinnedGeneration);
  assert.ok(fresh.generation !== '', 'the pointer moved to a newer generation');
});

test('a decimal value survives wiki sentence splitting', async (t) => {
  const tmp = await makeTempDir(t);
  const docs = path.join(tmp, 'docs');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(path.join(docs, 'a.txt'), 'The release timeout is 1.5 seconds.', 'utf8');
  const paths = buildPaths({ memoryRoot: path.join(tmp, 'data'), workspaceDir: path.join(tmp, 'workspace') });
  const config = resolveConfig({ memoryRoot: path.join(tmp, 'data'), wikiBuildConcurrency: 1 });
  const handler = (value) => ({ stage }) => {
    if (stage === 'extract') {
      return {
        claims: [{
          text: 'The release timeout is 1.5 seconds',
          quote: 'The release timeout is 1.5 seconds.',
          page: 'release',
          kind: 'number',
          date: '2026-03-01',
        }],
      };
    }
    const body = `- The release timeout is ${value}. ^[a#p1, 2026-03-01]`;
    const write = { file: 'release-notes.md', name: 'Release notes', description: 'Release timings', body };
    return stage === 'analyze'
      ? { writes: [write] }
      : { summary: 'organized', writes: [write], deletes: [], links: [], conflicts: [] };
  };

  const published = await new WikiBuilder({ ctx: fakeCtx(handler('1.5 seconds')), config })
    .build({ pctx: { paths }, docsDir: docs });
  assert.equal(published.ok, true, `ok=false: ${published.error}`);
  const store = new WikiStore({ rootDir: paths.wikiDir });
  t.after(() => store.close());
  assert.match((await store.readPage('release-notes.md')).body, /1\.5 seconds/u);

  const rejected = await new WikiBuilder({ ctx: fakeCtx(handler('15 seconds')), config })
    .build({ pctx: { paths }, docsDir: docs });
  assert.equal(rejected.ok, false, 'the source says 1.5, so 15 is not a fact it carries');
  assert.equal(rejected.error, 'claim-not-verified');
  assert.match(rejected.failures[0].error, /a#p1 does not support "The release timeout is 15 seconds/u);
});

test('an unchanged source reuses its claims instead of calling the extractor again', async (t) => {
  const env = await makeEnv(t);
  const first = await new WikiBuilder({ ctx: fakeCtx(twoSourceHandler()), config: env.config })
    .build({ pctx: { paths: env.paths }, docsDir: env.docs });
  assert.equal(first.ok, true, `ok=false: ${first.error}`);
  assert.equal(first.manifest.documents.reused, 0);

  let extractCalls = 0;
  const counting = ({ stage, prompt }) => {
    if (stage === 'extract') extractCalls += 1;
    return twoSourceHandler()({ stage, prompt });
  };
  const second = await new WikiBuilder({ ctx: fakeCtx(counting), config: env.config })
    .build({ pctx: { paths: env.paths }, docsDir: env.docs });

  assert.equal(second.ok, true, `ok=false: ${second.error}`);
  assert.equal(second.manifest.documents.reused, 2);
  assert.equal(extractCalls, 0, 'the extractor must not see an unchanged document');
  const store = new WikiStore({ rootDir: env.paths.wikiDir });
  t.after(() => store.close());
  assert.equal((await readWikiPage(store, 'deal-overview.md')).claims.length >= 2, true);
});
