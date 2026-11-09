/**
 * Silent HTTP API for the Memory Web UI.
 *
 * The client view must not execute slash commands for every refresh: command
 * runs are appended to the session log and the Trajectory view renders each one
 * as a `memory · …` row. This module exposes the same operations over a
 * loopback HTTP route authenticated with a per-process random token injected
 * into the application index. Nothing here writes session events.
 *
 * All project-facing reads and mutations go through `src/status.js` so the HTTP
 * payload and the `/memory json` payload share one implementation.
 */
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';
import { BAD_REQUEST_CODES, DEFAULT_LOG_LINES, createStatusService, readTail } from './status.js';

/** URL prefix served to the browser. */
export const API_PREFIX = '/api/cc-memory';
/** Body limit accepted by the JSON endpoints. */
const MAX_BODY_BYTES = 256 * 1024;

/** Convert any result into lossless JSON before sending it. */
function lossless(value) {
  try {
    const text = JSON.stringify(value ?? null);
    return text === undefined ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** Constant-time string comparison. */
function sameToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Loopback-only carrier addresses. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  const value = address.toLowerCase();
  if (value === '::1' || value === '::ffff:127.0.0.1') return true;
  return value.startsWith('127.');
}

/** Reject cross-origin mutations; same-origin (or loopback host) is required. */
function isSameOriginRequest(req) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = req.headers?.host;
  if (typeof host === 'string' && parsed.host === host) return true;
  const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
  return loopbackHosts.has(parsed.hostname);
}

/** Stable per-profile API token: survives plugin reloads (open pages keep working). */
function loadOrCreateApiToken(file) {
  try {
    if (file !== '') {
      const existing = fsSync.readFileSync(file, 'utf8').trim();
      if (/^[A-Za-z0-9_-]{24,}$/.test(existing)) return existing;
    }
  } catch {
    /* missing token file: create below */
  }
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    if (file !== '') {
      fsSync.mkdirSync(path.dirname(file), { recursive: true });
      fsSync.writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  } catch {
    /* a non-writable token file only means the token is per-process */
  }
  return token;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(lossless(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Read a small JSON request body with a hard size limit. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('request body must be a JSON object'), { code: 'BAD_BODY' }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { code: 'BAD_BODY' }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Create the request handler. Exported separately so tests can call it with
 * fake `req`/`res` objects and a known token.
 * @param {{runtime:object, token:string}} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHttpHandler({ runtime, token }) {
  const service = createStatusService(runtime);

  /** Resolve one project context for the request. */
  async function resolveProject(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      const projectContext = await runtime.forSessionId(sessionId);
      if (projectContext) return projectContext;
    }
    const projects = typeof runtime.projects === 'function' ? runtime.projects() : [];
    if (projects.length === 1) return projects[0];
    return undefined;
  }

  /** Send a coded service error, mapping caller mistakes to HTTP 400. */
  function sendCoded(res, error, fallbackCode) {
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : fallbackCode;
    const status = BAD_REQUEST_CODES.includes(code) ? 400 : 200;
    return sendJson(res, status, {
      ok: false,
      error: code,
      message: String(error?.message ?? error),
    });
  }

  /** Resolve the project for one dream action; shared by every dream route. */
  async function dreamContext(res, body) {
    const projectContext = await resolveProject(body?.sessionId);
    if (!projectContext) {
      sendJson(res, 400, { ok: false, error: 'no-project' });
      return undefined;
    }
    if (!runtime.effectiveEnabled()) {
      sendJson(res, 200, { ok: false, error: 'plugin-disabled', message: 'memory is disabled; enable it first' });
      return undefined;
    }
    if (runtime.config.autoMemoryEnabled === false) {
      sendJson(res, 200, { ok: false, error: 'auto-memory-disabled', message: 'auto memory is off; run /memory on' });
      return undefined;
    }
    return projectContext;
  }

  async function handleAction(res, action, body) {
    const projectContext = await dreamContext(res, body);
    if (!projectContext) return;
    let response;
    try {
      response = await service.dream(projectContext, {
        agent: projectContext.agent,
        sessionId: body.sessionId,
        action,
        indexes: body.indexes,
        focus: body.focus,
        trigger: 'manual',
        reason: 'web ui',
      });
    } catch (error) {
      return sendCoded(res, error, 'dream-failed');
    }
    return sendJson(res, 200, response);
  }

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad-url' });
    }
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
      return sendJson(res, 404, { ok: false, error: 'not-found' });
    }
    const remoteAddress = req.socket?.remoteAddress;
    // Bridge discovery: the Web UI may start before the index injection reaches
    // it (desktop boot caches rows; a page can be older than a plugin reload).
    // The page fetches this once to obtain the same {base, token} the Host would
    // have injected. Loopback-only; the DSH auth layer gates the route, and the
    // token still guards every data call. Never served to a non-loopback peer.
    if (url.pathname === `${API_PREFIX}/bridge`) {
      if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
        return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      }
      if (remoteAddress !== undefined && !isLoopbackAddress(remoteAddress)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' });
      }
      return sendJson(res, 200, { ok: true, base: API_PREFIX, token });
    }
    const provided = req.headers?.['x-cc-memory-token'];
    if (!sameToken(typeof provided === 'string' ? provided : '', token)) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    const route = url.pathname.slice(API_PREFIX.length);
    const method = (req.method ?? 'GET').toUpperCase();
    if (remoteAddress !== undefined && !isLoopbackAddress(remoteAddress)) {
      return sendJson(res, 403, {
        ok: false,
        error: 'loopback-only',
        message: 'the memory API only accepts loopback connections',
      });
    }
    if (method !== 'GET' && method !== 'HEAD' && !isSameOriginRequest(req)) {
      return sendJson(res, 403, {
        ok: false,
        error: 'bad-origin',
        message: 'cross-origin writes to the memory API are not allowed',
      });
    }
    // Master switch: only status and toggle stay reachable when the plugin is
    // disabled, so the UI can always re-enable it.
    if (!runtime.effectiveEnabled() && !(route === '/status' && method === 'GET')) {
      const isToggle = route === '/toggle' && method === 'POST';
      if (!isToggle) {
        return sendJson(res, 200, {
          ok: false,
          error: 'plugin-disabled',
          message: 'memory is disabled; enable it first',
        });
      }
    }
    try {
      if (route === '/status' && method === 'GET') {
        const projectContext = await resolveProject(url.searchParams.get('sessionId') ?? undefined);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        return sendJson(
          res,
          200,
          await service.status(projectContext, { sessionId: url.searchParams.get('sessionId') ?? undefined }),
        );
      }
      if (route === '/rules' && method === 'GET') {
        const projectContext = await resolveProject(url.searchParams.get('sessionId') ?? undefined);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        return sendJson(res, 200, { ok: true, rules: service.rules(projectContext) });
      }
      if (route === '/log' && method === 'GET') {
        const projectContext = await resolveProject(url.searchParams.get('sessionId') ?? undefined);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        const lines = Number(url.searchParams.get('lines')) || DEFAULT_LOG_LINES;
        const tail = await readTail(projectContext.paths.changelogFile, lines);
        return sendJson(res, 200, { ok: true, tail });
      }
      if (route === '/file' && method === 'GET') {
        const projectContext = await resolveProject(url.searchParams.get('sessionId') ?? undefined);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        const file = url.searchParams.get('file') ?? '';
        const scope = (url.searchParams.get('scope') ?? 'project').toLowerCase();
        try {
          return sendJson(res, 200, { ok: true, ...(await service.file(projectContext, file, scope)) });
        } catch (error) {
          return sendJson(res, 200, {
            ok: false,
            error: typeof error?.code === 'string' ? error.code : 'READ_FAILED',
            message: String(error?.message ?? error),
          });
        }
      }
      if (route === '/file' && method === 'POST') {
        const body = await readBody(req);
        const projectContext = await resolveProject(body.sessionId);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        try {
          return sendJson(res, 200, await service.writeFile(projectContext, body));
        } catch (error) {
          return sendCoded(res, error, 'write-failed');
        }
      }
      if (route === '/merge' && method === 'POST') {
        const body = await readBody(req);
        const projectContext = await resolveProject(body.sessionId);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        try {
          return sendJson(res, 200, await service.mergeFiles(projectContext, body));
        } catch (error) {
          return sendCoded(res, error, 'merge-failed');
        }
      }
      if (route === '/file-history' && method === 'GET') {
        const projectContext = await resolveProject(url.searchParams.get('sessionId') ?? undefined);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        try {
          const result = await service.fileHistory(projectContext, url.searchParams.get('file') ?? '');
          return sendJson(res, 200, result);
        } catch (error) {
          return sendCoded(res, error, 'history-failed');
        }
      }
      if (route === '/search' && method === 'GET') {
        const projectContext = await resolveProject(url.searchParams.get('sessionId') ?? undefined);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        try {
          const result = await service.search(projectContext, {
            query: url.searchParams.get('q') ?? '',
            limit: url.searchParams.get('limit') ?? undefined,
            offset: url.searchParams.get('offset') ?? undefined,
            type: url.searchParams.get('type') ?? undefined,
            scope: url.searchParams.get('scope') ?? undefined,
          });
          return sendJson(res, 200, { ok: true, items: result.items, total: result.total });
        } catch (error) {
          return sendCoded(res, error, 'search-failed');
        }
      }
      if (route === '/dream-history' && method === 'GET') {
        const projectContext = await resolveProject(url.searchParams.get('sessionId') ?? undefined);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        const result = await service.dreamHistory(projectContext);
        return sendJson(res, 200, { ok: true, items: result.items });
      }
      if (route === '/import' && method === 'POST') {
        const body = await readBody(req);
        const projectContext = await resolveProject(body.sessionId);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        try {
          return sendJson(res, 200, await service.importMemory(projectContext, body));
        } catch (error) {
          return sendCoded(res, error, 'import-failed');
        }
      }
      if (route === '/export' && method === 'POST') {
        const body = await readBody(req);
        const projectContext = await resolveProject(body.sessionId);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        try {
          return sendJson(res, 200, await service.exportMemory(projectContext, body));
        } catch (error) {
          return sendCoded(res, error, 'export-failed');
        }
      }
      if (route === '/toggle' && method === 'POST') {
        const body = await readBody(req);
        try {
          const { overrides, config } = await service.toggle(runtime, body);
          return sendJson(res, 200, { ok: true, overrides, config });
        } catch (error) {
          return sendCoded(res, error, 'no-toggle-field');
        }
      }
      if (route === '/rules' && method === 'POST') {
        const body = await readBody(req);
        const projectContext = await resolveProject(body.sessionId);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        const scope = body.scope === 'global' ? 'global' : 'project';
        try {
          const rules = await service.saveRules(projectContext, scope, body.text, { source: 'api' });
          return sendJson(res, 200, { ok: true, rules });
        } catch (error) {
          return sendJson(res, 200, {
            ok: false,
            error: typeof error?.code === 'string' ? error.code : 'RULES_SAVE_FAILED',
            message: String(error?.message ?? error),
          });
        }
      }
      if (route === '/delete' && method === 'POST') {
        const body = await readBody(req);
        const projectContext = await resolveProject(body.sessionId);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        try {
          const result = await service.deleteFile(projectContext, body.file, body.scope);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendCoded(res, error, 'DELETE_FAILED');
        }
      }
      if (route === '/backups' && method === 'GET') {
        const projectContext = await resolveProject(url.searchParams.get('sessionId') ?? undefined);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        const result = await service.backups(projectContext);
        return sendJson(res, 200, { ok: true, items: result.items });
      }
      if (route === '/trash' && method === 'GET') {
        const projectContext = await resolveProject(url.searchParams.get('sessionId') ?? undefined);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        const result = await service.trash(projectContext);
        return sendJson(res, 200, { ok: true, items: result.items });
      }
      if (route === '/metrics' && method === 'GET') {
        const projectContext = await resolveProject(url.searchParams.get('sessionId') ?? undefined);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        const daysValue = Number(url.searchParams.get('days'));
        const report = await service.metricsReport(projectContext, {
          days: Number.isFinite(daysValue) && daysValue > 0 ? daysValue : undefined,
        });
        return sendJson(res, 200, {
          ok: true,
          metrics: report.metrics,
          summary: report.summary,
          trend: report.trend,
          quality: report.quality,
        });
      }
      if (route === '/pending-writes' && method === 'GET') {
        const projectContext = await resolveProject(url.searchParams.get('sessionId') ?? undefined);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        return sendJson(res, 200, { ok: true, ...(await service.pendingWrites(projectContext)) });
      }
      if (route === '/pending-writes' && method === 'POST') {
        const body = await readBody(req);
        const projectContext = await resolveProject(body.sessionId);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        const action = String(body.action ?? '').toLowerCase();
        try {
          if (action === 'approve') {
            const result = await service.approveWrite(projectContext, body.id, { sessionId: body.sessionId });
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (action === 'reject') {
            const result = await service.rejectWrite(projectContext, body.id, body.reason);
            return sendJson(res, 200, { ok: true, ...result });
          }
          return sendJson(res, 400, {
            ok: false,
            error: 'unknown-action',
            message: 'action must be "approve" or "reject"',
          });
        } catch (error) {
          return sendCoded(res, error, 'pending-write-failed');
        }
      }
      if (route === '/session-live' && method === 'POST') {
        const body = await readBody(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (sessionId === '') {
          return sendJson(res, 400, { ok: false, error: 'invalid-session', message: 'sessionId is required' });
        }
        if (typeof runtime.setSessionMode !== 'function') {
          return sendJson(res, 200, {
            ok: false,
            error: 'not-ready',
            message: 'per-session live mode is not available in this build',
          });
        }
        try {
          const mode = runtime.setSessionMode(sessionId, body.live === true ? 'live' : 'auto');
          return sendJson(res, 200, { ok: true, session: { live: mode === 'live', mode } });
        } catch (error) {
          return sendCoded(res, error, 'session-live-failed');
        }
      }
      if (route === '/restore' && method === 'POST') {
        const body = await readBody(req);
        const projectContext = await resolveProject(body.sessionId);
        if (!projectContext) return sendJson(res, 400, { ok: false, error: 'no-project' });
        try {
          const result = await service.restore(projectContext, {
            kind: body.kind,
            id: body.id,
            file: body.file,
          });
          return sendJson(res, 200, {
            ok: true,
            restored: result.restored,
            reconciled: result.reconciled,
          });
        } catch (error) {
          return sendCoded(res, error, 'restore-failed');
        }
      }
      if (route === '/dream' && method === 'POST') {
        const body = await readBody(req);
        return handleAction(res, body.action, body);
      }
      return sendJson(res, 404, { ok: false, error: 'not-found' });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : '';
      if (code === 'BAD_BODY') {
        return sendJson(res, 400, { ok: false, error: 'bad-body', message: String(error?.message ?? 'invalid JSON body') });
      }
      if (code === 'BODY_TOO_LARGE') {
        return sendJson(res, 413, { ok: false, error: 'body-too-large', message: 'request body exceeds 256 KiB' });
      }
      return sendJson(res, 500, {
        ok: false,
        error: code !== '' ? code : 'internal',
        message: String(error?.message ?? error),
      });
    }
  };
}

/**
 * Register the silent HTTP API on the Host web server (no-op without one).
 * The Host starts webServer asynchronously, often after this plugin, so a
 * lookup at load time can miss it. Injecting it registers whenever it is up.
 * @returns {() => void} disposer.
 */
export function registerHttpApi(ctx, runtime) {
  if (typeof ctx.inject === 'function') {
    const fiber = ctx.inject(['webServer'], (webCtx) => {
      const dispose = mountHttpApi(webCtx, runtime);
      webCtx.effect(() => dispose, 'cc-memory: http api');
    });
    return () => fiber?.dispose?.();
  }
  return mountHttpApi(ctx, runtime);
}

function mountHttpApi(ctx, runtime) {
  let server;
  try {
    server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  } catch {
    server = undefined;
  }
  if (!server || typeof server.register !== 'function') {
    // eslint-disable-next-line no-console
    console.warn('[cc-memory] webServer is unavailable; the Web UI falls back to command mode');
    return function dispose() {};
  }
  const token = loadOrCreateApiToken(path.join(path.dirname(runtime.overrideFile), '.api-token'));
  const handler = createHttpHandler({ runtime, token });
  const disposers = [];
  // Structured index injection: the same row feeds the served web index and the
  // desktop shell (Electron collects rows and applies kind:'global' before the
  // app boots). Only an owner Peer gets the token — liveshare viewers must
  // never receive the memory API credential.
  try {
    const isOwnerPeer = (peer) => {
      if (!peer || typeof peer !== 'object') return false;
      if (peer.owner === true) return true;
      const principal = peer.principal;
      return Boolean(principal && typeof principal === 'object' && principal.kind === 'owner');
    };
    const stopIndexInject =
      typeof ctx.on === 'function'
        ? ctx.on('webserver/index-inject', (table, peer) => {
            try {
              if (!Array.isArray(table) || !isOwnerPeer(peer)) return;
              table.push({
                kind: 'global',
                name: '__CC_MEMORY_API__',
                value: { base: API_PREFIX, token },
              });
            } catch (error) {
              // eslint-disable-next-line no-console
              console.warn('[cc-memory] index injection failed:', error?.message ?? error);
            }
          })
        : undefined;
    if (typeof stopIndexInject === 'function') disposers.push(stopIndexInject);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[cc-memory] failed to register index injection:', error?.message ?? error);
  }
  // Older builds wrote a diagnostic log through tapIndex; remove it on upgrade.
  try {
    fsSync.rmSync(path.join(path.dirname(runtime.overrideFile), '.api-tap.log'), { force: true });
  } catch {
    /* optional cleanup */
  }
  disposers.push(
    server.register({
      kind: 'prefix',
      // No trailing slash: webServer prefix matching compares
      // `pathname.startsWith(prefix + '/')`, so a trailing-slash prefix
      // (`/api/cc-memory/`) never matches `/api/cc-memory/status`.
      path: API_PREFIX,
      handler: (req, res) => {
        Promise.resolve(handler(req, res)).catch((error) => {
          // eslint-disable-next-line no-console
          console.warn('[cc-memory] http handler failed:', error?.message ?? error);
          try {
            sendJson(res, 500, { ok: false, error: 'internal' });
          } catch {
            /* response may already be closed */
          }
        });
      },
    }),
  );
  return function dispose() {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* best effort */
      }
    }
  };
}
