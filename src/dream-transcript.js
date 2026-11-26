import { addAbortListener } from 'node:events';
import { createHash } from 'node:crypto';

export async function untilAborted(promise, signal) {
  if (!signal) return promise;
  let listener;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason));
    })]);
  } finally {
    listener?.[Symbol.dispose]();
  }
}

// An exact match over the entire conversation. A short reply can confirm a
// decision in context, so never drop individual turns with this rule.
const SOCIAL_ONLY = /^(?:hi|hello|hey|good morning|good evening|thanks|thank you|you're welcome|你好|您好|早上好|晚上好|谢谢|多谢|不客气)[\s.!！。]*$/iu;

export function isSocialOnly(bounds, eventText) {
  if (!bounds.dialogue.length || bounds.tools.length) return false;
  for (const event of bounds.all.values()) {
    if (event.type === 'tool/call') return false;
    const content = (event.data?.message ?? event.data)?.content;
    if (Array.isArray(content) && content.some((block) => block?.type !== 'text')) return false;
  }
  return bounds.dialogue.every((event) => SOCIAL_ONLY.test(eventText(event).trim()));
}

export function freezeTranscript(events, through, eventText, isInjected) {
  const all = new Map();
  const hash = createHash('sha256');
  let lastSeq = 0;
  const dialogue = [];
  const tools = [];
  for (const event of events) {
    const { seq, type } = event ?? {};
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > through) continue;
    lastSeq = Math.max(lastSeq, seq);
    all.set(seq, event);
    if (isInjected(event)) continue;
    if (!type || type === 'user/message' || type === 'assistant/message') {
      if (eventText(event)) dialogue.push(event);
    } else if (type === 'tool/result') {
      tools.push(event);
    } else if (type !== 'tool/call') continue;
    hash.update(JSON.stringify(event)).update('\n');
  }
  const required = (dialogue.length ? dialogue : tools.slice(-1)).map(({ seq }) => seq);
  return { lastSeq, required, all, dialogue, tools, fingerprint: hash.digest('hex') };
}
