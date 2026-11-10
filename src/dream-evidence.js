/**
 * Host-side checks on what a dream may claim.
 *
 * The model proposes; the host verifies. A write that adds statements must cite
 * short verbatim quotes the host can find in what the dream actually read, and a
 * `user`/`feedback` memory must rest on something the user typed. This raises the
 * bar against invented or laundered facts; it cannot prove a statement follows
 * from its quote, which is why plans stay reviewable and undoable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Below this many significant characters a quote proves nothing. */
const MIN_QUOTE_CHARS = 6;
/** Files this small are not worth guarding against shrinking. */
const SHRINK_MIN_CHARS = 400;
const SHRINK_MIN_RATIO = 0.5;
const MAX_STALE_REFERENCES = 30;
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

/** Everything a dream read, as tagged normalized text the host can search. */
export function buildEvidenceCorpus(input) {
  const corpus = [];
  for (const session of input?.sessions ?? []) {
    if (session?.excerpt) {
      for (const block of parseTranscriptBlocks(session.excerpt)) {
        const original = (session.evidenceBlocks ?? []).find((item) => item.tag === block.tag && normalizeForMatch(item.text).includes(block.text));
        corpus.push({ ...block, sessionId: session.id, ...(original ? { seq: original.seq } : {}) });
      }
    }
    for (const fact of session?.facts ?? []) corpus.push({ tag: fact.source, date: fact.date, sessionId: session.id,
      ...(Number.isFinite(fact.seq) ? { seq: fact.seq } : {}), text: normalizeForMatch(fact.quote) });
  }
  for (const file of input?.memory?.files ?? []) {
    if (typeof file?.body === 'string' && file.body !== '') corpus.push({ tag: 'memory', file: file.file, date: '', text: normalizeForMatch(file.body) });
  }
  return corpus;
}

/** The first block containing a quote, so its true source and date can be used. */
export function locateQuote(quote, blocks) {
  const needle = normalizeForMatch(quote);
  if (needle.length < MIN_QUOTE_CHARS) return null;
  return blocks.find((block) => block.text.includes(needle)) ?? null;
}

const statementKey = (line) => String(line ?? '').trimEnd();
function statementsOf(body) {
  return String(body ?? '').split(/\r\n|\r|\n/).map(statementKey).filter(Boolean);
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

/**
 * Filter a validated plan's operations.
 * @param {object[]} operations
 * @param {{corpus:object[], memoryFiles:object[], requireEvidence:boolean}} options
 * @returns {{operations:object[], dropped:string[], warnings:string[]}}
 */
export function checkPlanEvidence(operations, { corpus = [], memoryFiles = [], requireEvidence = true, } = {}) {
  const kept = [];
  const dropped = [];
  const warnings = [];
  const files = new Map(memoryFiles.map((file) => [file.file, file]));
  for (let op of operations) {
    if (op?.op !== 'write') {
      kept.push(op);
      continue;
    }
    const previous = files.get(op.file);
    const oldBody = typeof previous?.body === 'string' && previous.truncated !== true ? previous.body : '';
    const changes = bodyLineChanges(oldBody, op.body);
    if (changes.removedLines.length > 0) warnings.push(`write ${op.file}: removes ${changes.removedLines.length} existing body line(s); inspect the removed lines in preview before applying`);
    if (oldBody.length >= SHRINK_MIN_CHARS && String(op.body ?? '').length < oldBody.length * SHRINK_MIN_RATIO) {
      const message = `write ${op.file}: shrinks the file from ${oldBody.length} to ${String(op.body ?? '').length} chars`;
      warnings.push(`${message}; review before applying`);
    }
    // Existing user/feedback facts can move without rereading their old sessions.
    // Project/reference text cannot be laundered into a new user preference.
    const needsUser = op.type === 'user' || op.type === 'feedback';
    const known = new Set(memoryFiles
      .filter(file => !file.truncated && (file.scope ?? 'project') === (op.scope ?? 'project')
        && (!needsUser || file.type === 'user' || file.type === 'feedback'
          || (file.file === op.file && !file.type)))
      .flatMap(file => statementsOf(file.body)));
    const added = statementsOf(op.body).filter((line) => !known.has(line));
    if (requireEvidence && added.length > 0) {
      const citations = Array.isArray(op.evidence) ? op.evidence : [];
      const verified = [];
      const memoryRewriteSources = [];
      for (const item of citations) {
        const quote = typeof item === 'string' ? item : item?.quote;
        const statement = typeof item?.statement === 'string' ? item.statement : '';
        const needle = normalizeForMatch(quote);
        if (needle.length < MIN_QUOTE_CHARS) continue;
        const matches = corpus.filter((block) => block.text.includes(needle));
        const located = needsUser ? matches.find((block) => block.tag === 'user') : matches[0];
        if (!located && needsUser && !previous?.truncated && ['user', 'feedback'].includes(previous?.type)) {
          const ownMemory = matches.find(block => block.tag === 'memory' && block.file === op.file);
          if (ownMemory) {
            const { text: _text, ...source } = ownMemory;
            memoryRewriteSources.push({ quote, ...source });
          }
        }
        if (!located) continue;
        if (statement && !statementsOf(op.body).includes(statementKey(statement))) continue;
        const { text: _text, ...source } = located;
        verified.push({ ...(statement ? { statement } : {}), quote, ...source });
      }
      if (verified.length === 0 && memoryRewriteSources.length > 0) {
        op = { ...op, requiresReview: true, evidenceSources: memoryRewriteSources };
        warnings.push(`write ${op.file}: existing-memory rewording has no fresh [user] evidence; explicit review required`);
        kept.push(op);
        continue;
      }
      if (verified.length === 0) {
        dropped.push(`write ${op.file}: adds statements without evidence from an allowed source${op.type === 'user' || op.type === 'feedback' ? ' ([user] required)' : ''}`);
        continue;
      }
      warnings.push(`write ${op.file}: operation-level evidence establishes a source, not semantic support; review the added statements before applying`);
      op = { ...op, evidenceSources: verified };
    }
    kept.push(op);
  }
  const guarded = dropDestructiveDependents(operations, kept);
  return { operations: guarded.operations, dropped: [...dropped, ...guarded.dropped], warnings };
}

/** Whitespace-only canonicalization; case and punctuation can carry meaning. */
const canonical = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const sameMetadata = (left, right) => ['name', 'type', 'description'].every((key) => canonical(left[key]) === canonical(right[key]));

/** Unattended changes must preserve the observable content, not just cite it. */
export function automaticReviewReasons(operations, memoryFiles = []) {
  const files = new Map(memoryFiles.map((file) => [file.file, file]));
  const final = new Map(files);
  for (const op of operations) {
    if (op.op === 'write') final.set(op.file, op);
    if (op.op === 'delete') final.delete(op.file);
  }
  const reasons = [];
  for (const op of operations) {
    const before = files.get(op.file);
    if (op.op === 'write' && (!before || before.truncated || canonical(before.body) !== canonical(op.body) || !sameMetadata(before, op))) {
      reasons.push(`write ${op.file}: semantic or metadata change requires review before automatic application`);
    }
    if (op.op === 'delete') {
      const retained = before && !before.truncated && canonical(before.body) !== '' && [...final.values()].some((file) =>
        file.file !== op.file && !file.truncated && canonical(file.body) === canonical(before.body) && sameMetadata(file, before));
      if (!retained) reasons.push(`delete ${op.file}: content is not identically preserved in a surviving memory; review required`);
    }
    if (op.op === 'index') {
      const allowed = new Set([...final.values()].map((file) => `- [${file.name}](${file.file}) — ${file.description ?? ''}`.trim()));
      if (canonical(op.content).split('\n').filter(Boolean).some((line) => !allowed.has(line))) {
        reasons.push('index: changed descriptions or unknown entries require review');
      }
    }
  }
  return reasons;
}

/** Backticked tokens that look like a file or directory path. */
function pathReferences(body, bases) {
  const references = new Set();
  for (const match of String(body ?? '').matchAll(/`([^`\n]{3,200})`/g)) {
    const token = match[1].trim().replace(/:\d+(:\d+)?$/, '');
    if (/\s|[*{}<>$]/.test(token)) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) || token.startsWith('~')) continue;
    const isWindowsAbsolute = /^[a-z]:[\\/]/i.test(token);
    // A rooted token is usually a route; it is a path only under a known directory.
    const isKnownAbsolute = [os.homedir(), ...bases].some((base) => token.startsWith(base));
    if ((token.startsWith('/') || token.startsWith('\\')) && !isKnownAbsolute) continue;
    if (!/[\\/]/.test(token)) continue;
    // `turn/end`-style names are not paths: require an extension or a trailing slash.
    if (!isWindowsAbsolute && !isKnownAbsolute && !/\.[A-Za-z0-9]{1,8}$/.test(token) && !/[\\/]$/.test(token)) continue;
    references.add(token);
  }
  return [...references];
}

/**
 * Paths mentioned in memory that no longer exist. Deterministic and read-only:
 * the consolidation model cannot run tools, so the host checks for it.
 * @param {Array<{file:string, body:string}>} files
 * @param {string[]} roots directories relative paths may live under.
 * @returns {Array<{file:string, reference:string}>}
 */
export function collectStaleReferences(files, roots) {
  const bases = roots.filter((root) => typeof root === 'string' && root !== '');
  const stale = [];
  for (const file of files ?? []) {
    for (const reference of pathReferences(file?.body, bases)) {
      if (stale.length >= MAX_STALE_REFERENCES) return stale;
      const exists = path.isAbsolute(reference)
        ? fs.existsSync(reference)
        : bases.some((base) => fs.existsSync(path.join(base, reference)));
      if (!exists) stale.push({ file: file.file, reference });
    }
  }
  return stale;
}
