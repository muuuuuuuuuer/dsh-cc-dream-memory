#!/usr/bin/env node
/**
 * Generates ../traps.json from the project files in this directory (p1..p4). Run once, review, then
 * freeze: traps.json is the artifact, this directory is only its source. No model, no network.
 *   node eval/traps-v2/src/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p1 from './p1.mjs';
import * as p2 from './p2.mjs';
import * as p3 from './p3.mjs';
import * as p4 from './p4.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'traps.json');
const MECHANISMS = ['window-anaphora', 'index-mismatch', 'fragmentation', 'dense-window', 'lossy-detail', 'selection-standard', 'over-merge', 'one-off-kept', 'abstention'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n) => String(n).padStart(2, '0');
const fmt = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())} (${DAYS[d.getUTCDay()]}) ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
const hash = (text) => [...text].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

function assemble(project, spec) {
  const sessions = spec.order.map((entry) => {
    const turns = typeof entry === 'string' ? project.noise[entry] : entry;
    if (!turns) throw new Error(`${spec.id}: unknown noise session ${entry}`);
    return turns.map((content, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content }));
  });
  const h = hash(spec.id);
  let t = Date.UTC(2026, 8, 1 + (h % 10), 19 + (h % 3), 10 + (h % 5) * 10);
  const dates = [];
  sessions.forEach((_, i) => { if (i > 0) t += (2 + ((h >> i) % 3)) * 86400000 + ((i * 37) % 60) * 60000; dates.push(fmt(t)); });
  const questionDate = fmt(t + 3 * 86400000 + 65 * 60000);
  const evidence = spec.evidence.map((item) => {
    const { quote, role } = typeof item === 'string' ? { quote: item } : item;
    const hits = [];
    sessions.forEach((session, si) => session.forEach((turn, ti) => { if (turn.role === 'user' && turn.content.includes(quote)) hits.push({ session: si, turn: ti }); }));
    if (hits.length !== 1) throw new Error(`${spec.id}: quote matches ${hits.length} user turns: ${quote.slice(0, 40)}`);
    return { ...hits[0], quote, ...(role ? { role } : {}) };
  });
  const abs = spec.id.endsWith('_abs');
  return {
    question_id: spec.id,
    question_type: spec.type,
    question: spec.question,
    answer: spec.answer,
    question_date: questionDate,
    haystack_session_ids: sessions.map((_, i) => `${spec.id}-s${i + 1}`),
    haystack_dates: dates,
    haystack_sessions: sessions,
    group: spec.mechanism,
    mechanism: spec.mechanism,
    trap: spec.trap,
    b_hypothesis: spec.b_hypothesis,
    evidence,
    ...(abs ? { absent_keys: spec.absent_keys } : { answer_keys: spec.answer_keys }),
    ...(spec.stale_keys?.length ? { stale_keys: spec.stale_keys } : {}),
    ...(spec.key_variants ? { key_variants: spec.key_variants } : {}),
    ...(spec.dense_facts ? { dense_facts: spec.dense_facts } : {}),
  };
}

const all = [p1, p2, p3, p4].flatMap((project) => project.items.map((spec) => assemble(project, spec)));
all.sort((a, b) => MECHANISMS.indexOf(a.mechanism) - MECHANISMS.indexOf(b.mechanism) || a.question_id.localeCompare(b.question_id));
fs.writeFileSync(OUT, JSON.stringify(all, null, 2) + '\n');
console.log(`wrote ${all.length} items to ${OUT}`);
