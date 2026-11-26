#!/usr/bin/env node
/**
 * No-model validator for eval/traps/traps.json (or the file given as argv[2]).
 * Checks format, and that every reference answer is really determinable from
 * the user's own words (answer_keys covered by verbatim evidence quotes), and
 * that the unanswerable items really leave the asked detail out (absent_keys).
 * Prints per-item results and the dataset sha256. Exit code 1 on any failure.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDate, sessionsOf } from '../longmemeval/lme-lib.mjs';

const file = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'traps.json'));
const raw = fs.readFileSync(file);
const data = JSON.parse(raw.toString('utf8'));
const TYPES = new Set(['knowledge-update', 'multi-session', 'single-session-preference', 'temporal-reasoning']);
const GROUPS = new Set(['correction-later', 'one-off-vs-default', 'scope-exception', 'provenance', 'synthesis', 'abstention', 'control']);
const ids = new Set();
let failed = 0;

for (const q of data) {
  const errs = [];
  const err = (m) => errs.push(m);
  const str = (k) => { if (typeof q[k] !== 'string' || !q[k].trim()) err(`missing ${k}`); };
  ['question_id', 'question_type', 'question', 'answer', 'question_date', 'group', 'trap'].forEach(str);
  if (ids.has(q.question_id)) err('duplicate question_id');
  ids.add(q.question_id);
  if (!TYPES.has(q.question_type)) err('bad question_type ' + q.question_type);
  if (!GROUPS.has(q.group)) err('bad group ' + q.group);
  const isAbs = String(q.question_id).endsWith('_abs');
  if (isAbs !== (q.group === 'abstention')) err('_abs id and group abstention disagree');
  if (!isAbs && String(q.question_id).includes('_abs')) err('_abs inside a non-abstention id');
  const n = q.haystack_sessions?.length ?? 0;
  if (n < 4 || n > 8) err(`session count ${n} outside 4..8`);
  if (q.haystack_session_ids?.length !== n || q.haystack_dates?.length !== n) err('haystack arrays differ in length');
  if (new Set(q.haystack_session_ids).size !== n) err('duplicate session ids');
  let last = -Infinity;
  try {
    for (const d of q.haystack_dates) {
      const t = parseDate(d);
      if (!(t > last)) err('haystack_dates not strictly increasing at ' + d);
      last = t;
    }
    if (!(parseDate(q.question_date) > last)) err('question_date is not after the last session');
  } catch (e) { err(e.message); }
  const userText = []; // [session][turn] -> user text or null
  q.haystack_sessions.forEach((session, si) => {
    if (!Array.isArray(session) || session.length < 2) err(`session ${si} too short`);
    userText[si] = session.map((turn, ti) => {
      if (!['user', 'assistant'].includes(turn.role)) err(`s${si}t${ti} bad role`);
      if (typeof turn.content !== 'string' || !turn.content.trim()) err(`s${si}t${ti} empty content`);
      if (ti > 0 && turn.role === session[ti - 1].role) err(`s${si}t${ti} roles do not alternate`);
      return turn.role === 'user' ? turn.content : null;
    });
  });
  const all = q.haystack_sessions.flat().map((t) => t.content).join('\n');
  const detail = [];
  if (!Array.isArray(q.evidence) || q.evidence.length === 0) err('no evidence');
  const quotes = [];
  for (const [i, ev] of (q.evidence ?? []).entries()) {
    const text = userText[ev.session]?.[ev.turn];
    if (typeof text !== 'string') err(`evidence[${i}] points at s${ev.session}t${ev.turn}, not a user turn`);
    else if (typeof ev.quote !== 'string' || !ev.quote || !text.includes(ev.quote)) err(`evidence[${i}] quote is not a verbatim substring of s${ev.session}t${ev.turn}`);
    else quotes.push(ev.quote);
  }
  if (isAbs) {
    if (!Array.isArray(q.absent_keys) || q.absent_keys.length === 0) err('abstention item needs absent_keys');
    for (const key of q.absent_keys ?? []) if (all.includes(key)) err(`absent_key "${key}" appears in the history`);
    detail.push(`absent_keys ${q.absent_keys?.length ?? 0} all absent`);
  } else {
    if (!Array.isArray(q.answer_keys) || q.answer_keys.length === 0) err('non-abstention item needs answer_keys');
    for (const key of q.answer_keys ?? []) if (!quotes.some((quote) => quote.includes(key))) err(`answer_key "${key}" is in no evidence quote`);
    detail.push(`answer_keys ${q.answer_keys?.length ?? 0} covered by ${quotes.length} quotes`);
  }
  // The harness reads only these fields; make sure it can load the item.
  try { sessionsOf(q, 'C:/tmp/x'); } catch (e) { err('sessionsOf failed: ' + e.message); }
  if (errs.length) failed += 1;
  console.log(`${errs.length ? 'FAIL' : 'ok  '} ${q.question_id} [${q.group}, ${n} sessions] ${errs.length ? errs.join('; ') : detail.join(', ')}`);
}

const groups = {};
for (const q of data) groups[q.group] = (groups[q.group] ?? 0) + 1;
console.log(`items ${data.length}, groups ${JSON.stringify(groups)}`);
console.log(`sha256 ${createHash('sha256').update(raw).digest('hex')}`);
if (failed) { console.log(`${failed} item(s) failed`); process.exitCode = 1; } else console.log('all items valid');
