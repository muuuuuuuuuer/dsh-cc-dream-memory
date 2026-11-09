#!/usr/bin/env node
/**
 * Freeze the evaluation assets: scenario pack, corrected rubric versions, plugin
 * version, harness contract and target model. Run after any intentional change.
 *
 *   node eval/freeze.mjs
 *
 * The runner refuses to start when this manifest does not match the current
 * scenario file, rubrics, plugin version or harness contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_CONTRACT, hashFile } from './harness-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const rubricNames = fs.readdirSync(path.join(ROOT, 'eval', 'rubrics')).filter((name) => name.endsWith('.json')).sort();
const rubrics = {};
for (const name of rubricNames) rubrics[name] = hashFile(path.join(ROOT, 'eval', 'rubrics', name));
const scenarioNames = fs.readdirSync(path.join(ROOT, 'eval')).filter((name) => /^scenarios\..*\.json$/.test(name)).sort();
const scenarioHashes = {};
for (const name of scenarioNames) scenarioHashes[name] = hashFile(path.join(ROOT, 'eval', name));

const manifest = {
  frozenAt: new Date().toISOString(),
  harnessContract: HARNESS_CONTRACT,
  pluginVersion: plugin.version,
  target: {
    profile: 'cc-memory-eval',
    model: 'profile default (deepseek-flash)',
    runner: 'eval/run.mjs',
  },
  scenarioFile: 'eval/scenarios.dev.json',
  scenarioHash: hashFile(path.join(ROOT, 'eval', 'scenarios.dev.json')),
  scenarioFiles: scenarioHashes,
  rubrics,
  isolation: {
    mechanism: 'memory scenarios use the tool-plugin lock (all tool-* except executors/pruner disabled) and isolated memoryRoot per condition; open-tool coding scenarios intentionally expose the full tool surface, so they run in a separate temporary git workspace outside this repository to keep the rubric and plugin checkout out of reach',
    probe: 'memory scenarios: one-shot headless probe listed only memory_read/save/search/update; coding scenarios: objective `node --test` exit-code and test-file hash checks',
  },
  checkpoints: {
    beforeDream: 'checkpoint-before-dream (B tests)',
    afterDream: 'checkpoint-after-dream (C tests)',
    restore: 'sha256 verified per condition; mismatch makes the run invalid',
  },
  dream: {
    mode: 'pure consolidation (noSessions=true) for memory scenarios; dreamSessions:true scenarios run one transcript-reading consolidation and record sessionsReviewed',
    sessionsReviewed: '0 for pure scenarios; >0 asserted for transcript-reading scenarios',
  },
  metrics: {
    raw: 'deterministic checks + judge gate',
    deterministic: 'deterministic checks only',
    semantic: 'judge taskCompleted && !boundaryFailure && !fabricatedHistory',
  },
};
fs.writeFileSync(path.join(ROOT, 'eval', 'frozen-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('frozen manifest written:', path.join('eval', 'frozen-manifest.json'));
console.log('contract:', HARNESS_CONTRACT, '| plugin:', plugin.version, '| scenario:', manifest.scenarioHash);
