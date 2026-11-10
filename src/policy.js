/** Write-policy layer: decide whether one candidate memory should be written,
 * merged into an existing file, surfaced as a suggestion, or queued for review.
 *
 * The policy is deterministic and dependency-free:
 * - similarity = weighted name/description/body text similarity, where text is
 *   tokenized into CJK bigrams and latin words (Dice coefficient);
 * - duplicate is a hard block at `policyDuplicateThreshold`;
 * - possible-duplicate is **advisory** (v11): the write proceeds and the caller
 *   reports the near-duplicate candidates;
 * - conflict is **advisory** in this evaluator; model-originated tools use
 *   write-review to queue same-topic, opposite-polarity clauses for review;
 * - low-confidence is only an explicit `confidence:'low'` or
 *   `writeMode:'confirm'` (v11 removed the short-body / invalid-type heuristics
 *   so ordinary preference notes are never queued).
 *
 * `evaluateWrite` never writes anything; callers (the tools) act on the action.
 *
 * @module dsh-cc-dream-memory/policy
 */

/** Default similarity thresholds (also the config defaults). */
export const POLICY_DEFAULTS = Object.freeze({ duplicateThreshold: 0.82, suggestThreshold: 0.55 });

/** Per-field weights for candidate-vs-entry similarity. */
const FIELD_WEIGHTS = Object.freeze({ name: 0.45, description: 0.25, body: 0.3 });

/** Positive-polarity phrases (Chinese + English). */
const POSITIVE_PATTERNS = Object.freeze([
  '喜欢',
  '偏好',
  '偏爱',
  '使用',
  '采用',
  '应该',
  '需要',
  '总是',
  '一直',
  '开启',
  '启用',
  '允许',
  '支持',
  'prefer',
  'like',
  'use',
  'uses',
  'using',
  'should',
  'always',
  'enable',
  'enabled',
  'allow',
  'want',
  'need',
  'keep',
]);

/** Negative-polarity phrases, matched before positives (longest first). */
const NEGATIVE_PATTERNS = Object.freeze([
  '不喜欢',
  '不想要',
  '不需要',
  '不应该',
  '不支持',
  '不允许',
  '不用',
  '不要',
  '别用',
  '不再',
  '从不',
  '绝不',
  '避免',
  '讨厌',
  '禁止',
  '关闭',
  '禁用',
  '反对',
  "don't",
  'do not',
  "doesn't",
  'does not',
  'avoid',
  'dislike',
  'hate',
  'never',
  'disable',
  'disabled',
  'no longer',
  'should not',
  "shouldn't",
  'stop using',
]);

/** Words ignored when computing topic overlap. */
const STOPWORDS = new Set([
  'the',
  'and',
  'or',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'user',
  'users',
  'memory',
  'memories',
  'note',
  'notes',
  'should',
  'always',
  'never',
  'prefer',
  'like',
  'use',
  'using',
  'avoid',
  'want',
  'need',
]);

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;
const LATIN_WORD = /[a-z0-9_]+/g;
// Keep command/file identifiers intact: legacy-deploy.sh and release-staging
// must not become the same subject merely because both contain "deploy".
const LATIN_ENTITY = /[a-z0-9_]+(?:[.-][a-z0-9_]+)*/g;

function phrasePattern(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(/^[a-z]/i.test(phrase) ? `\\b${escaped}\\b` : escaped, 'g');
}

const NEGATIVE_REGEXPS = NEGATIVE_PATTERNS.map(phrasePattern);
const POSITIVE_REGEXPS = POSITIVE_PATTERNS.map(phrasePattern);

function clausesOf(text) {
  // A period inside a filename is not a sentence boundary.
  return String(text ?? '').toLowerCase().split(/[\n。！？!?；;，,]+|\.(?=\s|$)/u).filter((clause) => clause.trim() !== '');
}

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number < 0) return 0;
  if (number > 1) return 1;
  return number;
}

/** Stable 3-decimal rounding used in policy results. */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/** Coerce a candidate object into the policy's plain shape. */
function normalizeCandidate(candidate) {
  const value = candidate && typeof candidate === 'object' ? candidate : {};
  const body =
    typeof value.body === 'string'
      ? value.body
      : typeof value.content === 'string'
        ? value.content
        : '';
  return {
    name: typeof value.name === 'string' ? value.name : '',
    type: typeof value.type === 'string' ? value.type : '',
    description: typeof value.description === 'string' ? value.description : '',
    content: body,
    confidence: value.confidence === 'low' ? 'low' : 'high',
    scope: value.scope === 'user' ? 'user' : 'project',
  };
}

/** The full searchable text of a candidate or entry. */
function fullText(value) {
  const item = value && typeof value === 'object' ? value : {};
  const body =
    typeof item.body === 'string' ? item.body : typeof item.content === 'string' ? item.content : '';
  return [item.name, item.description, body].filter((part) => typeof part === 'string').join('\n');
}

/**
 * Tokenize one text into CJK bigrams and lowercased latin words.
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  const value = String(text ?? '').toLowerCase();
  const tokens = new Set();
  for (const word of value.match(LATIN_WORD) ?? []) {
    if (word.length >= 2) tokens.add(`w:${word}`);
  }
  for (const run of value.match(CJK_RUN) ?? []) {
    const chars = Array.from(run);
    // Unigrams keep short related CJK sentences comparable; bigrams keep the
    // score from over-rewarding accidental single-character matches.
    for (const char of chars) tokens.add(`u:${char}`);
    for (let index = 0; index < chars.length - 1; index += 1) {
      tokens.add(`c:${chars[index]}${chars[index + 1]}`);
    }
  }
  return tokens;
}

/**
 * Dice similarity between two texts (0..1) using CJK bigrams + latin words.
 * Identical texts score 1; two empty texts score 1; one empty scores 0.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function textSimilarity(a, b) {
  const left = tokenize(a);
  const right = tokenize(b);
  const leftEmpty = left.size === 0;
  const rightEmpty = right.size === 0;
  if (leftEmpty && rightEmpty) return 0;
  if (leftEmpty || rightEmpty) return 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  let shared = 0;
  for (const token of smaller) if (larger.has(token)) shared += 1;
  return Math.min(1, (2 * shared) / (left.size + right.size));
}

/**
 * Weighted candidate-vs-entry similarity (name 0.45, description 0.25,
 * body 0.30; fields missing on either side are skipped and the weights
 * renormalized).
 * @param {object} candidate
 * @param {object} entry
 * @returns {number}
 */
export function entrySimilarity(candidate, entry) {
  const left = normalizeCandidate(candidate);
  const right = normalizeCandidate(entry);
  let weighted = 0;
  let total = 0;
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const a = String(left[field] ?? '').trim();
    const b = String(right[field] ?? '').trim();
    if (a === '' || b === '') continue;
    weighted += textSimilarity(a, b) * weight;
    total += weight;
  }
  return total === 0 ? 0 : weighted / total;
}

/** Remove polarity words from a text before extracting topic entities. */
function maskPolarity(text) {
  let masked = String(text ?? '').toLowerCase();
  for (const pattern of [...NEGATIVE_REGEXPS, ...POSITIVE_REGEXPS]) masked = masked.replace(pattern, ' ');
  return masked;
}

/** Topic entities: latin words/identifiers (>=4 chars, no stopwords) + CJK bigrams. */
function entityTokens(text) {
  const value = maskPolarity(text);
  const tokens = new Set();
  for (const word of value.match(LATIN_ENTITY) ?? []) {
    if (word.length >= 4 && !STOPWORDS.has(word)) tokens.add(`w:${word}`);
  }
  for (const run of value.match(CJK_RUN) ?? []) {
    const chars = Array.from(run);
    if (chars.length === 1) tokens.add(`c:${chars[0]}`);
    else for (let index = 0; index < chars.length - 1; index += 1) tokens.add(`c:${chars[index]}${chars[index + 1]}`);
  }
  return tokens;
}

/**
 * Polarity within one clause; negation governs only this clause.
 * @param {unknown} text
 * @returns {'positive'|'negative'|null}
 */
function clausePolarity(text) {
  let value = String(text ?? '').toLowerCase();
  let negative = false;
  for (const pattern of NEGATIVE_REGEXPS) {
    if (value.search(pattern) !== -1) {
      negative = true;
      value = value.replace(pattern, ' ');
    }
  }
  // Negation governs its own clause, never a separate positive statement.
  if (negative) return 'negative';
  for (const pattern of POSITIVE_REGEXPS) if (value.search(pattern) !== -1) return 'positive';
  return null;
}

/** Overall polarity, or null when there are no signals or clauses disagree. */
export function polarityOf(text) {
  const polarities = new Set(clausesOf(text).map(clausePolarity).filter(Boolean));
  return polarities.size === 1 ? [...polarities][0] : null;
}

function topicClauses(text) {
  return clausesOf(text).map((clause) => ({ polarity: clausePolarity(clause), entities: entityTokens(clause) }))
    .filter((clause) => clause.polarity !== null && clause.entities.size > 0);
}

/** Topic overlap in [0,1]; containment-normalized so a short option still matches. */
function entityOverlap(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  let shared = 0;
  for (const token of smaller) if (larger.has(token)) shared += 1;
  if (shared === 0) return 0;
  return shared / Math.min(left.size, right.size);
}

/**
 * Detect a same-topic, opposite-polarity conflict.
 * @param {object} candidate `{name, type, description, content|body}`
 * @param {object[]} entries existing entries (`{file, name, description, body?}`)
 * @returns {{existingFile:string, reason:string}|null}
 */
export function detectConflict(candidate, entries) {
  const normalized = normalizeCandidate(candidate);
  const candidateClauses = topicClauses(fullText(normalized));
  if (candidateClauses.length === 0) return null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string' || entry.file === '') continue;
    const entryClauses = topicClauses(fullText(entry));
    for (const candidateClause of candidateClauses) {
      for (const entryClause of entryClauses) {
        if (candidateClause.polarity === entryClause.polarity) continue;
        if (entityOverlap(candidateClause.entities, entryClause.entities) < 0.5) continue;
        return {
          existingFile: entry.file,
          reason: `opposite polarity about the same topic (candidate is ${candidateClause.polarity}, ${entry.file} is ${entryClause.polarity})`,
        };
      }
    }
  }
  return null;
}

/**
 * Reasons a write is not confident enough to apply automatically (v11).
 * Only two signals queue a write for human review: an explicit
 * `confidence:'low'` and `writeMode:'confirm'`. Ordinary preference notes,
 * short bodies and missing descriptions are written directly — the earlier
 * body-length/type/description heuristics made normal model writes get queued.
 * @param {object} normalized candidate from `normalizeCandidate`
 * @param {object} config resolved plugin config
 * @returns {string[]}
 */
function lowConfidenceReasons(normalized, config) {
  const reasons = [];
  if (config.writeMode === 'confirm') {
    reasons.push('writeMode is confirm: every write needs review');
  }
  if (normalized.confidence === 'low') reasons.push('confidence is low');
  return reasons;
}

/**
 * Evaluate one candidate write against the existing memory (v11 advisory
 * policy).
 *
 * Only a `duplicate` (similarity ≥ duplicateThreshold) blocks the write.
 * `conflict` and `possible-duplicate` are advisory return values. Tool callers
 * use write-review to queue conflicts independently of the duplicate score;
 * possible duplicates may still be written with advisory fields. Low-confidence
 * (`confidence:'low'` or `writeMode:'confirm'`) also requires review.
 *
 * Return shapes:
 * - `{action:'allow'}`
 * - `{action:'duplicate', existingFile, similarity, advisory:false}`
 * - `{action:'conflict', advisory:true, existingFile, reason,
 *    conflicts:[{file,reason}], candidates:[{file,similarity,name,description}],
 *    similarity}`
 * - `{action:'possible-duplicate', advisory:true,
 *    candidates:[{file,similarity,name,description}], conflicts:[],
 *    similarity}`
 * - `{action:'low-confidence', reasons}`
 *
 * @param {{candidate:object, entries?:object[], config?:object}} input
 * @returns {object}
 */
export function evaluateWrite(input = {}) {
  const config = input.config && typeof input.config === 'object' ? input.config : {};
  const duplicateThreshold = clamp01(config.policyDuplicateThreshold, POLICY_DEFAULTS.duplicateThreshold);
  const suggestThreshold = clamp01(config.policySuggestThreshold, POLICY_DEFAULTS.suggestThreshold);
  const candidate = normalizeCandidate(input.candidate);
  const entries = (Array.isArray(input.entries) ? input.entries : []).filter(
    (entry) => entry && typeof entry === 'object' && typeof entry.file === 'string' && entry.file !== '',
  );

  // Low confidence queues the write instead of advising on it. v12 Bug 2:
  // `writeMode:'confirm'` must win over every other outcome — even an exact
  // duplicate is queued (and force cannot bypass it), never silently blocked.
  const lowReasons = lowConfidenceReasons(candidate, config);
  if (lowReasons.length > 0) return { action: 'low-confidence', reasons: lowReasons };

  // Hard block: an almost identical memory already exists.
  const scored = entries
    .map((entry) => ({ entry, similarity: entrySimilarity(candidate, entry) }))
    .sort((left, right) => right.similarity - left.similarity || left.entry.file.localeCompare(right.entry.file));
  const best = scored[0];
  if (best && best.similarity >= duplicateThreshold) {
    return {
      action: 'duplicate',
      advisory: false,
      existingFile: best.entry.file,
      similarity: round3(best.similarity),
    };
  }

  // v11 advisory layer: report every same-topic contradictory entry and the
  // near-duplicate candidates, then let the caller write anyway.
  const conflicts = [];
  for (const entry of entries) {
    const conflict = detectConflict(candidate, [entry]);
    if (conflict !== null) {
      conflicts.push({ file: conflict.existingFile, reason: conflict.reason });
      if (conflicts.length >= 3) break;
    }
  }
  const candidates = scored
    .filter((item) => item.similarity >= suggestThreshold)
    .slice(0, 3)
    .map((item) => ({
      file: item.entry.file,
      similarity: round3(item.similarity),
      name: typeof item.entry.name === 'string' ? item.entry.name : '',
      description: typeof item.entry.description === 'string' ? item.entry.description : '',
    }));

  if (conflicts.length > 0 || candidates.length > 0) {
    const primary = conflicts[0] ?? null;
    return {
      action: primary === null ? 'possible-duplicate' : 'conflict',
      advisory: true,
      conflicts,
      candidates,
      // Backward-compatible single-target fields for older callers/UI.
      ...(primary === null
        ? {}
        : { existingFile: primary.file, reason: primary.reason }),
      similarity: candidates.length > 0 ? candidates[0].similarity : undefined,
    };
  }

  return { action: 'allow', advisory: false };
}
