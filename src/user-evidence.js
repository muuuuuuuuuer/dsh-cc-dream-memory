/**
 * Host-side check for `basis: 'user-explicit'` (v22).
 *
 * The basis is a proposal classification, not proof: a model can claim the user
 * approved anything. So a write that asserts something about the user must name
 * the authorizing message in `evidence`, and the host — not the model — checks
 * that the quote really is a verbatim `[user]` line of this session's
 * transcript. Relay material (`[user-pasted]`) and assistant text never
 * authorize a user claim.
 *
 * When the transcript cannot be read the check fails closed: the write is queued
 * in the existing pending-review flow instead of becoming active memory.
 *
 * @module dsh-cc-dream-memory/user-evidence
 */
import { normalizeForMatch, parseTranscriptBlocks } from './dream-evidence.js';
import { buildSessionTranscript } from './dream-session-text.js';
import { addedContentLines, supportsStatement } from './support.js';

/** Below this a "quote" is a substring of everything and proves nothing. */
const MIN_QUOTE_CHARS = 4;

/**
 * Locate a verbatim quote inside one `[user]` block.
 *
 * @param {string} quote
 * @param {string} transcript tagged transcript (`[user] …` lines)
 * @returns {{tag:string, date:string, text:string}|null}
 */
export function locateUserQuote(quote, transcript) {
  const needle = normalizeForMatch(quote);
  if (needle.length < MIN_QUOTE_CHARS) return null;
  return parseTranscriptBlocks(transcript).find((block) => block.tag === 'user' && block.text.includes(needle)) ?? null;
}

/**
 * Read this session's transcript and check the quoted user message.
 *
 * @param {{ctx?:object, sessionId?:string, quote?:string}} input
 *   `ctx` is the plugin context (`ctx.get('sessionQuery')`).
 * @returns {Promise<{verified:boolean, reason?:string, source?:string}>}
 */
export async function verifyUserEvidence({ ctx, sessionId, quote } = {}) {
  const value = typeof quote === 'string' ? quote.trim() : '';
  if (value === '') {
    return { verified: false, reason: 'user-explicit needs the authorizing message in `evidence` (verbatim user text)' };
  }
  if (normalizeForMatch(value).length < MIN_QUOTE_CHARS) {
    return { verified: false, reason: '`evidence` is too short to identify the user message it quotes' };
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { verified: false, reason: 'no session id: the host cannot check a user quote' };
  }
  const sessionQuery = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
    return { verified: false, reason: 'session transcript unavailable: the host cannot check a user quote' };
  }
  let snapshot;
  try {
    snapshot = await sessionQuery.readSession(sessionId);
  } catch (error) {
    return { verified: false, reason: `session ${sessionId} could not be read: ${error?.message ?? error}` };
  }
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  if (events.length === 0) {
    return { verified: false, reason: `session ${sessionId} has no transcript yet` };
  }
  // `buildSessionTranscript` returns structured blocks; flatten them back into the
  // tagged text form the block parser reads.
  const built = buildSessionTranscript(events);
  const transcript = Array.isArray(built?.blocks) ? built.blocks.map((block) => block.text).join('\n') : '';
  const block = locateUserQuote(value, transcript);
  if (block === null) {
    return { verified: false, reason: `evidence is not a verbatim user message in session ${sessionId}` };
  }
  return { verified: true, reason: '', source: block.date === '' ? 'user' : `user ${block.date}` };
}

/**
 * Host-side binding check: the quoted message must also carry the claim.
 *
 * Locating the quote proves *who* spoke; it does not prove *what* they agreed
 * to. The sentences this write adds must appear in that same user message, so
 * `evidence: "Please continue."` cannot authorize `Always answer in German.`
 * Lines the page already had are not re-litigated — only new content needs a
 * source in the message.
 *
 * @param {{evidence?:string, content?:string, previous?:string}} input
 * @returns {{ok:boolean, unbound:string[]}}
 */
export function bindUserClaim({ evidence, content, previous = '' } = {}) {
  const lines = addedContentLines(content, previous);
  const unbound = lines.filter((line) => !supportsStatement(line, String(evidence ?? ''), { minRatio: 0.5, minMatched: 2 }));
  return { ok: unbound.length === 0, unbound };
}
