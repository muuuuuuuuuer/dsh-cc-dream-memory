/**
 * Current-content projection of a memory body.
 *
 * A correction keeps the replaced value as provenance: an inline
 * `- Superseded: … (until …)` line (Dream pipeline) or a `## History` section
 * (explicit corrections, see `write-review.js`). Those lines record what a fact
 * used to be, so automatic recall, the hot set and compaction must not treat
 * them as current content. The memory tools also use this projection.
 *
 * @module dsh-cc-dream-memory/memory-body
 */
/** `VERIFIED: 2026-11-11` (date) and `VERIFIED AGAINST: <hash>` (binding). */
const STAMP_LINE_RE = /^\s*VERIFIED(?:\s+AGAINST)?:/iu;

/** @param {unknown} body */
function normalizedLines(body) {
  return String(body ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/u, ''));
}

/**
 * Remove old verification stamps before reading or saving current content.
 * @param {unknown} body
 */
export function stripVerification(body) {
  // Trailing blank lines are dropped so a stamped page and the same content read
  // back from disk fingerprint identically.
  return normalizedLines(body).filter((line) => !STAMP_LINE_RE.test(line)).join('\n').replace(/\s+$/u, '');
}

/**
 * Current facts together with the headings they sit under, for deciding
 * whether an edit kept the meaning. A heading changes what the lines below it
 * say ("Likes > coffee" vs "Dislikes > coffee"), so each fact is keyed by its
 * heading path. Only the bullet marker and surrounding whitespace are ignored.
 *
 * @param {string} body
 * @returns {{line:number,paragraphStart:number,sectionStart:number,fenced:boolean,heading:string,text:string}[]} Zero-based positions in `currentBody(body)`.
 */
export function currentFactLines(body) {
  const headings = [];
  const facts = [];
  let paragraphStart = 0;
  let sectionStart = 0;
  for (const [index, { line: raw, fenced }] of [...memoryBodyLines(currentBody(body))].entries()) {
    const line = raw.trim();
    const heading = fenced ? null : /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      paragraphStart = index + 1;
      sectionStart = paragraphStart;
      const level = heading[1].length;
      while (headings.length > 0 && headings[headings.length - 1].level >= level) headings.pop();
      const text = heading[2].replace(/\s+#+\s*$/u, '').replace(/\s+/gu, ' ').trim();
      if (text !== '') headings.push({ level, text });
      continue;
    }
    if (line === '') {
      paragraphStart = index + 1;
      continue;
    }
    if (!fenced && (FACT_METADATA_RE.test(line) || LINK_ONLY_RE.test(line) || SUPERSEDED_LINE_RE.test(line))) continue;
    const fact = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, '');
    const path = headings.map((item) => item.text).join(' > ');
    facts.push({ line: index, paragraphStart, sectionStart, fenced, heading: path, text: path === '' ? fact : `${path} » ${fact}` });
  }
  return facts;
}

/** The text form used by evidence comparison. */
export function currentFactsInContext(body) {
  return currentFactLines(body).map(({ text }) => text);
}

/** Inline history bullet written by a correction. */
export const SUPERSEDED_LINE_RE = /^\s*[-*]\s+Superseded:/iu;
/** A derived line that keeps two values the host could not reconcile. */
export const CONFLICT_LINE_RE = /^\s*[-*]\s+CONFLICT:/iu;

/** Heading that starts a history section; everything after it is history. */
export const HISTORY_HEADING_RE = /^##\s+history\s*$/iu;

/** Standalone labels whose text qualifies the preceding recommendation. */
export const MEMORY_CAVEAT_RE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*)?(?:Applies when|How to apply|How to verify|Verify|Observed|Exception|适用条件|何时适用|如何应用|如何验证|验证|观察|例外|注意事项)\s*(?:\*\*)?[:：]/iu;

/** Mark literal lines (including the delimiters) in fenced Markdown examples. */
export function* memoryBodyLines(body) {
  let fence = '';
  for (const line of String(body ?? '').split(/\r\n?|\n/u)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0]
        && delimiter[1].length >= fence.length && delimiter[2].trim() === '') fence = '';
      yield { line, fenced: true };
    } else {
      if (delimiter && (delimiter[1][0] === '~' || !delimiter[2].includes('`'))) fence = delimiter[1];
      yield { line, fenced: fence !== '' };
    }
  }
}

/** The one status line that marks a page as the active value. */
export const CURRENT_STATUS_LINE = 'STATUS: current';

/**
 * Stamp a body the user just put into force. Idempotent: a body that already
 * declares `STATUS: current` is returned unchanged.
 * @param {unknown} content
 * @returns {string}
 */
export function ensureCurrentStatus(content) {
  const text = String(content ?? '').replace(/\r\n?/g, '\n');
  if ([...memoryBodyLines(text)].some(({ line, fenced }) => !fenced && /^\s*status:\s*current\s*$/iu.test(line))) return text;
  return `${CURRENT_STATUS_LINE}\n${text.replace(/^\n+/, '')}`;
}

/** Metadata labels the host owns; they describe the page, not the world. */
const FACT_METADATA_RE = /^\s*(?:STATUS|VERIFIED(?:\s+AGAINST)?|USER\s+CONFIRMED|CONFIRMED|Superseded|Created|Updated|Source|Scope|Type|Date)\s*:/iu;
// Same link-only shapes the write gate treats as structure (dream-write-evidence):
// `[[a]]`, `- [[a]] [[b]]`, `Related: [[a]] [[b]]`, `See also: [[a]]`.
const LINK_ONLY_RE = /^(?:(?:Related|See also):\s*|[-*]\s*)?(?:\[\[[^\]\n]+\]\]\s*)+$/iu;

/**
 * @param {unknown} body
 * @returns {string} the body with superseded values removed.
 */
export function currentBody(body) {
  const kept = [];
  for (const { line, fenced } of memoryBodyLines(body)) {
    if (!fenced && HISTORY_HEADING_RE.test(line.trim())) break;
    if (!fenced && SUPERSEDED_LINE_RE.test(line.trim())) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** Statuses whose pages are history, not a value the user relies on now. */
export const CURRENTNESS_EXCLUDED = ['stale', 'superseded', 'disputed', 'review-needed', 'retired'];

/**
 * The page-level status marker Dream v2 writes; a page without one is current.
 * @param {unknown} body
 * @returns {string}
 */
export function memoryStatusOf(body) {
  for (const { line, fenced } of memoryBodyLines(body)) {
    if (fenced) continue;
    const match = /^\s*STATUS:\s*([a-z-]+)/iu.exec(line);
    if (match) return match[1].toLowerCase();
  }
  return 'current';
}

/**
 * True when a page may enter default retrieval (search, recall, model reads).
 * Excluded pages stay reachable through an explicit history read.
 * @param {unknown} body
 * @returns {boolean}
 */
export function isCurrentPage(body) {
  return !CURRENTNESS_EXCLUDED.includes(memoryStatusOf(body));
}

/**
 * The status a write would give its page when that hides the page from the
 * index and recall; '' otherwise. The first `STATUS:` line decides for the
 * whole page, so a body that is the current decision but opens with
 * `STATUS: superseded` vanishes. A page that was already hidden stays as it is.
 * @param {unknown} before the page body before the write (undefined for a new page).
 * @param {unknown} after the page body the write would leave.
 * @returns {string}
 */
export function statusHidingPage(before, after) {
  const status = memoryStatusOf(after);
  if (!CURRENTNESS_EXCLUDED.includes(status)) return '';
  return before !== undefined && !isCurrentPage(before) ? '' : status;
}

/**
 * The explanation of a hiding status, for the model that wrote it.
 * @param {string} status
 * @param {boolean} [canRetire] whether the writer may ask to hide the page (`retire: true`).
 */
export function statusHidingMessage(status, canRetire = true) {
  return `STATUS: ${status} would hide this whole page from the index and recall (the first STATUS line decides for the page). `
    + 'To retire a page, delete it with moved_to or merges; to record an old value, put it under ## History.'
    + (canRetire ? ' Set retire: true only if you mean to hide this page.' : '');
}
