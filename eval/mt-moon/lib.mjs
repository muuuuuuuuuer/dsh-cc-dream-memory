/**
 * Shared by the deterministic test (test/dream-mt-moon.test.mjs) and the
 * real-model runner (eval/mt-moon/run.mjs): the case data and its scoring, so
 * both layers judge the same outcome the same way.
 */
import { readFile } from 'node:fs/promises';
import { HISTORY_HEADING_RE, SUPERSEDED_LINE_RE, memoryBodyLines } from '../../src/memory-body.js';

const CASES_URL = new URL('./cases.json', import.meta.url);

export async function loadCases() {
  return JSON.parse(await readFile(CASES_URL, 'utf8')).cases;
}

/** An event's text; long pasted blocks are written as arrays of lines. */
export const eventText = (event) => (Array.isArray(event.text) ? event.text.join('\n') : event.text);

const normalize = (text) => String(text ?? '').replace(/^﻿/u, '').replace(/\r\n/gu, '\n');

/**
 * Split a note file the way the host reads it: the text a future session acts on,
 * and what a correction kept as history (a `## History` section or `- Superseded:` lines).
 */
export function splitNote(raw) {
  const body = normalize(raw).replace(/^---\n[\s\S]*?\n---\n/u, '');
  const current = [];
  const history = [];
  let inHistory = false;
  for (const { line, fenced } of memoryBodyLines(body)) {
    if (!fenced && HISTORY_HEADING_RE.test(line.trim())) inHistory = true;
    (inHistory || (!fenced && SUPERSEDED_LINE_RE.test(line.trim())) ? history : current).push(line);
  }
  return { current: current.join('\n'), history: history.join('\n') };
}

/**
 * Score one case.
 * @param {object} testCase a case from cases.json
 * @param {{before:Record<string,string>, after:Record<string,string>}} notes raw note files by name
 *   before the run and after it was switched in
 * @returns {{pass:boolean, checks:Array<{label:string, ok:boolean, soft?:boolean}>}} `soft` checks
 *   (the old value kept in History) are reported but do not decide `pass`: a model may fix a note
 *   by replacing the page, which is also a correct fix.
 */
export function scoreCase(testCase, { before, after }) {
  const checks = [];
  const check = (label, ok, soft = false) => checks.push({ label, ok: Boolean(ok), ...(soft ? { soft: true } : {}) });
  const { expect } = testCase;
  for (const [file, rule] of Object.entries(expect.notes ?? {})) {
    const raw = after[file];
    if (raw === undefined) {
      check(`${file}: removed`, rule.allowDeleted === true);
      continue;
    }
    if (rule.unchanged) check(`${file}: byte-identical`, raw === before[file]);
    const { current, history } = splitNote(raw);
    for (const text of rule.contains ?? []) check(`${file}: says "${text}"`, current.includes(text));
    for (const text of rule.notContains ?? []) check(`${file}: no longer says "${text}"`, !current.includes(text));
    if (rule.containsAny) check(`${file}: says one of ${rule.containsAny.map((text) => `"${text}"`).join(', ')}`, rule.containsAny.some((text) => current.includes(text)));
    for (const text of rule.historyContains ?? []) check(`${file}: History keeps "${text}"`, history.includes(text), true);
  }
  if (expect.acrossFiles) {
    // Two notes that disagreed: one current value may remain between them, the loser only in History.
    const text = Object.values(after).map((raw) => splitNote(raw).current).join('\n');
    check(`across notes: says "${expect.acrossFiles.keep}"`, text.includes(expect.acrossFiles.keep));
    check(`across notes: current text no longer says /${expect.acrossFiles.dropPattern}/`, !new RegExp(expect.acrossFiles.dropPattern, 'u').test(text));
  }
  if (expect.noNewNotes) check('no new notes', Object.keys(after).every((file) => file in before));
  return { pass: checks.every((item) => item.ok || item.soft), checks };
}
