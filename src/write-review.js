/** Shared authority boundary for model-originated saves and updates. */
import { createHash } from 'node:crypto';
import { basisReviewReasons, detectConflict, evaluateWrite } from './policy.js';
import { queuePendingWrite } from './pending-writes.js';

export const memoryHash = (raw) => createHash('sha256').update(raw).digest('hex');

/** Active marker written on an explicit user correction (v21). */
export const CURRENT_STATUS_LINE = 'STATUS: current';
/** Heading separating the current value from superseded values (v21). */
export const HISTORY_HEADING = '## History';
const HISTORY_HEADING_RE = /^##\s+history\s*$/iu;
const STATUS_LINE_RE = /^\s*status:\s*([a-z-]+)\s*$/iu;
/** Superseded values may be inline bullets (Dream pipeline) or under `## History`. */
const SUPERSEDED_LINE_RE = /^\s*[-*]\s+Superseded:/iu;
/** Engineering-note lines that stay with the current value across a correction. */
const NOTE_LINE_RE = /^\s*(APPLIES WHEN|HOW TO VERIFY|VERIFY|OBSERVED|EXCEPTION):\s*(.+)$/iu;
/** A superseded value is collapsed onto one history line and capped for size. */
const MAX_SUPERSEDED_CHARS = 1000;

function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

/** Collapse arbitrary text to one trimmed line (for the history trace). */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Split a memory body into the pieces a correction must preserve:
 * - `status`: the `STATUS:` metadata line (first one, when present);
 * - `value`: every other active line (blank lines included);
 * - `notes`: engineering-note lines (`APPLIES WHEN`, `HOW TO VERIFY`, `VERIFY`,
 *   `OBSERVED`, `EXCEPTION`), which describe how to apply/verify the value and
 *   are carried forward instead of being superseded;
 * - `history`: superseded values kept by earlier writes: inline
 *   `- Superseded: ...` bullets (Dream pipeline) and every line under an
 *   existing `## History` heading (explicit corrections).
 *
 * @param {unknown} body
 * @returns {{status:string, value:string, notes:string[], history:string[]}}
 */
export function splitMemoryBody(body) {
  const lines = normalizeNewlines(body).split('\n');
  // Collect superseded values from both shapes the plugin writes:
  //  - the Dream pipeline keeps them as inline `- Superseded: ... (until ...)`
  //    bullets next to the replacement;
  //  - explicit user corrections keep them under a `## History` section.
  const history = [];
  const activeLines = [];
  let inHistory = false;
  for (const line of lines) {
    if (HISTORY_HEADING_RE.test(line.trim())) {
      inHistory = true;
      continue;
    }
    if (inHistory) {
      if (line.trim() !== '') history.push(line.trim());
      continue;
    }
    if (SUPERSEDED_LINE_RE.test(line)) {
      history.push(line.trim());
      continue;
    }
    activeLines.push(line);
  }
  const notes = [];
  const valueLines = [];
  let status = '';
  for (const line of activeLines) {
    if (status === '' && STATUS_LINE_RE.test(line.trim())) {
      status = line.trim();
      continue;
    }
    if (NOTE_LINE_RE.test(line)) {
      notes.push(line.trim());
      continue;
    }
    valueLines.push(line);
  }
  return { status, value: valueLines.join('\n').replace(/^\n+|\n+$/g, '').trim(), notes, history };
}

/** Label of one engineering-note line (`VERIFY`, `OBSERVED`, ...), uppercased. */
function noteLabel(line) {
  const match = NOTE_LINE_RE.exec(line);
  return match === null ? '' : match[1].toUpperCase();
}

/** One source/session description used on a superseded history line. */
function traceOf(source) {
  const value = source && typeof source === 'object' ? source : {};
  const via = typeof value.via === 'string' && value.via !== '' ? value.via : 'tool:memory_update';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
  return sessionId === '' ? `source: ${via}` : `source: ${via}, session ${sessionId}`;
}

/**
 * Compose the body of an explicit user correction (v21).
 *
 * The new value becomes the active value under `STATUS: current`; the previous
 * current value is kept as one `- Superseded: <old> (until <YYYY-MM-DD>)`
 * history line that also records the source/session. Engineering-note lines
 * from the previous body are carried forward unless the new content supplies
 * the same labels, and earlier `## History` lines are preserved. Audit
 * attribution is unchanged: the frontmatter of the file (`via`,
 * `source_session`, `created`) still records who wrote the current version.
 *
 * Nothing is written here; the caller passes `content` to the store.
 * @param {{existingBody:string, content:string, source?:object, date?:string, now?:Date}} input
 * @returns {{content:string, changed:boolean, superseded:string, until:string,
 *   source:string, notes:string[], history:string[]}}
 */
export function composeCorrection({ existingBody, content, source = {}, date, now = new Date() } = {}) {
  const until = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
  const previous = splitMemoryBody(existingBody);
  const next = splitMemoryBody(content);
  const sourceText = traceOf(source);
  const unchanged = next.value === previous.value;
  if (unchanged) {
    return {
      content: normalizeNewlines(content).replace(/\n+$/, ''),
      changed: false,
      superseded: '',
      until,
      source: sourceText,
      notes: previous.notes,
      history: previous.history,
    };
  }
  const previousValue = oneLine(previous.value.replace(/^[-*]\s+/u, ''));
  const superseded = previousValue.length > MAX_SUPERSEDED_CHARS
    ? `${previousValue.slice(0, MAX_SUPERSEDED_CHARS)}…`
    : previousValue;
  // A note label supplied by the new content replaces the old note of that label
  // (the correction itself says how to apply/verify the new value).
  const suppliedLabels = new Set(next.notes.map(noteLabel).filter((label) => label !== ''));
  const carriedNotes = previous.notes.filter((line) => !suppliedLabels.has(noteLabel(line)));
  const notes = [...next.notes, ...carriedNotes];
  const history = superseded === ''
    ? [...next.history, ...previous.history]
    : [
        `- Superseded: ${superseded} (until ${until}) — ${sourceText}`,
        ...next.history,
        ...previous.history,
      ];
  const blocks = [CURRENT_STATUS_LINE];
  if (next.value !== '') blocks.push(next.value);
  if (notes.length > 0) blocks.push(notes.join('\n'));
  if (history.length > 0) blocks.push(HISTORY_HEADING, history.join('\n'));
  return {
    content: `${blocks.join('\n\n')}\n`,
    changed: true,
    superseded,
    until,
    source: sourceText,
    notes,
    history,
  };
}

/**
 * Mark a body the user just stated as the current value.
 *
 * Only writes backed by a verified user quote reach here: a hand-edited note
 * keeps whatever status it had, so an inference can never mint one.
 * @param {string} content
 * @returns {string}
 */
export function ensureCurrentStatus(content) {
  const text = normalizeNewlines(String(content ?? ''));
  if (/^\s*status:\s*current\s*$/imu.test(text)) return text;
  return `${CURRENT_STATUS_LINE}\n${text.replace(/^\n+/, '')}`;
}

/**
 * Returns a tool result when the write must stop, otherwise null.
 *
 * `basis` (v21) adds attribution review on top of the existing confidence,
 * conflict and duplicate checks. Attribution reasons are never bypassed by
 * `force:true`: a forwarded/inferred user claim has to be confirmed by the user
 * (approved from the pending queue) rather than forced active. Since v22 an
 * explicit basis also needs `verifiedEvidence` — a quote the host matched
 * against the session transcript and bound to the new lines of this write —
 * before it can write an active user claim, and a profile-page write needs that
 * authority even when the model omits `basis` (`profileTarget`).
 */
export async function reviewWrite({ paths, candidate, entries = [], force = false, action = 'save', file = '', name = '', content, description, source, config = {}, existing, basis = '', verifiedEvidence = '', profileTarget = false }) {
  const decision = evaluateWrite({ candidate, entries, config });
  // Check independently: neither a high similarity score nor force may hide
  // a negation. A lexical conflict needs human review, not permanent rejection.
  const conflict = detectConflict(candidate, entries);
  const reasons = decision.action === 'low-confidence' ? [...decision.reasons] : [];
  reasons.push(...basisReviewReasons({ basis, candidate, verifiedEvidence, profileTarget }));
  if (conflict) reasons.push(conflict.reason);
  if (reasons.length > 0) {
    const queued = await queuePendingWrite(paths, {
      action, file, name, candidate, content, description, source,
      reasons,
      ...(typeof existing?.raw === 'string' ? { expectedHash: memoryHash(existing.raw) } : {}),
    });
    return { ok: true, written: false, action: 'queued-review', pendingId: queued.id, reasons,
      ...(basis !== '' ? { basis } : {}),
      ...(conflict ? { existingFile: conflict.existingFile, conflicts: [{ file: conflict.existingFile, reason: conflict.reason }] } : {}),
      hint: 'Queued for human review. Use /memory writes; approve with /memory approve <id>.' };
  }
  if (!force && decision.action === 'duplicate') {
    return { ok: true, written: false, action: 'duplicate', existingFile: decision.existingFile, similarity: decision.similarity,
      hint: `Not written: ${decision.existingFile} already covers this memory. Use memory_update, or force:true for an intentional duplicate.` };
  }
  return null;
}
