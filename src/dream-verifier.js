/**
 * Host-side verification for one analyzer result.
 *
 * The model proposes; the host checks every quote against the transcript it
 * actually read, annotates the true source tag and date, drops claims without
 * evidence, and refuses patches that target unsafe files. This is deliberately
 * mechanical: it proves a quote exists, not that an interpretation is correct.
 */
import { locateQuote, normalizeForMatch, parseTranscriptBlocks } from './dream-evidence.js';
import { supportsStatement, contradictsClaim } from './support.js';

const PAGE_RE = /^[\p{L}\p{N}._-]+\.md$/u;
const RESERVED = new Set(['MEMORY.md', 'SKILL.md', '_index.md', '.dream-log.md']);

function text(value) {
  return typeof value === 'string' ? value : '';
}

function oneLine(value, max = 2000) {
  const flat = text(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function safeFile(file) {
  const name = oneLine(file, 200);
  if (!PAGE_RE.test(name) || RESERVED.has(name) || name.includes('..')) return '';
  return name;
}

/**
 * Verify one analyzer result.
 * @param {{analysis:object, transcript:string, sessionId:string, memoryFiles?:Array<{file:string,body:string,type?:string}>,
 *   maxPatches?:number, maxPatchChars?:number}} input
 * @returns {{summary:string, claims:object[], patches:object[], verify:object[], dropped:string[], warnings:string[]}}
 */
export function verifyAnalysis({
  analysis,
  transcript = '',
  sessionId = '',
  memoryFiles = [],
  evidenceBlocks = [],
  maxPatches = 24,
  maxPatchChars = 20_000,
} = {}) {
  const parsed = analysis && typeof analysis === 'object' ? analysis : {};
  const blocks = parseTranscriptBlocks(transcript);
  const locationSeq = (located) => {
    if (!located) return undefined;
    const original = (Array.isArray(evidenceBlocks) ? evidenceBlocks : []).find((block) =>
      block?.tag === located.tag
      && parseTranscriptBlocks(block.text).some((part) => part.text.includes(located.text)));
    return Number.isFinite(Number(original?.seq)) ? Number(original.seq) : undefined;
  };
  const claims = [];
  const dropped = [];
  const warnings = [];
  const knownFiles = new Set(memoryFiles.map((file) => file?.file).filter(Boolean));

  for (const claim of Array.isArray(parsed.claims) ? parsed.claims : []) {
    const statement = oneLine(claim?.text, 2000);
    const quote = oneLine(claim?.quote, 500);
    if (statement === '' || quote === '') {
      dropped.push('claim without text or quote');
      continue;
    }
    const located = locateQuote(quote, blocks);
    if (!located) {
      dropped.push(`claim has no quote in the transcript: ${statement.slice(0, 120)}`);
      continue;
    }
    const target = safeFile(claim?.target);
    if (target !== '' && knownFiles.size > 0 && !knownFiles.has(target)) {
      warnings.push(`claim targets a page not present in this call: ${target}`);
    }
    const seq = locationSeq(located);
    claims.push({
      text: statement,
      quote,
      kind: oneLine(claim?.kind, 32) || 'fact',
      confidence: ['high', 'medium', 'low'].includes(claim?.confidence) ? claim.confidence : 'medium',
      source: located.tag,
      date: located.date,
      ...(Number.isFinite(seq) ? { seq } : {}),
      ...(target !== '' ? { target } : {}),
      ...(sessionId !== '' ? { sessionId } : {}),
    });
  }

  const patches = [];
  for (const patch of Array.isArray(parsed.patches) ? parsed.patches : []) {
    if (patches.length >= maxPatches) {
      dropped.push(`patch limit ${maxPatches} reached`);
      break;
    }
    const file = safeFile(patch?.file);
    if (file === '') {
      dropped.push(`patch has an unsafe file name: ${oneLine(patch?.file, 80) || '(empty)'}`);
      continue;
    }
    const content = text(patch?.content);
    if (content.trim() === '') {
      dropped.push(`patch for ${file} has no content`);
      continue;
    }
    if (content.length > maxPatchChars) {
      dropped.push(`patch for ${file} is ${content.length} chars, limit is ${maxPatchChars}`);
      continue;
    }
    const evidence = Array.isArray(patch?.evidence) ? patch.evidence : [];
    const verifiedEvidence = evidence.map((quote) => oneLine(quote, 500)).filter((quote) => quote !== '' && locateQuote(quote, blocks));
    if (evidence.length > 0 && verifiedEvidence.length === 0) {
      dropped.push(`patch for ${file} has evidence quotes that are not in the transcript`);
      continue;
    }
    patches.push({
      file,
      op: patch?.op === 'replace' ? 'replace' : 'append',
      content: content.replace(/\r\n?/g, '\n').replace(/\n+$/, ''),
      ...(verifiedEvidence.length > 0 ? { evidence: verifiedEvidence } : {}),
      ...(sessionId !== '' ? { sessionId } : {}),
    });
  }

  const verify = [];
  for (const item of Array.isArray(parsed.verify) ? parsed.verify : []) {
    const file = safeFile(item?.file);
    const claim = oneLine(item?.claim, 1000);
    const result = item?.result;
    if (file === '' || claim === '' || !['holds', 'contradicts', 'unknown'].includes(result)) continue;
    const quote = oneLine(item?.quote, 500);
    const located = quote === '' ? null : locateQuote(quote, blocks);
    // A verdict is evidence only when its quote was actually found AND that
    // quote backs the verdict itself: `holds` needs the quote to state the current
    // fact, `contradicts` needs it to state the same fact with a different value.
    // A real quote about something else says nothing about this fact.
    const backed = located !== null && (result === 'contradicts'
      ? contradictsClaim(claim, quote)
      : supportsStatement(claim, quote, { minRatio: 0.5, minMatched: 2 }));
    const effective = result !== 'unknown' && !backed ? 'unknown' : result;
    if (result === 'contradicts' && !located) warnings.push(`contradiction for ${file} has no transcript quote; downgraded to unknown`);
    if (result === 'holds' && !located) warnings.push(`verification for ${file} has no transcript quote; downgraded to unknown`);
    if (result !== 'unknown' && located && !backed) {
      warnings.push(`verification for ${file} quotes something other than "${oneLine(claim, 80)}"; downgraded to unknown`);
    }
    const seq = locationSeq(located);
    verify.push({
      file,
      claim,
      result: effective,
      ...(located ? { source: located.tag, date: located.date, quote } : {}),
      ...(Number.isFinite(seq) ? { seq } : {}),
    });
  }

  return {
    summary: oneLine(parsed.summary, 2000),
    claims,
    patches,
    verify,
    retire: Array.isArray(parsed.retire) ? parsed.retire : [],
    dropped,
    warnings,
  };
}

/** Does a body contain a statement, ignoring formatting? */
export function bodyHasStatement(body, statement) {
  const needle = normalizeForMatch(statement);
  if (needle.length < 6) return false;
  return normalizeForMatch(body).includes(needle);
}
