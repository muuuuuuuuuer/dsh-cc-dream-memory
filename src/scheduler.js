/**
 * Turns durable session events into automatic Dream and Inbox work.
 * The Dream launcher owns readiness and execution.
 */
import { runAutoExtract } from './auto-extract.js';
import { dreamReadiness } from './readiness.js';
import { buildFocus } from './dream-focus.js';
import { listRunManifests } from './dream-run.js';
import { isDelegated } from './session-kind.js';

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

export function registerScheduler(ctx, runtime) {
  const cleanups = [];
  const extracting = new Set();
  const projectQueues = new Map();
  let disposed = false;

  const onTurnEnd = (session, event) => {
    if (disposed) return;
    if (!event || event.type !== 'turn/end') return;
    if (isDelegated(session)) return;
    const sessionId = typeof session?.id === 'string' ? session.id : event?.data?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const cwd = session?.header?.cwd ?? session?.cwd;
    const at = Number(event?.time) || Date.now();
    handleTurnEnd(sessionId, cwd, at, session).catch((error) => warn('turn-end handling', error));
  };

  async function handleTurnEnd(sessionId, cwd, at, session) {
    const projectContext = await runtime.forSessionId(sessionId, cwd);
    if (!projectContext) return;
    try {
      await projectContext.state.ensureSession(sessionId, at);
    } catch (error) {
      warn('state.ensureSession', error);
    }
    // One consolidation queue per project: the extractor writes live notes, so
    // it must finish before Dream snapshots them (and Dream must not run twice).
    const key = projectContext.paths.projectDir;
    const previous = projectQueues.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const extraction = maybeAutoExtract(projectContext, sessionId, at, session);
      if (extraction) await extraction.catch((error) => warn('auto extract', error));
      await maybeAutoDream(projectContext, sessionId).catch((error) => warn('auto dream', error));
    });
    projectQueues.set(key, work);
    runtime.track(work.finally(() => {
      if (projectQueues.get(key) === work) projectQueues.delete(key);
    }));
  }

  async function maybeAutoDream(projectContext, sessionId) {
    // `dreamReadiness` trusts the pending record; one whose copy is gone must
    // not be able to block automatic runs for good.
    await projectContext.state?.dropStaleShadowPending?.();
    if (disposed || !dreamReadiness(projectContext, { config: runtime.config }).eligible) return;
    // `dreamReadiness` throttles on `lastScanAt`, so the attempt has to stamp it;
    // otherwise a run that ends without a result is restarted on the next turn.
    await projectContext.state?.noteScan?.();
    const query = ctx.get?.('sessionQuery');
    const canReviewDialogue = typeof query?.readSession === 'function' && typeof query?.filterSessions === 'function';
    if (canReviewDialogue) {
      const [latest] = await listRunManifests(projectContext.paths, 1);
      if (latest?.checkpoint && latest.manifest.trigger === 'auto') return;
    }
    const focus = await buildFocus(projectContext, runtime.config);
    if (focus.files.length === 0) {
      const ids = (projectContext.state?.snapshot()?.sessionsSince ?? []).map(({ id }) => id)
        .filter((id) => projectContext.state.flagsOf(id).learn !== false);
      const sessions = ids.length && canReviewDialogue ? await query.filterSessions([{ kind: 'id', values: ids }]) : [];
      if (sessions.length === 0) {
        await projectContext.state?.markSkipped?.('no-focus');
        return;
      }
    }
    const run = await runtime.startDream(projectContext, { trigger: 'auto', focus: focus.text, sessionId });
    if (run.started && (await run.done)?.skipped) await projectContext.state.markSkipped();
  }

  /**
   * v20 auto-extract: fire-and-forget after the Nth mainline turn, unless the
   * model already wrote memory this turn. The model call never blocks turn/end;
   * a failed attempt simply waits for the next multiple.
   */
  function maybeAutoExtract(projectContext, sessionId, at, session) {
    const config = runtime.config;
    if (config.enabled === false || !config.autoMemoryEnabled || !config.autoExtract || disposed) return;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (extracting.has(sessionId)) return;
    // `/memory session learn off`: nothing is mined from this conversation.
    if (projectContext.state?.flagsOf?.(sessionId).learn === false) return;
    const turn = runtime.noteTurnEnd(sessionId, at);
    if (turn.wrote) return;
    const every = Math.max(1, Number(config.autoExtractEveryTurns) || 1);
    if (turn.turns % every !== 0) return;
    extracting.add(sessionId);
    const state = projectContext.state;
    state.markExtractStart('auto').catch((error) => warn('state.markExtractStart', error));
    const work = runAutoExtract({
      ctx: runtime.ctx,
      runtime,
      pctx: projectContext,
      sessionId,
      agent: session ?? projectContext.agent ?? { id: sessionId },
      trigger: 'auto',
    })
      .then(async (result) => {
        await state.markExtractResult({
          ok: result?.ok === true,
          count: Number(result?.written ?? result?.count) || 0,
          reason: result?.ok === true ? String(result?.mode ?? 'ok') : String(result?.reason ?? 'failed'),
          trigger: 'auto',
        });
      })
      .catch(async (error) => {
        warn('auto extract', error);
        try {
          await state.markExtractResult({ ok: false, reason: 'error', error, trigger: 'auto' });
        } catch (inner) {
          warn('state.markExtractResult', inner);
        }
      })
      .finally(() => extracting.delete(sessionId));
    return work;
  }

  // `session/event` is the post-commit fire-and-forget append feed; `turn/end`
  // is durable, so a dream check never races the turn it just observed.
  if (typeof ctx.on === 'function') {
    cleanups.push(ctx.on('session/event', onTurnEnd));
  }

  return () => {
    disposed = true;
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        warn('scheduler cleanup', error);
      }
    }
  };
}
