/**
 * Secret scanning for memory content.
 *
 * Memory is injected into future prompts, so a credential accidentally saved
 * once would keep being re-injected. This module is a small, dependency-free
 * detector for the most common credential shapes.
 *
 * v11 severity model (`SECRET_RULES`):
 * - `deny` rules are unambiguous credential formats (OpenAI/Anthropic project
 *   keys, GitHub PAT/OAuth tokens, AWS access keys, Google API keys, JWTs,
 *   password-bearing connection strings, Chinese 密码 labels, private key
 *   blocks, Slack tokens). The write layer refuses a write when one matches.
 * - `warn` rules are generic heuristics (`xxx = ...` assignments, high-entropy
 *   base64 blobs, Bearer headers): they are surfaced as warnings only, so a
 *   false positive never loses a memory.
 *
 * `scanSecrets` returns `{matches, hasDeny, hasWarn}`; each match carries its
 * `severity` and a 12-character `excerpt` (never the full secret). The legacy
 * `{matches}` shape stays valid for callers that only read matches.
 *
 * @module dsh-cc-dream-memory/secrets
 */

/** Characters used by base64 and the entropy check. */
const BASE64_CANDIDATE = /[A-Za-z0-9+/]{40,}={0,2}/g;
/** Shannon entropy (bits per character) above which a long base64 blob is suspicious. */
const ENTROPY_THRESHOLD = 4.2;
/** Characters of a match kept as a non-reversible excerpt. */
export const EXCERPT_CHARS = 12;

/**
 * Ordered secret rules. Each rule reports its first match only: one warning
 * per credential shape is enough and keeps the result small.
 * Format-explicit rules are `deny`; generic heuristics are `warn`.
 * @type {ReadonlyArray<{rule:string, severity:'deny'|'warn', pattern:RegExp}>}
 */
export const SECRET_RULES = Object.freeze([
  // ----- format-explicit credentials: deny -----
  { rule: 'aws-access-key', severity: 'deny', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: 'private-key-block', severity: 'deny', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { rule: 'sk-proj-key', severity: 'deny', pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { rule: 'sk-ant-key', severity: 'deny', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: 'openai-key', severity: 'deny', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { rule: 'github-pat', severity: 'deny', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { rule: 'github-oauth', severity: 'deny', pattern: /\bgho_[A-Za-z0-9]{20,}\b/g },
  { rule: 'github-token', severity: 'deny', pattern: /\bghp_[A-Za-z0-9]{30,}\b/g },
  { rule: 'google-api-key', severity: 'deny', pattern: /\bAIza[0-9A-Za-z_-]{35,}/g },
  { rule: 'jwt-token', severity: 'deny', pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  {
    rule: 'password-connection-string',
    severity: 'deny',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi,
  },
  { rule: 'chinese-password', severity: 'deny', pattern: /密码\s*[:：]\s*[^\s，。；、,.;]+/gu },
  { rule: 'slack-token', severity: 'deny', pattern: /\bxox[bap]-[A-Za-z0-9-]{10,}/g },
  // ----- generic heuristics: warn only -----
  { rule: 'bearer-token', severity: 'warn', pattern: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{10,}/g },
  {
    rule: 'secret-assignment',
    severity: 'warn',
    pattern: /\b(?:api[_-]?key|apikey|password|passwd|secret|token)\s*[:=]\s*["']?\S{8,}/gi,
  },
]);

/** Rule names that are hard refusals (exported for callers/tests). */
export const DENY_RULES = Object.freeze(
  SECRET_RULES.filter((rule) => rule.severity === 'deny').map((rule) => rule.rule),
);

/** First 12 characters of a match, for logs and warnings. */
function excerptOf(match) {
  return String(match).slice(0, EXCERPT_CHARS);
}

/**
 * Shannon entropy per character of a string (bits).
 * @param {string} text
 * @returns {number}
 */
function shannonEntropy(text) {
  if (text.length === 0) return 0;
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/**
 * True for a long base64-looking blob that mixes cases and digits and is
 * random enough to be a credential rather than prose or an identifier.
 * @param {string} candidate
 * @returns {boolean}
 */
function looksLikeHighEntropyBlob(candidate) {
  if (candidate.length < 40) return false;
  if (!/[a-z]/.test(candidate) || !/[A-Z]/.test(candidate)) return false;
  if (!/\d/.test(candidate)) return false;
  return shannonEntropy(candidate) >= ENTROPY_THRESHOLD;
}

/**
 * Scan one text for credential-like content.
 *
 * Matches never expose the full secret: `excerpt` keeps the first
 * {@link EXCERPT_CHARS} characters only.
 *
 * @param {unknown} text
 * @returns {{matches: Array<{rule:string, severity:'deny'|'warn', excerpt:string}>,
 *   hasDeny:boolean, hasWarn:boolean}}
 */
export function scanSecrets(text) {
  const value = typeof text === 'string' ? text : '';
  /** @type {Array<{rule:string, severity:'deny'|'warn', excerpt:string}>} */
  const matches = [];
  if (value === '') return { matches, hasDeny: false, hasWarn: false };

  for (const { rule, severity, pattern } of SECRET_RULES) {
    pattern.lastIndex = 0;
    const found = pattern.exec(value);
    if (found !== null) matches.push({ rule, severity, excerpt: excerptOf(found[0]) });
  }

  BASE64_CANDIDATE.lastIndex = 0;
  let candidate;
  while ((candidate = BASE64_CANDIDATE.exec(value)) !== null) {
    if (looksLikeHighEntropyBlob(candidate[0])) {
      matches.push({ rule: 'high-entropy-base64', severity: 'warn', excerpt: excerptOf(candidate[0]) });
      break;
    }
  }
  const hasDeny = matches.some((match) => match.severity === 'deny');
  const hasWarn = matches.some((match) => match.severity === 'warn');
  return { matches, hasDeny, hasWarn };
}

/**
 * Normalize the configured scan mode.
 *
 * v11 keeps the field for backward compatibility:
 * - `off` disables the scan completely;
 * - `deny` refuses both deny- and warn-severity matches (the strict mode);
 * - `warn` (default) refuses deny-severity matches and only warns about the
 *   generic heuristics. Callers that can only see the mode still get a safe
 *   default; the precise decision belongs to `scanSecrets`'s `hasDeny`.
 * @param {object|null|undefined} config
 * @returns {'warn'|'deny'|'off'}
 */
export function secretScanMode(config) {
  const mode = config && typeof config === 'object' ? config.secretScan : undefined;
  if (mode === 'deny' || mode === 'off') return mode;
  return 'warn';
}

/**
 * Human-readable warning lines for one scan result (never the full secret).
 * Accepts either the legacy matches array or the full `scanSecrets` result.
 * @param {Array<{rule:string, excerpt:string, severity?:string}>|{matches?:Array}} matches
 * @returns {string[]}
 */
export function secretWarnings(matches) {
  const list = Array.isArray(matches)
    ? matches
    : matches && Array.isArray(matches.matches)
      ? matches.matches
      : [];
  return list.map((match) => `secret-scan: rule ${match.rule} near "${match.excerpt}…"`);
}

/**
 * Error code raised when the write layer refuses a write because a
 * deny-severity secret rule matched.
 * @type {string}
 */
export const SECRET_DETECTED = 'SECRET_DETECTED';

/**
 * Decide whether a scan result must block a write.
 *
 * The write layer is not allowed to depend on the config mode alone: a
 * deny-severity credential always blocks, while warn-only heuristics never do
 * (they become warnings).
 * @param {{hasDeny?:boolean, hasWarn?:boolean, matches?:Array}} scan one `scanSecrets` result
 * @param {{secretScan?:string}} [config]
 * @returns {{block:boolean, warn:boolean}}
 */
export function secretScanDecision(scan, config) {
  const mode = secretScanMode(config);
  if (mode === 'off') return { block: false, warn: false };
  const hasDeny = scan?.hasDeny === true;
  const hasWarn = scan?.hasWarn === true;
  if (hasDeny) return { block: true, warn: mode !== 'deny' };
  if (hasWarn && mode === 'deny') return { block: true, warn: false };
  return { block: false, warn: hasWarn };
}
