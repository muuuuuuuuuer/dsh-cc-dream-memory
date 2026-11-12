import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WikiBuilder } from '../src/wiki-build.js';
import { buildPaths } from '../src/paths.js';
import { resolveConfig } from '../src/config.js';
import { makeTempDir } from './helpers.mjs';

// Three paragraphs that each become one extractor part. The middle part fails
// once, so the retry has to reuse the part that already finished.
const MARKERS = ['marker one', 'marker two', 'marker three'];
const FILLER = 'the rest of this paragraph only pads the part to the chunk limit. ';
const PARTS = MARKERS.map((marker) => `${marker}: ${FILLER.repeat(16).trim()}`);

function fakeCtx(handler) {
  return {
    get(name) {
      if (name === 'llm') {
        return {
          stream(options) {
            const purpose = String(options?.purpose ?? '');
            const stage = purpose.includes('extract') ? 'extract' : purpose.includes('analyze') ? 'analyze' : 'organize';
            const prompt = options?.messages?.[0]?.content?.[0]?.text ?? '';
            const reply = handler({ stage, prompt });
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

/** Which part of the document this extractor call is about (0-based). */
function partOf(prompt) {
  const match = /Part (\d+) of (\d+)/u.exec(prompt);
  return match ? Number(match[1]) - 1 : -1;
}

async function makeEnv(t) {
  const tmp = await makeTempDir(t);
  const docs = path.join(tmp, 'docs');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(path.join(docs, 'notes.txt'), PARTS.map((part) => `# ${part}`).join('\n\n'), 'utf8');
  const paths = buildPaths({ memoryRoot: path.join(tmp, 'data'), workspaceDir: path.join(tmp, 'workspace') });
  const config = resolveConfig({ memoryRoot: path.join(tmp, 'data'), wikiBuildConcurrency: 1, wikiChunkChars: 2_000 });
  return { tmp, docs, paths, config };
}

test('an interrupted document only re-extracts the parts that did not finish', async (t) => {
  const e = await makeEnv(t);
  const calls = [];
  let failPartTwo = true;
  const ctx = fakeCtx(({ stage, prompt }) => {
    if (stage === 'extract') {
      const part = partOf(prompt);
      calls.push(part);
      if (part === 1 && failPartTwo) {
        failPartTwo = false;
        throw new Error('extractor outage on part two');
      }
      return {
        claims: part < 0 ? [] : [{ text: MARKERS[part], quote: MARKERS[part], page: 'notes', kind: 'fact', date: '2026-01-01' }],
      };
    }
    if (stage === 'analyze') return { writes: [] };
    return { summary: '', writes: [], deletes: [], links: [], conflicts: [] };
  });
  const builder = new WikiBuilder({ ctx, paths: e.paths, config: e.config });
  const pctx = { workspaceDir: path.join(e.tmp, 'workspace'), paths: e.paths };

  const first = await builder.build({ pctx, docsDir: e.docs });
  assert.equal(first.ok, false, 'the outage must fail the build');
  assert.equal(first.stage, 'extract');
  assert.deepEqual(calls, [0, 1], 'the build stops at the part that failed');

  calls.length = 0;
  const second = await builder.build({ pctx, docsDir: e.docs });
  const extract = (second.manifest?.stages ?? []).find((stage) => stage.name === 'extract');
  assert.ok(extract, 'the retry records its extract stage');
  assert.equal(extract.partsReused, 1, 'the finished part is reused');
  assert.deepEqual(calls, [1, 2], 'only the failed part and the rest are extracted again');
});
