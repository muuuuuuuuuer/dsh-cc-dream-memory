import { addAbortListener } from 'node:events';
import { createHash } from 'node:crypto';
import { scanSecrets } from './secrets.js';

const PRIORITY = /纠正|改为|仍用|以后|默认|例外|通过|修好了|\b(?:correction|instead|decided|from now on|except|passed|fixed)\b/iu;
const RESULT = /\b(?:passed|failed|error|timeout|exit code)\b|失败|通过|超时/iu;

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

export function visibleText(text, from = 0, width = 600) {
  let end = Math.min(text.length, from + width);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  const sensitive = scanSecrets(text.slice(Math.max(0, from - 128), end + 128)).matches.length > 0;
  return {
    end,
    text: sensitive ? '[sensitive passage omitted]' : text.slice(from, end),
  };
}

const TASK_PAGE_CHARS = 4_000;
export const OVERVIEW_GROUP_SIZE = 4;
const timestampOf = (time) => Number.isSafeInteger(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : undefined;
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

/** Build model-visible pages on demand for the current task, without exporting a transcript file. */
export function taskSourcePages(candidate, eventText) {
  if (!candidate) return [];
  const pages = [];
  let page = { text: '', fragments: [] };
  let pageDate;
  const add = (event, text) => {
    const date = timestampOf(event.time)?.slice(0, 10);
    const marker = date ? '[Source date ' + date + ' UTC]\n' : '[Source date unknown]\n';
    const heading = `[seq ${event.seq}] ${event.type || 'message'}`;
    const width = TASK_PAGE_CHARS - heading.length - marker.length - 2;
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + width);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      const fragment = text.slice(offset, end);
      const block = heading + '\n' + fragment;
      if (page.text && page.text.length + block.length + (date !== pageDate ? marker.length : 0) + 2 > TASK_PAGE_CHARS) {
        pages.push(page);
        page = { text: '', fragments: [] };
      }
      const dateChanged = !page.text || pageDate !== date;
      page.text += (page.text ? '\n\n' : '') + (dateChanged ? marker : '') + block;
      page.fragments.push({ seq: event.seq, type: event.type, time: event.time, text: fragment });
      pageDate = date;
      offset = end;
    }
  };
  for (const seq of candidate.bounds.required) {
    if (seq <= (candidate.readSeq ?? -1)) continue;
    const event = candidate.bounds.all.get(seq);
    const raw = eventText(event);
    const text = event.type === 'tool/result' ? '[tool result body omitted]'
      : scanSecrets(raw).matches.length > 0 ? '[sensitive passage omitted]' : raw;
    add(event, text);
  }
  if (page.text) pages.push(page);
  return pages;
}

/** Every page gets a disposition. An overview may screen a page only when
 * all user text on it is visible. Long or crowded user input needs detail. */
export function taskSourceOverview(pages) {
  if (pages.length < 3) return [];
  const cardTurns = indexCardTurns(pages);
  const entries = pages.map(({ fragments }, page) => {
    const excerpts = [];
    const progress = new Map();
    let remaining = 520;
    let requiresDetail = false;
    for (const { seq, type, time, text } of fragments) {
      if (!text.trim()) continue;
      const assistant = type === 'assistant/message';
      const compact = text.replace(/\s+/gu, ' ').trim();
      const turn = cardTurns.get(seq);
      if (turn) {
        // Keep each instruction visible, including exceptions without keywords.
        // Receipts can be screened by card; the latest outcome remains visible.
        const role = !assistant ? (seq === turn.first ? 'first request' : 'follow-up')
          : seq === turn.latest ? 'latest reply' : turn.receipts.has(seq) ? 'earlier reply' : 'progress';
        const width = assistant ? 160 : 950;
        const sample = compact.length > width ? compact.slice(0, width - 50) + '…' + compact.slice(-50) : compact;
        if (!assistant && compact.length > width) requiresDetail = true;
        // A changed decision inside an earlier report can outlive its status.
        const rulings = assistant ? text.split(/[\n。！？]+/u).filter((line) =>
          /纠正|裁定|改为|例外|取代|以后|默认|不再|supersed|correction|exception|\b(?:decided|ruling|decision|instead|from now on|default)\b/iu.test(line)).map((line) => line.trim()).join(' / ') : '';
        if (rulings.length > 650) requiresDetail = true;
        const routine = /^(?:let me\b|now (?:I|let|run|check)\b|(?:running|checking|reading|implementing|verifying|rerunning)\b|(?:red|green)\b|先(?:读|查|跑)|接下来(?:运行|检查)|正在(?:运行|检查)|\[sensitive passage omitted\])/iu.test(compact);
        if (role === 'progress' && !rulings) {
          const range = progress.get(turn.card) ?? { card: turn.card, role, firstSeq: seq, lastSeq: seq, count: 0 };
          range.lastSeq = seq;
          range.count++;
          if (!routine || compact.length > 350) {
            (range.updates ??= []).push([seq, compact.length <= 96 ? compact : compact.slice(0, 70) + '…' + compact.slice(-25)]);
          }
          progress.set(turn.card, range);
        } else {
          excerpts.push({ seq, role, card: turn.card, time: timestampOf(time), text: sample,
            ...(rulings && !sample.includes(rulings) ? { rulings: rulings.slice(0, 650) } : {}) });
        }
        continue;
      }
      const width = Math.min(remaining, assistant ? 112 : 320);
      if (!width || (!assistant && compact.length > width)) requiresDetail = true;
      if (width > 0) {
        const tail = Math.floor(width / 3);
        const sample = compact.length <= width ? compact
          : compact.slice(0, width - tail) + '…' + (tail ? compact.slice(-tail) : '');
        if (assistant && compact.length > width) {
          const omitted = compact.slice(width - tail, compact.length - tail);
          if (PRIORITY.test(omitted) || RESULT.test(omitted)) requiresDetail = true;
        }
        excerpts.push({ seq, role: type || 'message', time: timestampOf(time), text: sample });
        remaining = Math.max(0, remaining - sample.length - 50);
      }
    }
    const rows = [...excerpts, ...progress.values()];
    // The model must fetch these pages anyway. Keep just enough to locate
    // them and avoid sending the same long instructions twice.
    if (requiresDetail || JSON.stringify(rows).length > 5_500) {
      return { page, requiresDetail: true, excerpts: rows.filter((row) => row.role !== 'progress').slice(0, 12)
        .map(({ seq, role, card, time, text }) => ({ seq, role, card, time, text: text?.slice(0, 65) })) };
    }
    return { page, requiresDetail, excerpts: rows };
  });
  // Even perfect screening cannot save a fetch when the overview costs at
  // least as many calls as all the pages it could replace.
  const eligible = entries.filter((entry) => !entry.requiresDetail);
  let groups = 0;
  for (let page = 0; page < entries.length; groups++) page += overviewGroup(entries, page).length;
  if (eligible.length <= groups) return [];
  const possibleSaving = eligible.reduce((chars, entry) => chars + pages[entry.page].text.length, 0);
  return possibleSaving > JSON.stringify(entries).length ? entries : [];
}

/** Keep each tool response below the host handoff size even on dense card pages. */
export function overviewGroup(entries, page) {
  const group = [];
  let chars = 0;
  for (const entry of entries.slice(page, page + OVERVIEW_GROUP_SIZE)) {
    const size = JSON.stringify(entry).length + 1;
    if (group.length && chars + size > 7_000) break;
    group.push(entry);
    chars += size;
  }
  return group;
}

/** Associate replies with the card actually assigned in the preceding request.
 * A later reference to another card (often "do not start T02") is not an assignment. */
function indexCardTurns(pages) {
  const turns = new Map();
  const cards = new Map();
  let current;
  let previous;
  for (const { fragments } of pages) {
    for (const { seq, type, text } of fragments) {
      if (seq === previous || !text.trim()) continue;
      previous = seq;
      if (type !== 'assistant/message') {
        if (current?.latest != null) current.receipts.add(current.latest);
        const assignment = /(?:^|[\n。；;：:！.!?])\s*(?:本轮|本次|请|please\s+)?\s*(?:只执行|只做|只补(?:修|完)?|继续(?:补修)?|执行|implement|work on|continue|execute)\s*(?:(?:[^\s，。；]{1,160}[\\/])?tasks[\\/])?(T\d+)\b/iu.exec(text);
        const card = assignment?.[1].toUpperCase();
        if (card) {
          if (!cards.has(card)) cards.set(card, { card, first: seq, latest: null, receipts: new Set() });
          current = cards.get(card);
        } else if (!(current && /^(?:只补(?:完|修)?|继续补修)\s*R\d/iu.test(text.trim()))) {
          current = undefined;
        }
        if (current) current.latest = null;
      } else if (current) current.latest = seq;
      if (current) turns.set(seq, current);
    }
  }
  return cards.size >= 2 ? turns : new Map();
}

export function freezeTranscript(events, through, eventText, isInjected) {
  const all = new Map();
  const hash = createHash('sha256');
  const names = new Map();
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
    } else if (type === 'tool/call') {
      const id = event.data?.callId ?? event.data?.id ?? event.data?.call?.id;
      const name = event.data?.toolName ?? event.data?.name ?? event.data?.call?.name;
      if (typeof id === 'string' && typeof name === 'string') names.set(id, name);
    } else continue;
    hash.update(JSON.stringify(event)).update('\n');
  }
  const required = (dialogue.length ? dialogue : tools.slice(-1)).map(({ seq }) => seq);
  return { lastSeq, required, all, dialogue, tools, names, fingerprint: hash.digest('hex') };
}

function toolLabel(event, names) {
  const data = event.data ?? {};
  const message = data.message ?? data;
  const name = names.get(message.source?.callId) ?? data.toolName ?? data.name ?? message.toolName;
  return typeof name === 'string' && /^[a-z0-9_.-]{1,80}$/iu.test(name) ? name : 'tool';
}

export function transcriptOverview(candidate, through, focus, eventText, markRead) {
  const { id, bounds } = candidate;
  if (!bounds?.all) return '';
  let remaining = 1_150;
  const lines = [];
  const pending = bounds.dialogue.filter(({ seq }) => seq > through);
  // Leave space for a late correction even when the first message is long.
  for (const [index, event] of pending.slice(0, 3).entries()) {
    if (remaining < 150) break;
    const raw = eventText(event);
    const { end, text } = visibleText(raw, 0, Math.min(500, remaining));
    lines.push(`[${event.seq}] ${event.type}: ${text}` + (end < raw.length ? ` [read next offset ${end}]` : ''));
    remaining -= text.length + 50;
    markRead(id, event.seq, { from: 0, end, length: raw.length });
    if (index === 0 && end < raw.length) break;
  }
  const focusTerms = focus.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)?.slice(0, 12) ?? [];
  let best;
  let bestScore = 0;
  for (const event of (focusTerms.length ? bounds.dialogue : pending).slice(-120)) {
    if (lines.some((line) => line.startsWith(`[${event.seq}]`))) continue;
    const sample = eventText(event).slice(0, 1_200);
    const lower = sample.toLowerCase();
    const score = focusTerms.filter((term) => lower.includes(term)).length * 3 + (PRIORITY.test(sample) ? 1 : 0);
    if (score >= bestScore && score > 0) {
      best = event;
      bestScore = score;
    }
  }
  if (best) {
    const previous = bounds.dialogue.indexOf(best) - 1;
    for (const event of [bounds.dialogue[previous], best]) {
      if (!event || lines.some((line) => line.startsWith(`[${event.seq}]`))) continue;
      const raw = eventText(event);
      const { end, text } = visibleText(raw, 0, event === best ? 420 : 220);
      lines.push(`[${event.seq}] ${event.type}: ${text}` + (end < raw.length ? ` [read next offset ${end}]` : ''));
      markRead(id, event.seq, { from: 0, end, length: raw.length });
    }
  }
  const results = bounds.tools.filter(({ seq }) => seq > through);
  if (results.length) {
    lines.push(`${results.length} tool results, seq ${results[0].seq}–${results.at(-1).seq}. Search by literal or read the relevant seq for exact evidence.`);
    for (const event of [...new Set([results[0], results.at(-1)])]) {
      const data = event.data ?? {};
      const code = data.exitCode ?? data.result?.exitCode ?? data.meta?.exitCode;
      const failed = data.message?.isError === true || Boolean(data.error);
      const raw = eventText(event);
      const sample = raw.slice(-350);
      const outcome = sample.split(/\r?\n/u).findLast((line) => RESULT.test(line));
      lines.push(`[${event.seq}] ${toolLabel(event, bounds.names)}${Number.isInteger(code) ? ` exit ${code}` : failed ? ' error' : ''}`
        + (outcome ? ' — ' + visibleText(outcome, 0, 100).text : ' — outcome unknown'));
    }
    if (!bounds.dialogue.length) markRead(id, results.at(-1).seq);
  }
  return lines.length ? `Session ${id}\n${lines.join('\n')}` : '';
}

export function searchTranscript(bounds, query, limit, eventText) {
  const escaped = query.slice(0, 160).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'iu');
  const lines = [];
  let remaining = 8_000_000;
  for (const events of [bounds.dialogue, bounds.tools]) {
    for (let index = events.length - 1; index >= 0 && remaining > 0 && lines.length < limit; index -= 1) {
      const event = events[index];
      const text = eventText(event);
      const width = Math.min(remaining, 256_000, text.length);
      const head = text.length > width ? Math.min(32_000, Math.floor(width / 4)) : 0;
      const tailStart = text.length - width + head;
      remaining -= width;
      const tail = pattern.exec(text.slice(tailStart));
      const prefix = !tail && head ? pattern.exec(text.slice(0, head)) : null;
      if (tail || prefix) {
        const offset = Math.max(0, (tail ? tailStart + tail.index : prefix.index) - 65);
        lines.push(`- seq ${event.seq}, offset ${offset}: ${visibleText(text, offset, 250).text}`);
      }
    }
  }
  return lines.join('\n') || 'No matches in the bounded local scan. Read a specific seq/offset to inspect longer results.';
}
