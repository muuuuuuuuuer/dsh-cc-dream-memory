/**
 * Dream as a host subagent.
 *
 * One standard-preset child runs the batch. Its scoped tools let it read the
 * offered sessions and notes and submit cited changes; the plugin checks and
 * checkpoints each submission.
 */

import { randomUUID } from 'node:crypto';
import { untilAborted } from './dream-transcript.js';

/** The preset every Dream child runs. Only `standard` reviews and rejects out-of-workspace writes. */
export const DREAM_CHILD_PRESET = 'standard';
const RETRY_WAIT_MS = 30_000;
/** How long a child's result may lag behind the end of its turn. */
const RESULT_GRACE_MS = 15_000;
/** How long a cancelled run waits for the host to tear a child down. */
const DISPOSE_WAIT_MS = 5_000;

const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms).unref?.());
const citation = {
  type: 'object',
  properties: {
    session_id: { type: 'string', description: 'The session of a cited event. Use with seq.' },
    seq: { type: 'integer', description: 'The seq shown in dream_read_session or dream_read_event for the cited event.' },
    memory_file: { type: 'string', description: 'A note filename, to cite a note instead of a session event.' },
    quote: { type: 'string', description: 'Text copied verbatim from that event or note. The host checks that it is there and records who said it.' },
  },
  required: ['quote'],
  additionalProperties: false,
};

const submitSchema = {
  type: 'object',
  properties: {
    done: { type: 'boolean', description: 'true ends the run. Call it once, after the last changes.' },
    skipped_sessions: { type: 'array', items: { type: 'string' }, description: 'Offered sessions you screened and found nothing reusable in. They count as reviewed without being read to the end.' },
    changes: {
      type: 'array',
      description: 'Every change needs at least one citation that checks out; citations that do not are dropped and named in the reply. If no citation of some change checks out, no change in the call is applied and the reply says why. A memory_file citation refers to a note as it was before this run.',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          op: { type: 'string', enum: ['write', 'add', 'edit', 'delete'], description: 'write creates a file or replaces a whole page. add inserts a fact into an EXISTING note. edit replaces one passage in an EXISTING note and saves the old passage in history. delete removes a note.' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['project', 'feedback', 'reference', 'user', 'wiki'], description: 'wiki only for files named wiki_<slug>.md.' },
          description: { type: 'string' },
          body: { type: 'string', description: 'Required for add (new fact only), edit (replacement passage), and write (complete page).' },
          old_text: { type: 'string', description: 'For edit, the exact unique passage to replace.' },
          version: { type: 'string', description: 'The version dream_read_note returned, required for add, edit and replacing an existing note.' },
          citations: { type: 'array', items: citation },
          sources: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths or path#symbol (max 10) the note depends on: anchors that say where to look, not a copy of the file. Replaces the sources of the note; leave it out to keep them.' },
          merges: { type: 'array', items: { type: 'string' }, description: 'Notes whose facts this change takes over.' },
          moved_to: { type: 'string', description: 'For delete, the note or wiki page the facts moved into.' },
          retire: { type: 'boolean', description: 'Set true only to hide this whole page from the index and recall with a STATUS: line other than current. To retire a page, prefer delete.' },
        },
        required: ['file', 'op', 'citations'],
        additionalProperties: false,
      },
    },
  },
  required: ['changes', 'done'],
  additionalProperties: false,
};

const finishSchema = {
  type: 'object',
  properties: { finished: { type: 'boolean' } },
  required: ['finished'],
  additionalProperties: false,
};

const textOutput = {
  schema: { type: 'string' },
  render: (_args, text) => [{ type: 'text', text }],
};

// Some host/model combinations deliver an integer field as a decimal string.
// Normalize the read and its delivery receipt identically.
function sessionArgs(args) {
  const integer = (value) => typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) ? Number(value) : value;
  return { ...args, from_seq: integer(args.from_seq), limit: integer(args.limit) };
}

/** Tools for looking across this project's other sessions; mounted only when the host can search. */
function searchTools({ searchSessions, searchEvents, readEvent, eventDelivered }) {
  return [
    {
      name: 'dream_search_sessions',
      description: 'Search all sessions of this project (not only the offered ones) for a topic, command, error or phrase. Returns the sessions that match best, each with its best matching event. Use it to find out whether something recurs across sessions before calling it a one-off. Read what you find with dream_read_event.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 240 },
          since: { type: 'string', description: 'Only sessions created on or after this date (YYYY-MM-DD or ISO timestamp).' },
          until: { type: 'string', description: 'Only sessions created on or before this date (YYYY-MM-DD covers that whole day).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: searchSessions,
    },
    {
      name: 'dream_search_events',
      description: 'Search the events of one session of this project for a phrase. Returns matching events with their seq. Read them with dream_read_event.',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string' }, query: { type: 'string', maxLength: 240 } },
        required: ['session_id', 'query'],
        additionalProperties: false,
      },
      execute: searchEvents,
    },
    {
      name: 'dream_read_event',
      description: 'Read one event of any session of this project with the events around it, shown like dream_read_session. A quote from an event shown here can be cited. Reading it does not review that session: only the offered sessions count as reviewed.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          seq: { type: 'integer', minimum: 0 },
          before: { type: 'integer', minimum: 0, maximum: 20, description: 'Events before it to show. Default 2.' },
          after: { type: 'integer', minimum: 0, maximum: 20, description: 'Events after it to show. Default 4.' },
        },
        required: ['session_id', 'seq'],
        additionalProperties: false,
      },
      execute: readEvent,
      finalizeContent({ arguments: args }, result) {
        const [block] = result.content;
        eventDelivered(args, !result.isError && result.content.length === 1 && block.type === 'text' ? block.text : null);
      },
    },
  ];
}

export function dreamWorkerTools({ readSession, sessionDelivered, readNote, noteDelivered, listNotes, submit, search }) {
  return [
    {
      name: 'dream_read_session',
      description: 'Read one offered session: its messages, tool calls and tool results with their seq numbers, in order. Without from_seq it starts at the first event not yet reviewed (or the beginning, for a session offered only for a lookup). If next_from_seq is not null, call again with it to read on.',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string' }, from_seq: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Most messages in one reply. Default 40.' } },
        required: ['session_id'],
        additionalProperties: false,
      },
      execute: async (args) => readSession(sessionArgs(args)),
      finalizeContent({ arguments: args }, result) {
        if (!result.isError && result.content.length === 1) sessionDelivered(sessionArgs(args), result.content[0].text);
      },
    },
    {
      name: 'dream_list_notes',
      description: 'Find project notes by topic. Read a known filename directly. If empty_catalog is true, stop looking. Otherwise use include_body to widen, omit query to browse, or follow next_offset with the same query.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', maxLength: 240 }, offset: { type: 'integer', minimum: 0 }, include_body: { type: 'boolean' } },
        additionalProperties: false,
      },
      execute: listNotes,
    },
    {
      name: 'dream_read_note',
      description: 'Read a project note. Follow next with the same page version to read the whole note.',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, version: { type: 'string' } },
        required: ['file'],
        additionalProperties: false,
      },
      execute: readNote,
      finalizeContent({ arguments: args }, result) {
        const [block] = result.content;
        noteDelivered(args, !result.isError && result.content.length === 1 && block.type === 'text' ? block.text : null);
      },
    },
    {
      name: 'dream_submit',
      description: 'Propose note changes, each backed by citations, and declare screened sessions. May be called several times. Call with done: true when finished.',
      parameters: submitSchema,
      execute: submit,
    },
    ...(search ? searchTools(search) : []),
  ].map((tool) => ({ ...tool, output: textOutput }));
}

/**
 * Live subagent runs, from the host lifecycle events. Dream's own children are
 * kept apart: they never count as the user's work, and their sessions are
 * confined to the shadow copy as soon as the host creates them.
 */
export class SubagentTracker {
  constructor() {
    /** runId -> child session id, for runs Dream did not start. */
    this.active = new Map();
    /** Child session ids Dream started. */
    this.own = new Set();
    this.workers = new Map();
    this.waiters = new Set();
    /** Child session id -> resolvers waiting for its turn to end. */
    this.turnWaiters = new Map();
  }

  /** Resolve when this child's turn ends (normally, or paused or interrupted from the host). */
  turnEnded(id) {
    return new Promise((resolve) => {
      this.turnWaiters.set(id, [...(this.turnWaiters.get(id) ?? []), resolve]);
    });
  }

  endedTurn(session, event) {
    if (event?.type !== 'turn/end' || !this.own.has(session?.id)) return;
    for (const resolve of this.turnWaiters.get(session.id) ?? []) resolve();
    this.turnWaiters.delete(session.id);
  }

  /** Register the host listeners; returns the disposer. */
  attach(ctx) {
    if (typeof ctx?.on !== 'function') return () => {};
    const offs = [
      ctx.on('subagent/start', (info) => this.started(info)),
      ctx.on('subagent/end', (info) => this.ended(info)),
      ctx.on('agent/created', (payload) => this.confine(payload?.agent)),
      ctx.on('session/event', (session, event) => this.endedTurn(session, event)),
    ];
    return () => {
      for (const off of offs) if (typeof off === 'function') off();
      for (const worker of this.workers.values()) this.release(worker);
      this.wake();
    };
  }

  started(info) {
    const key = String(info?.runId ?? info?.id ?? '');
    if (key === '' || this.own.has(info?.id)) return;
    this.active.set(key, info?.id);
  }

  ended(info) {
    this.active.delete(String(info?.runId ?? info?.id ?? ''));
    this.wake();
  }

  confine(agent) {
    const worker = this.workers.get(agent?.id);
    if (!worker || worker.mounted || worker.error) return;
    try {
      const tools = agent.ctx?.tools;
      if (typeof tools?.restrict !== 'function' || typeof tools.register !== 'function') {
        throw new Error('Dream requires scoped host tools');
      }
      agent.session.append('sandbox/mode', { mode: 'workspace-write' });
      worker.disposers.push(tools.restrict({ allow: [] }));
      for (const definition of worker.tools) worker.disposers.push(tools.register(definition));
      worker.mounted = true;
    } catch (error) {
      worker.error = error;
      this.release(worker);
      throw error;
    }
  }

  release(worker) {
    for (const dispose of worker.disposers.splice(0).reverse()) {
      try { dispose?.(); } catch { /* the host also disposes the child scope */ }
    }
  }

  isOwn(id) {
    return typeof id === 'string' && this.own.has(id);
  }

  /** Whether a subagent the user started is running. */
  busy() {
    return this.active.size > 0;
  }

  wake() {
    for (const resolve of [...this.waiters]) resolve();
  }

  /** Resolve on the next subagent end, after `ms`, or when `signal` aborts. */
  next(signal, ms = RETRY_WAIT_MS) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        this.waiters.delete(done);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  /** Wait until no user subagent is running. */
  async idle(signal) {
    while (this.busy()) await this.next(signal);
  }
}

/**
 * Start one child and wait for its result. At the host's activation limit it
 * waits for a running subagent to end and tries again; admission never queues.
 */
export async function runDreamChild({ subagents, tracker, parent, cwd, prompt, tools, onChildId, agentOptions, signal, graceMs = RESULT_GRACE_MS }) {
  const childId = randomUUID();
  const worker = tools && { tools, disposers: [] };
  tracker.own.add(childId);
  if (worker) tracker.workers.set(childId, worker);
  try {
    onChildId?.(childId);
    const turnEnded = tracker.turnEnded(childId);
    let activation;
    for (;;) {
      signal.throwIfAborted();
      try {
        activation = await subagents.startActivation({
          provider: 'spawn',
          label: 'Dream',
          name: 'dream-' + childId.slice(0, 8),
          delivery: 'caller',
          signal,
          childId,
          parent,
          agentPreset: DREAM_CHILD_PRESET,
          cwd,
          prompt: [{ type: 'text', text: prompt }],
          outputSchema: finishSchema,
          ...(agentOptions ? { agentOptions } : {}),
        });
        break;
      } catch (error) {
        if (error?.code !== 'ACTIVATION_LIMIT_REACHED') throw error;
        await tracker.next(signal);
      }
    }
    let disposing;
    const stop = () => {
      disposing ??= activation.dispose();
      void disposing.catch(() => {});
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (signal.aborted) stop();
      if (worker && !worker.mounted) throw worker.error ?? new Error('Dream worker tools were not mounted');
      // A cancelled run stops waiting even if the host never settles the result,
      // and a child paused or interrupted from the host ends its turn without one.
      const stalled = turnEnded.then(() => later(graceMs,
        { stopReason: 'aborted', output: [], diagnostic: 'the child ended its turn without a result' }));
      const result = await untilAborted(Promise.race([activation.result, stalled]), signal);
      return { childId, result };
    } finally {
      signal.removeEventListener('abort', stop);
      await Promise.race([(disposing ?? activation.dispose()).catch(() => {}), later(DISPOSE_WAIT_MS)]);
    }
  } finally {
    if (worker) tracker.release(worker);
    tracker.workers.delete(childId);
    tracker.own.delete(childId);
    tracker.turnWaiters.delete(childId);
  }
}
