/** Body composition shared by every memory write (corrections, hashes). */
import { createHash } from 'node:crypto';
import { CURRENT_STATUS_LINE, ensureCurrentStatus } from './memory-body.js';

/** Re-exported for the write callers; the definition lives with the other body
 * markers in `memory-body.js`. */
export { CURRENT_STATUS_LINE, ensureCurrentStatus };

export const memoryHash = (raw) => createHash('sha256').update(raw).digest('hex');

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
/** Inline history is a short audit trail, not an append-only log. */
const MAX_HISTORY_LINES = 20;
const MAX_HISTORY_CHARS = 4000;

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
  const history = [];
  let historyChars = 0;
  const candidates = superseded === ''
    ? [...next.history, ...previous.history]
    : [
        `- Superseded: ${superseded} (until ${until}) — ${sourceText}`,
        ...next.history,
        ...previous.history,
      ];
  for (const line of candidates) {
    if (history.length >= MAX_HISTORY_LINES || historyChars + line.length > MAX_HISTORY_CHARS) break;
    history.push(line);
    historyChars += line.length;
  }
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
