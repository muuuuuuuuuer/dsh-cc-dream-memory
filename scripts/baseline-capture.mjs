#!/usr/bin/env node
/**
 * Capture the pre-simplification memory workflow as a repeatable, isolated
 * fixture: copy one project store (memory notes, dream run manifests, state,
 * history, trash) into a scratch memory root and record what the current code
 * injects and reports for it.
 *
 * The copy is the fixture; the source store is never written. Run it before
 * touching the workflow and again afterwards to compare behaviour:
 *
 *   node scripts/baseline-capture.mjs --source "<project store dir>" \
 *     [--out .baseline] [--label before]
 *
 * `--source` is a `~/.dsh/cc-memory/projects/<slug>` directory. Output lands in
 * `<out>/<label>/`: `memory-root/projects/baseline/` (the copy),
 * `baseline.json` (machine-readable record) and `REPORT.md` (human summary).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildPaths } from '../src/paths.js';
import { resolveConfig } from '../src/config.js';
import { MemoryStore } from '../src/store.js';
import { buildInjectionText } from '../src/inject.js';
import { isCurrentPage } from '../src/memory-body.js';

function fail(message) {
  console.error(`[baseline-capture] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { label: 'before' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value`);
    out[arg.slice(2)] = value;
    index += 1;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Summarize classic plan.json and v2 manifest.json Dream runs without inventing fields. */
function summarizeDreamRuns(projectDir) {
  const dreamsDir = path.join(projectDir, '.dreams');
  let names = [];
  try {
    names = fs.readdirSync(dreamsDir).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const dir = path.join(dreamsDir, name);
    const plan = readJson(path.join(dir, 'plan.json')) || {};
    const manifest = readJson(path.join(dir, 'manifest.json')) || {};
    const analysisDir = path.join(dir, 'analysis');
    let analysisFiles = 0;
    try {
      analysisFiles = fs.readdirSync(analysisDir).length;
    } catch {
      /* classic run */
    }
    let pageFiles = 0;
    try {
      pageFiles = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((item) => item.isFile() && item.name.endsWith('.md') && item.name !== 'MEMORY.md').length;
    } catch {
      /* no pages kept */
    }
    const error =
      (typeof manifest.error === 'string' && manifest.error) ||
      (typeof plan.error === 'string' && plan.error) ||
      '';
    return {
      dir: name,
      kind: typeof manifest.kind === 'string' ? manifest.kind : 'classic',
      mode: typeof manifest.mode === 'string' ? manifest.mode : typeof plan.mode === 'string' ? plan.mode : '',
      applied: manifest.applied === true || plan.ok === true,
      error,
      findings: Array.isArray(plan.findings) ? plan.findings.length : 0,
      patches: Array.isArray(plan.patches) ? plan.patches.length : 0,
      pageFiles,
      analysisFiles,
      usage: manifest.usage ?? null,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source || process.env.CC_MEMORY_BASELINE_SOURCE || '';
  if (source === '') {
    fail('pass --source "<~/.dsh/cc-memory/projects/<slug>>" or set CC_MEMORY_BASELINE_SOURCE');
  }
  if (!fs.existsSync(path.join(source, 'memory'))) fail(`no memory/ directory under ${source}`);

  const outRoot = path.resolve(args.out || '.baseline');
  const outDir = path.join(outRoot, args.label || 'before');
  const memoryRoot = path.join(outDir, 'memory-root');
  const projectDir = path.join(memoryRoot, 'projects', 'baseline');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(projectDir), { recursive: true });
  fs.cpSync(source, projectDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'workspace'), { recursive: true });

  const config = resolveConfig({ memoryRoot });
  const paths = buildPaths({
    memoryRoot,
    workspaceDir: path.join(outDir, 'workspace'),
    projectId: 'baseline',
  });
  const store = new MemoryStore({ paths, getConfig: () => config });
  await store.ensure();

  const entries = await store.listEntries('project');
  const notes = [];
  for (const entry of entries) {
    let body = '';
    try {
      body = (await store.readEntry(entry.file, 'project'))?.body ?? '';
    } catch {
      /* unreadable note stays name-only in the record */
    }
    notes.push({
      file: entry.file,
      name: entry.name ?? '',
      description: entry.description ?? '',
      statusCurrent: isCurrentPage(body),
    });
  }

  const index = await store.injectedIndex('project');
  const rulesPath = path.join(projectDir, 'RULES.md');
  const injectionText = buildInjectionText({
    index,
    rulesSource: fs.existsSync(rulesPath) ? 'project' : 'default',
    rules: fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8') : '',
  });

  const state = readJson(path.join(projectDir, '.state.json')) || {};
  const runs = summarizeDreamRuns(projectDir);
  const pendingProposal = typeof state.pendingProposal === 'string' ? state.pendingProposal : '';
  const failedRuns = runs.filter((run) => run.error !== '');
  const truncatedRuns = runs.filter((run) => /max-tokens|max tokens|truncat/i.test(run.error));

  const record = {
    capturedAt: new Date().toISOString(),
    source,
    noteCount: notes.length,
    statusCurrentCount: notes.filter((note) => note.statusCurrent).length,
    index: { text: index.text, lines: index.lines, bytes: index.bytes },
    injectionText,
    lastError: typeof state.lastError === 'string' ? state.lastError : '',
    lastDreamMode: typeof state.lastDreamMode === 'string' ? state.lastDreamMode : '',
    counters: state.counters ?? {},
    pendingProposal,
    dreamRuns: { total: runs.length, failed: failedRuns.length, truncated: truncatedRuns.length, runs },
    notes,
  };

  fs.writeFileSync(path.join(outDir, 'baseline.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDir, 'REPORT.md'), renderReport(record), 'utf8');
  console.log(`[baseline-capture] wrote ${path.join(outDir, 'REPORT.md')}`);
}

function renderReport(record) {
  const lines = [];
  lines.push(`# Memory workflow baseline (${record.capturedAt})`);
  lines.push('');
  lines.push(`Source store: \`${record.source}\` (copied, never modified).`);
  lines.push('');
  lines.push('## Measured state');
  lines.push('');
  lines.push(`- topic notes: **${record.noteCount}** (\`STATUS: current\`: ${record.statusCurrentCount})`);
  lines.push(`- index lines injected on turn one: **${record.index.lines}**`);
  lines.push(`- last Dream error: ${record.lastError === '' ? '(none)' : `\`${record.lastError}\``}`);
  lines.push(`- pending proposal: ${record.pendingProposal === '' ? '(none)' : `\`${record.pendingProposal}\``}`);
  lines.push(`- Dream runs: ${record.dreamRuns.total}, failed: ${record.dreamRuns.failed}, truncated: ${record.dreamRuns.truncated}`);
  lines.push('');
  lines.push('## Symptom 1: old notes are invisible on turn one');
  lines.push('');
  lines.push('The first-turn injection for this store:');
  lines.push('');
  lines.push('```text');
  lines.push(record.injectionText);
  lines.push('```');
  lines.push('');
  lines.push('## Symptom 2: failed previews count as pending work');
  lines.push('');
  lines.push(
    record.dreamRuns.failed === 0
      ? 'No failed run manifest in this store.'
      : `${record.dreamRuns.failed} run(s) failed but kept findings/pages; \`pendingProposal\` above still decides what the panel shows.`,
  );
  lines.push('');
  lines.push('## Symptom 3: organizer output truncation');
  lines.push('');
  lines.push(
    record.dreamRuns.truncated === 0
      ? 'No truncation error recorded in run manifests.'
      : `${record.dreamRuns.truncated} run(s) recorded a max-tokens/truncation error (see \`dreamRuns.runs[].error\`).`,
  );
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  for (const note of record.notes) {
    lines.push(`- \`${note.file}\` — ${note.name}${note.statusCurrent ? ' (current)' : ''}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

await main();
