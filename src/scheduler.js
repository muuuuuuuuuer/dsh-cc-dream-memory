/**
 * Turns durable session events into automatic Dream and Inbox work.
 * The Dream launcher owns readiness and execution.
 */
import { runAutoExtract } from './auto-extract.js';
import { dreamReadiness } from './readiness.js';
import { isDelegated } from './session-kind.js';

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

export function registerScheduler(ctx, runtime) {
  const cleanups = [];
  const extracting = new Set();
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
    runtime.track(maybeAutoDream(projectContext).catch((error) => warn('auto dream', error)));
    maybeAutoExtract(projectContext, sessionId, at, session);
  }

  async function maybeAutoDream(projectContext) {
    if (disposed || !dreamReadiness(projectContext, { config: runtime.config }).eligible) return;
    const run = await runtime.startDream(projectContext, { trigger: 'auto' });
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
          count: Number(result?.count) || 0,
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
    runtime.track(work);
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
