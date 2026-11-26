#!/usr/bin/env node
/**
 * No-model classifier for a finished (or partly finished) eval run: what did the notes say before and
 * after Dream, regardless of how the answer was graded? It tells "Dream fixed it" from "B never had it".
 *
 *   node eval/traps-v2/classify.mjs [runDir] [--data eval/traps-v2/traps.json] [--verbose]
 *   (runDir defaults to $LME_RUN)
 *
 * For every item it reads <runDir>/<id>/checkpoint-before-dream (B) and checkpoint-after-dream (C),
 * takes the CURRENT text of every note (pages whose STATUS is stale/superseded/... and everything from a
 * "## History" heading or a "- Superseded:" line on are excluded, using the plugin's own memory-body.js),
 * and classifies:
 *   missing   no answer_key anywhere in the current text (and no stale key asserted)
 *   stale     a stale_key is asserted: it occurs on a line with no retraction wording (作废, 取消, 原来, 仍 ...)
 *   partial   some answer_keys present, not all
 *   complete  every answer_key present, no stale key asserted
 *   invented  abstention items only: an absent_key (the made-up reason or owner) appears in a note
 *   clean     abstention items only: none does
 * Keys may list alternatives separated by "|"; `key_variants` adds more spellings. Matching ignores
 * whitespace, ":", "=", quotes and case. It is a string heuristic: read the notes of any surprising row.
 * It joins grades.json (A / B / C labels) when present.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentBody, isCurrentPage } from '../../src/memory-body.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--data');
const RUN = path.resolve(positional[0] || process.env.LME_RUN || '');
const DATA = path.resolve(opt('--data') || process.env.LME_DATA || path.join(here, 'traps.json'));
if (!positional[0] && !process.env.LME_RUN) { console.error('usage: classify.mjs <runDir> [--data file] [--verbose]'); process.exit(2); }
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

const norm = (s) => String(s).replace(/[\s:=：`'"“”*]/gu, '').toLowerCase();
const RETRACTION = /作废|取消|不再|不搞|不用了|放弃|废弃|撤回|已废|被取代|被替换|已改回|恢复|维持|保持|仍[然是用]|原为|原来|曾经|[（(]原|旧值|superseded|obsolete|no longer|instead of|previously|\(was/iu;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };

function notesOf(dir) {
  if (!fs.existsSync(dir)) return undefined;
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
        const raw = fs.readFileSync(full, 'utf8');
        if (isCurrentPage(raw)) out.push({ file: path.relative(dir, full), text: currentBody(raw) });
      }
    }
  };
  walk(dir);
  return out;
}

const variantsOf = (q, key) => [...key.split('|'), ...(q.key_variants?.[key] ?? [])].map(norm).filter(Boolean);
const found = (q, key, text) => variantsOf(q, key).some((v) => norm(text).includes(v));

function classify(q, notes) {
  if (!notes) return { state: 'n/a', hits: [], stale: [] };
  const text = notes.map((n) => n.text).join('\n');
  if (q.question_id.endsWith('_abs')) {
    const invented = (q.absent_keys ?? []).filter((k) => norm(text).includes(norm(k)));
    return { state: invented.length ? 'invented' : 'clean', hits: invented, stale: [] };
  }
  const hits = (q.answer_keys ?? []).filter((k) => found(q, k, text));
  const stale = [];
  for (const key of q.stale_keys ?? []) {
    for (const note of notes) {
      for (const line of note.text.split(/\r?\n/u)) {
        if (found(q, key, line) && !RETRACTION.test(line)) stale.push(`${note.file}: ${line.trim().slice(0, 80)}`);
      }
    }
  }
  const state = hits.length === 0 && stale.length === 0 ? 'missing' : stale.length ? 'stale' : hits.length < q.answer_keys.length ? 'partial' : 'complete';
  return { state, hits, stale };
}

const mark = (g) => (g === undefined ? '-' : g.label === true ? 'Y' : 'N');
const rows = data.map((q) => {
  const dir = path.join(RUN, q.question_id);
  const grades = readJson(path.join(dir, 'grades.json')) ?? {};
  const bNotes = notesOf(path.join(dir, 'checkpoint-before-dream'));
  const cNotes = notesOf(path.join(dir, 'checkpoint-after-dream'));
  return { q, B: classify(q, bNotes), C: classify(q, cNotes), nB: bNotes?.length ?? '-', nC: cNotes?.length ?? '-', A: mark(grades.A), gB: mark(grades.B), gC: mark(grades.C) };
});

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('id', 18)}${pad('mechanism', 20)}${pad('B notes', 9)}${pad('B state', 10)}${pad('C notes', 9)}${pad('C state', 10)}A B C (grades)`);
for (const r of rows) {
  console.log(`${pad(r.q.question_id, 18)}${pad(r.q.mechanism, 20)}${pad(r.nB, 9)}${pad(r.B.state, 10)}${pad(r.nC, 9)}${pad(r.C.state, 10)}${r.A} ${r.gB} ${r.gC}`);
  if (flag('--verbose')) {
    for (const side of ['B', 'C']) if (r[side].stale.length) console.log(`    ${side} stale: ${r[side].stale.join(' | ')}`);
    for (const side of ['B', 'C']) if (r[side].hits.length) console.log(`    ${side} keys: ${r[side].hits.join(', ')}`);
  }
}

const STATES = ['missing', 'stale', 'partial', 'complete', 'invented', 'clean', 'n/a'];
console.log('\nPer mechanism (note states; graded-right counts in brackets):');
for (const mechanism of [...new Set(data.map((q) => q.mechanism))]) {
  const set = rows.filter((r) => r.q.mechanism === mechanism);
  const count = (side) => STATES.map((s) => [s, set.filter((r) => r[side].state === s).length]).filter(([, n]) => n).map(([s, n]) => `${s} ${n}`).join(', ') || '-';
  const right = (side) => set.filter((r) => r[side] === 'Y').length;
  console.log(`  ${pad(mechanism, 20)} n=${set.length}  B: ${count('B')} [graded right ${right('gB')}]  |  C: ${count('C')} [graded right ${right('gC')}]  | A right ${right('A')}`);
}

const good = (r, side) => ['complete', 'clean'].includes(r[side].state);
const bad = (r, side) => ['missing', 'stale', 'partial', 'invented'].includes(r[side].state);
const list = (set) => set.map((r) => r.q.question_id).join(', ') || 'none';
const built = rows.filter((r) => r.B.state !== 'n/a' && r.C.state !== 'n/a');
console.log('\nReading the table:');
console.log(`  Dream fixed it       (B note state bad -> C good): ${list(built.filter((r) => bad(r, 'B') && good(r, 'C')))}`);
console.log(`  B never had it       (B missing):                 ${list(built.filter((r) => r.B.state === 'missing'))}`);
console.log(`  stale survived in B  (B stale):                   ${list(built.filter((r) => r.B.state === 'stale'))}`);
console.log(`  Dream broke it       (B good -> C bad):           ${list(built.filter((r) => good(r, 'B') && bad(r, 'C')))}`);
console.log(`  notes right, answer wrong (recall or answering):  B ${list(built.filter((r) => good(r, 'B') && r.gB === 'N'))}  |  C ${list(built.filter((r) => good(r, 'C') && r.gC === 'N'))}`);
console.log(`  notes bad, answer right (judge or other source):  B ${list(built.filter((r) => bad(r, 'B') && r.gB === 'Y'))}  |  C ${list(built.filter((r) => bad(r, 'C') && r.gC === 'Y'))}`);
