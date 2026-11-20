/**
 * Dream tasks as host subagents.
 *
 * One standard-preset child runs the batch. Its scoped tools serve source
 * pages and let the plugin check and checkpoint each task independently.
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
    session_id: { type: 'string' },
    seq: { type: 'integer' },
    memory_file: { type: 'string' },
    quote: { type: 'string', description: 'Copy one exact supporting sentence including its qualifications. Give separate citations for independent sentences in one event.' },
  },
  required: ['quote'],
  additionalProperties: false,
};

const submitSchema = {
  type: 'object',
  properties: {
    task: { type: 'integer', description: 'The number of the current task.' },
    done: { type: 'boolean' },
    skip_pages: { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'Raw page numbers explicitly screened as having no reusable change after reading their overview. Omit when reading every raw page.' },
    summary: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          op: { type: 'string', enum: ['write', 'add', 'edit', 'delete'], description: 'write creates a file or replaces a whole page. add inserts a fact into an EXISTING note. edit replaces one passage in an EXISTING note and saves the old passage in history.' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['project', 'feedback', 'reference', 'user'] },
          description: { type: 'string' },
          body: { type: 'string', description: 'Required for add (new fact only), edit (replacement passage), and write (complete page).' },
          old_text: { type: 'string', description: 'For edit, the exact unique passage to replace.' },
          version: { type: 'string' },
          citations: { type: 'array', items: citation },
          merges: { type: 'array', items: { type: 'string' } },
          moved_to: { type: 'string' },
        },
        required: ['file', 'op', 'citations'],
        additionalProperties: false,
      },
    },
  },
  required: ['task', 'done', 'summary', 'changes'],
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
function sourceArgs(args) {
  const integer = (value) => typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) ? Number(value) : value;
  return { ...args, task: integer(args.task), page: integer(args.page) };
}

export function dreamWorkerTools({ readSource, sourceDelivered, readNote, listNotes, submit, submitDelivered }) {
  return [
    {
      name: 'dream_read_source',
      description: 'Read a raw source page or a group of overview entries. In overview mode page is the first raw page to preview. Use raw pages for evidence or uncertainty.',
      parameters: {
        type: 'object',
        properties: { task: { type: 'integer' }, page: { type: 'integer', minimum: 0 }, view: { type: 'string', enum: ['overview', 'raw'] } },
        required: ['task', 'page'],
        additionalProperties: false,
      },
      execute: async (args) => readSource(sourceArgs(args)),
      finalizeContent({ arguments: args }, result) {
        if (!result.isError && result.content.length === 1) sourceDelivered(sourceArgs(args), result.content[0].text);
      },
    },
    {
      name: 'dream_list_notes',
      description: 'List the notes in the project shadow copy.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
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
    },
    {
      name: 'dream_submit_task',
      description: 'Submit the current task and its proposed note edits. On success the result includes the next task or indicates that the batch is finished.',
      parameters: submitSchema,
      execute: submit,
      finalizeContent({ arguments: args }, result) {
        if (!result.isError && result.content.length === 1 && result.content[0].type === 'text') {
          submitDelivered(args, result.content[0].text);
        }
      },
    },
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
