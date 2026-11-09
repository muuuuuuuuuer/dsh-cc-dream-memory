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

const statementKey = (line) => String(line ?? '').trim().replace(/\s+/g, ' ');
function statementsOf(body) {
  return String(body ?? '').split(/\r\n|\r|\n/).map(statementKey).filter(Boolean);
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
    if (oldBody.length >= SHRINK_MIN_CHARS && String(op.body ?? '').length < oldBody.length * SHRINK_MIN_RATIO) {
      const message = `write ${op.file}: shrinks the file from ${oldBody.length} to ${String(op.body ?? '').length} chars`;
      warnings.push(`${message}; review before applying`);
    }
    const known = new Set(statementsOf(oldBody));
    const added = statementsOf(op.body).filter((line) => !known.has(line));
    if (requireEvidence && added.length > 0) {
      const citations = Array.isArray(op.evidence) ? op.evidence : [];
      const structured = citations.some((item) => item && typeof item === 'object');
      const covered = new Set();
      const verified = [];
      for (const item of citations) {
        const quote = typeof item === 'string' ? item : item?.quote;
        const statement = typeof item?.statement === 'string' ? item.statement : '';
        const needle = normalizeForMatch(quote);
        if (needle.length < MIN_QUOTE_CHARS) continue;
        const matches = corpus.filter((block) => block.text.includes(needle));
        const needsUser = op.type === 'user' || op.type === 'feedback';
        const located = needsUser ? matches.find((block) => block.tag === 'user') : matches[0];
        if (!located) continue;
        if (structured && (!statement || !added.includes(statementKey(statement)))) continue;
        covered.add(statementKey(statement));
        const { text: _text, ...source } = located;
        verified.push({ ...(statement ? { statement } : {}), quote, ...source });
      }
      if (verified.length === 0) {
        dropped.push(`write ${op.file}: adds statements without evidence from an allowed source${op.type === 'user' || op.type === 'feedback' ? ' ([user] required)' : ''}`);
        continue;
      }
      if (structured && added.some((statement) => !covered.has(statement))) {
        dropped.push(`write ${op.file}: uncovered new statements; cite every new statement separately`);
        continue;
      }
      if (!structured) warnings.push(`write ${op.file}: legacy operation-level evidence; review every added statement before applying`);
      op = { ...op, evidenceSources: verified };
    }
    kept.push(op);
  }
  return { operations: kept, dropped, warnings };
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
