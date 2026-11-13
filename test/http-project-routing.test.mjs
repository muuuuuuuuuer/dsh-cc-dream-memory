/**
 * HTTP project routing: a request that names a session must be served by that
 * session's project, or rejected. Falling back to the single loaded project
 * would route a stale page's write into an unrelated repository.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { httpEnv, callHttp } from './v10-helpers.mjs';

test('http routing: a stale explicit session id is rejected, not routed to the only project', async (t) => {
  const env = await httpEnv(t);
  assert.equal(env.runtime.projects().length, 1, 'fixture must have exactly one loaded project');

  const status = await callHttp(env, { token: env.token, path: '/status?sessionId=session-that-vanished' });
  assert.equal(status.statusCode, 400, status.bodyText());
  assert.equal(status.json().error, 'unknown-session');

  const write = await callHttp(env, {
    method: 'POST',
    token: env.token,
    path: '/file',
    body: { sessionId: 'session-that-vanished', name: 'stale write', content: 'must not land' },
  });
  assert.equal(write.statusCode, 400, write.bodyText());
  assert.equal(write.json().error, 'unknown-session');
  assert.deepEqual(await env.store.listEntries('project'), [], 'a rejected write must not create a note');
});

test('http routing: a live session still reaches its own project for reads and writes', async (t) => {
  const env = await httpEnv(t);
  await env.runtime.forAgent({ id: 'live-session' });
  assert.equal(env.runtime.projects().length, 1);

  const status = await callHttp(env, { token: env.token, path: '/status?sessionId=live-session' });
  assert.equal(status.statusCode, 200, status.bodyText());
  assert.equal(status.json().ok, true);

  const write = await callHttp(env, {
    method: 'POST',
    token: env.token,
    path: '/file',
    body: { sessionId: 'live-session', name: 'live write', content: 'lands in the session project' },
  });
  assert.equal(write.statusCode, 200, write.bodyText());
  assert.equal(write.json().ok, true);
  const entries = await env.store.listEntries('project');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'live write');
});

test('http routing: a saved session with no live agent reaches the project its header names', async (t) => {
  const env = await httpEnv(t);
  env.host.services.sessionQuery = {
    filterSessions: async (filters) => {
      const ids = filters.find((filter) => filter.kind === 'id')?.values ?? [];
      return ids.includes('saved-session') ? [{ header: { id: 'saved-session', cwd: env.workspaceDir } }] : [];
    },
    readSession: async () => undefined,
  };

  const status = await callHttp(env, { token: env.token, path: '/status?sessionId=saved-session' });
  assert.equal(status.statusCode, 200, status.bodyText());
  assert.equal(status.json().ok, true);

  const gone = await callHttp(env, { token: env.token, path: '/status?sessionId=session-that-vanished' });
  assert.equal(gone.statusCode, 400, gone.bodyText());
  assert.equal(gone.json().error, 'unknown-session');
});

test('http routing: a request without a session may use the single loaded project', async (t) => {
  const env = await httpEnv(t);
  const status = await callHttp(env, { token: env.token, path: '/status' });
  assert.equal(status.statusCode, 200, status.bodyText());
  assert.equal(status.json().ok, true);
});
