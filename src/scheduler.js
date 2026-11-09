/**
 * Background dream scheduler.
 *
 * Listens to the durable session feed and, after a turn ends, first expires a
 * stale review proposal (`pendingProposalTtlHours`, moved to `.pending/expired/`)
 * and then checks the dream gates for that project: auto memory enabled, auto
 * dream enabled, no pending review proposal, at least `minHours` since the last
 * dream, at least `minSessions` distinct sessions touched since then, the scan
 * throttle, and a failure backoff. The actual run is fire-and-forget and owns
 * its own lock, so a second session cannot start a concurrent dream.
 */
import { expireStaleProposal } from './readiness.js';

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

/** Exponential backoff for consecutive dream failures, capped at 6 hours. */
function failureBackoffMs(config, failures) {
  const base = Math.max(60_000, Number(config.scanThrottleMs) || 600_000);
  return Math.min(base * 2 ** Math.min(failures, 6), 6 * 60 * 60 * 1000);
}

/** A delegated child session (teammate/subagent) is not a user conversation. */
function isDelegatedSession(session) {
  const header = session && typeof session === 'object' ? session.header : undefined;
  if (header && typeof header === 'object') {
    if (header.parentSession) return true;
    if (header.origin === 'subagent') return true;
  }
  return false;
}

export function registerScheduler(ctx, runtime) {
  const cleanups = [];
  const running = new Set();
  let disposed = false;

  const onTurnEnd = (session, event) => {
    if (disposed) return;
    if (!event || event.type !== 'turn/end') return;
    if (isDelegatedSession(session)) return;
    const sessionId = typeof session?.id === 'string' ? session.id : event?.data?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const cwd = session?.header?.cwd ?? session?.cwd;
    const at = Number(event?.time) || Date.now();
    handleTurnEnd(sessionId, cwd, at).catch((error) => warn('turn-end handling', error));
  };

  async function handleTurnEnd(sessionId, cwd, at, session) {
    const projectContext = await runtime.forSessionId(sessionId, cwd);
    if (!projectContext) return;
    try {
      await projectContext.state.ensureSession(sessionId, at);
    } catch (error) {
      warn('state.ensureSession', error);
    }
    // v9: an over-age review proposal must not block dreaming forever.
    if (runtime.config.expireStaleProposal !== false) {
      try {
        const expired = await expireStaleProposal(projectContext, {
          config: runtime.config,
          now: Date.now(),
        });
        if (expired && expired.expired) {
          try {
            runtime.invalidateAllInjections?.('pending-expired');
          } catch {
            /* prompt refresh is best-effort */
          }
        }
      } catch (error) {
        warn('expire pending proposal', error);
      }
    }
    await maybeAutoDream(projectContext);
  }

  /**
   * Cheap gate pass before waking the model. The engine re-checks the
   * authoritative time/session gates itself; this only avoids the work.
   */
  async function maybeAutoDream(projectContext) {
    const config = runtime.config;
    if (config.enabled === false || !config.autoMemoryEnabled || !config.autoDreamEnabled || disposed) return;
    const key = projectContext.paths.projectDir;
    if (running.has(key)) return;
    let snapshot;
    try {
      snapshot = projectContext.state.snapshot();
    } catch {
      return;
    }
    const now = Date.now();
    if (snapshot.pendingProposal) return; // a human still has to accept or reject it
    if (snapshot.lastScanAt && now - snapshot.lastScanAt < config.scanThrottleMs) return;
    if (snapshot.lastDreamAt && now - snapshot.lastDreamAt < config.minHours * 60 * 60 * 1000) return;
    const failures = Number(snapshot.consecutiveFailures) || 0;
    if (failures > 0 && snapshot.lastDreamAttemptAt) {
      if (now - snapshot.lastDreamAttemptAt < failureBackoffMs(config, failures)) return;
    }
    if (!Array.isArray(snapshot.sessionsSince) || snapshot.sessionsSince.length < config.minSessions) return;
    running.add(key);
    try {
      await projectContext.state.noteScan();
      const result = await runtime.dream({
        pctx: projectContext,
        agent: projectContext.agent,
        force: false,
        trigger: 'auto',
      });
      if (result && result.skipped) {
        try {
          await projectContext.state.markSkipped();
        } catch (error) {
          warn('state.markSkipped', error);
        }
      }
    } catch (error) {
      warn('auto dream', error);
      try {
        await projectContext.state.markDreamFailed(error);
      } catch (inner) {
        warn('state.markDreamFailed', inner);
      }
    } finally {
      running.delete(key);
    }
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
