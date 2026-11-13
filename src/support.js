/**
 * Does one text support another?
 *
 * Three gates must not trust a model's claim of support:
 *   - `user-evidence.js` binds a `user-explicit` write to what the user actually
 *     sent: a located quote proves provenance, not consent for this sentence;
 *   - `dream-verifier.js` decides whether a transcript quote really backs the
 *     memory claim it is filed against.
 *
 * The judgement is deliberately lexical and deterministic: coverage of the
 * statement's content tokens inside the source text. It is a floor, not a
 * semantic matcher. A statement that shares no content token with its source is
 * unsupported, and a source that only repeats a stopword cannot support it.
 *
 * @module dsh-cc-dream-memory/support
 */

/** Words that carry no claim by themselves. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'from', 'into', 'onto', 'than',
  'are', 'was', 'were', 'been', 'being', 'has', 'have', 'had', 'does', 'did', 'not', 'but',
  'you', 'your', 'yours', 'our', 'ours', 'its', 'his', 'her', 'hers', 'they', 'them', 'their',
  'will', 'would', 'can', 'could', 'should', 'must', 'may', 'might', 'shall', 'about', 'after',
  'before', 'when', 'where', 'which', 'what', 'who', 'whom', 'whose', 'how', 'why', 'all',
  'any', 'one', 'two', 'also', 'then', 'there', 'here', 'only', 'just', 'very', 'more', 'most',
  'some', 'such', 'each', 'other', 'over', 'under', 'out', 'off', 'per', 'via', 'use', 'used',
  'using', 'is', 'it', 'in', 'on', 'of', 'to', 'a', 'an', 'as', 'at', 'by', 'be', 'do', 'if',
  'so', 'or', 'no', 'yes', 'we', 'me', 'my', 'i',
]);

/** Content tokens: ASCII words (>=2 chars) plus CJK characters. */
export function supportTokens(value) {
  const text = String(value ?? '').toLowerCase();
  const tokens = new Set();
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_+#.-]*/g)) {
    const word = match[0].replace(/[.-]+$/u, '');
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    // Light plural folding: "tests" and "test" are the same fact fragment.
    tokens.add(/^[a-z]{4,}s$/u.test(word) ? word.slice(0, -1) : word);
  }
  for (const match of text.matchAll(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)) {
    tokens.add(match[0]);
  }
  return tokens;
}

/**
 * Fraction of the statement's content tokens that appear in the source.
 * @returns {{matched:number, total:number, ratio:number}}
 */
export function supportScore(statement, sourceText) {
  const wanted = supportTokens(statement);
  const available = supportTokens(sourceText);
  let matched = 0;
  for (const token of wanted) if (available.has(token)) matched += 1;
  return { matched, total: wanted.size, ratio: wanted.size === 0 ? 0 : matched / wanted.size };
}

/**
 * True when `sourceText` carries enough of `statement` to be its support.
 *
 * `minMatched` keeps a one-token coincidence from counting, and `minRatio`
 * rejects a source that only mentions part of a longer claim. A statement whose
 * tokens are all present still fails when the source states a different
 * polarity, quantity or condition (see `supportConflict`).
 *
 * @param {string} statement
 * @param {string} sourceText
 * @param {{minRatio?:number, minMatched?:number}} [options]
 */
export function supportsStatement(statement, sourceText, { minRatio = 0.6, minMatched = 2 } = {}) {
  const score = supportScore(statement, sourceText);
  if (score.total === 0) return false;
  if (score.matched < minMatched) return false;
  if (!(score.matched === score.total || score.ratio >= minRatio)) return false;
  return supportConflict(statement, sourceText) === '';
}

/**
 * Polarity words: a statement that flips one of these is not the same fact as
 * its source, however many content tokens the two share.
 */
const NEGATION_RE = /\b(?:never|not|none|cannot|can't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|wouldn't|shouldn't|without|disabled?|disallow(?:ed)?|forbid(?:den)?|prohibit(?:ed)?)\b|[不没无别勿禁非]|禁止|不可|不要/iu;

/** Conditional framing: dropping it turns a rule into an unconditional claim. */

/** Unit spellings that mean the same quantity. */
const UNIT_CANON = new Map([
  ['s', 'second'], ['sec', 'second'], ['secs', 'second'], ['second', 'second'], ['seconds', 'second'],
  ['ms', 'millisecond'], ['msec', 'millisecond'], ['millisecond', 'millisecond'], ['milliseconds', 'millisecond'],
  ['min', 'minute'], ['mins', 'minute'], ['minute', 'minute'], ['minutes', 'minute'],
  ['h', 'hour'], ['hr', 'hour'], ['hrs', 'hour'], ['hour', 'hour'], ['hours', 'hour'],
  ['k', 'kb'], ['kb', 'kb'], ['kilobyte', 'kb'], ['kilobytes', 'kb'],
  ['m', 'mb'], ['mb', 'mb'], ['megabyte', 'mb'], ['megabytes', 'mb'],
  ['g', 'gb'], ['gb', 'gb'], ['gigabyte', 'gb'], ['gigabytes', 'gb'],
  ['%', 'percent'], ['pct', 'percent'], ['percent', 'percent'],
  // CJK unit words: `15 秒` is a quantity with a unit, not a bare number.
  ['秒', 'second'], ['毫秒', 'millisecond'], ['分钟', 'minute'], ['小时', 'hour'],
  ['千字节', 'kb'], ['兆字节', 'mb'], ['字节', 'byte'],
]);

/** Drop citation tokens and dates: they identify a source, not a fact. */
function withoutCitations(value) {
  return String(value ?? '')
    .replace(/\^\[[^\]]*\]/gu, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, ' ');
}

const UNIT_WORDS = new Set([...UNIT_CANON.keys(), ...UNIT_CANON.values()]);

/** Content tokens without unit words or numbers: what the fact is about. */
function contentTokens(value) {
  return [...supportTokens(value)].filter((token) => !UNIT_WORDS.has(token) && !/^\d/u.test(token));
}

/**
 * Which kind of conditional a text states. `only if tests fail` and `unless the
 * tests fail` are logically the same rule, but a swap rewrites the sentence, so
 * the class has to match exactly.
 */
const CONDITION_CLASSES = [
  ['only-if', /\bonly\s+if\b|\bonly\s+when\b|只有|仅当|才(?![能会])/u],
  ['unless', /\bunless\b|除非/u],
  ['when', /\bwhen(?:ever)?\b|当(?![前然])/u],
  ['if', /\bif\b|如果|倘若|若是/u],
  ['provided', /\bprovided(?:\s+that)?\b|\bexcept\b|除了/u],
];

function conditionClass(value) {
  const text = String(value ?? '');
  for (const [name, pattern] of CONDITION_CLASSES) if (pattern.test(text)) return name;
  return '';
}

/** Any conditional framing, in the same spellings `conditionClass` knows. */
const CONDITION_RE = new RegExp(CONDITION_CLASSES.map(([, pattern]) => pattern.source).join('|'), 'iu');

/** A quantity: number, unit alias and the object it modifies. */
const MEASURE_RE = /(\d+(?:[.,]\d+)?)(?:([a-z%]{1,12}|[\u4e00-\u9fff]{1,3})|\s([a-z%]{1,12}|[\u4e00-\u9fff]{1,3}))?/gu;
/** Where one object's description ends and the next begins. */
const OBJECT_BOUNDARY_RE = /[，,；;。、]|\band\b|\bplus\b|和|以及/gu;

/** Unit spellings, or `''` for a bare number. */
function unitOf(raw, allowAlias) {
  if (raw === '') return '';
  const canon = UNIT_CANON.get(raw);
  if (canon) return canon;
  // A CJK suffix only counts when it is a known unit word (`15 秒`), so
  // `15 个测试用例` stays a count of items, not one "个测试用例".
  if (/^[\u4e00-\u9fff]/u.test(raw)) return '';
  return allowAlias ? raw : '';
}

/**
 * Each quantity with the object it belongs to. In `read 15 s, write 15 s` the
 * numbers are identical; only the words before each one say which is which.
 *
 * @returns {Array<{key:string, number:string, unit:string, object:string[]}>}
 */
function measurementsWithObject(value) {
  const text = String(value ?? '');
  const found = [];
  for (const match of text.matchAll(MEASURE_RE)) {
    const number = match[1].replace(/,/gu, '');
    const adjacent = (match[2] ?? '').replace(/[.+]/gu, '');
    const spaced = match[3] ?? '';
    const unit = adjacent !== '' ? unitOf(adjacent, true) : unitOf(spaced, false);
    const before = text.slice(0, match.index);
    let start = 0;
    for (const boundary of before.matchAll(OBJECT_BOUNDARY_RE)) start = boundary.index + boundary[0].length;
    found.push({ key: `${number}|${unit}`, number, unit, object: contentTokens(before.slice(start)).sort() });
  }
  return found;
}

/** Quantity mentions as `value|unit`, so 15 seconds and 90 seconds differ. */
function measurements(value) {
  return [...new Set(measurementsWithObject(value).map((item) => item.key))].sort();
}

/**
 * Why `sourceText` states a different fact than `statement`, or `''`.
 *
 * Token coverage answers "do these texts talk about the same thing?". It cannot
 * tell `15 seconds` from `90 seconds`, `read timeout` from `write timeout`, or
 * `always answer in German` from `never answer in German`, because those pairs
 * share every content token. Automatic writes and published facts need the
 * stronger check: polarity, quantities (with their units *and objects*) and
 * conditional framing must survive from source to statement.
 *
 * @param {string} statement
 * @param {string} sourceText
 * @returns {''|'negation'|'quantity'|'condition'}
 */
export function supportConflict(statement, sourceText) {
  const claim = withoutCitations(statement).toLowerCase();
  const source = withoutCitations(sourceText).toLowerCase();
  if (NEGATION_RE.test(claim) !== NEGATION_RE.test(source)) return 'negation';

  // Count and value first, so `15 seconds` + `90 seconds` fails before the more
  // expensive object pairing.
  const claimMeasures = measurements(claim);
  const sourceMeasures = measurements(source);
  if (claimMeasures.length !== sourceMeasures.length) return 'quantity';
  for (const measure of claimMeasures) if (!sourceMeasures.includes(measure)) return 'quantity';

  // Then pair every quantity with its object: `read timeout 15 s` is not
  // `write timeout 15 s`, even though the number and unit are the same.
  const claimed = measurementsWithObject(claim);
  const available = measurementsWithObject(source);
  for (const item of claimed) {
    // Only a number with a unit is a size with an owner; `FOO=1` is a flag.
    if (item.unit === '') continue;
    const carried = available.some((other) => other.unit === item.unit
      && other.number === item.number
      && item.object.every((token) => other.object.includes(token)));
    if (!carried) return 'quantity';
  }

  // `only if tests fail` is not `only if tests pass`, and a condition that names
  // two approvers cannot lose one: the whole conditional sentence has to survive.
  const claimHasCondition = CONDITION_RE.test(claim);
  const sourceHasCondition = CONDITION_RE.test(source);
  if (claimHasCondition !== sourceHasCondition) return 'condition';
  if (claimHasCondition) {
    if (conditionClass(claim) !== conditionClass(source)) return 'condition';
    const claimTokens = new Set(contentTokens(claim));
    const sourceTokens = new Set(contentTokens(source));
    // A conditional claim cannot silently drop (or add) a requirement:
    // "客户同意时才用 YAML" is broader than "客户和负责人都同意时才用 YAML".
    if (claimTokens.size !== sourceTokens.size) return 'condition';
    for (const token of claimTokens) if (!sourceTokens.has(token)) return 'condition';
  }
  return '';
}

/**
 * True when `quote` states the same fact as `claim` with a different value —
 * what a `contradicts` verdict has to show before the host replaces a fact.
 *
 * The quote must be about the same subject. When the difference is measurable
 * (another quantity, other polarity) that difference is the proof; otherwise the
 * analyzer's verdict is the only signal available, so demand a clear textual
 * difference and strong subject overlap.
 *
 * @param {string} claim the current (wrong) value.
 * @param {string} quote the transcript sentence with the corrected value.
 * @returns {boolean}
 */
export function contradictsClaim(claim, quote) {
  const conflict = supportConflict(claim, quote);
  const claimed = measurementsWithObject(withoutCitations(claim)).filter((item) => item.unit !== '');
  // A corrected value must restate the same quantity for the same object with
  // another number: `write timeout 90 s` says nothing about a read timeout.
  if (claimed.length > 0) {
    if (conflict !== 'quantity' && conflict !== 'negation') return false;
    const quoted = measurementsWithObject(withoutCitations(quote));
    return claimed.every((item) => quoted.some((other) => other.unit === item.unit
      && other.number !== item.number
      && item.object.every((token) => other.object.includes(token))));
  }
  const overlap = subjectOverlap(claim, quote);
  if (conflict === 'quantity' || conflict === 'negation') return overlap >= 0.5;
  if (conflict === 'condition') return false;
  const differs = plainText(claim) !== plainText(quote);
  return differs && overlap >= 0.6;
}

/** Text with whitespace and punctuation removed: what `normalizeForMatch` means. */
function plainText(value) {
  return withoutCitations(value).replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

/** Share of the claim's content tokens the quote mentions. */
function subjectOverlap(claim, quote) {
  const claimTokens = contentTokens(withoutCitations(claim));
  if (claimTokens.length === 0) return 0;
  const quoteTokens = new Set(contentTokens(withoutCitations(quote)));
  return claimTokens.filter((token) => quoteTokens.has(token)).length / claimTokens.length;
}

/** Sentence-ish segments of one fact line: each must be supported on its own. */
export function factSegments(line) {
  return String(line ?? '')
    .replace(/\r?\n/gu, ' ')
    // A decimal point is part of the number: `1.5 seconds` stays one segment.
    .split(/(?<=[。！？；;!?])|(?<=\.)(?!\d)/u)
    .map((part) => part.replace(/^[\s\-*•]+/u, '').trim())
    .filter((part) => part !== '');
}

/**
 * Segments of `statement` that no text in `sources` supports.
 *
 * A line that claims two facts needs both of them: one supported sentence must
 * not license an appended, unsourced one.
 *
 * @param {string} statement
 * @param {string[]} sources
 * @param {{minRatio?:number, minMatched?:number}} [options]
 * @returns {string[]}
 */
export function unsupportedSegments(statement, sources, options = {}) {
  const pool = (Array.isArray(sources) ? sources : []).filter((value) => typeof value === 'string' && value !== '');
  return factSegments(statement).filter((segment) => !pool.some((source) => supportsStatement(segment, source, options)));
}

/** Lines of `content` that are new relative to `previous`, ignoring metadata. */
export function addedContentLines(content, previous = '') {
  const wrapper = /^\s*(?:STATUS|VERIFIED(?:\s+AGAINST)?|USER CONFIRMED|CONFIRMED|Superseded|##\s+history)\b/iu;
  const existing = new Set(String(previous ?? '').split(/\r?\n/).map((line) => line.trim()));
  return String(content ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !wrapper.test(line) && !existing.has(line));
}
