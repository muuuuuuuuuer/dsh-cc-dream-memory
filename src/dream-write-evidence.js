/**
 * Evidence gate for the final Dream write path.
 *
 * The analyzer and the host verifier prove that quotes exist in the transcript.
 * That is not enough by itself: the organizer can write a complete page body and
 * introduce claims the analyzers never verified, or attribute forwarded material
 * to the user. This module checks every line the final plan would add or change:
 *
 * - a new/changed content line must carry an inline citation `^[source#seq, date]`;
 * - the citation's source, locator and date must match a verified claim;
 * - the line must contain that claim's text or quote;
 * - `user`/`feedback` classification and user-attribution wording require a
 *   claim from `[user]` -- never `[user-pasted]`, `[assistant]` or tool output;
 * - page type changes and injected descriptions/names are part of the check;
 * - `STATUS:` is metadata only for its fixed enum; `APPLIES WHEN`, `VERIFY`,
 *   `OBSERVED` and `EXCEPTION` content still needs evidence;
 * - an existing line may be moved without fresh evidence only when its original
 *   attribution is compatible with the destination page type.
 */
import { bodyLineChanges } from './dream-evidence.js';
import { extractCitations } from './wiki-core.js';

const USER_CLASS = new Set(['user', 'feedback']);
const STATUS_VALUES = new Set(['current', 'stale', 'superseded', 'disputed', 'review-needed', 'retired']);
const METADATA_RE = /^(STATUS|APPLIES WHEN|HOW TO VERIFY|VERIFY|OBSERVED|EXCEPTION|VERIFIED|USER CONFIRMED|CONFIRMED):\s*(.*)$/iu;
const STRUCTURAL_RE = [
  /^#{1,6}\s+/u,
  /^\s*$/u,
  /^```/u,
  /^~~~ /u,
  /^---+\s*$/u,
  /^(?:Related|See also):\s*(?:\[\[[^\]]+\]\]\s*)+$/iu,
  /^(?:[-*]\s*)?(?:\[\[[^\]]+\]\]\s*)+$/u,
];
const USER_ATTRIBUTION_RE = /(?:用户|user)\s*(?:明确|explicitly)?\s*(?:要求|希望|偏好|喜欢|不要|禁止|选择|决定|确认|说|asked|wants|prefers|requires|chose|decided|confirmed)/iu;

/** One claim object per verified analyzer claim. */
export function buildEvidence(analyses) {
  const evidence = [];
  const seen = new Set();
  for (const analysis of Array.isArray(analyses) ? analyses : []) {
    const sessionId = typeof analysis?.sessionId === 'string' ? analysis.sessionId : '';
    for (const claim of Array.isArray(analysis?.claims) ? analysis.claims : []) {
      const text = typeof claim?.text === 'string' ? claim.text.trim() : '';
      const quote = typeof claim?.quote === 'string' ? claim.quote.trim() : '';
      if (text === '' || quote === '') continue;
      const source = typeof claim?.source === 'string' ? claim.source : '';
      const key = `${sessionId}\u0000${source}\u0000${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({
        sessionId,
        source,
        text,
        quote,
        date: typeof claim?.date === 'string' ? claim.date : '',
        seq: Number.isFinite(Number(claim?.seq)) ? Number(claim.seq) : undefined,
        kind: typeof claim?.kind === 'string' ? claim.kind : 'fact',
        confidence: typeof claim?.confidence === 'string' ? claim.confidence : 'medium',
      });
    }
  }
  return evidence;
}

function isUserClass(type) {
  return USER_CLASS.has(type);
}

function isStructural(line) {
  const value = String(line ?? '').trim();
  if (value === '') return true;
  if (/^[-*]\s*Superseded:/iu.test(value)) return true;
  // A conflict line is derived: it quotes the page value and the new claim.
  if (/^[-*]\s*CONFLICT:/iu.test(value)) return true;
  const status = /^STATUS:\s*([a-z-]+)\s*$/iu.exec(value);
  if (status !== null) return STATUS_VALUES.has(status[1].toLowerCase());
  return STRUCTURAL_RE.some((pattern) => pattern.test(value));
}

/** Strip a metadata label. STATUS is handled as metadata; the others are content. */
function contentOf(line) {
  const value = String(line ?? '').trim();
  const match = METADATA_RE.exec(value);
  if (match === null) return value;
  const key = match[1].toUpperCase();
  const rest = String(match[2] ?? '').trim();
  if (key === 'STATUS') return STATUS_VALUES.has(rest.toLowerCase()) ? null : value;
  if (['VERIFIED', 'USER CONFIRMED', 'CONFIRMED'].includes(key) && /^\d{4}-\d{2}-\d{2}$/.test(rest)) return null;
  return rest;
}

function sourceOf(citation) {
  return String(citation?.source ?? '').split('#')[0].trim();
}

function claimsForSource(evidence, source) {
  return evidence.filter((claim) => claim.sessionId === source || (claim.sessionId === '' && claim.source === source));
}

function normalizeLight(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function lineMatches(claim, line) {
  const value = normalizeLight(line);
  const text = normalizeLight(claim.text);
  const quote = normalizeLight(claim.quote);
  return (text !== '' && value.includes(text)) || (quote.length >= 6 && value.includes(quote));
}

function citationMatchesClaim(citation, claim) {
  if (!citation || !claim) return false;
  const locator = String(citation.locator ?? '').trim();
  const date = String(citation.date ?? '').trim();
  if (locator === '' || date === '') return false;
  if (!Number.isFinite(Number(claim.seq))) return false;
  if (String(Number(claim.seq)) !== locator) return false;
  return claim.date === date;
}

function assertsUserAttribution(line) {
  return USER_ATTRIBUTION_RE.test(String(line ?? ''));
}

/** Status of a page body; an absent STATUS line means current. */
function statusOf(body) {
  const match = /^\s*STATUS:\s*([a-z-]+)\s*$/imu.exec(String(body ?? ''));
  return match === null ? 'current' : match[1].toLowerCase();
}

/**
 * Check every write operation the final plan would apply.
 * @param {{operations:object[], currentPages?:Array<{file:string,body?:string,type?:string,description?:string,name?:string}>,
 *   evidence:object[], allowExistingLines?:boolean}} input
 * @returns {{operations:object[], dropped:string[], warnings:string[]}}
 */
export function checkWriteOperations({
  operations = [],
  currentPages = [],
  evidence = [],
  allowExistingLines = true,
} = {}) {
  const current = new Map();
  const existingLines = new Map();
  for (const page of Array.isArray(currentPages) ? currentPages : []) {
    if (!page || typeof page.file !== 'string') continue;
    current.set(page.file, page);
    if (typeof page.body !== 'string') continue;
    for (const line of page.body.split(/\r?\n/)) {
      const raw = line.trim();
      if (raw === '' || isStructural(raw)) continue;
      if (!existingLines.has(raw)) existingLines.set(raw, new Set());
      existingLines.get(raw).add(page.type || 'project');
    }
  }
  const currentDescriptions = new Map(
    [...current.values()].map((page) => [page.file, String(page.description ?? '')]),
  );

  const kept = [];
  const dropped = [];
  const warnings = [];

  const userClaimFor = (text) => {
    return evidence.filter((claim) => claim.source === 'user' && lineMatches(claim, text));
  };

  const checkLine = ({ file, line, targetType, typeChanged }) => {
    if (isStructural(line)) return { ok: true, matches: [] };
    const content = contentOf(line);
    if (content === null) return { ok: true, matches: [] }; // valid STATUS enum
    if (content === '') return { ok: true, matches: [] };
    const origins = existingLines.get(String(line ?? '').trim());
    if (origins && allowExistingLines && !typeChanged && origins.has(targetType)) {
      return { ok: true, matches: [] };
    }
    const citations = extractCitations(content);
    if (citations.length === 0) {
      return { ok: false, reason: `${file}: new line has no source citation: "${content.slice(0, 120)}"` };
    }
    const matches = [];
    for (const citation of citations) {
      const source = sourceOf(citation);
      if (source === '') return { ok: false, reason: `${file}: empty citation source in "${content.slice(0, 120)}"` };
      if (String(citation.locator ?? '').trim() === '' || String(citation.date ?? '').trim() === '') {
        return { ok: false, reason: `${file}: citation needs a locator and date: "${content.slice(0, 120)}"` };
      }
      const candidates = claimsForSource(evidence, source).filter((claim) => citationMatchesClaim(citation, claim));
      if (candidates.length === 0) {
        return { ok: false, reason: `${file}: citation ${source}#${citation.locator}, ${citation.date} does not match any verified claim` };
      }
      const isConflict = /^CONFLICT:/iu.test(content) || /^[-*]\s*CONFLICT:/iu.test(content);
      const matched = isConflict ? candidates : candidates.filter((claim) => lineMatches(claim, content));
      if (matched.length === 0) {
        return { ok: false, reason: `${file}: line is not supported by a verified claim from "${source}": "${content.slice(0, 120)}"` };
      }
      matches.push(...matched);
    }
    if (assertsUserAttribution(content) && !matches.some((claim) => claim.source === 'user')) {
      return { ok: false, reason: `${file}: line attributes a requirement to the user without [user] evidence: "${content.slice(0, 120)}"` };
    }
    if (isUserClass(targetType) && !matches.some((claim) => claim.source === 'user')) {
      return { ok: false, reason: `${file}: a user/feedback line has no [user] claim; forwarded material cannot become a user preference` };
    }
    return { ok: true, matches };
  };

  for (const op of Array.isArray(operations) ? operations : []) {
    if (!op || op.op === 'index') {
      let indexBad = false;
      if (op?.op === 'index' && typeof op.content === 'string') {
        for (const raw of op.content.split(/\r?\n/)) {
          const match = /^\s*-\s*\[[^\]]*\]\(([^)]*)\)\s*—\s*(.+)$/u.exec(raw);
          if (match === null) continue;
          const file = match[1].trim();
          const description = match[2].trim();
          if (currentDescriptions.get(file) === description) continue;
          if (assertsUserAttribution(description) && userClaimFor(description).length === 0) {
            dropped.push(`index: description attributes a requirement to the user without [user] evidence: "${description.slice(0, 120)}"`);
            indexBad = true;
          }
        }
      }
      if (!indexBad) kept.push(op);
      continue;
    }
    if (op.op !== 'write' || typeof op.file !== 'string') {
      kept.push(op);
      continue;
    }
    const existing = current.get(op.file);
    const oldBody = typeof existing?.body === 'string' ? existing.body : '';
    const body = typeof op.body === 'string' ? op.body : '';
    const oldType = existing?.type || 'project';
    const targetType = op.type || existing?.type || 'project';
    const typeChanged = existing !== undefined && oldType !== targetType;
    const metadataChanged = existing !== undefined
      && (String(existing.description ?? '') !== String(op.description ?? '')
        || String(existing.name ?? '') !== String(op.name ?? ''));
    if (oldBody === body && !typeChanged && !metadataChanged) {
      kept.push(op);
      continue;
    }

    let reason = '';
    const lines = typeChanged
      ? body.split(/\r?\n/)
      : bodyLineChanges(oldBody, body).addedLines.map((item) => item.text);
    const allMatches = [];
    for (const line of lines) {
      const checked = checkLine({ file: op.file, line, targetType, typeChanged });
      if (!checked.ok) {
        reason = checked.reason;
        break;
      }
      allMatches.push(...checked.matches);
    }
    if (reason === '') {
      // Demoting a page (stale/superseded/disputed/…) is always allowed: it is
      // the conservative move. Promoting one back to current is a claim about
      // today's truth, so it needs at least one line backed by a verified claim.
      if (statusOf(body) === 'current' && statusOf(oldBody) !== 'current' && allMatches.length === 0) {
        reason = `${op.file}: STATUS: current needs a verified claim; a ${statusOf(oldBody)} page cannot be promoted without evidence`;
      }
    }
    if (reason === '') {
      for (const [field, value, previous] of [
        ['description', op.description, existing?.description],
        ['name', op.name, existing?.name],
      ]) {
        const text = String(value ?? '').trim();
        if (text === '' || !assertsUserAttribution(text)) continue;
        if (existing !== undefined && String(previous ?? '') === text) continue;
        if (userClaimFor(text).length === 0) {
          reason = `${op.file}: ${field} attributes a requirement to the user without [user] evidence: "${text.slice(0, 120)}"`;
          break;
        }
      }
    }
    if (reason !== '') {
      dropped.push(reason);
      continue;
    }
    const unique = [];
    const seen = new Set();
    for (const match of allMatches) {
      const key = `${match.sessionId}\u0000${match.source}\u0000${match.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ statement: match.text, quote: match.quote });
    }
    kept.push({ ...op, ...(unique.length > 0 ? { evidence: unique } : {}) });
    if (isUserClass(targetType) && lines.length > 0) {
      warnings.push(`${op.file}: user-class content verified against [user] evidence`);
    }
  }
  return { operations: kept, dropped, warnings };
}

/** True when a plan carries evidence metadata. */
export function hasEvidence(plan) {
  return Array.isArray(plan?.evidence) && plan.evidence.length > 0;
}
