/**
 * Host-side verification for one analyzer result.
 *
 * The model proposes; the host checks every quote against the transcript it
 * actually read, annotates the true source tag and date, and drops claims
 * without evidence. Check verdicts are accepted only for lines that exist on the
 * page and claims that passed this check. This is deliberately mechanical: it
 * proves a quote and a line exist, not that an interpretation is correct.
 */
import { locateQuote, normalizeForMatch, parseTranscriptBlocks } from './dream-evidence.js';
import { supportsStatement } from './support.js';

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
 * Verify one map result.
 * @param {{analysis:object, transcript:string, sessionId:string, memoryFiles?:Array<{file:string}>, evidenceBlocks?:object[]}} input
 * @returns {{summary:string, claims:object[], retire:object[], dropped:string[], warnings:string[]}}
 */
export function verifyAnalysis({
  analysis,
  transcript = '',
  sessionId = '',
  memoryFiles = [],
  evidenceBlocks = [],
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

  return {
    summary: oneLine(parsed.summary, 2000),
    claims,
    retire: Array.isArray(parsed.retire) ? parsed.retire : [],
    dropped,
    warnings,
  };
}

/**
 * Turn check verdicts into verify items the merge understands. A verdict counts
 * only when its claim is one the host verified in this run and its line is
 * really on that page; the claim's quote and location become the evidence.
 * `holds` additionally needs the quote to state the line's fact, because it
 * vouches for the page. `contradicts` is a proposal the human reviews (the old
 * value stays in the page history), so the line and claim existing is enough.
 * @param {{verdicts:Array<{file:string,line:string,claim:string,result:string}>,
 *   pages:Array<{file:string,body:string}>, claims:Map<string,object>}} input
 * @returns {{verify:Array<object>, warnings:string[]}}
 */
export function verifyCheck({ verdicts = [], pages = [], claims = new Map() } = {}) {
  const bodies = new Map(pages.map((page) => [page.file, normalizeForMatch(page.body)]));
  const verify = [];
  const warnings = [];
  for (const verdict of verdicts) {
    const claim = claims.get(verdict.claim);
    const body = bodies.get(verdict.file);
    if (!claim || body === undefined) {
      warnings.push(`check verdict names an unknown claim or page: ${verdict.claim} / ${verdict.file}`);
      continue;
    }
    const line = oneLine(verdict.line, 1000).replace(/^[-*]\s+/u, '').replace(/\s*\^\[[^\]]*\]\s*$/u, '');
    if (normalizeForMatch(line).length < 4 || !body.includes(normalizeForMatch(line))) {
      warnings.push(`check verdict quotes a line that is not on ${verdict.file}`);
      continue;
    }
    if (verdict.result === 'holds' && !supportsStatement(line, claim.quote, { minRatio: 0.5, minMatched: 2 })) {
      warnings.push(`${verdict.file}: "${oneLine(line, 80)}" is not stated by the quote; not counted as confirmed`);
      continue;
    }
    verify.push({
      file: verdict.file,
      claim: line,
      result: verdict.result,
      quote: claim.quote,
      source: claim.source,
      date: claim.date,
      sessionId: claim.sessionId,
      ...(Number.isFinite(claim.seq) ? { seq: claim.seq } : {}),
    });
  }
  return { verify, warnings };
}

/** Does a body contain a statement, ignoring formatting? */
export function bodyHasStatement(body, statement) {
  const needle = normalizeForMatch(statement);
  if (needle.length < 6) return false;
  return normalizeForMatch(body).includes(needle);
}
