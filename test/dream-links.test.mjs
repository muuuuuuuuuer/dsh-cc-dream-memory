/**
 * Cross-links in Dream v2: the organizer is told to put relations in `links`,
 * and model-written link lines ("相关：[[a]]（说明）") are lifted out of page
 * bodies and re-rendered by the host as one structural `Related:` line, which
 * the write gate and the verification stamp both treat as structure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildPaths } from '../src/paths.js';
import { resolveConfig } from '../src/config.js';
import { MemoryStore } from '../src/store.js';
import { ProjectState } from '../src/state.js';
import { DreamEngine } from '../src/dream.js';
import { DreamPipeline } from '../src/dream-pipeline.js';
import {
  ORGANIZER_SYSTEM_PROMPT,
  extractLinkLines,
  linkLineTargets,
  normalizeOrganizerReply,
  renderRelatedLinks,
} from '../src/dream-organizer.js';
import { checkWriteOperations } from '../src/dream-write-evidence.js';
import { currentFactLines } from '../src/memory-body.js';
import { makeTempDir } from './helpers.mjs';

test('link-only lines are recognized whatever their label; lines that say more are not', () => {
  assert.deepEqual(linkLineTargets('相关：[[plugin]]（被评估插件）、[[decisions]]（设计决策）。'), ['plugin', 'decisions']);
  assert.deepEqual(linkLineTargets('- See also: [[a]], [[b|B page]] and [[c]]'), ['a', 'b', 'c']);
  assert.deepEqual(linkLineTargets('- [[a]] (eval harness)'), ['a']);
  assert.deepEqual(linkLineTargets('**Related**: [[a]]'), ['a']);
  assert.equal(linkLineTargets('- 与 deepseek-stack 重叠度高（对照见 [[ref]]）：`a`≈`b`'), null, 'a fact that mentions a link stays');
  assert.equal(linkLineTargets('相关：[[a]] 这个页面讲评估'), null, 'free text after the links stays for the gate to judge');
  assert.equal(linkLineTargets('- 回复风格：用户要求回答简短。'), null);
});

test('extracting link lines drops an emptied related section and leaves code alone', () => {
  const extracted = extractLinkLines([
    'Fact one. ^[s#1, 2026-11-10]',
    '',
    '## 相关',
    '- [[a]]（说明）',
    '- [[b]]',
    '',
    '## Notes',
    'keep',
    '',
    '```',
    '相关：[[x]]',
    '```',
    '相关：[[c]]',
  ].join('\n'));
  assert.deepEqual(extracted.targets, ['a', 'b', 'c']);
  assert.equal(extracted.body, 'Fact one. ^[s#1, 2026-11-10]\n\n## Notes\nkeep\n\n```\n相关：[[x]]\n```');
});

test('organizer replies: body link lines become links, deduplicated with the declared ones', () => {
  const reply = normalizeOrganizerReply({
    writes: [{ file: 'project_eval.md', type: 'project', body: '- Eval runs nightly.\n相关：[[project_plugin]]（插件）、[[project_eval]]' }],
    links: [{ from: 'project_eval.md', to: 'project_plugin.md' }],
  });
  assert.equal(reply.writes[0].body, '- Eval runs nightly.');
  assert.deepEqual(reply.links, [{ from: 'project_eval.md', to: 'project_plugin.md' }], 'self-links and duplicates are dropped');
});

test('the host renders one Related line, only to pages that exist, and it is structure to both checks', () => {
  const pages = new Map([
    ['a.md', { file: 'a.md', type: 'project', body: '- Fact A.' }],
    ['b.md', { file: 'b.md', type: 'project', body: '- Fact B. See [[a]].' }],
    ['c.md', { file: 'c.md', type: 'project', body: '- Fact C.' }],
  ]);
  renderRelatedLinks(pages, [
    { from: 'a.md', to: 'b.md' },
    { from: 'a.md', to: 'c.md' },
    { from: 'a.md', to: 'gone.md' },
    { from: 'b.md', to: 'a.md' },
  ]);
  assert.equal(pages.get('a.md').body, '- Fact A.\n\nRelated: [[b]] [[c]]\n');
  assert.equal(pages.get('b.md').body, '- Fact B. See [[a]].', 'an existing link is not repeated');
  const checked = checkWriteOperations({
    operations: [{ op: 'write', file: 'a.md', type: 'project', body: pages.get('a.md').body }],
    currentPages: [{ file: 'a.md', type: 'project', body: '- Fact A.' }],
    evidence: [],
  });
  assert.deepEqual(checked.dropped, []);
  assert.deepEqual(currentFactLines(pages.get('a.md').body), ['- Fact A.'], 'a Related line never blocks the verification stamp');
});

test('the organizer prompt keeps links out of bodies and states what the host accepts', () => {
  assert.match(ORGANIZER_SYSTEM_PROMPT, /Relations between pages go only in "links"/);
  assert.match(ORGANIZER_SYSTEM_PROMPT, /Never merge pages of different types/);
  assert.match(ORGANIZER_SYSTEM_PROMPT, /byte-for-byte/);
  assert.doesNotMatch(ORGANIZER_SYSTEM_PROMPT, /cross-link with \[\[slug\]\]/);
});

test('Dream v2: an organizer that writes a 相关 line still produces an applicable plan', async (t) => {
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'data');
  const workspaceDir = path.join(tmp, 'workspace');
  const paths = buildPaths({ memoryRoot, workspaceDir });
  // Explicit organizer output: this exercises the maintenance mode.
  const config = resolveConfig({ memoryRoot, dreamPipeline: 'v2', dreamMode: 'apply', dreamMaxOps: 10, dreamOrganizerMode: 'maintenance' });
  const store = new MemoryStore({ paths, config });
  await store.ensure();
  const state = new ProjectState(paths);
  await state.load();
  const pctx = { workspaceDir, paths, store, state };
  const a = await store.saveEntry({ name: 'Eval', type: 'project', content: '- Eval runs nightly.' });
  const b = await store.saveEntry({ name: 'Plugin', type: 'project', content: '- Plugin ships weekly.' });
  const reply = {
    summary: 'link eval to plugin',
    writes: [{
      file: a.file, name: 'Eval', type: 'project', description: '',
      body: `- Eval runs nightly.\n相关：[[${b.file.replace(/\.md$/, '')}]]（被评估插件）、[[project_gone]]（旧页面）。`,
    }],
    deletes: [], links: [], conflicts: [],
  };
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          stream: () => (async function* generate() {
            yield { type: 'text-delta', text: JSON.stringify(reply) };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })(),
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      return undefined;
    },
  };
  const engine = new DreamEngine({ ctx, config });
  const pipeline = new DreamPipeline({ ctx, config, engine });
  const result = await pipeline.run({ pctx, force: true, dryRun: true, noSessions: true, trigger: 'manual' });
  assert.equal(result.error, undefined, String(result.error));
  const plan = JSON.parse(await fs.readFile(result.planPath, 'utf8'));
  const write = plan.operations.find((op) => op.op === 'write' && op.file === a.file);
  assert.ok(write, 'the eval page is written');
  assert.match(write.body, new RegExp(`Related: \\[\\[${b.file.replace(/\.md$/, '')}\\]\\]`));
  assert.doesNotMatch(write.body, /相关|project_gone|被评估插件/);
  const preview = await engine.previewPlan({ pctx, plan, path: result.planPath });
  assert.equal(preview.ops.find((op) => op.file === a.file).rejected, undefined, 'review offers the change');
});
