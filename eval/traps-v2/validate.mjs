#!/usr/bin/env node
/**
 * No-model validator for eval/traps-v2/traps.json (or the file given as argv[2]).
 * v1 checks (format, verbatim user-turn evidence, answer_keys covered by evidence, absent_keys really
 * absent) plus the v2 mechanism checks, computed with the plugin's own transcript code:
 *   window-anaphora  the decision and the retraction are in different sessions, or in different
 *                    chunks of the same session (buildSessionTranscript + chunkTranscript at
 *                    autoExtractMaxChars); the same-session ones must span >= 2 chunks
 *   dense-window     >= 8 durable facts, all verbatim in one chunk of one session, the target not
 *                    among the first five (auto-extract saves at most 5 notes per run)
 * Prints per item the transcript chars and chunk count, then the dataset sha256. Exit code 1 on failure.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDate, sessionsOf } from '../longmemeval/lme-lib.mjs';
import { buildSessionTranscript, chunkTranscript } from '../../src/dream-session-text.js';
import { DEFAULTS } from '../../src/config.js';

const file = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'traps.json'));
const raw = fs.readFileSync(file);
const data = JSON.parse(raw.toString('utf8'));
const TYPES = new Set(['knowledge-update', 'multi-session', 'single-session-user', 'single-session-preference', 'temporal-reasoning']);
const MECHANISMS = ['window-anaphora', 'index-mismatch', 'fragmentation', 'dense-window', 'lossy-detail', 'selection-standard', 'over-merge', 'one-off-kept', 'abstention'];
const COUNTS = { 'window-anaphora': [3, 4], 'index-mismatch': [3, 4], fragmentation: [3, 4], 'dense-window': [3, 4], 'lossy-detail': [3, 4], 'selection-standard': [2, 2], abstention: [2, 2] };
const CHUNK_CHARS = DEFAULTS.autoExtractMaxChars; // 12000
const TOOL_CHARS = 4_000; // the constant auto-extract passes as toolCharsPerChunk
const EVERY = DEFAULTS.autoExtractEveryTurns; // 3
const HINTS = /后来|改了吗|变了吗|更新|作废|最新|取消|撤回|修改|有没有变/u;
const norm = (s) => String(s).replace(/[\s:=：`'"“”]/gu, '').toLowerCase();
const alts = (key) => String(key).split('|');
const inText = (key, text) => alts(key).some((alt) => text.includes(alt) || norm(text).includes(norm(alt)));
const ids = new Set();
const perMechanism = {};
let failed = 0;

const chunksOf = (q, si) => {
  const events = sessionsOf(q, 'C:/tmp/x')[si].events;
  const transcript = buildSessionTranscript(events);
  const chunks = chunkTranscript(transcript, { chunkChars: CHUNK_CHARS, toolCharsPerChunk: TOOL_CHARS });
  return { events, chunks, chars: chunks.reduce((n, c) => n + c.text.length, 0) };
};
const chunkIndexOfSeq = (chunks, seq) => chunks.findIndex((c) => c.firstSeq <= seq && seq <= c.lastSeq);

for (const q of data) {
  const errs = [];
  const err = (m) => errs.push(m);
  const str = (k) => { if (typeof q[k] !== 'string' || !q[k].trim()) err(`missing ${k}`); };
  ['question_id', 'question_type', 'question', 'answer', 'question_date', 'group', 'trap', 'mechanism', 'b_hypothesis'].forEach(str);
  if (ids.has(q.question_id)) err('duplicate question_id');
  ids.add(q.question_id);
  if (!TYPES.has(q.question_type)) err('bad question_type ' + q.question_type);
  if (!MECHANISMS.includes(q.mechanism)) err('bad mechanism ' + q.mechanism);
  if (q.group !== q.mechanism) err('group must equal mechanism');
  perMechanism[q.mechanism] = (perMechanism[q.mechanism] ?? 0) + 1;
  const isAbs = String(q.question_id).endsWith('_abs');
  if (isAbs !== (q.mechanism === 'abstention')) err('_abs id and mechanism abstention disagree');
  if (!isAbs && String(q.question_id).includes('_abs')) err('_abs inside a non-abstention id');
  if (HINTS.test(q.question ?? '')) err('question contains a hint word');
  const n = q.haystack_sessions?.length ?? 0;
  if (n < 8 || n > 15) err(`session count ${n} outside 8..15`);
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
  const userText = [];
  q.haystack_sessions.forEach((session, si) => {
    if (!Array.isArray(session) || session.length < 2) err(`session ${si} too short`);
    userText[si] = session.map((turn, ti) => {
      if (!['user', 'assistant'].includes(turn.role)) err(`s${si}t${ti} bad role`);
      if (typeof turn.content !== 'string' || !turn.content.trim()) err(`s${si}t${ti} empty content`);
      if (ti === 0 && turn.role !== 'user') err(`s${si} does not start with a user turn`);
      if (ti > 0 && turn.role === session[ti - 1].role) err(`s${si}t${ti} roles do not alternate`);
      return turn.role === 'user' ? turn.content : null;
    });
  });
  const all = q.haystack_sessions.flat().map((t) => t.content).join('\n');
  const allUser = userText.flat().filter(Boolean).join('\n');
  const detail = [];
  if (!Array.isArray(q.evidence) || q.evidence.length === 0) err('no evidence');
  const quotes = [];
  const byRole = {};
  for (const [i, ev] of (q.evidence ?? []).entries()) {
    const text = userText[ev.session]?.[ev.turn];
    if (typeof text !== 'string') err(`evidence[${i}] points at s${ev.session}t${ev.turn}, not a user turn`);
    else if (typeof ev.quote !== 'string' || !ev.quote || !text.includes(ev.quote)) err(`evidence[${i}] quote is not a verbatim substring of s${ev.session}t${ev.turn}`);
    else { quotes.push(ev.quote); if (ev.role) (byRole[ev.role] ??= []).push(ev); }
  }
  if (isAbs) {
    if (!Array.isArray(q.absent_keys) || q.absent_keys.length === 0) err('abstention item needs absent_keys');
    for (const key of q.absent_keys ?? []) if (all.includes(key)) err(`absent_key "${key}" appears in the history`);
    if (q.answer_keys) err('abstention item must not have answer_keys');
    detail.push(`absent_keys ${q.absent_keys?.length ?? 0} all absent`);
  } else {
    if (!Array.isArray(q.answer_keys) || q.answer_keys.length === 0) err('non-abstention item needs answer_keys');
    for (const key of q.answer_keys ?? []) if (!quotes.some((quote) => inText(key, quote))) err(`answer_key "${key}" is in no evidence quote`);
    detail.push(`answer_keys ${q.answer_keys?.length ?? 0} covered by ${quotes.length} quotes`);
  }
  for (const key of q.stale_keys ?? []) if (!inText(key, allUser)) err(`stale_key "${key}" never appears in the user's words`);
  try { sessionsOf(q, 'C:/tmp/x'); } catch (e) { err('sessionsOf failed: ' + e.message); }

  // Transcript stats and mechanism checks, with the plugin's own chunker.
  let relevant = -1;
  const stats = [];
  try {
    for (let si = 0; si < n; si += 1) { const c = chunksOf(q, si); stats.push({ chars: c.chars, chunks: c.chunks.length, c }); }
  } catch (e) { err('transcript failed: ' + e.message); }
  const need = (role, min = 1) => { if ((byRole[role]?.length ?? 0) < min) err(`evidence role "${role}" needs ${min}`); return byRole[role] ?? []; };
  if (stats.length === n) {
    if (q.mechanism === 'window-anaphora') {
      const [dec] = need('decision');
      const [ret] = need('retraction');
      if (dec && ret) {
        relevant = dec.session;
        const decChunks = stats[dec.session].c.chunks;
        if (decChunks.length < 2) err('the decision session must span >= 2 chunks (a long session)');
        if (ret.session < dec.session) err('retraction precedes decision');
        else if (ret.session > dec.session) detail.push(`retraction in a later session (s${dec.session + 1} -> s${ret.session + 1}); decision session ${decChunks.length} chunks`);
        else {
          const a = chunkIndexOfSeq(decChunks, dec.turn + 1);
          const b = chunkIndexOfSeq(decChunks, ret.turn + 1);
          if (decChunks.length < 2) err('same-session window-anaphora item spans only one chunk');
          if (a < 0 || b < 0 || a === b) err(`decision and retraction share chunk ${a}/${b}`);
          const userSeqs = stats[dec.session].c.events.filter((e) => e.type === 'user/message').map((e) => e.seq);
          const ga = Math.floor(userSeqs.indexOf(dec.turn + 1) / EVERY);
          const gb = Math.floor(userSeqs.indexOf(ret.turn + 1) / EVERY);
          if (ga === gb) err('decision and retraction fall in the same 3-turn group');
          detail.push(`same session: decision in chunk ${a + 1}, retraction in chunk ${b + 1} of ${decChunks.length}; 3-turn groups ${ga + 1} vs ${gb + 1}`);
        }
        if (dec.session === ret.session && q.haystack_sessions[dec.session].length < 6) err('long session expected');
      }
    } else if (q.mechanism === 'dense-window') {
      const facts = q.dense_facts ?? [];
      const [target] = need('target');
      if (facts.length < 8) err(`dense_facts ${facts.length} < 8`);
      if (target) {
        relevant = target.session;
        const { chunks, events } = stats[target.session].c;
        const text = userText[target.session].filter(Boolean).join('\n');
        const idx = facts.map((f) => (text.includes(f) ? chunks.findIndex((c) => c.text.includes(f)) : -2));
        if (idx.some((i) => i < 0)) err('a dense fact is missing from the session or from every chunk');
        else if (new Set(idx).size !== 1) err(`dense facts spread over chunks ${[...new Set(idx)].join(',')}`);
        const pos = facts.map((f) => text.indexOf(f));
        const tIdx = facts.findIndex((f) => f.includes(target.quote) || target.quote.includes(f));
        const rank = tIdx < 0 ? -1 : pos.filter((p) => p < pos[tIdx]).length;
        if (rank < 5) err(`target is fact #${rank + 1}; it must come after the first five`);
        const users = events.filter((e) => e.type === 'user/message').map((e) => e.seq);
        const groups = new Set(facts.map((f) => { const ti = userText[target.session].findIndex((t) => t && t.includes(f)); return Math.floor(users.indexOf(ti + 1) / EVERY); }));
        if (groups.size !== 1) err(`dense facts span ${groups.size} three-turn groups`);
        detail.push(`${facts.length} dense facts in chunk ${idx[0] + 1} of ${chunks.length}, one 3-turn group, target is fact #${rank + 1}`);
      }
    } else if (q.mechanism === 'fragmentation') {
      const sessionsHit = new Set((q.evidence ?? []).map((e) => e.session));
      if (sessionsHit.size < 5) err(`fragmentation needs pieces in >= 5 sessions, got ${sessionsHit.size}`);
      if ((q.answer_keys ?? []).length < 5) err('fragmentation answer needs >= 5 keys');
      detail.push(`pieces in ${sessionsHit.size} sessions`);
    } else if (q.mechanism === 'index-mismatch') {
      const [o] = need('old');
      const [u] = need('update');
      if (o && u && !(u.session > o.session)) err('update must come in a later session than the old fact');
    } else if (q.mechanism === 'over-merge') {
      const [s] = need('sibling');
      const [t] = need('target');
      if (s && t && s.session === t.session) err('sibling and target must be in different sessions');
    } else if (['lossy-detail', 'one-off-kept', 'selection-standard'].includes(q.mechanism)) {
      const [t] = need('target');
      if (t) { relevant = t.session; if (q.mechanism === 'lossy-detail' && userText[t.session].filter(Boolean).length < 2) err('lossy detail should sit inside a longer discussion'); }
    }
    const rel = relevant >= 0 ? relevant : stats.reduce((best, s, i) => (s.chars > stats[best].chars ? i : best), 0);
    const total = stats.reduce((sum, s) => sum + s.chars, 0);
    detail.push(`transcript chars s${rel + 1}=${stats[rel].chars} chunks=${stats[rel].chunks} (history ${total} chars)`);
  }
  if (errs.length) failed += 1;
  console.log(`${errs.length ? 'FAIL' : 'ok  '} ${q.question_id} [${q.mechanism}, ${n} sessions] ${errs.length ? errs.join('; ') + ' | ' : ''}${detail.join(', ')}`);
}

for (const [m, [lo, hi]] of Object.entries(COUNTS)) {
  const c = perMechanism[m] ?? 0;
  if (c < lo || c > hi) { failed += 1; console.log(`FAIL mechanism ${m}: ${c} items, expected ${lo}..${hi}`); }
}
const controls = (perMechanism['over-merge'] ?? 0) + (perMechanism['one-off-kept'] ?? 0) + (perMechanism.abstention ?? 0);
if (controls < 3 || controls > 4) { failed += 1; console.log(`FAIL Dream-risk controls: ${controls}, expected 3..4`); }
console.log(`items ${data.length}, mechanisms ${JSON.stringify(perMechanism)}`);
console.log(`sha256 ${createHash('sha256').update(raw).digest('hex')}`);
if (failed) { console.log(`${failed} failure(s)`); process.exitCode = 1; } else console.log('all items valid');
