/**
 * Text-matching helpers shared by the dream layers.
 *
 * The verifier (`src/dream-verifier.js`) and the user-evidence check
 * (`src/user-evidence.js`) locate the quote a claim cites in what the dream
 * actually read; the apply path diffs a proposed body against the stored one.
 * Matching ignores case, whitespace, markdown and punctuation, so a real quote
 * survives reformatting without turning the check into a loose substring test.
 */

/** Below this many significant characters a quote proves nothing. */
const MIN_QUOTE_CHARS = 6;
const TRANSCRIPT_TAG = /^\[(user|user-pasted|assistant|tool-call|tool-result|tool-error)\] ?/;
const DATE_MARKER = /^--- (\d{4}-\d{2}-\d{2}) ---$/;

/** Compare text ignoring case, whitespace, markdown and punctuation. */
export function normalizeForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\\\s`*_#>|\-—:：,，.。;；!！?？()（）[\]{}"'“”‘’「」…/]+/g, '');
}

/**
 * Split a rendered transcript back into blocks.
 * @param {string} text transcript from `chunkTranscript`.
 * @returns {Array<{tag:string, date:string, text:string}>} `text` is normalized.
 */
export function parseTranscriptBlocks(text) {
  const blocks = [];
  let date = '';
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const marker = line.match(DATE_MARKER);
    if (marker) {
      date = marker[1];
      continue;
    }
    const tag = line.match(TRANSCRIPT_TAG);
    if (tag) {
      current = { tag: tag[1], date, raw: line.slice(tag[0].length) };
      blocks.push(current);
    } else if (current) {
      current.raw += `\n${line}`;
    }
  }
  return blocks.map((block) => ({ tag: block.tag, date: block.date, text: normalizeForMatch(block.raw) }));
}

/** The first block containing a quote, so its true source and date can be used. */
export function locateQuote(quote, blocks) {
  const needle = normalizeForMatch(quote);
  if (needle.length < MIN_QUOTE_CHARS) return null;
  return blocks.find((block) => block.text.includes(needle)) ?? null;
}

/** Content-line inventory, preserving indentation, duplicates and line numbers. */
export function bodyLineChanges(before, after) {
  const lines = value => String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const oldLines = lines(before);
  const newLines = lines(after);
  const unmatched = (source, target) => {
    const remaining = new Map();
    for (const text of target) remaining.set(text, (remaining.get(text) ?? 0) + 1);
    return source.flatMap((text, index) => {
      const count = remaining.get(text) ?? 0;
      if (count > 0) { remaining.set(text, count - 1); return []; }
      return text.trim() ? [{ line: index + 1, text }] : [];
    });
  };
  return { addedLines: unmatched(newLines, oldLines), removedLines: unmatched(oldLines, newLines) };
}

/** Without explicit model dependencies, a failed write invalidates destructive follow-ups. */
export function dropDestructiveDependents(original, accepted) {
  const rejectedWrite = (original ?? []).filter(op => op?.op === 'write').length
    > (accepted ?? []).filter(op => op?.op === 'write').length;
  const dropped = [];
  const operations = (accepted ?? []).filter(op => {
    if (!rejectedWrite || (op.op !== 'delete' && op.op !== 'index')) return true;
    dropped.push(`${op.op}${op.file ? ` ${op.file}` : ''}: dropped dependency because a write was rejected; regenerate the plan`);
    return false;
  });
  return { operations, dropped };
}
