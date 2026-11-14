/**
 * Current-content projection of a memory body.
 *
 * A correction keeps the replaced value as provenance: an inline
 * `- Superseded: … (until …)` line (Dream pipeline) or a `## History` section
 * (explicit corrections, see `write-review.js`). Those lines record what a fact
 * used to be, so automatic recall, the hot set and compaction must not treat
 * them as current content. Explicit `memory_read`/`memory_search` still return
 * the full body.
 *
 * The same module owns the verification stamp (`VERIFIED AGAINST: <hash>`): only
 * the host writes it, and it covers one exact content version, so an edited page
 * stops being hot until it is verified again.
 *
 * @module dsh-cc-dream-memory/memory-body
 */
import { createHash } from 'node:crypto';

/** Label of the host-written stamp; a model-written stamp is overwritten. */
export const VERIFIED_AGAINST_LABEL = 'VERIFIED AGAINST';
/** `VERIFIED: 2026-11-11` (date) and `VERIFIED AGAINST: <hash>` (binding). */
const STAMP_LINE_RE = /^\s*VERIFIED(?:\s+AGAINST)?:/iu;
const STAMP_VALUE_RE = /^\s*VERIFIED AGAINST:\s*([0-9a-f]{16})\s*$/imu;

/** @param {unknown} body */
function normalizedLines(body) {
  return String(body ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/u, ''));
}

/**
 * The body without its verification stamps.
 * @param {unknown} body
 */
export function stripVerification(body) {
  // Trailing blank lines are dropped so a stamped page and the same content read
  // back from disk fingerprint identically.
  return normalizedLines(body).filter((line) => !STAMP_LINE_RE.test(line)).join('\n').replace(/\s+$/u, '');
}

/**
 * Hash of the content a stamp covers.
 *
 * The stamp lines themselves are excluded, so re-stamping a verified page with a
 * newer date does not change the binding: only a change to the page's actual
 * content invalidates it.
 *
 * @param {unknown} body
 * @returns {string} 16 hex chars
 */
export function verificationHash(body) {
  const lines = normalizedLines(stripVerification(body));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Host-only: stamp a body as verified on `date`, replacing older stamps.
 * @param {unknown} body
 * @param {string} [date] YYYY-MM-DD
 */
/**
 * Current factual lines of a memory body: the lines a reader takes as true now.
 * Metadata labels, headings and bare wiki links carry no fact of their own, and
 * `## History` / `- Superseded:` lines describe the past.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function currentFactLines(body) {
  return currentBody(body)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== ''
      && !line.startsWith('#')
      && !FACT_METADATA_RE.test(line)
      && !LINK_ONLY_RE.test(line)
      && !SUPERSEDED_LINE_RE.test(line));
}

export function stampVerification(body, date = new Date().toISOString().slice(0, 10)) {
  const content = stripVerification(body).replace(/\n+$/u, '');
  const hash = verificationHash(content);
  const stamps = `VERIFIED: ${date}\n${VERIFIED_AGAINST_LABEL}: ${hash}`;
  return `${content === '' ? '' : `${content}\n`}${stamps}\n`;
}

/**
 * True when the page carries a stamp for exactly this content version, so an
 * edit (or a hand-typed date) cannot keep it hot.
 * @param {unknown} body
 */
export function verifiedAgainstCurrent(body) {
  const match = STAMP_VALUE_RE.exec(String(body ?? ''));
  return match !== null && match[1].toLowerCase() === verificationHash(body);
}

/** Inline history bullet written by a correction. */
export const SUPERSEDED_LINE_RE = /^\s*[-*]\s+Superseded:/iu;
/** A derived line that keeps two values the host could not reconcile. */
export const CONFLICT_LINE_RE = /^\s*[-*]\s+CONFLICT:/iu;

/** Heading that starts a history section; everything after it is history. */
export const HISTORY_HEADING_RE = /^##\s+history\s*$/iu;

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
  if (/^\s*status:\s*current\s*$/imu.test(text)) return text;
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
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (HISTORY_HEADING_RE.test(line.trim())) break;
    if (SUPERSEDED_LINE_RE.test(line.trim())) continue;
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
  const match = /^\s*STATUS:\s*([a-z-]+)/imu.exec(String(body ?? ''));
  return match ? match[1].toLowerCase() : 'current';
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
