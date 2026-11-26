import { asNumber, normalizeBackupList, normalizeDreamHistory, normalizeDreamTasks, normalizeFile, normalizeFileHistory, normalizeRules, normalizeSearch, normalizeStatus } from './normalize.js';
import { formatError } from './format.js';
import { planWaiting } from './model.js';

export async function discoverBridge() {
  try {
    if (typeof window === 'undefined' || typeof fetch !== 'function') return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), 1500) : undefined;
    try {
      const response = await fetch('/api/cc-memory/bridge', {
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data || data.ok !== true || typeof data.base !== 'string' || data.base === '') return null;
      return { base: data.base.replace(/\/+$/, ''), token: typeof data.token === 'string' ? data.token : '' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function queryString(query) {
  if (!query || typeof query !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  }
  return parts.length > 0 ? '?' + parts.join('&') : '';
}

/** One token-authenticated JSON request against the silent memory API. */
export async function apiRequest(api, method, endpoint, options = {}) {
  const url = api.base + endpoint + queryString(options.query);
  const headers = { accept: 'application/json' };
  if (api.token !== '') headers['x-cc-memory-token'] = api.token;
  let body;
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body === undefined ? {} : options.body);
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    throw new Error('memory API request failed: ' + formatError(error));
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') throw new Error('memory API returned HTTP ' + response.status);
  if (data.ok === false) {
    const code = typeof data.error === 'string' && data.error !== '' ? data.error : 'request failed';
    const detail = typeof data.message === 'string' && data.message !== '' ? data.message : '';
    const error = new Error(detail !== '' ? code + ': ' + detail : code);
    error.code = data.error;
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error('memory API returned HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function sessionIdOf(owner) {
  if (typeof owner === 'string' && owner !== '') return owner;
  if (owner && typeof owner === 'object' && typeof owner.sessionId === 'string' && owner.sessionId !== '') {
    return owner.sessionId;
  }
  return undefined;
}

export function createBackend({ api, sessionId, connection }) {
  const sid = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;
  const request = async (method, endpoint, options) => {
    const current = connection ? await connection.get() : api;
    if (!current) {
      throw Object.assign(new Error('the memory service is unavailable'), { code: 'no-backend' });
    }
    try {
      return await apiRequest(current, method, endpoint, options);
    } catch (error) {
      if (error.status === 401) connection?.invalidate(current);
      throw error;
    }
  };
  const get = (endpoint, query = {}) => request('GET', endpoint, { query: { sessionId: sid, ...query } });
  const post = (endpoint, body = {}) => request('POST', endpoint, { body: { sessionId: sid, ...body } });

  async function status({ view } = {}) {
    return normalizeStatus(await get('/status', { view }));
  }

  async function dreamCoverage() {
    const data = await get('/status', { view: 'dream-coverage' });
    return normalizeDreamTasks(data.dreamTasks);
  }

  async function chipStatus() {
    const data = await get('/status', { view: 'chip' });
    const status = normalizeStatus(data);
    return {
      config: status.config,
      index: status.index,
      entryCount: asNumber(data.entryCount, status.entries.length),
      needsReview: typeof data.needsReview === 'boolean' ? data.needsReview : planWaiting(status),
    };
  }

  /** The user marked a recalled note not relevant: recall stops attaching it in this conversation. */
  async function dismissRecall(file, scope) {
    return post('/recall-dismiss', { file, scope: scope === 'user' ? 'user' : 'project' });
  }

  async function file(name) {
    return normalizeFile(await get('/file', { file: name }));
  }

  async function saveRules(scope, text) {
    const data = await post('/rules', { scope: scope === 'global' ? 'global' : 'project', text });
    return normalizeRules(data.rules);
  }

  /** Saving empty text removes a layer; clear both so nothing extra is injected. */
  async function resetRules() {
    await post('/rules', { scope: 'project', text: '' });
    const data = await post('/rules', { scope: 'global', text: '' });
    return normalizeRules(data.rules);
  }

  async function toggle(patch) {
    const data = await post('/toggle', patch);
    return {
      overrides: data.overrides && typeof data.overrides === 'object' ? data.overrides : {},
      config: data.config && typeof data.config === 'object' ? data.config : {},
    };
  }

  /** POST /dream: estimate, start, resume, status, cancel, switch, discard, undo. */
  async function dream(action, options = {}) {
    const body = { action };
    const focus = typeof options.focus === 'string' ? options.focus.trim() : '';
    if (focus !== '') body.focus = focus;
    if (typeof options.runId === 'string' && options.runId !== '') body.runId = options.runId;
    // v23: a confirmed run is pinned to the range it was priced for.
    if (Array.isArray(options.reject) && options.reject.length > 0) body.reject = options.reject;
    if (Array.isArray(options.defer) && options.defer.length > 0) body.defer = options.defer;
    if (Array.isArray(options.confirm) && options.confirm.length > 0) body.confirm = options.confirm;
    if (options.noSessions === true) body.noSessions = true;
    return (await post('/dream', body)).result;
  }

  async function deleteFile(name) {
    return post('/delete', { file: name });
  }

  /** GET /backups → `{items:[{id,at,files[]}]}`. */
  async function backups() {
    return { items: normalizeBackupList(await get('/backups')) };
  }

  /** GET /trash → `{items:[{id,at,files[]}]}`. */
  async function trash() {
    return { items: normalizeBackupList(await get('/trash')) };
  }

  /** POST /restore `{kind:'backup'|'trash',id,file?}` → `{restored,reconciled}`. */
  async function restore(kind, id, name) {
    const body = { kind: kind === 'backup' ? 'backup' : 'trash', id };
    if (typeof name === 'string' && name !== '') body.file = name;
    return post('/restore', body);
  }

  async function dreamDiff(runId, file) {
    return get('/dream-diff', { runId, file });
  }

  async function dreamHistory() {
    return normalizeDreamHistory(await get('/dream-history'));
  }

  /** Save or overwrite a memory file. */
  async function saveFile(payload) {
    const body = {
      name: String(payload && payload.name !== undefined ? payload.name : ''),
      type: String(payload && payload.type !== undefined ? payload.type : 'user'),
      description: String(payload && payload.description !== undefined ? payload.description : ''),
      content: String(payload && payload.content !== undefined ? payload.content : ''),
    };
    if (payload && typeof payload.file === 'string' && payload.file !== '') body.file = payload.file;
    // v23: the server refuses the write when the file moved since this baseline.
    if (payload && typeof payload.expectedHash === 'string' && payload.expectedHash !== '') {
      body.expectedHash = payload.expectedHash;
    }
    return post('/file', body);
  }

  /** GET /search → ranked `{query,total,items:[{file,name,type,score,snippets}]}`. */
  async function search(query, options = {}) {
    const data = await get('/search', {
      q: String(query === undefined || query === null ? '' : query),
      limit: String(asNumber(options.limit, 20)),
      offset: String(asNumber(options.offset, 0)),
      type: options.type === undefined || options.type === null ? '' : String(options.type),
      history: options.history === true ? '1' : '',
    });
    return normalizeSearch(data);
  }

  /** GET /file-history → dream batches and changelog lines that touched one file. */
  async function fileHistory(target) {
    return normalizeFileHistory(await get('/file-history', { file: target }));
  }

  return {
    get mode() { return (connection ? connection.current : api) ? 'api' : 'none'; },
    sessionId: sid,
    status,
    dreamCoverage,
    chipStatus,
    dismissRecall,
    fileHistory,
    file,
    saveRules,
    resetRules,
    toggle,
    dream,
    deleteFile,
    backups,
    trash,
    restore,
    dreamHistory,
    dreamDiff,
    saveFile,
    search,
  };
}
